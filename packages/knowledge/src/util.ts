import { BudgetExceededError, DeferJob, enqueue, type JobRow } from '@ios/core';
import type { Db } from '@ios/db';
import { EMBEDDING_DIM } from '@ios/providers';

/** pgvector literal for a 384-d embedding. */
export function toVector(v: readonly number[]): string {
  if (v.length !== EMBEDDING_DIM) throw new Error(`expected a ${EMBEDDING_DIM}-d embedding, got ${v.length}`);
  return `[${v.map((x) => (Number.isFinite(x) ? Number(x.toFixed(7)) : 0)).join(',')}]`;
}

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Trims a quote to at most `max` words (sources are summarised; quotes stay short). */
export function shortQuote(q: string | undefined | null, max = 25): string | undefined {
  if (!q) return undefined;
  const words = q.replace(/\s+/g, ' ').trim().split(' ');
  return words.length <= max ? words.join(' ') : `${words.slice(0, max).join(' ')}…`;
}

export function trimText(s: string | null | undefined, max: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** YYYY-MM-DD of `at` in `timeZone`. */
export function localDate(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Enqueues a job unless one with the same kind and dedupe key is already queued or running (schedules may run
 * twice; handlers stay idempotent anyway).
 */
export async function enqueueOnce(
  db: Db,
  job: { kind: string; key: string; payload: Record<string, unknown>; studioId?: string | null; personaId?: string | null; priority?: number; runAt?: Date; maxAttempts?: number },
): Promise<JobRow | null> {
  const open = await db.maybeOne(
    `SELECT 1 FROM job WHERE kind = $1 AND status IN ('queued','running') AND payload->>'dedupe' = $2 LIMIT 1`,
    [job.kind, job.key],
  );
  if (open) return null;
  return enqueue(db, {
    kind: job.kind,
    payload: { ...job.payload, dedupe: job.key },
    studioId: job.studioId ?? null,
    personaId: job.personaId ?? null,
    priority: job.priority,
    runAt: job.runAt,
    maxAttempts: job.maxAttempts,
  });
}

/** A capped governor refuses the work: postpone instead of burning retries (the governor already alerted). */
export function deferOnBudget(err: unknown, what: string): never {
  if (err instanceof BudgetExceededError) throw new DeferJob(6 * 3_600_000, `${what}: budget cap reached (${err.message})`);
  throw err;
}

/** Personas whose work continues (not killed or retired). */
export const ACTIVE_PERSONA_SQL = `state NOT IN ('KILLED','RETIRED','ARCHIVED')`;
