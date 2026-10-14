import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimNext, completeJob, DeferJob, enqueue, failJob, heartbeat, type JobRow, reapStale, retryDelayMs, runOnce } from '../src';
import { type Ctx, makePersona, setup } from './helpers';

let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => ctx.db.close());

const job = (id: string) => ctx.db.one<JobRow>('SELECT * FROM job WHERE id = $1', [id]);

describe('Postgres job queue', () => {
  it('concurrent claims never hand the same job to two workers (FOR UPDATE SKIP LOCKED)', async () => {
    const personas = await Promise.all([1, 2, 3, 4, 5].map(() => makePersona(ctx)));
    for (const personaId of personas) await enqueue(ctx.db, { kind: 'render', personaId, studioId: ctx.studioId });
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => claimNext(ctx.db, { workerId: `w${i}` })));
    const got = claims.filter((c): c is JobRow => c !== null);
    expect(got).toHaveLength(5);
    expect(new Set(got.map((j) => j.id)).size).toBe(5);
    expect(got.every((j) => j.status === 'running' && j.attempts === 1)).toBe(true);
    expect(await claimNext(ctx.db, { workerId: 'late' })).toBeNull();
    expect(await completeJob(ctx.db, got[0]!, { ok: true })).toBe(true);
    expect((await job(got[0]!.id)).status).toBe('succeeded');
  });

  it('retries failures with exponential backoff, then marks the job dead', async () => {
    const t0 = new Date('2026-10-14T10:00:00Z');
    const j = await enqueue(ctx.db, { kind: 'flaky', maxAttempts: 3, runAt: t0 });
    const handlers = { flaky: async () => { throw new Error('upstream 503'); } };
    const opts = { workerId: 'w', random: () => 1 }; // deterministic: full delay

    let now = t0;
    const r1 = await runOnce(ctx.db, handlers, { ...opts, now });
    expect(r1?.outcome).toBe('retry');
    let row = await job(j.id);
    expect(row.run_at.getTime() - now.getTime()).toBe(retryDelayMs(1, undefined, () => 1)); // 30 s
    expect(row.last_error).toBe('upstream 503');

    // Not due yet → nothing claimed.
    expect(await runOnce(ctx.db, handlers, { ...opts, now: new Date(now.getTime() + 1000) })).toBeNull();

    now = row.run_at;
    expect((await runOnce(ctx.db, handlers, { ...opts, now }))?.outcome).toBe('retry');
    row = await job(j.id);
    expect(row.run_at.getTime() - now.getTime()).toBe(60_000); // doubled

    now = row.run_at;
    expect((await runOnce(ctx.db, handlers, { ...opts, now }))?.outcome).toBe('dead');
    row = await job(j.id);
    expect(row).toMatchObject({ status: 'dead', attempts: 3 });
    expect(retryDelayMs(30, undefined, () => 1)).toBe(3_600_000); // capped at 1 h
  });

  it("isolates personas: one persona's failing or slow jobs never block another's", async () => {
    const a = await makePersona(ctx, { name: 'A' });
    const b = await makePersona(ctx, { name: 'B' });
    const now = new Date();
    // A's jobs are first in line (higher priority) and always fail.
    for (let i = 0; i < 3; i++) await enqueue(ctx.db, { kind: 'publish', personaId: a, priority: 1, payload: { who: 'A' }, runAt: new Date(now.getTime() - 1000) });
    for (let i = 0; i < 3; i++) await enqueue(ctx.db, { kind: 'publish', personaId: b, priority: 50, payload: { who: 'B' }, runAt: new Date(now.getTime() - 1000) });
    const done: string[] = [];
    const handlers = {
      publish: async (j: JobRow) => {
        if (j.payload.who === 'A') throw new Error('A account rate-limited');
        done.push(String(j.payload.who));
      },
    };
    for (let i = 0; i < 6; i++) await runOnce(ctx.db, handlers, { workerId: 'w', now, random: () => 1 });
    expect(done).toEqual(['B', 'B', 'B']);

    // A slow (running) job caps that persona at one in flight; others are still claimed.
    const c = await makePersona(ctx, { name: 'C' });
    await enqueue(ctx.db, { kind: 'render', personaId: c, priority: 1 });
    await enqueue(ctx.db, { kind: 'render', personaId: c, priority: 1 });
    await enqueue(ctx.db, { kind: 'render', personaId: b, priority: 90 });
    const first = await claimNext(ctx.db, { workerId: 'w1', kinds: ['render'] });
    const second = await claimNext(ctx.db, { workerId: 'w2', kinds: ['render'] });
    expect(first?.persona_id).toBe(c);
    expect(second?.persona_id).toBe(b);
  });

  it('deferred jobs keep their attempts; stale locks are reaped', async () => {
    const j = await enqueue(ctx.db, { kind: 'publish' });
    const now = new Date();
    const r = await runOnce(ctx.db, { publish: async () => { throw new DeferJob(15 * 60_000, 'kill switch on'); } }, { workerId: 'w', now });
    expect(r?.outcome).toBe('deferred');
    expect(await job(j.id)).toMatchObject({ status: 'queued', attempts: 0, last_error: 'kill switch on' });

    const k = await enqueue(ctx.db, { kind: 'render', runAt: new Date(now.getTime() - 30 * 60_000) });
    await claimNext(ctx.db, { workerId: 'dies', kinds: ['render'], now: new Date(now.getTime() - 20 * 60_000) });
    expect(await reapStale(ctx.db, { timeoutMs: 10 * 60_000, now })).toBe(1);
    expect((await job(k.id)).status).toBe('queued');
  });

  it("a worker that lost its lease can't overwrite the new run (reap → re-claim → complete → stale fail)", async () => {
    const t0 = new Date('2026-10-14T10:00:00Z');
    const j = await enqueue(ctx.db, { kind: 'render', runAt: t0 });
    const a = (await claimNext(ctx.db, { workerId: 'A', now: t0 }))!;
    // A is slow; the reaper takes the job back and B runs it to completion.
    const later = new Date(t0.getTime() + 20 * 60_000);
    expect(await reapStale(ctx.db, { timeoutMs: 15 * 60_000, now: later })).toBe(1);
    const due = (await job(j.id)).run_at;
    const b = (await claimNext(ctx.db, { workerId: 'B', now: due }))!;
    expect(b.id).toBe(j.id);
    expect(await heartbeat(ctx.db, a)).toBe(false); // A's lease is gone
    expect(await heartbeat(ctx.db, b)).toBe(true);
    expect(await completeJob(ctx.db, b, { by: 'B' })).toBe(true);

    // A's late failure (or late success) is discarded instead of re-queueing a finished job.
    expect(await failJob(ctx.db, a, new Error('A timed out'))).toBe('lost');
    expect(await completeJob(ctx.db, a, { by: 'A' })).toBe(false);
    expect(await job(j.id)).toMatchObject({ status: 'succeeded', result: { by: 'B' } });
  });

  it('the lease is the claim, not the worker id: a restarted worker with the same id cannot finish a stale claim', async () => {
    const t0 = new Date('2026-10-14T10:00:00Z');
    const j = await enqueue(ctx.db, { kind: 'render', runAt: t0 });
    const first = (await claimNext(ctx.db, { workerId: 'mac-1', now: t0 }))!;
    expect(first.lease_token).toMatch(/^[0-9a-f-]{36}$/);
    // The worker hangs; the reaper takes the job back; the same worker id (after a restart) claims it again.
    const later = new Date(t0.getTime() + 20 * 60_000);
    expect(await reapStale(ctx.db, { timeoutMs: 15 * 60_000, now: later })).toBe(1);
    const second = (await claimNext(ctx.db, { workerId: 'mac-1', now: (await job(j.id)).run_at }))!;
    expect(second.locked_by).toBe(first.locked_by);
    expect(second.lease_token).not.toBe(first.lease_token);

    // The stale run's heartbeat, completion, failure and deferral are all refused.
    expect(await heartbeat(ctx.db, first)).toBe(false);
    expect(await completeJob(ctx.db, first, { by: 'stale' })).toBe(false);
    expect(await failJob(ctx.db, first, new Error('stale'))).toBe('lost');
    expect(await job(j.id)).toMatchObject({ status: 'running', lease_token: second.lease_token });

    expect(await heartbeat(ctx.db, second)).toBe(true);
    expect(await completeJob(ctx.db, second, { by: 'fresh' })).toBe(true);
    expect(await job(j.id)).toMatchObject({ status: 'succeeded', result: { by: 'fresh' }, lease_token: null });
  });

  it('the reaper backs off and dead-letters a job that keeps crashing its worker', async () => {
    let now = new Date('2026-10-14T10:00:00Z');
    const j = await enqueue(ctx.db, { kind: 'render', maxAttempts: 3, runAt: now });
    const policy = { baseMs: 30_000, capMs: 3_600_000 };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claimed = await claimNext(ctx.db, { workerId: `crash-${attempt}`, now });
      expect(claimed?.attempts).toBe(attempt);
      now = new Date(now.getTime() + 20 * 60_000); // the worker died; its lock expires
      expect(await reapStale(ctx.db, { timeoutMs: 15 * 60_000, now, policy })).toBe(1);
      const row = await job(j.id);
      if (attempt < 3) {
        expect(row.status).toBe('queued');
        // Same backoff as a failure, not an immediate re-claim.
        expect(row.run_at.getTime() - now.getTime()).toBe(policy.baseMs * 2 ** (attempt - 1));
        expect(await claimNext(ctx.db, { workerId: 'eager', now })).toBeNull();
        now = row.run_at;
      } else {
        expect(row).toMatchObject({ status: 'dead', attempts: 3 });
      }
    }
    expect(await claimNext(ctx.db, { workerId: 'w', now: new Date(now.getTime() + 24 * 3_600_000) })).toBeNull();
  });
});
