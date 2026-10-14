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
  /** Fresh per claim. Every post-claim update matches on it, so only the current claim can finish the job. */
  lease_token: string | null;
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
     UPDATE job SET status = 'running', attempts = job.attempts + 1, locked_by = $2, locked_at = $1, updated_at = $1,
                    lease_token = gen_random_uuid()
       FROM next WHERE job.id = next.id
     RETURNING job.*`,
    [now, opts.workerId, opts.kinds ? [...opts.kinds] : null, opts.maxRunningPerPersona ?? 1],
  );
}

/**
 * Every state change after a claim is scoped to the lease: status running and this claim's own lease token (not
 * the worker id, which a restarted worker reuses). If the reaper took the job back and it was re-claimed (by any
 * worker, the same one included), the late result is discarded ('lost') instead of overwriting the new run.
 */
type Lease = Pick<JobRow, 'id' | 'lease_token'>;
const LEASE = `id = $1 AND status = 'running' AND lease_token = $2`;

/** Marks a claimed job done. Returns false when the lease was lost (the result is discarded). */
export async function completeJob(db: Db, job: Lease, result?: unknown): Promise<boolean> {
  const rows = await db.query(
    `UPDATE job SET status = 'succeeded', result = $3::jsonb, locked_by = NULL, lease_token = NULL, finished_at = now(), updated_at = now()
      WHERE ${LEASE} RETURNING id`,
    [job.id, job.lease_token, json(result ?? null)],
  );
  return rows.length > 0;
}

/** Long jobs (renders) call this so the reaper only takes jobs whose worker really died. */
export async function heartbeat(db: Db, job: Lease, now: Date = new Date()): Promise<boolean> {
  const rows = await db.query(`UPDATE job SET locked_at = $3, updated_at = $3 WHERE ${LEASE} RETURNING id`, [job.id, job.lease_token, now]);
  return rows.length > 0;
}

export async function failJob(
  db: Db,
  job: Pick<JobRow, 'id' | 'attempts' | 'max_attempts' | 'lease_token'>,
  error: unknown,
  opts: { now?: Date; policy?: RetryPolicy; random?: () => number } = {},
): Promise<'retry' | 'dead' | 'lost'> {
  const now = opts.now ?? new Date();
  const message = error instanceof Error ? error.message : String(error);
  if (job.attempts >= job.max_attempts) {
    const rows = await db.query(
      `UPDATE job SET status = 'dead', last_error = $3, locked_by = NULL, lease_token = NULL, finished_at = $4, updated_at = $4 WHERE ${LEASE} RETURNING id`,
      [job.id, job.lease_token, message, now],
    );
    return rows.length ? 'dead' : 'lost';
  }
  const runAt = new Date(now.getTime() + retryDelayMs(job.attempts, opts.policy, opts.random));
  const rows = await db.query(
    `UPDATE job SET status = 'queued', last_error = $3, run_at = $4, locked_by = NULL, locked_at = NULL, lease_token = NULL, updated_at = $5 WHERE ${LEASE} RETURNING id`,
    [job.id, job.lease_token, message, runAt, now],
  );
  return rows.length ? 'retry' : 'lost';
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

/**
 * Running jobs whose worker died (lock older than `timeoutMs`) go back to the queue with the same backoff as a
 * failure, or to `dead` once they have used all their attempts (a job that crashes its worker can't loop forever).
 * Returns how many jobs were reaped.
 */
export async function reapStale(db: Db, opts: { timeoutMs: number; now?: Date; policy?: RetryPolicy }): Promise<number> {
  const now = opts.now ?? new Date();
  const policy = opts.policy ?? DEFAULT_RETRY;
  const rows = await db.query(
    `UPDATE job SET
            status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
            run_at = CASE WHEN attempts >= max_attempts THEN run_at
                          ELSE $1::timestamptz + make_interval(secs => LEAST($3::float8, $4::float8 * power(2, LEAST(GREATEST(attempts, 1) - 1, 30)))) END,
            finished_at = CASE WHEN attempts >= max_attempts THEN $1 ELSE finished_at END,
            locked_by = NULL, locked_at = NULL, lease_token = NULL, last_error = 'lock expired (worker died or timed out)', updated_at = $1
      WHERE status = 'running' AND locked_at < $2 RETURNING id`,
    [now, new Date(now.getTime() - opts.timeoutMs), policy.capMs / 1000, policy.baseMs / 1000],
  );
  return rows.length;
}

export type JobHandler = (job: JobRow) => Promise<unknown>;

/** Claims and runs one job. Returns null when nothing is due. */
export async function runOnce(
  db: Db,
  handlers: Readonly<Record<string, JobHandler>>,
  opts: ClaimOptions & { policy?: RetryPolicy; random?: () => number },
): Promise<{ job: JobRow; outcome: 'succeeded' | 'retry' | 'dead' | 'deferred' | 'lost' } | null> {
  const job = await claimNext(db, { ...opts, kinds: opts.kinds ?? Object.keys(handlers) });
  if (!job) return null;
  const handler = handlers[job.kind];
  let result: unknown;
  try {
    if (!handler) throw new Error(`no handler for job kind ${job.kind}`);
    result = await handler(job);
  } catch (err) {
    if (err instanceof DeferJob) {
      const now = opts.now ?? new Date();
      const rows = await db.query(
        `UPDATE job SET status = 'queued', attempts = attempts - 1, last_error = $3, run_at = $4, locked_by = NULL, locked_at = NULL, lease_token = NULL, updated_at = now() WHERE ${LEASE} RETURNING id`,
        [job.id, job.lease_token, err.message, new Date(now.getTime() + err.delayMs)],
      );
      return { job, outcome: rows.length ? 'deferred' : 'lost' };
    }
    return { job, outcome: await failJob(db, job, err, opts) };
  }
  try {
    return { job, outcome: (await completeJob(db, job, result)) ? 'succeeded' : 'lost' };
  } catch (err) {
    return { job, outcome: await failJob(db, job, err, opts) };
  }
}
