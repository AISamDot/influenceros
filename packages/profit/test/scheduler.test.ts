import type { ScheduledTask } from '@troupe/agents';
import { createTestStudio, makeTestPersona, type TestStudio } from '@troupe/agents/testing';
import { DeferJob, enqueue, propose, STUDIO_MANAGER } from '@troupe/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorker, jobs, lastDailyMark, lastWeeklyMark, PROFIT_JOBS, runSchedules, schedules, studioTick, tools } from '../src';
import { addWeeklyHistory, NOW } from './fixtures';

let t: TestStudio | null = null;
afterEach(async () => {
  await t?.db.close();
  t = null;
});

const HOUR = 3_600_000;

describe('scheduler', () => {
  it('runs due tasks once, records the last run, and isolates failures', async () => {
    t = await createTestStudio({ now: () => NOW });
    const calls: string[] = [];
    const hourly: ScheduledTask = { name: 'test.hourly', due: (now, last) => !last || now.getTime() - last.getTime() >= HOUR, run: async () => void calls.push('hourly') };
    const broken: ScheduledTask = {
      name: 'test.broken',
      due: () => true,
      run: async () => {
        throw new Error('boom');
      },
    };
    const r1 = await runSchedules(t.services, [hourly, broken], NOW);
    expect(r1.ran).toEqual(['test.hourly']);
    expect(r1.errors).toEqual(['test.broken: boom']);
    expect((await runSchedules(t.services, [hourly], new Date(NOW.getTime() + 60_000))).skipped).toEqual(['test.hourly']);
    expect((await runSchedules(t.services, [hourly], new Date(NOW.getTime() + HOUR))).ran).toEqual(['test.hourly']);
    expect(calls).toEqual(['hourly', 'hourly']);
    const rows = await t.db.query<{ name: string; runs: number; failures: number; last_status: string; last_error: string | null }>(
      'SELECT name, runs, failures, last_status, last_error FROM scheduler_run ORDER BY name',
    );
    expect(rows).toEqual([
      { name: 'test.broken', runs: 0, failures: 1, last_status: 'error', last_error: 'boom' },
      { name: 'test.hourly', runs: 2, failures: 0, last_status: 'ok', last_error: null },
    ]);
  });

  it('lets only one of two overlapping ticks run a task', async () => {
    t = await createTestStudio({ now: () => NOW });
    let n = 0;
    const slow: ScheduledTask = { name: 'test.slow', due: (_now, last) => !last, run: async () => void n++ };
    // A tick on another machine holds the claim.
    await t.db.query(`INSERT INTO scheduler_run (name, claimed_until) VALUES ('test.slow', $1)`, [new Date(NOW.getTime() + 60_000)]);
    expect((await runSchedules(t.services, [slow], NOW)).skipped).toEqual(['test.slow']);
    expect(n).toBe(0);
    // Its claim expires (that tick died): the next tick takes over.
    expect((await runSchedules(t.services, [slow], new Date(NOW.getTime() + 6 * 60_000))).ran).toEqual(['test.slow']);
  });

  it('computes the weekly and daily marks', () => {
    expect(lastWeeklyMark(NOW).toISOString()).toBe('2026-10-12T06:00:00.000Z');
    expect(lastWeeklyMark(new Date('2026-10-12T05:00:00Z')).toISOString()).toBe('2026-10-05T06:00:00.000Z');
    expect(lastDailyMark(NOW).toISOString()).toBe('2026-10-14T05:00:00.000Z');
    expect(lastDailyMark(new Date('2026-10-14T04:00:00Z')).toISOString()).toBe('2026-10-13T05:00:00.000Z');
  });

  it('the full tick runs the core tick (auto-approvals) and the profit schedules, which enqueue each job once', async () => {
    t = await createTestStudio({ now: () => NOW });
    const p = await makeTestPersona(t, { state: 'PROPOSED' });
    const card = await propose(t.db, { studioId: t.studioId, personaId: p.id, kind: 'persona_launch', title: 'Launch', proposedBy: STUDIO_MANAGER, now: new Date(NOW.getTime() - 25 * HOUR) });
    const r = await studioTick(t.services, schedules, { now: NOW });
    expect(r.approved).toEqual([card.id]);
    expect(r.schedules.ran.sort()).toEqual(['profit.daily_measure', 'profit.weekly_cycle']);
    expect(r.errors).toEqual([]);
    const queued = async () => (await t!.db.query<{ kind: string }>(`SELECT kind FROM job ORDER BY kind`)).map((j) => j.kind);
    expect(await queued()).toEqual([PROFIT_JOBS.measure, PROFIT_JOBS.weeklyCycle]);
    // A minute later nothing is due; even if the schedule re-ran, the job isn't enqueued twice.
    const r2 = await studioTick(t.services, schedules, { now: new Date(NOW.getTime() + 60_000) });
    expect(r2.schedules.ran).toEqual([]);
    await schedules.find((s) => s.name === 'profit.weekly_cycle')!.run(t.services, NOW);
    expect(await queued()).toEqual([PROFIT_JOBS.measure, PROFIT_JOBS.weeklyCycle]);
  });
});

describe('worker', () => {
  it('runs profit jobs with a JobContext, skips kinds without a handler and honours DeferJob', async () => {
    t = await createTestStudio({ tools, now: () => NOW });
    const p = await makeTestPersona(t, { name: 'Winner', state: 'MONETISING' });
    await addWeeklyHistory(t.db, t.studioId, p.id, { weeks: 4, gross: 20_000, cost: 1_000 });
    let beat: boolean | null = null;
    const handlers = {
      ...jobs,
      'test.beat': async (ctx: Parameters<(typeof jobs)[string]>[0]) => {
        beat = await ctx.heartbeat();
        return { persona: ctx.job.persona_id };
      },
      'test.defer': async () => {
        throw new DeferJob(60_000, 'kill switch on');
      },
    };
    // The services' clock is fixed at NOW, so jobs are due from before it.
    const runAt = new Date(NOW.getTime() - HOUR);
    await enqueue(t.db, { kind: PROFIT_JOBS.weeklyCycle, studioId: t.studioId, payload: { studio_id: t.studioId, week_start: '2026-10-12' }, runAt });
    await enqueue(t.db, { kind: 'media.render', personaId: p.id, payload: {}, runAt });
    await enqueue(t.db, { kind: 'test.beat', personaId: p.id, runAt });
    await enqueue(t.db, { kind: 'test.defer', personaId: p.id, runAt });
    const w = createWorker({ services: t.services, handlers, workerId: 'test-worker' });
    const outcomes = await w.drain();
    expect(outcomes).toEqual(
      expect.arrayContaining([
        { kind: PROFIT_JOBS.weeklyCycle, outcome: 'succeeded' },
        { kind: 'test.beat', outcome: 'succeeded' },
        { kind: 'test.defer', outcome: 'deferred' },
      ]),
    );
    expect(beat).toBe(true);
    const jobsLeft = await t.db.query<{ kind: string; status: string; attempts: number }>(`SELECT kind, status, attempts FROM job ORDER BY kind`);
    expect(jobsLeft.find((j) => j.kind === 'media.render')).toMatchObject({ status: 'queued', attempts: 0 }); // waits for IOS-3
    expect(jobsLeft.find((j) => j.kind === 'test.defer')).toMatchObject({ status: 'queued', attempts: 0 });
    expect((await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM chat_message WHERE author = 'agent:profit-engine'`)).n).toBe(1);
  });

  it('starts and stops a polling loop', async () => {
    t = await createTestStudio({ now: () => NOW });
    let ran = 0;
    const w = createWorker({ services: t.services, handlers: { 'test.count': async () => void ran++ }, workerId: 'loop', idleMs: 10 });
    await enqueue(t.db, { kind: 'test.count', runAt: new Date(NOW.getTime() - HOUR) });
    w.start();
    expect(w.running).toBe(true);
    for (let i = 0; i < 50 && ran === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await w.stop();
    expect(ran).toBe(1);
    expect(w.running).toBe(false);
  });
});
