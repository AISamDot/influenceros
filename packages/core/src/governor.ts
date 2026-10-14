import { type Db, json } from '@ios/db';
import { audit } from './audit';
import { BudgetExceededError } from './errors';
import { notify } from './notifications';
import { getSettings, personaCaps } from './settings';
import { type Caps, type PersonaRow, SYSTEM } from './types';

/**
 * Cost governor and credit ledger (PRD §8.4, §8.5, FR-5.3). Monthly caps per persona and per studio for LLM USD
 * and Higgsfield credits. Alert at 80%, refuse at 100%. Every metered provider call is debited.
 * Headroom = cap + Owner-approved grants (spend_over_cap) − debits − open holds.
 * A paid call first reserves its estimate as a hold (under the same lock as debits, refused past a cap), then the
 * hold is settled to the actual cost, or released if the call fails. Concurrent calls can't all squeeze in.
 */
export type Unit = 'llm_usd' | 'hf_credits' | 'media_usd';
export const UNITS: readonly Unit[] = ['llm_usd', 'hf_credits', 'media_usd'];

export const creditPeriod = (d: Date): string => d.toISOString().slice(0, 7);

export function capFor(unit: Unit, caps: Caps): number | null {
  if (unit === 'llm_usd') return caps.llm_usd_month;
  if (unit === 'hf_credits') return caps.hf_credits_month;
  return null; // media_usd (fal, ElevenLabs) is tracked, not capped, in IOS-1
}

export interface ScopeUsage {
  used: number;
  grants: number;
  cap: number | null;
  /** cap + grants, or null when uncapped. */
  limit: number | null;
  ratio: number;
}

export interface BudgetStatus {
  unit: Unit;
  period: string;
  persona: ScopeUsage | null;
  studio: ScopeUsage;
  level: 'ok' | 'warn' | 'blocked';
}

async function sums(db: Db, where: string, params: unknown[]): Promise<{ used: number; grants: number }> {
  const r = await db.one<{ used: number; grants: number }>(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE entry_type IN ('debit','hold')), 0) AS used,
            COALESCE(SUM(amount) FILTER (WHERE entry_type = 'grant'), 0) AS grants
       FROM credit_ledger WHERE ${where}`,
    params,
  );
  return { used: Number(r.used), grants: Number(r.grants) };
}

function scope(used: number, grants: number, cap: number | null): ScopeUsage {
  const limit = cap === null ? null : cap + grants;
  return { used, grants, cap, limit, ratio: limit === null ? 0 : limit <= 0 ? (used > 0 ? Infinity : 1) : used / limit };
}

export async function budgetStatus(
  db: Db,
  input: { studioId: string; personaId?: string | null; unit: Unit; now?: Date },
): Promise<BudgetStatus> {
  const settings = await getSettings(db, input.studioId);
  const period = creditPeriod(input.now ?? new Date());
  const st = await sums(db, `studio_id = $1 AND period = $2 AND unit = $3 AND (entry_type IN ('debit','hold') OR persona_id IS NULL)`, [
    input.studioId,
    period,
    input.unit,
  ]);
  const studio = scope(st.used, st.grants, capFor(input.unit, settings.caps));
  let persona: ScopeUsage | null = null;
  if (input.personaId) {
    const p = await db.one<Pick<PersonaRow, 'budget'>>('SELECT budget FROM persona WHERE id = $1', [input.personaId]);
    const ps = await sums(db, 'persona_id = $1 AND period = $2 AND unit = $3', [input.personaId, period, input.unit]);
    persona = scope(ps.used, ps.grants, capFor(input.unit, personaCaps(p, settings)));
  }
  const maxRatio = Math.max(studio.ratio, persona?.ratio ?? 0);
  const level = maxRatio >= 1 ? 'blocked' : maxRatio >= settings.alert_threshold ? 'warn' : 'ok';
  return { unit: input.unit, period, persona, studio, level };
}

/** Would spending `amount` stay within every cap? (Refuse at 100%.) */
export async function checkBudget(
  db: Db,
  input: { studioId: string; personaId?: string | null; unit: Unit; amount: number; now?: Date },
): Promise<{ allowed: boolean; status: BudgetStatus; reason?: string }> {
  const status = await budgetStatus(db, input);
  for (const [name, s] of [['persona', status.persona], ['studio', status.studio]] as const) {
    if (s && s.limit !== null && s.used + input.amount > s.limit + 1e-9) {
      return {
        allowed: false,
        status,
        reason: `${name} ${input.unit} cap reached: ${round(s.used)} used of ${round(s.limit)}, ${round(input.amount)} requested`,
      };
    }
  }
  return { allowed: true, status };
}

const round = (n: number) => Math.round(n * 10000) / 10000;

export interface DebitInput {
  studioId: string;
  personaId?: string | null;
  unit: Unit;
  amount: number;
  provider?: string;
  operation?: string;
  refType?: string;
  refId?: string;
  meta?: Record<string, unknown>;
  now?: Date;
  /** false = record a cost already incurred, even past the cap (the pre-check enforced it). */
  enforce?: boolean;
}

/**
 * Debits the ledger. With `enforce` (default) it refuses when the debit would pass a cap. Crossing the alert
 * threshold writes an audit entry and a notification once (on the debit that crosses it).
 */
export async function debit(db: Db, input: DebitInput): Promise<BudgetStatus> {
  return (await writeLedger(db, input, 'debit')).status;
}

const ledgerLock = (tx: Db, studioId: string, unit: Unit, period: string) =>
  tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${studioId}:${unit}:${period}`]);

async function writeLedger(db: Db, input: DebitInput, entryType: 'debit' | 'hold'): Promise<{ status: BudgetStatus; id: string }> {
  const now = input.now ?? new Date();
  const period = creditPeriod(now);
  try {
    return await db.transaction(async (tx) => {
      // Serialise debits and holds per studio/unit/month so two workers can't both squeeze under the cap.
      await ledgerLock(tx, input.studioId, input.unit, period);
      const before = await checkBudget(tx, { ...input, now });
      if (input.enforce !== false && !before.allowed) {
        const s = before.status.persona && before.status.persona.limit !== null && before.status.persona.used + input.amount > before.status.persona.limit ? before.status.persona : before.status.studio;
        throw new BudgetExceededError(before.reason ?? 'cap reached', {
          scope: s === before.status.persona ? 'persona' : 'studio',
          unit: input.unit,
          used: s.used,
          cap: s.limit ?? 0,
          requested: input.amount,
        });
      }
      const row = await tx.one<{ id: string }>(
        `INSERT INTO credit_ledger (studio_id, persona_id, unit, entry_type, amount, period, provider, operation, ref_type, ref_id, meta, created_at)
         VALUES ($1, $2, $3, $12, $4, $5, $6, $7, $8, $9, $10::jsonb, $11) RETURNING id`,
        [
          input.studioId,
          input.personaId ?? null,
          input.unit,
          input.amount,
          period,
          input.provider ?? null,
          input.operation ?? null,
          input.refType ?? null,
          input.refId ?? null,
          json(input.meta ?? {}),
          now,
          entryType,
        ],
      );
      const after = await budgetStatus(tx, { ...input, now });
      // Alerts fire on real spend only; a hold is settled into a debit (which alerts) or released.
      if (entryType === 'hold') return { status: after, id: row.id };
      const settings = await getSettings(tx, input.studioId);
      for (const [name, b, a] of [
        ['persona', before.status.persona, after.persona],
        ['studio', before.status.studio, after.studio],
      ] as const) {
        if (!b || !a || a.limit === null) continue;
        const crossed = (t: number) => b.ratio < t && a.ratio >= t;
        const hit100 = crossed(1);
        if (hit100 || crossed(settings.alert_threshold)) {
          const pct = hit100 ? 100 : Math.round(settings.alert_threshold * 100);
          const who =
            name === 'persona' && input.personaId
              ? ((await tx.maybeOne<{ name: string }>('SELECT name FROM persona WHERE id = $1', [input.personaId]))?.name ?? 'Persona')
              : 'Studio';
          await audit(tx, {
            studioId: input.studioId,
            personaId: input.personaId,
            actor: SYSTEM,
            action: hit100 ? 'budget.cap_reached' : 'budget.alert',
            entityType: 'budget',
            entityId: `${name}:${input.unit}:${period}`,
            data: { used: a.used, limit: a.limit, pct },
          });
          await notify(tx, {
            studioId: input.studioId,
            personaId: name === 'persona' ? input.personaId : null,
            kind: 'budget',
            severity: hit100 ? 'critical' : 'warn',
            title: `${who}: ${input.unit === 'llm_usd' ? 'LLM spend' : input.unit === 'hf_credits' ? 'Higgsfield credits' : input.unit} at ${pct}%`,
            body: `${round(a.used)} of ${round(a.limit)} used this month.${hit100 ? ' New work is refused until the Owner approves more.' : ''}`,
            link: '/money',
          });
        }
      }
      return { status: after, id: row.id };
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      await audit(db, {
        studioId: input.studioId,
        personaId: input.personaId,
        actor: SYSTEM,
        action: 'budget.refused',
        entityType: 'budget',
        entityId: `${err.details.scope}:${input.unit}:${period}`,
        data: { ...err.details, operation: input.operation ?? null, provider: input.provider ?? null },
      });
    }
    throw err;
  }
}

/** Refuses up front (estimate) so no paid call starts past a cap. Throws BudgetExceededError. */
export async function assertBudget(
  db: Db,
  input: { studioId: string; personaId?: string | null; unit: Unit; amount: number; operation?: string; now?: Date },
): Promise<void> {
  const r = await checkBudget(db, input);
  if (r.allowed) return;
  const s = r.status.persona && r.status.persona.limit !== null && r.status.persona.used + input.amount > r.status.persona.limit ? r.status.persona : r.status.studio;
  await audit(db, {
    studioId: input.studioId,
    personaId: input.personaId,
    actor: SYSTEM,
    action: 'budget.refused',
    entityType: 'budget',
    entityId: `${s === r.status.persona ? 'persona' : 'studio'}:${input.unit}:${r.status.period}`,
    data: { used: s.used, limit: s.limit, requested: input.amount, operation: input.operation ?? null },
  });
  throw new BudgetExceededError(r.reason ?? 'cap reached', {
    scope: s === r.status.persona ? 'persona' : 'studio',
    unit: input.unit,
    used: s.used,
    cap: s.limit ?? 0,
    requested: input.amount,
  });
}

/** Reserves `amount` before a paid call (refused past a cap, like an enforced debit). Returns the hold id. */
export async function reserve(db: Db, input: Omit<DebitInput, 'enforce'>): Promise<string> {
  return (await writeLedger(db, { ...input, enforce: true }, 'hold')).id;
}

/** Replaces a hold with the actual cost (recorded even past the cap: it was incurred). */
export async function settleHold(db: Db, holdId: string, input: Omit<DebitInput, 'enforce' | 'now'>): Promise<BudgetStatus> {
  return db.transaction(async (tx) => {
    const hold = await tx.maybeOne<{ period: string; created_at: Date }>(
      `SELECT period, created_at FROM credit_ledger WHERE id = $1 AND entry_type = 'hold'`,
      [holdId],
    );
    if (hold) {
      await ledgerLock(tx, input.studioId, input.unit, hold.period);
      await tx.query(`DELETE FROM credit_ledger WHERE id = $1 AND entry_type = 'hold'`, [holdId]);
    }
    // Same month as the reservation, so a call that straddles midnight on the 1st debits the month it reserved.
    return debit(tx, { ...input, now: hold ? new Date(hold.created_at) : undefined, enforce: false });
  });
}

/** Drops a hold (the paid call failed, so nothing was spent). */
export async function releaseHold(db: Db, holdId: string): Promise<void> {
  await db.query(`DELETE FROM credit_ledger WHERE id = $1 AND entry_type = 'hold'`, [holdId]);
}

/** Longer than any paid call runs: a hold older than this belongs to a process that died mid-call. */
export const ORPHAN_HOLD_MS = 30 * 60_000;

/**
 * Deletes holds orphaned by a process that died between reserve and settle/release (worker restart, function
 * timeout, dev reload), so they stop counting against the month's headroom. Each one is audited; the actual cost
 * of the interrupted call is unknown, so nothing is debited. Returns how many were removed.
 */
export async function reapOrphanHolds(db: Db, opts: { now?: Date; maxAgeMs?: number } = {}): Promise<number> {
  const before = new Date((opts.now ?? new Date()).getTime() - (opts.maxAgeMs ?? ORPHAN_HOLD_MS));
  const rows = await db.query<{ id: string; studio_id: string; persona_id: string | null; unit: string; amount: number; operation: string | null; created_at: Date }>(
    `DELETE FROM credit_ledger WHERE entry_type = 'hold' AND created_at < $1
     RETURNING id, studio_id, persona_id, unit, amount, operation, created_at`,
    [before],
  );
  for (const r of rows) {
    await audit(db, {
      studioId: r.studio_id,
      personaId: r.persona_id,
      actor: SYSTEM,
      action: 'budget.hold_reaped',
      entityType: 'credit_ledger',
      entityId: r.id,
      data: { unit: r.unit, amount: r.amount, operation: r.operation, held_since: new Date(r.created_at).toISOString() },
    });
  }
  return rows.length;
}
