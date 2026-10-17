import { budgetStatus } from '@troupe/core';
import type { Db } from '@troupe/db';
import { forecastStudio, weekForecasts } from './forecast';
import { type LeverProposal, leverInputs, planLevers } from './levers';
import { aggregate, FORMAT_LABELS, isSyntheticRow } from './pnl';
import type { Forecast, ProfitAction } from './types';
import { round, sum, WEEKS_PER_MONTH } from './util';

/**
 * "How do we make more profit?" (PRD §3.11.6, FR-24.5): a ranked list of actions with their expected monthly
 * dollar impact (ranked by impact weighted by confidence). Automatic levers come from the same planners the weekly cycle runs (dry run); the rest are
 * actions only the Owner can take (kills, cap raises) or other agents own (products, price tests).
 */

const TIER_NAMES: Record<string, string> = { fast: 'Haiku 5.5', standard: 'Sonnet 5.5', strong: 'Opus 5.5' };
const CONFIDENCE_WEIGHT: Record<ProfitAction['confidence'], number> = { high: 1, medium: 0.75, low: 0.5 };
/** Revenue per 1,000 views assumed for a persona with no sales yet, when the studio has no data either. */
const DEFAULT_RPM_CENTS = 150;

function leverTitle(p: LeverProposal): string {
  const who = p.personaName ?? 'Studio';
  switch (p.lever) {
    case 'cadence': {
      const from = Number(p.before.postsPerWeek);
      const to = Number(p.after.postsPerWeek);
      return `${to > from ? 'Raise' : 'Trim'} ${who} to ${to} posts a week (from ${from})`;
    }
    case 'format_mix': {
      const before = p.before.formatMix as Record<string, number>;
      const after = p.after.formatMix as Record<string, number>;
      const up = Object.keys(after).find((k) => after[k]! > (before[k] ?? 0));
      const down = Object.keys(after).find((k) => after[k]! < (before[k] ?? 0));
      return `Shift one ${who} slot from ${FORMAT_LABELS[down as keyof typeof FORMAT_LABELS] ?? down} to ${FORMAT_LABELS[up as keyof typeof FORMAT_LABELS] ?? up}`;
    }
    case 'model_routing':
      return `Run ${who}'s ${String(p.after.agent)} on ${TIER_NAMES[String(p.after.tier)] ?? p.after.tier}`;
    case 'credit_reallocation':
      return "Reallocate next week's credits by profit per credit";
  }
}

export async function rankActions(db: Db, studioId: string, now: Date, opts: { limit?: number; personaId?: string | null } = {}): Promise<ProfitAction[]> {
  const inp = await leverInputs(db, studioId, now);
  const { settings } = inp;
  const actions: Omit<ProfitAction, 'rank'>[] = [];

  for (const p of await planLevers(inp)) {
    actions.push({
      title: leverTitle(p),
      personaId: p.personaId,
      kind: p.lever,
      expectedImpactCents: p.expectedImpactCents,
      confidence: p.confidence,
      requiresOwner: false,
      rationale: p.rationale,
    });
  }

  // Kill candidates and pending kills (the Owner's call).
  let forecasts: Forecast[] = await weekForecasts(db, studioId, now);
  if (!forecasts.length) forecasts = (await forecastStudio(db, { studioId, now, runs: 300 })).personas;
  const pending = new Set(
    (await db.query<{ persona_id: string }>(`SELECT persona_id FROM approval WHERE studio_id = $1 AND status = 'pending' AND kind IN ('persona_kill','persona_retire')`, [studioId])).map(
      (r) => r.persona_id,
    ),
  );
  for (const f of forecasts) {
    if (!f.personaId) continue;
    const p = inp.personas.find((x) => x.id === f.personaId);
    if (!p) continue;
    const monthLoss = -sum(f.weekly.slice(0, 4).map((w) => w.median));
    if (pending.has(p.id)) {
      actions.push({
        title: `Decide the pending kill proposal for ${p.name}`,
        personaId: p.id,
        kind: 'kill_candidate',
        expectedImpactCents: Math.max(0, round(monthLoss)),
        confidence: 'medium',
        requiresOwner: true,
        rationale: `A kill or retire proposal for ${p.name} is waiting in Approvals. Forecast: ${f.negativeWeeks} negative weeks ahead.`,
      });
    } else if (f.negativeWeeks >= settings.killNegativeWeeks && (f.weeksOfHistory ?? 0) >= settings.minWeeksBeforeKill) {
      actions.push({
        title: `Kill or re-angle ${p.name} (forecast negative for ${f.negativeWeeks} weeks)`,
        personaId: p.id,
        kind: 'kill_candidate',
        expectedImpactCents: Math.max(0, round(monthLoss)),
        confidence: f.negativeWeeks >= 8 ? 'high' : 'medium',
        requiresOwner: true,
        rationale: `${p.name}'s 90-day forecast median is ${(f.totalCents.median / 100).toFixed(0)} USD with ${f.negativeWeeks} straight negative weeks. Killing it stops the loss; the Studio Manager proposes it in Approvals.`,
      });
    }
  }

  // Cap raises for winners that are about to hit their caps (Owner only).
  const rows = aggregate(inp.window, 'persona').filter((r) => !isSyntheticRow(r));
  for (const r of rows) {
    if (!r.posts || r.costPerPostCents <= 0) continue;
    const ratio = r.revenuePerPostCents / r.costPerPostCents;
    if (ratio < settings.raiseRatio) continue;
    const [llm, hf] = await Promise.all([
      budgetStatus(db, { studioId, personaId: r.key, unit: 'llm_usd', now }),
      budgetStatus(db, { studioId, personaId: r.key, unit: 'hf_credits', now }),
    ]);
    const usage = Math.max(llm.persona?.ratio ?? 0, hf.persona?.ratio ?? 0);
    if (usage < 0.8) continue;
    actions.push({
      title: `Raise ${r.label}'s monthly caps (at ${Math.round(Math.min(usage, 9.99) * 100)}%, ${ratio.toFixed(1)}× return per post)`,
      personaId: r.key,
      kind: 'cap_raise',
      expectedImpactCents: round(3 * WEEKS_PER_MONTH * (r.revenuePerPostCents - r.costPerPostCents) * 0.5),
      confidence: 'medium',
      requiresOwner: true,
      rationale: `${r.label} returns ${ratio.toFixed(1)}× its cost per post but has used ${Math.round(usage * 100)}% of a monthly cap. Raising caps is the Owner's call (Settings or a spend-over-cap card).`,
    });
  }

  // Products: personas with an audience but nothing paid to sell (the Monetization Agent builds it).
  const live = new Set(
    (await db.query<{ persona_id: string }>(`SELECT DISTINCT p.persona_id FROM product p JOIN persona x ON x.id = p.persona_id WHERE x.studio_id = $1 AND p.status = 'live' AND p.price_cents > 0`, [studioId])).map(
      (r) => r.persona_id,
    ),
  );
  const selling = rows.filter((r) => r.revenueCents > 0 && r.views > 0);
  const rpm = selling.length ? (sum(selling.map((r) => r.revenueCents)) / sum(selling.map((r) => r.views))) * 1000 : DEFAULT_RPM_CENTS;
  for (const r of rows) {
    // An audience with no sales and nothing paid live: the Monetization Agent's next build.
    if (live.has(r.key) || r.revenueCents > 0 || r.views < 5_000) continue;
    const monthlyViews = (r.views / settings.leverWindowDays) * 30.44;
    actions.push({
      title: `Ship a first paid product for ${r.label}`,
      personaId: r.key,
      kind: 'product',
      expectedImpactCents: round((monthlyViews / 1000) * rpm * 0.25),
      confidence: 'low',
      requiresOwner: false,
      rationale: `${r.label} drew ${r.views.toLocaleString('en-US')} views in ${settings.leverWindowDays} days with no paid product live. At the studio's ${(rpm / 100).toFixed(2)} USD per 1,000 views, a first product is worth testing; the Monetization Agent picks it.`,
    });
  }

  // Price tests inside the band for proven products.
  const products = await db.query<{ id: string; name: string; persona_id: string; orders: number; revenue: number; refunds: number }>(
    `SELECT pr.id, pr.name, pr.persona_id, count(o.id)::int AS orders, COALESCE(SUM(o.amount_cents),0)::int AS revenue,
            count(o.id) FILTER (WHERE o.status IN ('refunded','partially_refunded'))::int AS refunds
       FROM product pr JOIN persona x ON x.id = pr.persona_id JOIN orders o ON o.product_id = pr.id
      WHERE x.studio_id = $1 AND pr.status = 'live' AND o.ordered_at >= $2 AND o.ordered_at < $3
      GROUP BY pr.id, pr.name, pr.persona_id`,
    [studioId, inp.window.from, inp.window.to],
  );
  for (const pr of products) {
    if (pr.orders < 20 || pr.refunds / pr.orders >= 0.05) continue;
    const monthly = (pr.revenue / settings.leverWindowDays) * 30.44;
    actions.push({
      title: `Test +10% on "${pr.name}" within the price band`,
      personaId: pr.persona_id,
      kind: 'price_test',
      expectedImpactCents: round(monthly * 0.05),
      confidence: 'low',
      requiresOwner: false,
      rationale: `${pr.orders} orders in ${settings.leverWindowDays} days with a ${Math.round((pr.refunds / pr.orders) * 100)}% refund rate: room to test a higher price (minimum sample sizes, stop early if conversion drops).`,
    });
  }

  // Ranked by risk-adjusted impact (a low-confidence idea needs twice the dollars to beat a sure one).
  const score = (a: Omit<ProfitAction, 'rank'>) => a.expectedImpactCents * CONFIDENCE_WEIGHT[a.confidence];
  const filtered = opts.personaId ? actions.filter((a) => a.personaId === opts.personaId) : actions;
  return filtered
    .sort((a, b) => score(b) - score(a) || Number(a.requiresOwner) - Number(b.requiresOwner))
    .slice(0, opts.limit ?? 10)
    .map((a, i) => ({ rank: i + 1, ...a }));
}
