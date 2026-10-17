import { type AgentName, baseCadence, CADENCE_BOUNDS, type CadencePolicy, type CadenceTarget, DEFAULT_CADENCE, type FormatMix, type FormatPlan, type RoutingPolicy, type ServiceBase, WINNER_CADENCE, WINNER_STATES } from '@troupe/agents';
import type { PersonaState } from '@troupe/core';
import { type CoreFormat, CORE_FORMATS, isOptionalFormat, type PostFormat, type PostPurpose, POST_FORMATS } from '@troupe/core';
import type { Db } from '@troupe/db';
import type { ModelTier } from '@troupe/providers';
import { apportion, isoDate, sum } from './util';

/**
 * The policies other streams read (docs/IOS-2-CONTRACTS.md §5.4): stream B's calendar asks the CadencePolicy for
 * a persona's weekly target; stream A's runtime asks the RoutingPolicy for a tier override before DEFAULT_ROUTING.
 * Both read the overrides the Profit Engine's levers write, and fall back to the defaults.
 * (IOS-5 stream L) The CadencePolicy also reads the persona's Format Plan (`format_plan`, FR-4.3c): the newest of the
 * plan and the lever / Owner override wins, so an Owner edit supersedes older lever moves and the levers build on the plan.
 */

export const FORMATS: readonly CoreFormat[] = CORE_FORMATS;
export const PURPOSES: readonly PostPurpose[] = ['reach', 'trust', 'sell'];

/** How far the format lever may move a line away from the approved Format Plan (scaled to the week), per line. */
export const LEVER_DRIFT = 3;

/**
 * Format-mix bounds: every core format keeps at least one slot; no format takes more than half the week. Optional
 * formats (IOS-5): with `on` (the optional formats the persona's Format Plan has on), those keep at least one slot and
 * every other optional format stays at 0 (the lever never switches a format on: the Owner does). With `base` (the
 * approved plan scaled to the week), no line drifts more than LEVER_DRIFT from it.
 */
export function formatBounds(
  postsPerWeek: number,
  opts: { on?: readonly PostFormat[]; base?: Readonly<Partial<Record<PostFormat, number>>> } = {},
): { min: Partial<Record<PostFormat, number>>; max: Partial<Record<PostFormat, number>> } {
  const cap = Math.ceil(postsPerWeek / 2);
  const min: Partial<Record<PostFormat, number>> = {};
  const max: Partial<Record<PostFormat, number>> = {};
  for (const f of POST_FORMATS) {
    const core = !isOptionalFormat(f);
    const on = core || !opts.on || opts.on.includes(f);
    min[f] = core || (opts.on?.includes(f) ?? false) ? 1 : 0;
    max[f] = on ? cap : 0;
    const b = opts.base?.[f];
    if (b !== undefined && on) {
      min[f] = Math.max(min[f]!, Math.min(cap, b - LEVER_DRIFT));
      max[f] = Math.max(min[f]!, Math.min(max[f]!, b + LEVER_DRIFT));
    }
  }
  return { min, max };
}

/** Purpose bounds: at least one sell and one trust post; reach stays the majority-ish default share. */
export const PURPOSE_MIN: Readonly<Record<PostPurpose, number>> = { reach: 1, trust: 1, sell: 1 };

/** The formats a mix has on: every core format plus the optional formats with a count. */
export const formatsOn = (mix: Readonly<Partial<Record<PostFormat, number>>>): PostFormat[] => POST_FORMATS.filter((f) => !isOptionalFormat(f) || (mix[f] ?? 0) > 0);

/** Rescales a target to `postsPerWeek` (clamped to CADENCE_BOUNDS), keeping the mix proportions within bounds. */
export function scaleTarget(current: CadenceTarget, postsPerWeek: number, source: CadenceTarget['source'], reason?: string): CadenceTarget {
  const n = Math.min(CADENCE_BOUNDS.max, Math.max(CADENCE_BOUNDS.min, Math.round(postsPerWeek)));
  const on = formatsOn(current.formatMix);
  const weights = Object.fromEntries(on.map((f) => [f, current.formatMix[f] ?? 0])) as Record<string, number>;
  const mix: Record<string, number> = apportion(n, weights, formatBounds(n, { on: on.filter(isOptionalFormat) }) as { min: Record<string, number>; max: Record<string, number> });
  for (const f of Object.keys(mix)) if (isOptionalFormat(f) && mix[f] === 0) delete mix[f];
  return {
    postsPerWeek: n,
    formatMix: mix as FormatMix,
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
    Object.entries(t.formatMix).every(([f, v]) => (POST_FORMATS as readonly string[]).includes(f) && Number.isInteger(v) && (v ?? 0) >= 0) &&
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
  created_at: Date;
}

/** The latest Format Plan version effective for a week (stream L's table). */
export interface PlanRow {
  version: number;
  plan: FormatPlan;
  posts_per_week: number;
  source: FormatPlan['source'];
  reason: string | null;
  created_at: Date;
}

export async function latestPlanRow(db: Db, personaId: string, weekStart?: Date): Promise<PlanRow | null> {
  return db.maybeOne<PlanRow>(
    `SELECT version, plan, posts_per_week, source, reason, created_at FROM format_plan
      WHERE persona_id = $1 AND ($2::date IS NULL OR effective_from <= $2::date) ORDER BY version DESC LIMIT 1`,
    [personaId, weekStart ? isoDate(weekStart) : null],
  );
}

/** The weekly feed mix a Format Plan asks for: its enabled lines (core formats always present). */
export function planMix(plan: Pick<FormatPlan, 'lines'>): Partial<Record<PostFormat, number>> {
  const mix: Partial<Record<PostFormat, number>> = Object.fromEntries(FORMATS.map((f) => [f, 0]));
  for (const l of plan.lines) {
    const n = Math.max(0, Math.round(l.perWeek));
    if (!isOptionalFormat(l.format)) mix[l.format] = n;
    else if (l.enabled && n > 0) mix[l.format] = n;
  }
  return mix;
}

/**
 * A Format Plan as a cadence target. The purpose mix comes from the latest override when it fits the week, else the
 * default proportions. A recommended (not Owner-set) plan for a winner (SCALING / BRAND) scales to the winner cadence.
 */
export function planTarget(row: Pick<PlanRow, 'version' | 'plan' | 'posts_per_week' | 'source' | 'reason'>, override: Pick<OverrideRow, 'purpose_mix'> | null, state: PersonaState | null | undefined): CadenceTarget {
  const mix = planMix(row.plan);
  const n = Math.min(CADENCE_BOUNDS.max, Math.max(CADENCE_BOUNDS.min, row.posts_per_week));
  const source: CadenceTarget['source'] = row.source === 'owner' ? 'owner' : row.source === 'lever' ? 'lever' : 'default';
  const reason = `Format Plan v${row.version}${row.reason ? `: ${row.reason}` : ''}`.slice(0, 500);
  const purpose =
    override && sum(PURPOSES.map((p) => Number(override.purpose_mix?.[p] ?? 0))) === n && PURPOSES.every((p) => Number.isInteger(override.purpose_mix?.[p]))
      ? { ...override.purpose_mix }
      : apportion(n, DEFAULT_CADENCE.purposeMix, { min: PURPOSE_MIN });
  let t: CadenceTarget = { postsPerWeek: n, formatMix: mix as FormatMix, purposeMix: purpose, source, reason };
  if (!validTarget(t)) t = scaleTarget({ ...t, postsPerWeek: n }, n, source, reason);
  const winner = !!state && WINNER_STATES.includes(state);
  if (winner && (row.source === 'recommended' || row.source === 'default') && t.postsPerWeek < WINNER_CADENCE.postsPerWeek) {
    t = scaleTarget(t, WINNER_CADENCE.postsPerWeek, 'default', `${reason} (scaled to the winner cadence)`);
  }
  return t;
}

/**
 * The target in force for the week starting `weekStart`: the newest of (the latest override effective by then, the
 * latest Format Plan version effective by then), else the base cadence for the persona's state (WINNER_CADENCE for
 * SCALING / BRAND, DEFAULT_CADENCE otherwise), so the levers and the calendar share one starting point.
 */
export async function cadenceTarget(db: Db, personaId: string, weekStart: Date): Promise<CadenceTarget> {
  const [row, plan] = await Promise.all([
    db.maybeOne<OverrideRow>(
      `SELECT posts_per_week, format_mix, purpose_mix, source, reason, created_at FROM profit_cadence_override
        WHERE persona_id = $1 AND effective_from <= $2::date ORDER BY effective_from DESC, seq DESC LIMIT 1`,
      [personaId, isoDate(weekStart)],
    ),
    latestPlanRow(db, personaId, weekStart),
  ]);
  if (plan && (!row || new Date(plan.created_at).getTime() >= new Date(row.created_at).getTime())) {
    const p = await db.maybeOne<{ state: PersonaState }>('SELECT state FROM persona WHERE id = $1', [personaId]);
    return planTarget(plan, row, p?.state);
  }
  if (!row) {
    const p = await db.maybeOne<{ state: PersonaState }>('SELECT state FROM persona WHERE id = $1', [personaId]);
    return baseCadence(p?.state);
  }
  // Rows written before IOS-5 carry only the core formats: fill a missing core format with 0, never an optional one.
  const formatMix = { ...Object.fromEntries(FORMATS.map((f) => [f, 0])), ...row.format_mix } as FormatMix;
  const t: CadenceTarget = {
    postsPerWeek: row.posts_per_week,
    formatMix,
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
