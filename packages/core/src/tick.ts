import type { Db } from '@ios/db';
import { sweepAutoApprovals } from './approvals';
import { reapStale } from './queue';

/** Jobs whose worker hasn't heartbeated for this long are reaped. */
export const STALE_JOB_MS = 15 * 60_000;

/**
 * The core part of a scheduler tick: auto-approve due cards and veto-window posts, then reap dead workers' jobs.
 * Each step runs on its own, so a failing sweep never stops the reaper (and vice versa). The full tick is
 * `studioTick` in @ios/profit (this, then every package's due schedules), called by /api/cron/tick (Vercel Cron),
 * the ticker in apps/web/instrumentation.ts and `pnpm worker`.
 */
export async function tick(db: Db, opts: { now?: Date } = {}): Promise<{ approved: string[]; reaped: number; errors: string[] }> {
  const errors: string[] = [];
  let approved: string[] = [];
  let reaped = 0;
  try {
    approved = await sweepAutoApprovals(db, opts);
  } catch (err) {
    errors.push(`sweep: ${(err as Error).message}`);
  }
  try {
    reaped = await reapStale(db, { timeoutMs: STALE_JOB_MS, now: opts.now });
  } catch (err) {
    errors.push(`reap: ${(err as Error).message}`);
  }
  return { approved, reaped, errors };
}
