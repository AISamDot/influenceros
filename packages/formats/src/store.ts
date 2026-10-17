import { type FormatPlan, WINNER_STATES } from '@troupe/agents';
import { type Actor, actorRef, audit, isOptionalFormat, type PersonaState, POST_FORMATS, type PostFormat } from '@troupe/core';
import { type Db, json } from '@troupe/db';
import { planTarget } from '@troupe/profit';
import { FORMAT_COST_USD, round2 } from './catalog';
import { defaultPlan, feedCostPerWeek, parsePlan, planLines, validatePlan } from './plan';
import { isoDate, mondayOf } from './time';

/**
 * Format Plans in the database (`format_plan`, one row per version). The plan in force composes the latest version
 * with any newer Profit Engine override (profit_cadence_override, written by the format and cadence levers), so lever
 * changes show on the persona page without rewriting the Owner's plan.
 */

export interface PlanVersion {
  readonly id: string;
  readonly version: number;
  readonly plan: FormatPlan;
  readonly source: FormatPlan['source'];
  readonly reason: string | null;
  readonly effectiveFrom: string;
  readonly createdBy: string;
  readonly createdAt: Date;
}

interface Row {
  id: string;
  version: number;
  plan: FormatPlan;
  source: FormatPlan['source'];
  reason: string | null;
  effective_from: string | Date;
  created_by: string;
  created_at: Date;
}

const toVersion = (r: Row): PlanVersion => ({
  id: r.id,
  version: r.version,
  plan: parsePlan(r.plan) ?? defaultPlan(),
  source: r.source,
  reason: r.reason,
  effectiveFrom: typeof r.effective_from === 'string' ? r.effective_from.slice(0, 10) : isoDate(r.effective_from),
  createdBy: r.created_by,
  createdAt: new Date(r.created_at),
});

export async function latestPlanVersion(db: Db, personaId: string): Promise<PlanVersion | null> {
  const r = await db.maybeOne<Row>(`SELECT * FROM format_plan WHERE persona_id = $1 ORDER BY version DESC LIMIT 1`, [personaId]);
  return r ? toVersion(r) : null;
}

export async function planHistory(db: Db, personaId: string, limit = 10): Promise<PlanVersion[]> {
  return (await db.query<Row>(`SELECT * FROM format_plan WHERE persona_id = $1 ORDER BY version DESC LIMIT $2`, [personaId, limit])).map(toVersion);
}

/** Writes a new plan version (validated). `effectiveFrom` defaults to this week's Monday: the next week planned uses it. */
export async function savePlan(
  db: Db,
  q: { studioId: string; personaId: string; plan: FormatPlan; actor: Actor; now: Date; effectiveFrom?: Date; action?: string },
): Promise<PlanVersion> {
  const plan = validatePlan(q.plan);
  const row = await db.one<Row>(
    `INSERT INTO format_plan (studio_id, persona_id, version, plan, posts_per_week, stories_per_day, source, reason, effective_from, created_by, created_at)
     VALUES ($1, $2, COALESCE((SELECT max(version) FROM format_plan WHERE persona_id = $2), 0) + 1, $3::jsonb, $4, $5, $6, $7, $8::date, $9, $10)
     RETURNING *`,
    [q.studioId, q.personaId, json(plan), plan.postsPerWeek, plan.stories.perDay, plan.source, plan.reason.slice(0, 1000), isoDate(q.effectiveFrom ?? mondayOf(q.now)), actorRef(q.actor), q.now],
  );
  await audit(db, {
    studioId: q.studioId,
    personaId: q.personaId,
    actor: q.actor,
    action: q.action ?? 'formats.plan_saved',
    entityType: 'format_plan',
    entityId: row.id,
    data: { version: row.version, source: plan.source, postsPerWeek: plan.postsPerWeek, storiesPerDay: plan.stories.perDay },
  });
  return toVersion(row);
}

interface OverrideRow {
  posts_per_week: number;
  format_mix: Record<string, number>;
  source: 'lever' | 'owner';
  reason: string | null;
  created_at: Date;
  effective_from: string | Date;
}

type PlanInForce = FormatPlan & { version: number; leverReason: string | null };

/**
 * The plan the CadencePolicy actually books: a recommended / default plan for a winner (SCALING / BRAND) is scaled to
 * the winner cadence (profit planTarget), so the persona page, Owner edits and the Stories lever all start from the
 * same feed lines as the calendar. The source stays as stored (it is still the Studio Manager's plan).
 */
async function winnerScaled(db: Db, personaId: string, plan: PlanInForce): Promise<PlanInForce> {
  if (plan.source !== 'recommended' && plan.source !== 'default') return plan;
  const p = await db.maybeOne<{ state: PersonaState }>('SELECT state FROM persona WHERE id = $1', [personaId]);
  if (!p || !WINNER_STATES.includes(p.state)) return plan;
  const t = planTarget({ version: plan.version, plan, posts_per_week: plan.postsPerWeek, source: plan.source, reason: null }, null, p.state);
  if (t.postsPerWeek === plan.postsPerWeek) return plan;
  const reasons = Object.fromEntries(
    plan.lines.map((l) => {
      const n = Math.max(0, Math.round(Number(t.formatMix[l.format as keyof typeof t.formatMix] ?? 0)));
      return [l.format, n !== (l.enabled ? l.perWeek : 0) ? `winner cadence: ${l.enabled ? l.perWeek : 0} → ${n} a week; ${l.reason}` : l.reason];
    }),
  ) as Partial<Record<PostFormat, string>>;
  const lines = planLines(t.formatMix as Partial<Record<PostFormat, number>>, reasons);
  const postsPerWeek = lines.reduce((a, l) => a + l.perWeek, 0);
  return {
    ...plan,
    postsPerWeek,
    lines,
    reason: `${plan.reason} Scaled to the winner cadence (${postsPerWeek} feed posts a week) while the persona is ${p.state}.`.trim(),
    costPerWeekUsd: round2(feedCostPerWeek(lines) + plan.stories.costPerWeekUsd),
  };
}

/**
 * The persona's plan in force: the latest version, with the lines and total from a newer lever / Owner cadence
 * override when there is one (source 'lever', the override's reason), and a recommended plan scaled to the winner
 * cadence for a SCALING / BRAND persona (as the calendar books it; `scaleForWinner: false` returns the stored lines).
 * null = no plan (the cadence default applies).
 */
export async function planInForce(db: Db, personaId: string, now: Date, opts: { scaleForWinner?: boolean } = {}): Promise<PlanInForce | null> {
  const v = await latestPlanVersion(db, personaId);
  if (!v) return null;
  const o = await db.maybeOne<OverrideRow>(
    `SELECT posts_per_week, format_mix, source, reason, created_at, effective_from FROM profit_cadence_override
      WHERE persona_id = $1 AND effective_from <= $2::date ORDER BY effective_from DESC, seq DESC LIMIT 1`,
    [personaId, isoDate(new Date(mondayOf(now).getTime() + 7 * 86_400_000))],
  );
  if (!o || new Date(o.created_at).getTime() <= v.createdAt.getTime()) {
    const stored: PlanInForce = { ...v.plan, version: v.version, leverReason: null };
    return opts.scaleForWinner === false ? stored : winnerScaled(db, personaId, stored);
  }
  const lines = POST_FORMATS.map((format) => {
    const prev = v.plan.lines.find((l) => l.format === format);
    const perWeek = Math.max(0, Math.round(Number(o.format_mix[format] ?? (isOptionalFormat(format) ? 0 : prev?.perWeek ?? 0))));
    const enabled = !isOptionalFormat(format) || perWeek > 0;
    const moved = (prev?.perWeek ?? 0) !== perWeek;
    return {
      format,
      perWeek,
      enabled,
      reason: moved ? `${o.source === 'lever' ? 'Profit Engine' : 'Owner'}: ${prev?.perWeek ?? 0} → ${perWeek} a week; ${prev?.reason ?? ''}`.replace(/; $/, '') : prev?.reason ?? '',
      costPerPostUsd: FORMAT_COST_USD[format as PostFormat],
      costPerWeekUsd: round2(perWeek * FORMAT_COST_USD[format as PostFormat]),
    };
  });
  return {
    ...v.plan,
    postsPerWeek: lines.reduce((a, l) => a + l.perWeek, 0),
    lines,
    source: o.source === 'lever' ? 'lever' : 'owner',
    reason: o.reason ?? v.plan.reason,
    costPerWeekUsd: round2(feedCostPerWeek(lines) + v.plan.stories.costPerWeekUsd),
    version: v.version,
    leverReason: o.reason,
  };
}
