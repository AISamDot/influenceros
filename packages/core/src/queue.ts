import { type Db, json } from '@ios/db';

/**
 * Postgres job queue. Claims use `SELECT … FOR UPDATE SKIP LOCKED`, so many workers can pull concurrently without
 * double-claiming. Failures retry with exponential backoff (full jitter) and go `dead` after max_attempts.
 * Per-persona isolation: at most `maxRunningPerPersona` jobs of one persona run at once, and a failing job only
 * delays itself, so one persona's failures never block the others.
 */
export interface JobRow {
  id: string;
  studio_id: string | null;
  persona_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'running' | 'succeeded' | 'dead';
  priority: number;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  locked_by: string | null;
  locked_at: Date | null;
  last_error: string | null;
  result: unknown;
}

export interface RetryPolicy {
  baseMs: number;
  capMs: number;
}
export const DEFAULT_RETRY: RetryPolicy = { baseMs: 30_000, capMs: 3_600_000 };

/** delay = min(cap, base · 2^(n−1)) · U(0.5, 1); `attempt` is the attempt that just failed (1-based). */
export function retryDelayMs(attempt: number, policy: RetryPolicy = DEFAULT_RETRY, random: () => number = Math.random): number {
  const n = Math.max(1, Math.trunc(attempt));
  const exp = Math.min(policy.capMs, policy.baseMs * 2 ** Math.min(n - 1, 30));
  return Math.round(exp * (0.5 + 0.5 * Math.min(1, Math.max(0, random()))));
}

export async function enqueue(
  db: Db,
  job: {
    kind: string;
    payload?: Record<string, unknown>;
    studioId?: string | null;
    personaId?: string | null;
    priority?: number;
    runAt?: Date;
    maxAttempts?: number;
  },
): Promise<JobRow> {
  return db.one<JobRow>(
    `INSERT INTO job (studio_id, persona_id, kind, payload, priority, run_at, max_attempts)
     VALUES ($1, $2, $3, $4::jsonb, $5, COALESCE($6, now()), $7) RETURNING *`,
    [job.studioId ?? null, job.personaId ?? null, job.kind, json(job.payload ?? {}), job.priority ?? 100, job.runAt ?? null, job.maxAttempts ?? 5],
  );
}

export interface ClaimOptions {
  workerId: string;
  kinds?: readonly string[];
  now?: Date;
  maxRunningPerPersona?: number;
}

export async function claimNext(db: Db, opts: ClaimOptions): Promise<JobRow | null> {
  const now = opts.now ?? new Date();
  return db.maybeOne<JobRow>(
    `WITH next AS (
       SELECT j.id FROM job j
        WHERE j.status = 'queued' AND j.run_at <= $1
          AND ($3::text[] IS NULL OR j.kind = ANY($3::text[]))
          AND (j.persona_id IS NULL OR
               (SELECT count(*) FROM job r WHERE r.persona_id = j.persona_id AND r.status = 'running') < $4)
        ORDER BY j.priority, j.run_at, j.created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE job SET status = 'running', attempts = job.attempts + 1, locked_by = $2, locked_at = $1, updated_at = $1
       FROM next WHERE job.id = next.id
     RETURNING job.*`,
    [now, opts.workerId, opts.kinds ? [...opts.kinds] : null, opts.maxRunningPerPersona ?? 1],
  );
}

export async function completeJob(db: Db, jobId: string, result?: unknown): Promise<void> {
  await db.query(
    `UPDATE job SET status = 'succeeded', result = $2::jsonb, locked_by = NULL, finished_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'running'`,
    [jobId, json(result ?? null)],
  );
}

export async function failJob(
  db: Db,
  job: Pick<JobRow, 'id' | 'attempts' | 'max_attempts'>,
  error: unknown,
  opts: { now?: Date; policy?: RetryPolicy; random?: () => number } = {},
): Promise<'retry' | 'dead'> {
  const now = opts.now ?? new Date();
  const message = error instanceof Error ? error.message : String(error);
  if (job.attempts >= job.max_attempts) {
    await db.query(
      `UPDATE job SET status = 'dead', last_error = $2, locked_by = NULL, finished_at = $3, updated_at = $3 WHERE id = $1`,
      [job.id, message, now],
    );
    return 'dead';
  }
  const runAt = new Date(now.getTime() + retryDelayMs(job.attempts, opts.policy, opts.random));
  await db.query(
    `UPDATE job SET status = 'queued', last_error = $2, run_at = $3, locked_by = NULL, locked_at = NULL, updated_at = $4 WHERE id = $1`,
    [job.id, message, runAt, now],
  );
  return 'retry';
}

/** Thrown by a handler to postpone a job without spending an attempt (e.g. a kill switch is on). */
export class DeferJob extends Error {
  override readonly name = 'DeferJob';
  constructor(
    readonly delayMs: number,
    reason: string,
  ) {
    super(reason);
  }
}

/** Running jobs whose worker died (lock older than `timeoutMs`) go back to the queue. */
export async function reapStale(db: Db, opts: { timeoutMs: number; now?: Date }): Promise<number> {
  const now = opts.now ?? new Date();
  const rows = await db.query(
    `UPDATE job SET status = 'queued', locked_by = NULL, locked_at = NULL, last_error = 'lock expired', updated_at = $1
      WHERE status = 'running' AND locked_at < $2 RETURNING id`,
    [now, new Date(now.getTime() - opts.timeoutMs)],
  );
  return rows.length;
}

export type JobHandler = (job: JobRow) => Promise<unknown>;

/** Claims and runs one job. Returns null when nothing is due. */
export async function runOnce(
  db: Db,
  handlers: Readonly<Record<string, JobHandler>>,
  opts: ClaimOptions & { policy?: RetryPolicy; random?: () => number },
): Promise<{ job: JobRow; outcome: 'succeeded' | 'retry' | 'dead' | 'deferred' } | null> {
  const job = await claimNext(db, { ...opts, kinds: opts.kinds ?? Object.keys(handlers) });
  if (!job) return null;
  const handler = handlers[job.kind];
  try {
    if (!handler) throw new Error(`no handler for job kind ${job.kind}`);
    await completeJob(db, job.id, await handler(job));
    return { job, outcome: 'succeeded' };
  } catch (err) {
    if (err instanceof DeferJob) {
      const now = opts.now ?? new Date();
      await db.query(
        `UPDATE job SET status = 'queued', attempts = attempts - 1, last_error = $2, run_at = $3, locked_by = NULL, locked_at = NULL, updated_at = now() WHERE id = $1`,
        [job.id, err.message, new Date(now.getTime() + err.delayMs)],
      );
      return { job, outcome: 'deferred' };
    }
    return { job, outcome: await failJob(db, job, err, opts) };
  }
}
