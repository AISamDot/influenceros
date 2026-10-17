import { type AgentName, CADENCE_BOUNDS, type CadenceTarget, DEFAULT_ROUTING, type FormatMix } from '@troupe/agents';
import { audit, getSettings, isOptionalFormat, personaCaps, type PostFormat } from '@troupe/core';
import { type Db, json } from '@troupe/db';
import { LLM_PRICES, type ModelTier } from '@troupe/providers';
import { aggregate, type Facts, isSyntheticRow, loadFacts } from './pnl';
import { cadenceTarget, formatBounds, formatsOn, latestPlanRow, planMix, routingOverride, scaleTarget } from './policies';
import { getProfitSettings, type ProfitSettings } from './settings';
import type { LeverAction, LeverKind, PnlRow } from './types';
import { addDays, DAY_MS, isoDate, mondayOf, round, sum, WEEKS_PER_MONTH } from './util';

/**
 * Profit Engine levers (PRD §3.11.2, FR-24.2), pulled automatically within bounds:
 *  - cadence: raise a persona while net revenue per post ≥ ~3× cost per post, trim below ~1× (7–21 a week);
 *  - format mix: shift one weekly slot from the least to the most profitable format (each format keeps ≥ 1 slot,
 *    none takes more than half the week);
 *  - credit reallocation: the weekly credit and LLM pool split 70/20/10 by profit per credit (FR-14.2);
 *  - model routing: step the scriptwriter down a tier while QC Q1 keeps passing, revert if quality drops.
 * Every action is logged in `profit_lever_action` with its expected monthly impact, then measured after the review
 * window. Caps and autonomy are never raised (that's the Owner's: it surfaces as an action that needs approval).
 */

export const PROFIT_ENGINE_ACTOR = { type: 'agent', id: 'profit-engine' } as const;
const PUBLISHING = ['TESTING', 'RE_ANGLE', 'MONETISING', 'SCALING', 'BRAND'];
const ALLOCATION_STATES = ['SETUP', ...PUBLISHING];
/** Higgsfield credits per 30-second clip (PRD Appendix E), for the clips estimate on an allocation. */
const CREDITS_PER_CLIP = 84;
const DAYS_PER_MONTH = 30.44;
const TIER_ORDER: readonly ModelTier[] = ['fast', 'standard', 'strong'];

/**
 * Agents the routing lever may move, with their floor tier and the QC stage that proves quality holds.
 * Gate, QC and the managers are never routed down: safety checks and strategy keep their tiers.
 */
export const ROUTING_RULES: Partial<Record<AgentName, { floor: ModelTier; qcStage: 'Q1' }>> = {
  scriptwriter: { floor: 'fast', qcStage: 'Q1' },
};

export interface LeverProposal {
  lever: LeverKind;
  personaId: string | null;
  personaName: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  rationale: string;
  expectedImpactCents: number;
  confidence: 'low' | 'medium' | 'high';
  reviewDays: number;
  baseline: Record<string, unknown>;
  effect:
    | { type: 'cadence'; target: CadenceTarget; effectiveFrom: Date }
    | { type: 'routing'; agent: AgentName; tier: ModelTier; fromTier: ModelTier }
    | { type: 'allocation'; weekStart: Date; rows: Array<{ personaId: string | null; credits: number; llmUsd: number; clips: number; score: number | null }> };
}

interface PersonaInfo {
  id: string;
  name: string;
  state: string;
}

export interface LeverInputs {
  db: Db;
  studioId: string;
  now: Date;
  settings: ProfitSettings;
  personas: PersonaInfo[];
  /** Facts for the cadence/allocation window. */
  window: Facts;
  /** Facts for the (longer) format window. */
  formatWindow: Facts;
}

export async function leverInputs(db: Db, studioId: string, now: Date): Promise<LeverInputs> {
  const settings = await getProfitSettings(db, studioId);
  const [personas, window, formatWindow] = await Promise.all([
    db.query<PersonaInfo>(`SELECT id, name, state FROM persona WHERE studio_id = $1 ORDER BY name`, [studioId]),
    loadFacts(db, { studioId, from: addDays(now, -settings.leverWindowDays), to: now }),
    loadFacts(db, { studioId, from: addDays(now, -settings.formatWindowDays), to: now }),
  ]);
  return { db, studioId, now, settings, personas, window, formatWindow };
}

/** Restricts loaded facts to one persona (no extra queries). */
export function factsFor(f: Facts, personaId: string): Facts {
  return {
    ...f,
    personas: new Map([...f.personas].filter(([id]) => id === personaId)),
    posts: new Map([...f.posts].filter(([, p]) => p.personaId === personaId)),
    orders: f.orders.filter((o) => o.personaId === personaId),
    costs: f.costs.filter((c) => c.personaId === personaId),
  };
}

const confidenceFor = (posts: number): LeverProposal['confidence'] => (posts >= 12 ? 'high' : posts >= 6 ? 'medium' : 'low');
const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: cents >= 10_000 || cents <= -10_000 ? 0 : 2 })}`;

async function recentLever(db: Db, personaId: string | null, studioId: string, lever: LeverKind, since: Date): Promise<boolean> {
  return !!(await db.maybeOne(
    `SELECT 1 FROM profit_lever_action WHERE studio_id = $1 AND persona_id IS NOT DISTINCT FROM $2 AND lever = $3 AND created_at > $4 LIMIT 1`,
    [studioId, personaId, lever, since],
  ));
}

/** Weekly profit of a persona over the window, for baselines. */
const weeklyProfit = (row: PnlRow | undefined, days: number) => (row ? round((row.profitCents / days) * 7) : 0);

// ───────────────────────────── Cadence ─────────────────────────────

export async function planCadence(inp: LeverInputs, personaId: string, opts: { ignoreCooldown?: boolean } = {}): Promise<LeverProposal | null> {
  const p = inp.personas.find((x) => x.id === personaId);
  if (!p || !PUBLISHING.includes(p.state)) return null;
  const { settings, now } = inp;
  if (!opts.ignoreCooldown && (await recentLever(inp.db, personaId, inp.studioId, 'cadence', addDays(now, -6)))) return null;
  const pf = factsFor(inp.window, personaId);
  const row = aggregate(pf, 'persona').find((r) => r.key === personaId);
  if (!row || row.posts < settings.minPostsForDecision) return null;
  const netPerPost = row.revenuePerPostCents;
  const costPerPost = row.costPerPostCents;
  // Marginal cost of one more post: the content work tied to posts and slots (overhead doesn't scale with cadence).
  const direct = sum(pf.costs.filter((c) => c.postId || c.slotFormat).map((c) => c.llmCents + c.mediaCents + c.creditsCents));
  const marginalCost = direct > 0 ? direct / row.posts : costPerPost;
  const ratio = costPerPost > 0 ? netPerPost / costPerPost : netPerPost > 0 ? Infinity : null;
  if (ratio === null) return null;
  const effectiveFrom = addDays(mondayOf(now), 7);
  const current = await cadenceTarget(inp.db, personaId, effectiveFrom);
  let next = current.postsPerWeek;
  if (ratio >= settings.raiseRatio && current.postsPerWeek < CADENCE_BOUNDS.max) {
    next = Math.min(CADENCE_BOUNDS.max, current.postsPerWeek + Math.max(2, Math.round(current.postsPerWeek * 0.3)));
  } else if (ratio < settings.trimRatio && current.postsPerWeek > CADENCE_BOUNDS.min) {
    next = Math.max(CADENCE_BOUNDS.min, current.postsPerWeek - Math.max(1, Math.round(current.postsPerWeek * 0.2)));
  }
  if (next === current.postsPerWeek) return null;
  const raise = next > current.postsPerWeek;
  const ratioText = Number.isFinite(ratio) ? `${ratio.toFixed(1)}×` : 'no cost';
  const reason = raise
    ? `${p.name} earns ${usd(netPerPost)} net per post against ${usd(costPerPost)} cost (${ratioText}): raising cadence ${current.postsPerWeek} → ${next} a week.`
    : `${p.name} earns ${usd(netPerPost)} net per post against ${usd(costPerPost)} cost (${ratioText}): trimming cadence ${current.postsPerWeek} → ${next} a week.`;
  const target = scaleTarget(current, next, 'lever', reason);
  // Extra posts earn less than the average one, so a raise is discounted; a trim saves what the posts lost.
  const expected = round((next - current.postsPerWeek) * WEEKS_PER_MONTH * (netPerPost - marginalCost) * (raise ? 0.6 : 1));
  return {
    lever: 'cadence',
    personaId,
    personaName: p.name,
    before: { postsPerWeek: current.postsPerWeek, formatMix: current.formatMix, purposeMix: current.purposeMix },
    after: { postsPerWeek: target.postsPerWeek, formatMix: target.formatMix, purposeMix: target.purposeMix },
    rationale: reason,
    expectedImpactCents: expected,
    confidence: confidenceFor(row.posts),
    reviewDays: settings.reviewDays + 7,
    baseline: {
      weeklyProfitCents: weeklyProfit(row, settings.leverWindowDays),
      windowDays: settings.leverWindowDays,
      posts: row.posts,
      netPerPostCents: netPerPost,
      costPerPostCents: costPerPost,
      marginalCostPerPostCents: round(marginalCost),
      ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : null,
    },
    effect: { type: 'cadence', target, effectiveFrom },
  };
}

// ───────────────────────────── Format mix ─────────────────────────────

/** Per-format results the format lever weighs (FR-4.3c): reach, follows, saves + shares, clicks, revenue ÷ cost. */
export interface FormatResult {
  format: PostFormat;
  label: string;
  posts: number;
  reachPerPost: number;
  followsPerPost: number;
  savesSharesPerPost: number;
  clicksPerPost: number;
  revenuePerPostCents: number;
  costPerPostCents: number;
  profitPerPostCents: number;
  /** Net revenue per post ÷ cost per post (cost floored at 1 cent). */
  roi: number;
  /** Composite score, 1 = the persona's average format. */
  score: number;
}

/** Score weights: money first (revenue ÷ cost), then reach, follows, saves/shares and clicks equally. */
export const FORMAT_SCORE_WEIGHTS = { roi: 0.4, reach: 0.15, follows: 0.15, savesShares: 0.15, clicks: 0.15 } as const;

/** Latest metrics per post in the window, summed per format (stream F's metric_snapshot). */
async function formatEngagement(db: Db, personaId: string, from: Date, to: Date): Promise<Map<string, { views: number; follows: number; savesShares: number; clicks: number }>> {
  const rows = await db.query<{ format: string; views: number; follows: number; ss: number; clicks: number }>(
    `SELECT p.format, COALESCE(sum(m.views), 0)::float8 AS views, COALESCE(sum(m.follows), 0)::float8 AS follows,
            COALESCE(sum(m.saves + m.shares), 0)::float8 AS ss, COALESCE(sum(m.link_clicks), 0)::float8 AS clicks
       FROM post p
       LEFT JOIN LATERAL (SELECT views, follows, saves, shares, link_clicks FROM metric_snapshot ms WHERE ms.post_id = p.id ORDER BY captured_on DESC, created_at DESC LIMIT 1) m ON true
      WHERE p.persona_id = $1 AND p.published_at >= $2 AND p.published_at < $3
      GROUP BY p.format`,
    [personaId, from, to],
  );
  return new Map(rows.map((r) => [r.format, { views: Number(r.views), follows: Number(r.follows), savesShares: Number(r.ss), clicks: Number(r.clicks) }]));
}

/** Scores each format with ≥ 2 posts in the format window (the P&L rows plus engagement). */
export async function formatResults(inp: LeverInputs, personaId: string): Promise<FormatResult[]> {
  const rows = aggregate(factsFor(inp.formatWindow, personaId), 'format', personaId).filter((r) => !isSyntheticRow(r) && r.format && r.posts >= 2);
  if (!rows.length) return [];
  const eng = await formatEngagement(inp.db, personaId, addDays(inp.now, -inp.settings.formatWindowDays), inp.now);
  const base = rows.map((r) => {
    const e = eng.get(r.format!) ?? { views: r.views, follows: 0, savesShares: 0, clicks: 0 };
    return {
      format: r.format!,
      label: r.label,
      posts: r.posts,
      reachPerPost: Math.max(e.views, r.views) / r.posts,
      followsPerPost: e.follows / r.posts,
      savesSharesPerPost: e.savesShares / r.posts,
      clicksPerPost: e.clicks / r.posts,
      revenuePerPostCents: r.revenuePerPostCents,
      costPerPostCents: r.costPerPostCents,
      profitPerPostCents: r.profitCents / r.posts,
      roi: Math.max(0, r.revenuePerPostCents) / Math.max(1, r.costPerPostCents),
    };
  });
  const rel = (k: keyof (typeof base)[number]) => {
    const avg = base.reduce((a, x) => a + Number(x[k]), 0) / base.length;
    return (x: (typeof base)[number]) => (avg > 0 ? Number(x[k]) / avg : 0);
  };
  const [roi, reach, follows, ss, clicks] = [rel('roi'), rel('reachPerPost'), rel('followsPerPost'), rel('savesSharesPerPost'), rel('clicksPerPost')];
  const W = FORMAT_SCORE_WEIGHTS;
  return base.map((x) => ({ ...x, score: W.roi * roi(x) + W.reach * reach(x) + W.follows * follows(x) + W.savesShares * ss(x) + W.clicks * clicks(x) }));
}

/**
 * The format lever (FR-4.3c, FR-24.2): moves one weekly slot from the weakest to the strongest format by per-format
 * results (revenue per post ÷ cost per post, reach, follows, saves/shares, clicks), never toward a less profitable one.
 * Bounds (formatBounds): each core format and each optional format the Format Plan has on keeps ≥ 1, none takes more
 * than half the week, formats the plan has off stay off, and no line drifts more than LEVER_DRIFT from the approved
 * plan. The new mix is the persona's plan in force from next Monday (profit_cadence_override, composed over
 * format_plan by the CadencePolicy and the Format Plan service).
 */
export async function planFormatMix(
  inp: LeverInputs,
  personaId: string,
  opts: { ignoreCooldown?: boolean; current?: CadenceTarget } = {},
): Promise<LeverProposal | null> {
  const p = inp.personas.find((x) => x.id === personaId);
  if (!p || !PUBLISHING.includes(p.state)) return null;
  const { settings, now } = inp;
  if (!opts.ignoreCooldown && (await recentLever(inp.db, personaId, inp.studioId, 'format_mix', addDays(now, -6)))) return null;
  const results = await formatResults(inp, personaId);
  if (results.length < 2) return null;
  const sorted = [...results].sort((a, b) => b.score - a.score || b.profitPerPostCents - a.profitPerPostCents);
  const effectiveFrom = addDays(mondayOf(now), 7);
  const current = opts.current ?? (await cadenceTarget(inp.db, personaId, effectiveFrom));
  const plan = await latestPlanRow(inp.db, personaId, effectiveFrom);
  const planned = plan ? planMix(plan.plan) : null;
  const on = (planned ? formatsOn(planned) : formatsOn(current.formatMix)).filter(isOptionalFormat);
  const base = planned ? scaleTarget({ ...DEFAULT_CADENCE_LIKE, formatMix: planned as FormatMix, postsPerWeek: sum(Object.values(planned).map((v) => v ?? 0)) }, current.postsPerWeek, 'lever').formatMix : undefined;
  const bounds = formatBounds(current.postsPerWeek, { on, base });
  const count = (f: PostFormat) => current.formatMix[f] ?? 0;
  const best = sorted.find((r) => count(r.format) < (bounds.max[r.format] ?? 0));
  const worst = [...sorted].reverse().find((r) => r !== best && count(r.format) > (bounds.min[r.format] ?? 0));
  if (!best || !worst || best.score - worst.score < 0.3 || best.profitPerPostCents < worst.profitPerPostCents) return null;
  const gap = best.profitPerPostCents - worst.profitPerPostCents;
  const mix: Record<string, number> = { ...current.formatMix };
  mix[best.format] = (mix[best.format] ?? 0) + 1;
  mix[worst.format] = (mix[worst.format] ?? 0) - 1;
  if (isOptionalFormat(worst.format) && mix[worst.format] === 0) delete mix[worst.format];
  const why = (r: FormatResult) => `${usd(r.profitPerPostCents)} profit, ${Math.round(r.reachPerPost)} reach, ${r.savesSharesPerPost.toFixed(1)} saves+shares per post (score ${r.score.toFixed(2)})`;
  const reason = `${p.name}: ${best.label} makes ${why(best)} vs ${worst.label} ${why(worst)} over the last ${settings.formatWindowDays} days: moving one weekly slot to ${best.label}.`;
  const target: CadenceTarget = { ...current, formatMix: mix as FormatMix, source: 'lever', reason };
  return {
    lever: 'format_mix',
    personaId,
    personaName: p.name,
    before: { formatMix: current.formatMix },
    after: { formatMix: mix },
    rationale: reason,
    expectedImpactCents: round(Math.max(0, gap) * WEEKS_PER_MONTH * 0.5),
    confidence: confidenceFor(Math.min(best.posts, worst.posts) * 2),
    reviewDays: settings.reviewDays + 14,
    baseline: {
      weeklyProfitCents: weeklyProfit(aggregate(factsFor(inp.formatWindow, personaId), 'persona').find((r) => r.key === personaId), settings.formatWindowDays),
      windowDays: settings.formatWindowDays,
      best: { format: best.format, profitPerPostCents: round(best.profitPerPostCents), posts: best.posts, score: Math.round(best.score * 100) / 100 },
      worst: { format: worst.format, profitPerPostCents: round(worst.profitPerPostCents), posts: worst.posts, score: Math.round(worst.score * 100) / 100 },
      planVersion: plan?.version ?? null,
    },
    effect: { type: 'cadence', target, effectiveFrom },
  };
}

/** A neutral shell for scaling a plan's mix (only formatMix and postsPerWeek matter to scaleTarget's format split). */
const DEFAULT_CADENCE_LIKE: CadenceTarget = { postsPerWeek: 10, formatMix: { talking: 1, activity_text: 1, voiceover: 1, static: 1, carousel: 1 }, purposeMix: { reach: 6, trust: 3, sell: 1 }, source: 'default' };

// ───────────────────────────── Model routing ─────────────────────────────

/** Blended price per million tokens (3:1 input:output), to compare tiers. */
const blended = (t: ModelTier) => (LLM_PRICES[t].inPerM * 3 + LLM_PRICES[t].outPerM) / 4;

async function qcPassRate(db: Db, personaId: string, stage: string, since: Date, until: Date): Promise<{ n: number; rate: number }> {
  const r = await db.one<{ n: number; pass: number }>(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE pass)::int AS pass FROM qc_report
      WHERE persona_id = $1 AND stage = $2 AND created_at >= $3 AND created_at < $4`,
    [personaId, stage, since, until],
  );
  return { n: r.n, rate: r.n ? r.pass / r.n : 0 };
}

async function agentSpendUsd(db: Db, personaId: string, agent: string, since: Date, until: Date): Promise<number> {
  const r = await db.one<{ usd: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM agent_run WHERE persona_id = $1 AND agent = $2 AND outcome = 'ok' AND started_at >= $3 AND started_at < $4`,
    [personaId, agent, since, until],
  );
  return Number(r.usd);
}

export async function planRouting(inp: LeverInputs, personaId: string, opts: { ignoreCooldown?: boolean } = {}): Promise<LeverProposal[]> {
  const p = inp.personas.find((x) => x.id === personaId);
  if (!p || !PUBLISHING.includes(p.state)) return [];
  const { settings, now, db } = inp;
  const out: LeverProposal[] = [];
  for (const [agentName, rule] of Object.entries(ROUTING_RULES)) {
    const agent = agentName as AgentName;
    if (!rule) continue;
    const override = await routingOverride(db, { studioId: inp.studioId, personaId, agent });
    if (override?.personaId === personaId) continue; // already trialling a tier for this persona
    if (!opts.ignoreCooldown && (await recentLever(db, personaId, inp.studioId, 'model_routing', addDays(now, -settings.reviewDays)))) continue;
    const from = override?.tier ?? DEFAULT_ROUTING[agent];
    const idx = TIER_ORDER.indexOf(from);
    if (idx <= TIER_ORDER.indexOf(rule.floor)) continue;
    const qc = await qcPassRate(db, personaId, rule.qcStage, addDays(now, -14), now);
    if (qc.n < 6 || qc.rate < settings.routingPassRate) continue;
    const spend = await agentSpendUsd(db, personaId, agent, addDays(now, -settings.leverWindowDays), now);
    if (spend < 0.25) continue;
    const to = TIER_ORDER[idx - 1]!;
    const saving = round(spend * (DAYS_PER_MONTH / settings.leverWindowDays) * (1 - blended(to) / blended(from)) * 100);
    const reason = `${p.name}: ${agent} passes QC ${rule.qcStage} ${Math.round(qc.rate * 100)}% of the time (${qc.n} checks) on ${from}: trying ${to}, reverted automatically if the pass rate drops below ${Math.round(settings.routingRevertRate * 100)}%.`;
    out.push({
      lever: 'model_routing',
      personaId,
      personaName: p.name,
      before: { agent, tier: from },
      after: { agent, tier: to },
      rationale: reason,
      expectedImpactCents: saving,
      confidence: 'medium',
      reviewDays: settings.reviewDays,
      baseline: { agent, qcStage: rule.qcStage, passRate: qc.rate, checks: qc.n, dailySpendUsd: spend / settings.leverWindowDays, windowDays: settings.leverWindowDays },
      effect: { type: 'routing', agent, tier: to, fromTier: from },
    });
  }
  return out;
}

// ───────────────────────────── Credit reallocation ─────────────────────────────

export async function planAllocation(inp: LeverInputs, opts: { ignoreExisting?: boolean } = {}): Promise<LeverProposal | null> {
  const { db, studioId, now, settings } = inp;
  const weekStart = addDays(mondayOf(now), 7);
  if (!opts.ignoreExisting) {
    const done = await db.maybeOne(`SELECT 1 FROM budget_allocation WHERE studio_id = $1 AND week_start = $2 AND source = 'lever' LIMIT 1`, [studioId, isoDate(weekStart)]);
    if (done) return null;
  }
  const active = inp.personas.filter((p) => ALLOCATION_STATES.includes(p.state));
  if (!active.length) return null;
  const studio = await getSettings(db, studioId);
  const budgets = await db.query<{ id: string; budget: Record<string, number> }>(`SELECT id, budget FROM persona WHERE studio_id = $1`, [studioId]);
  const perWeek = 7 / DAYS_PER_MONTH;
  const pool = { credits: studio.caps.hf_credits_month * perWeek, llm: studio.caps.llm_usd_month * perWeek };
  const rows = aggregate(inp.window, 'persona');
  const price = Math.max(0.0001, inp.window.creditPriceCents);
  const scores = new Map<string, number>();
  for (const p of active) {
    const r = rows.find((x) => x.key === p.id);
    // Credit-equivalent spend: Higgsfield credits plus LLM/media dollars converted at the credit price.
    const creditEq = r ? r.costBreakdown.hfCredits + (r.costBreakdown.llmCents + r.costBreakdown.mediaCents) / price : 0;
    scores.set(p.id, r ? r.profitCents / Math.max(1, creditEq) : 0);
  }
  const positive = active.filter((p) => (scores.get(p.id) ?? 0) > 0);
  const weight = (id: string) => (positive.length ? Math.max(0, scores.get(id) ?? 0) / sum(positive.map((p) => scores.get(p.id)!)) : 1 / active.length);
  const { exploit, explore } = settings.allocation;
  let reserveCredits = pool.credits;
  let reserveLlm = pool.llm;
  const alloc: Array<{ personaId: string | null; credits: number; llmUsd: number; clips: number; score: number | null }> = [];
  for (const p of active) {
    const share = exploit * weight(p.id) + explore / active.length;
    const caps = personaCaps({ budget: budgets.find((b) => b.id === p.id)?.budget ?? {} }, studio);
    const credits = Math.min(pool.credits * share, caps.hf_credits_month * perWeek);
    const llm = Math.min(pool.llm * share, caps.llm_usd_month * perWeek);
    reserveCredits -= credits;
    reserveLlm -= llm;
    alloc.push({ personaId: p.id, credits: Math.floor(credits), llmUsd: Math.round(llm * 100) / 100, clips: Math.floor(credits / CREDITS_PER_CLIP), score: Math.round((scores.get(p.id) ?? 0) * 10_000) / 10_000 });
  }
  alloc.push({ personaId: null, credits: Math.max(0, Math.floor(reserveCredits)), llmUsd: Math.max(0, Math.round(reserveLlm * 100) / 100), clips: 0, score: null });

  const prev = await db.query<{ persona_id: string | null; credits: number }>(
    `SELECT persona_id, credits FROM budget_allocation WHERE studio_id = $1 AND week_start = $2`,
    [studioId, isoDate(mondayOf(now))],
  );
  const even = (pool.credits * (exploit + explore)) / active.length;
  const prevOf = (id: string) => prev.find((r) => r.persona_id === id)?.credits ?? even;
  const expected = Math.max(
    0,
    round(sum(active.map((p) => ((alloc.find((a) => a.personaId === p.id)!.credits - prevOf(p.id)) * (scores.get(p.id) ?? 0)))) * WEEKS_PER_MONTH * 0.5),
  );
  const top = [...active].sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))[0]!;
  const name = (id: string | null) => (id ? (inp.personas.find((p) => p.id === id)?.name ?? id) : 'Studio reserve');
  // Plan only: nothing enforces budget_allocation yet (the governor enforces the monthly caps), so this lever logs no
  // expected or measured impact; measureLevers skips it.
  const reason = `Plan only: weekly pool ${Math.floor(pool.credits).toLocaleString('en-US')} credits and ${usd(pool.llm * 100)} LLM: ${Math.round(exploit * 100)}% by profit per credit (best: ${top.name}, ${usd(scores.get(top.id) ?? 0)}/credit), ${Math.round(explore * 100)}% spread for testing, ${Math.round(settings.allocation.reserve * 100)}% studio reserve. Caps still apply as set.`;
  return {
    lever: 'credit_reallocation',
    personaId: null,
    personaName: null,
    before: Object.fromEntries(prev.map((r) => [name(r.persona_id), r.credits])),
    after: Object.fromEntries(alloc.map((a) => [name(a.personaId), a.credits])),
    rationale: reason,
    expectedImpactCents: 0,
    confidence: positive.length >= 2 ? 'medium' : 'low',
    reviewDays: settings.reviewDays,
    baseline: {
      weeklyProfitCents: round((sum(rows.map((r) => r.profitCents)) / settings.leverWindowDays) * 7),
      windowDays: settings.leverWindowDays,
      scores: Object.fromEntries([...scores].map(([id, s]) => [id, Math.round(s * 10_000) / 10_000])),
      advisory: true,
      modelledImpactCents: expected,
    },
    effect: { type: 'allocation', weekStart, rows: alloc },
  };
}

// ───────────────────────────── Apply, log, measure ─────────────────────────────

interface LeverRow {
  id: string;
  studio_id: string;
  persona_id: string | null;
  lever: LeverKind;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  rationale: string;
  expected_impact_cents: number;
  measured_impact_cents: number | null;
  status: LeverAction['status'];
  review_at: Date;
  meta: Record<string, unknown>;
  created_at: Date;
  measured_at: Date | null;
}

export const leverFromRow = (r: LeverRow): LeverAction => ({
  id: r.id,
  studioId: r.studio_id,
  personaId: r.persona_id,
  lever: r.lever,
  before: r.before,
  after: r.after,
  rationale: r.rationale,
  expectedImpactCents: r.expected_impact_cents,
  measuredImpactCents: r.measured_impact_cents,
  status: r.status,
  createdAt: new Date(r.created_at),
  measuredAt: r.measured_at ? new Date(r.measured_at) : null,
});

/** Writes one lever action and its effect (override or allocation) atomically, then audits it. */
export async function applyProposal(db: Db, studioId: string, p: LeverProposal, now: Date): Promise<LeverAction | null> {
  return db.transaction(async (tx) => {
    if (p.effect.type === 'routing') {
      const taken = await tx.maybeOne(
        `SELECT 1 FROM profit_routing_override WHERE studio_id = $1 AND persona_id IS NOT DISTINCT FROM $2 AND agent = $3 AND active`,
        [studioId, p.personaId, p.effect.agent],
      );
      if (taken) return null;
    }
    const row = await tx.one<LeverRow>(
      `INSERT INTO profit_lever_action (studio_id, persona_id, lever, before, after, rationale, expected_impact_cents, review_at, meta, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb, $10) RETURNING *`,
      [
        studioId,
        p.personaId,
        p.lever,
        json(p.before),
        json(p.after),
        p.rationale,
        p.expectedImpactCents,
        addDays(now, p.reviewDays),
        json({ baseline: p.baseline, confidence: p.confidence }),
        now,
      ],
    );
    const e = p.effect;
    if (e.type === 'cadence') {
      await tx.query(
        `INSERT INTO profit_cadence_override (studio_id, persona_id, effective_from, posts_per_week, format_mix, purpose_mix, source, reason, lever_action_id, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'lever', $7, $8, $9)`,
        [studioId, p.personaId, isoDate(e.effectiveFrom), e.target.postsPerWeek, json(e.target.formatMix), json(e.target.purposeMix), p.rationale, row.id, now],
      );
    } else if (e.type === 'routing') {
      await tx.query(
        `INSERT INTO profit_routing_override (studio_id, persona_id, agent, tier, reason, lever_action_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [studioId, p.personaId, e.agent, e.tier, p.rationale, row.id, now],
      );
    } else {
      for (const a of e.rows) {
        await tx.query(
          `INSERT INTO budget_allocation (studio_id, persona_id, week_start, clips, llm_usd, credits, notes, source, score, lever_action_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'lever', $8, $9)
           ON CONFLICT (studio_id, COALESCE(persona_id::text, ''), week_start) DO UPDATE SET
             clips = EXCLUDED.clips, llm_usd = EXCLUDED.llm_usd, credits = EXCLUDED.credits, notes = EXCLUDED.notes,
             source = 'lever', score = EXCLUDED.score, lever_action_id = EXCLUDED.lever_action_id`,
          [studioId, a.personaId, isoDate(e.weekStart), a.clips, a.llmUsd, a.credits, a.personaId ? null : 'Studio reserve (new launches, tests)', a.score, row.id],
        );
      }
    }
    await tx.query(`INSERT INTO decision (studio_id, persona_id, agent, summary, rationale, outcome) VALUES ($1, $2, 'profit-engine', $3, $4, $5::jsonb)`, [
      studioId,
      p.personaId,
      `Lever ${p.lever}${p.personaName ? ` for ${p.personaName}` : ''}`,
      p.rationale,
      json({ lever_action_id: row.id, expected_impact_cents: p.expectedImpactCents }),
    ]);
    await audit(tx, {
      studioId,
      personaId: p.personaId,
      actor: PROFIT_ENGINE_ACTOR,
      action: 'profit.lever_applied',
      entityType: 'profit_lever_action',
      entityId: row.id,
      data: { lever: p.lever, before: p.before, after: p.after, expected_impact_cents: p.expectedImpactCents },
    });
    return leverFromRow(row);
  });
}

/** Plans every lever (dry run): what the engine would do now. Format mix builds on a planned cadence change. */
export async function planLevers(inp: LeverInputs, opts: { ignoreCooldown?: boolean } = {}): Promise<LeverProposal[]> {
  const out: LeverProposal[] = [];
  for (const p of inp.personas) {
    const cadence = await planCadence(inp, p.id, opts);
    if (cadence) out.push(cadence);
    const fmt = await planFormatMix(inp, p.id, { ...opts, current: cadence?.effect.type === 'cadence' ? cadence.effect.target : undefined });
    if (fmt) out.push(fmt);
    out.push(...(await planRouting(inp, p.id, opts)));
  }
  const alloc = await planAllocation(inp, { ignoreExisting: opts.ignoreCooldown });
  if (alloc) out.push(alloc);
  return out;
}

/** Pulls every lever that is due, within bounds, and logs each action. Idempotent within a week. */
export async function runLevers(db: Db, studioId: string, now: Date): Promise<LeverAction[]> {
  const inp = await leverInputs(db, studioId, now);
  const applied: LeverAction[] = [];
  for (const p of inp.personas) {
    const cadence = await planCadence(inp, p.id);
    if (cadence) {
      const a = await applyProposal(db, studioId, cadence, now);
      if (a) applied.push(a);
    }
    // Reads the target the cadence lever just wrote, so the two compose.
    const fmt = await planFormatMix(inp, p.id);
    if (fmt) {
      const a = await applyProposal(db, studioId, fmt, now);
      if (a) applied.push(a);
    }
    for (const r of await planRouting(inp, p.id)) {
      const a = await applyProposal(db, studioId, r, now);
      if (a) applied.push(a);
    }
  }
  const alloc = await planAllocation(inp);
  if (alloc) {
    const a = await applyProposal(db, studioId, alloc, now);
    if (a) applied.push(a);
  }
  return applied;
}

export async function listLeverActions(db: Db, studioId: string, opts: { personaId?: string | null; limit?: number; since?: Date } = {}): Promise<LeverAction[]> {
  const rows = await db.query<LeverRow>(
    `SELECT * FROM profit_lever_action WHERE studio_id = $1 AND ($2::uuid IS NULL OR persona_id = $2) AND ($3::timestamptz IS NULL OR created_at >= $3)
      ORDER BY created_at DESC LIMIT $4`,
    [studioId, opts.personaId ?? null, opts.since ?? null, opts.limit ?? 50],
  );
  return rows.map(leverFromRow);
}

/** Average weekly profit of a scope (persona, or the whole studio when null) over [from, to). */
async function scopeWeeklyProfit(db: Db, studioId: string, personaId: string | null, from: Date, to: Date): Promise<number> {
  const days = Math.max(1, (to.getTime() - from.getTime()) / DAY_MS);
  const rows = aggregate(await loadFacts(db, { studioId, from, to, personaId }), 'persona');
  return (sum(rows.map((r) => r.profitCents)) / days) * 7;
}

/**
 * Measures lever actions whose review window has passed (FR-24.2): the change in the scope's weekly profit vs the
 * baseline, as a monthly figure (for routing: the LLM spend saved). A routing step-down whose QC pass rate fell
 * below the revert threshold is reverted first.
 */
export async function measureLevers(db: Db, studioId: string, now: Date): Promise<{ measured: LeverAction[]; reverted: LeverAction[] }> {
  const settings = await getProfitSettings(db, studioId);
  const measured: LeverAction[] = [];
  const reverted: LeverAction[] = [];

  // Routing step-downs: revert whenever quality drops while the cheaper tier is still in force, measured or not
  // (planRouting skips a persona that has an override, so nothing else would ever re-check it). Recent QC only.
  const routing = await db.query<LeverRow>(
    `SELECT a.* FROM profit_lever_action a
      WHERE a.studio_id = $1 AND a.lever = 'model_routing' AND a.status IN ('applied','measured') AND a.created_at <= $2
        AND EXISTS (SELECT 1 FROM profit_routing_override o WHERE o.lever_action_id = a.id AND o.active)`,
    [studioId, addDays(now, -3)],
  );
  for (const r of routing) {
    if (!r.persona_id) continue;
    const stage = String((r.meta.baseline as Record<string, unknown> | undefined)?.qcStage ?? 'Q1');
    const since = new Date(Math.max(new Date(r.created_at).getTime(), addDays(now, -14).getTime()));
    const qc = await qcPassRate(db, r.persona_id, stage, since, now);
    const agent = String(r.after.agent ?? 'scriptwriter');
    if (qc.n >= 4 && qc.rate < settings.routingRevertRate) {
      const row = await db.transaction(async (tx) => {
        await tx.query(`UPDATE profit_routing_override SET active = false, ended_at = $2 WHERE lever_action_id = $1 AND active`, [r.id, now]);
        const u = await tx.one<LeverRow>(
          `UPDATE profit_lever_action SET status = 'reverted',
                  measured_impact_cents = CASE WHEN status = 'measured' THEN measured_impact_cents ELSE 0 END, measured_at = COALESCE(measured_at, $2),
                  meta = meta || $3::jsonb WHERE id = $1 RETURNING *`,
          [r.id, now, json({ revert: { passRate: qc.rate, checks: qc.n, at: now.toISOString(), after: r.status, reason: `QC ${stage} pass rate fell to ${Math.round(qc.rate * 100)}%` } })],
        );
        await audit(tx, {
          studioId,
          personaId: r.persona_id,
          actor: PROFIT_ENGINE_ACTOR,
          action: 'profit.lever_reverted',
          entityType: 'profit_lever_action',
          entityId: r.id,
          data: { agent, pass_rate: qc.rate, checks: qc.n },
        });
        return u;
      });
      reverted.push(leverFromRow(row));
    }
  }

  const due = await db.query<LeverRow>(
    `SELECT * FROM profit_lever_action WHERE studio_id = $1 AND status = 'applied' AND review_at <= $2 AND lever <> 'credit_reallocation' ORDER BY created_at`,
    [studioId, now],
  );
  for (const r of due) {
    const created = new Date(r.created_at);
    const end = new Date(Math.min(now.getTime(), new Date(r.review_at).getTime()));
    const baseline = (r.meta.baseline ?? {}) as Record<string, number>;
    let impact: number;
    if (r.lever === 'model_routing' && r.persona_id) {
      const days = Math.max(1, (end.getTime() - created.getTime()) / DAY_MS);
      const after = (await agentSpendUsd(db, r.persona_id, String(r.after.agent ?? 'scriptwriter'), created, end)) / days;
      impact = round(((Number(baseline.dailySpendUsd) || 0) - after) * DAYS_PER_MONTH * 100);
    } else {
      const after = await scopeWeeklyProfit(db, studioId, r.persona_id, created, end);
      impact = round((after - (Number(baseline.weeklyProfitCents) || 0)) * WEEKS_PER_MONTH);
    }
    const row = await db.maybeOne<LeverRow>(
      `UPDATE profit_lever_action SET status = 'measured', measured_impact_cents = $2, measured_at = $3 WHERE id = $1 AND status = 'applied' RETURNING *`,
      [r.id, impact, now],
    );
    if (row) measured.push(leverFromRow(row));
  }
  return { measured, reverted };
}
