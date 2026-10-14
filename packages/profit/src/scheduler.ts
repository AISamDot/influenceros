import type { ScheduledTask, StudioServices } from '@ios/agents';
import { enqueue, tick } from '@ios/core';
import { type Db, json } from '@ios/db';

/**
 * The scheduler behind the cron tick (docs/IOS-2-CONTRACTS.md §5.5). Every tick (Vercel Cron → /api/cron/tick each
 * minute, and the local ticker on the Mac) runs the core tick (auto-approvals, reaper) and then every due
 * ScheduledTask from every package. The last successful run of each task is kept in `scheduler_run`; a short claim
 * on the row stops two overlapping ticks from running the same task. A failing task is recorded and retried on a
 * later tick; it never stops the others.
 */

/** How long a claimed task may run before another tick may take it over. */
export const SCHEDULE_CLAIM_MS = 5 * 60_000;

export interface ScheduleRunResult {
  ran: string[];
  skipped: string[];
  errors: string[];
}

export async function runSchedules(services: StudioServices, schedules: readonly ScheduledTask[], now: Date = services.now()): Promise<ScheduleRunResult> {
  const { db } = services;
  const out: ScheduleRunResult = { ran: [], skipped: [], errors: [] };
  for (const s of [...schedules].sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      await db.query(`INSERT INTO scheduler_run (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [s.name]);
      const row = await db.one<{ last_run_at: Date | null }>('SELECT last_run_at FROM scheduler_run WHERE name = $1', [s.name]);
      const last = row.last_run_at ? new Date(row.last_run_at) : null;
      if (!s.due(now, last)) {
        out.skipped.push(s.name);
        continue;
      }
      const claimed = await db.maybeOne(
        `UPDATE scheduler_run SET claimed_until = $2, updated_at = now()
          WHERE name = $1 AND (claimed_until IS NULL OR claimed_until <= $3) AND last_run_at IS NOT DISTINCT FROM $4
          RETURNING name`,
        [s.name, new Date(now.getTime() + SCHEDULE_CLAIM_MS), now, last],
      );
      if (!claimed) {
        out.skipped.push(s.name); // another tick has it, or just ran it
        continue;
      }
      try {
        await s.run(services, now);
        await db.query(
          `UPDATE scheduler_run SET last_run_at = $2, last_status = 'ok', last_error = NULL, runs = runs + 1, claimed_until = NULL, updated_at = now() WHERE name = $1`,
          [s.name, now],
        );
        out.ran.push(s.name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db.query(
          `UPDATE scheduler_run SET last_status = 'error', last_error = $2, failures = failures + 1, claimed_until = NULL, updated_at = now() WHERE name = $1`,
          [s.name, message.slice(0, 500)],
        );
        out.errors.push(`${s.name}: ${message}`);
      }
    } catch (err) {
      out.errors.push(`${s.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

export interface StudioTickResult {
  approved: string[];
  reaped: number;
  schedules: ScheduleRunResult;
  errors: string[];
}

/** One full tick: the core tick (auto-approvals, reaper), then every due schedule. */
export async function studioTick(services: StudioServices, schedules: readonly ScheduledTask[], opts: { now?: Date } = {}): Promise<StudioTickResult> {
  const now = opts.now ?? services.now();
  const core = await tick(services.db, { now });
  const sched = await runSchedules(services, schedules, now);
  return { approved: core.approved, reaped: core.reaped, schedules: sched, errors: [...core.errors, ...sched.errors] };
}

export async function schedulerStatus(db: Db): Promise<Array<{ name: string; last_run_at: Date | null; last_status: string | null; last_error: string | null; runs: number; failures: number }>> {
  return db.query('SELECT name, last_run_at, last_status, last_error, runs, failures FROM scheduler_run ORDER BY name');
}

/**
 * Enqueues a job unless the same kind with a matching payload is already queued, running or done (schedules must
 * be idempotent: a tick that crashes after enqueueing may run the schedule again).
 */
export async function enqueueOnce(
  db: Db,
  job: { kind: string; payload: Record<string, unknown>; studioId?: string | null; personaId?: string | null; priority?: number },
): Promise<boolean> {
  const existing = await db.maybeOne(
    `SELECT 1 FROM job WHERE kind = $1 AND payload @> $2::jsonb AND status IN ('queued','running','succeeded') LIMIT 1`,
    [job.kind, json(job.payload)],
  );
  if (existing) return false;
  await enqueue(db, job);
  return true;
}
