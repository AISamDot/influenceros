import { type AgentName, baseCadence, CADENCE_BOUNDS, type CadencePolicy, type CadenceTarget, DEFAULT_CADENCE, type FormatMix, type RoutingPolicy, type ServiceBase } from '@ios/agents';
import type { PersonaState } from '@ios/core';
import { type CoreFormat, type PostFormat, type PostPurpose, POST_FORMATS } from '@ios/core';
import type { Db } from '@ios/db';
import type { ModelTier } from '@ios/providers';
import { apportion, isoDate, sum } from './util';

/**
 * The policies other streams read (docs/IOS-2-CONTRACTS.md §5.4): stream B's calendar asks the CadencePolicy for
 * a persona's weekly target; stream A's runtime asks the RoutingPolicy for a tier override before DEFAULT_ROUTING.
 * Both read the overrides the Profit Engine's levers write, and fall back to the defaults.
 */

export const FORMATS: readonly CoreFormat[] = ['talking', 'activity_text', 'voiceover', 'static', 'carousel'];
export const PURPOSES: readonly PostPurpose[] = ['reach', 'trust', 'sell'];

/**
 * Format-mix bounds: every core format keeps at least one slot; no format takes more than half the week. Optional
 * formats (IOS-5) may go to 0 (off); stream L tunes their bounds from the Format Plan.
 */
export function formatBounds(postsPerWeek: number): { min: Partial<Record<PostFormat, number>>; max: Partial<Record<PostFormat, number>> } {
  const max = Math.ceil(postsPerWeek / 2);
  return {
    min: Object.fromEntries(POST_FORMATS.map((f) => [f, (FORMATS as readonly PostFormat[]).includes(f) ? 1 : 0])) as Partial<Record<PostFormat, number>>,
    max: Object.fromEntries(POST_FORMATS.map((f) => [f, max])) as Partial<Record<PostFormat, number>>,
  };
}

/** Purpose bounds: at least one sell and one trust post; reach stays the majority-ish default share. */
export const PURPOSE_MIN: Readonly<Record<PostPurpose, number>> = { reach: 1, trust: 1, sell: 1 };

/** Rescales a target to `postsPerWeek` (clamped to CADENCE_BOUNDS), keeping the mix proportions within bounds. */
export function scaleTarget(current: CadenceTarget, postsPerWeek: number, source: CadenceTarget['source'], reason?: string): CadenceTarget {
  const n = Math.min(CADENCE_BOUNDS.max, Math.max(CADENCE_BOUNDS.min, Math.round(postsPerWeek)));
  return {
    postsPerWeek: n,
    formatMix: apportion(n, current.formatMix as Readonly<Record<string, number>>, formatBounds(n)) as FormatMix,
    purposeMix: apportion(n, current.purposeMix, { min: PURPOSE_MIN }),
    source,
    ...(reason ? { reason } : {}),
  };
}

/** True when a target is internally consistent and inside the bounds. */
export function validTarget(t: CadenceTarget): boolean {
  return (
    Number.isInteger(t.postsPerWeek) &&
    t.postsPerWeek >= CADENCE_BOUNDS.min &&
    t.postsPerWeek <= CADENCE_BOUNDS.max &&
    FORMATS.every((f) => Number.isInteger(t.formatMix[f]) && t.formatMix[f] >= 0) &&
    Object.values(t.formatMix).every((v) => Number.isInteger(v) && (v ?? 0) >= 0) &&
    PURPOSES.every((p) => Number.isInteger(t.purposeMix[p]) && t.purposeMix[p] >= 0) &&
    sum(Object.values(t.formatMix).map((v) => v ?? 0)) === t.postsPerWeek &&
    sum(PURPOSES.map((p) => t.purposeMix[p])) === t.postsPerWeek
  );
}

interface OverrideRow {
  posts_per_week: number;
  format_mix: Record<PostFormat, number>;
  purpose_mix: Record<PostPurpose, number>;
  source: 'lever' | 'owner';
  reason: string | null;
}

/**
 * The target in force for the week starting `weekStart`: the latest override effective by then, else the base cadence
 * for the persona's state (WINNER_CADENCE for SCALING / BRAND, DEFAULT_CADENCE otherwise), so the levers and the
 * calendar share one starting point.
 */
export async function cadenceTarget(db: Db, personaId: string, weekStart: Date): Promise<CadenceTarget> {
  const row = await db.maybeOne<OverrideRow>(
    `SELECT posts_per_week, format_mix, purpose_mix, source, reason FROM profit_cadence_override
      WHERE persona_id = $1 AND effective_from <= $2::date ORDER BY effective_from DESC, seq DESC LIMIT 1`,
    [personaId, isoDate(weekStart)],
  );
  if (!row) {
    const p = await db.maybeOne<{ state: PersonaState }>('SELECT state FROM persona WHERE id = $1', [personaId]);
    return baseCadence(p?.state);
  }
  const t: CadenceTarget = {
    postsPerWeek: row.posts_per_week,
    formatMix: { ...DEFAULT_CADENCE.formatMix, ...row.format_mix },
    purposeMix: { ...DEFAULT_CADENCE.purposeMix, ...row.purpose_mix },
    source: row.source,
    ...(row.reason ? { reason: row.reason } : {}),
  };
  // A malformed row never reaches the calendar: rescale it into a valid target instead.
  return validTarget(t) ? t : scaleTarget({ ...DEFAULT_CADENCE }, row.posts_per_week, row.source, row.reason ?? undefined);
}

export async function routingOverride(db: Db, q: { studioId: string; personaId: string | null; agent: AgentName | string }): Promise<{ tier: ModelTier; personaId: string | null } | null> {
  const row = await db.maybeOne<{ tier: ModelTier; persona_id: string | null }>(
    `SELECT tier, persona_id FROM profit_routing_override
      WHERE studio_id = $1 AND agent = $2 AND active AND (persona_id IS NULL OR persona_id = $3)
      ORDER BY persona_id NULLS LAST LIMIT 1`,
    [q.studioId, q.agent, q.personaId],
  );
  return row ? { tier: row.tier, personaId: row.persona_id } : null;
}

/** Cadence and format-mix levers → stream B's calendar. */
export function createCadencePolicyImpl(base: ServiceBase): CadencePolicy {
  return { target: (personaId, weekStart) => cadenceTarget(base.db, personaId, weekStart) };
}

/** Model-routing lever → stream A's runtime. A persona override beats a studio-wide one; null = no override. */
export function createRoutingPolicyImpl(base: ServiceBase): RoutingPolicy {
  return {
    async tierFor(q) {
      return (await routingOverride(base.db, q))?.tier ?? null;
    },
  };
}
