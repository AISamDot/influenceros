import { audit, type Actor, ForbiddenError, actorRef } from '@ios/core';
import { type Db, json } from '@ios/db';

/**
 * Profit Engine settings (stream D's own table, `profit_setting`). Every key has a code default, so a fresh
 * studio works without a row. Only the Owner changes them.
 */
export interface ProfitSettings {
  /** Price of one Higgsfield credit in cents (PRD Appendix E: ~$0.044 a credit). */
  creditPriceCents: number;
  /** Cadence lever: raise while net revenue per post ≥ raiseRatio × cost per post (PRD §3.11: ~3×). */
  raiseRatio: number;
  /** Cadence lever: trim below trimRatio × cost per post (PRD §3.11: ~1×). */
  trimRatio: number;
  /** Posts a persona needs in the lever window before cadence or format levers act on it. */
  minPostsForDecision: number;
  /** Days of history the cadence and routing levers look at. */
  leverWindowDays: number;
  /** Days of history the format-mix lever looks at (formats post less often, so a longer window). */
  formatWindowDays: number;
  /** Days after a lever action before its impact is measured. */
  reviewDays: number;
  /** Consecutive negative forecast weeks that make a persona a kill candidate (PRD: 4+). */
  killNegativeWeeks: number;
  /** Full weeks of history a persona needs before the Profit Engine may propose killing it. */
  minWeeksBeforeKill: number;
  /** After the Owner rejects a profit-engine kill proposal, wait this long before proposing again. */
  killCooldownDays: number;
  /** Monte Carlo runs per forecast. */
  forecastRuns: number;
  /** Weekly credit pool split (FR-14.2: 70/20/10): by profit per credit / exploration / studio reserve. */
  allocation: { exploit: number; explore: number; reserve: number };
  /** Routing lever: step a persona's scriptwriter down a tier when its Q1 pass rate is at least this. */
  routingPassRate: number;
  /** Routing lever: revert a step-down when the Q1 pass rate after it falls below this. */
  routingRevertRate: number;
}

export const DEFAULT_PROFIT_SETTINGS: ProfitSettings = {
  creditPriceCents: 4.4,
  raiseRatio: 3,
  trimRatio: 1,
  minPostsForDecision: 4,
  leverWindowDays: 28,
  formatWindowDays: 56,
  reviewDays: 14,
  killNegativeWeeks: 4,
  minWeeksBeforeKill: 3,
  killCooldownDays: 14,
  forecastRuns: 1000,
  allocation: { exploit: 0.7, explore: 0.2, reserve: 0.1 },
  routingPassRate: 0.9,
  routingRevertRate: 0.85,
};

function merge(v: Partial<ProfitSettings> | null | undefined): ProfitSettings {
  const s = v ?? {};
  const out: ProfitSettings = { ...DEFAULT_PROFIT_SETTINGS, ...s, allocation: { ...DEFAULT_PROFIT_SETTINGS.allocation, ...(s.allocation ?? {}) } };
  // Defensive: a bad row must never make a lever act outside its bounds.
  if (!(out.creditPriceCents >= 0)) out.creditPriceCents = DEFAULT_PROFIT_SETTINGS.creditPriceCents;
  if (!(out.raiseRatio > out.trimRatio)) {
    out.raiseRatio = DEFAULT_PROFIT_SETTINGS.raiseRatio;
    out.trimRatio = DEFAULT_PROFIT_SETTINGS.trimRatio;
  }
  if (!(out.killNegativeWeeks >= 4)) out.killNegativeWeeks = DEFAULT_PROFIT_SETTINGS.killNegativeWeeks;
  if (!(out.forecastRuns >= 100 && out.forecastRuns <= 20_000)) out.forecastRuns = DEFAULT_PROFIT_SETTINGS.forecastRuns;
  return out;
}

export async function getProfitSettings(db: Db, studioId: string): Promise<ProfitSettings> {
  const row = await db.maybeOne<{ settings: Partial<ProfitSettings> }>('SELECT settings FROM profit_setting WHERE studio_id = $1', [studioId]);
  return merge(row?.settings);
}

/** Owner only (dashboard / CLI). Agents never change the Profit Engine's thresholds. */
export async function updateProfitSettings(db: Db, studioId: string, patch: Partial<ProfitSettings>, actor: Actor): Promise<ProfitSettings> {
  if (actor.type !== 'owner') throw new ForbiddenError(`${actorRef(actor)} cannot change Profit Engine settings: only the Owner can`);
  const next = merge({ ...(await getProfitSettings(db, studioId)), ...patch });
  await db.query(
    `INSERT INTO profit_setting (studio_id, settings, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (studio_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()`,
    [studioId, json(next)],
  );
  await audit(db, { studioId, actor, action: 'profit.settings_updated', entityType: 'studio', entityId: studioId, data: { patch } });
  return next;
}
