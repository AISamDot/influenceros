import { createTestStudio, makeTestPersona, type TestStudio } from '@ios/agents/testing';
import { enqueue } from '@ios/core';
import { allJobs, allSchedules } from '@ios/wiring';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs, runCommand } from '../src/app';

let t: TestStudio | null = null;
afterEach(async () => {
  await t?.db.close();
  t = null;
});

describe('pnpm worker', () => {
  it('parses commands and switches', () => {
    expect(parseArgs([], {})).toEqual({ command: 'run', tick: true, concurrency: null });
    expect(parseArgs(['once', '--no-tick'], {})).toMatchObject({ command: 'once', tick: false });
    expect(parseArgs(['--concurrency', '3', 'run'], {})).toMatchObject({ command: 'run', concurrency: 3 });
    expect(parseArgs(['run'], { IOS_TICKER: 'off', IOS_WORKER_CONCURRENCY: '2' })).toMatchObject({ tick: false, concurrency: 2 });
    expect(parseArgs(['bogus'], {}).command).toBe('help');
  });

  it('`once` runs every due job with the composed handlers; `tick` runs the schedules; `status` reports', async () => {
    t = await createTestStudio();
    const p = await makeTestPersona(t, { state: 'MONETISING' });
    const lines: string[] = [];
    const deps = { services: t.services, handlers: allJobs(), schedules: allSchedules(), workerId: 'test', defaultConcurrency: 1, log: (l: string) => void lines.push(l) };

    const tick = await runCommand(parseArgs(['tick'], {}), deps);
    expect(tick.code).toBe(0);
    expect(lines.join('\n')).toMatch(/profit\.weekly_cycle/);

    // IOS-3: media.render has its handler now (renders end in publish.prepare); a kind without one just waits.
    const unhandled = 'publish.prepare';
    const handled = Object.keys(deps.handlers).includes(unhandled);
    if (!handled) await enqueue(t.db, { kind: unhandled, personaId: p.id }); // no handler until IOS-4 (stream F)
    const once = await runCommand(parseArgs(['once'], {}), deps);
    expect(once.code).toBe(0);
    const jobs = await t.db.query<{ kind: string; status: string }>('SELECT kind, status FROM job ORDER BY kind');
    // Other streams' schedules also enqueue work on the tick; every handled job must succeed.
    expect(jobs.filter((j) => (handled || j.kind !== unhandled) && j.status !== 'succeeded')).toEqual([]);
    expect(jobs.filter((j) => j.kind.startsWith('profit.'))).toEqual([
      { kind: 'profit.measure', status: 'succeeded' },
      { kind: 'profit.weekly_cycle', status: 'succeeded' },
    ]);
    const renders = jobs.filter((j) => j.kind === 'media.render');
    expect(renders.length).toBeGreaterThan(0);
    expect(renders.every((j) => j.status === 'succeeded')).toBe(true);
    if (!handled) expect(jobs.filter((j) => j.kind === unhandled).every((j) => j.status === 'queued')).toBe(true);
    // The weekly cycle posted its report into the Studio chat.
    expect((await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM chat_message WHERE author = 'agent:profit-engine'`)).n).toBe(1);

    lines.length = 0;
    await runCommand(parseArgs(['status'], {}), deps);
    expect(lines.join('\n')).toMatch(/media\.render\s+succeeded\s+\d+/);
    expect(lines.join('\n')).toMatch(/schedule profit\.weekly_cycle/);
  });
});
