import type { FormatBenchmark, FormatPlan, FormatPlanService, ServiceBase, ServiceFactory, StudioServices } from '@ios/agents';
import { getSettings } from '@ios/core';
import type { Db } from '@ios/db';
import { getProfitSettings } from '@ios/profit';
import { recommendPlan, validatePlan } from './plan';
import { planInForce, savePlan } from './store';
import { mondayOf } from './time';

/**
 * The FormatPlanService on StudioServices (docs/IOS-5-CONTRACTS.md §5):
 *  - recommend: the Studio Manager's plan in Persona Generator step 6 (archetype, the Radar's niche benchmark or the
 *    default when there is none, the product ladder, the budget);
 *  - planFor: the plan in force (latest version + newer lever moves);
 *  - adoptPlan: writes the approved plan inside the Owner's launch transaction.
 */

/** The persona's monthly media budget in USD: its Higgsfield credit cap at the Profit Engine's credit price. */
export async function mediaBudgetUsd(db: Db, studioId: string, personaBudget?: Record<string, unknown> | null): Promise<number> {
  const [settings, profit] = await Promise.all([getSettings(db, studioId), getProfitSettings(db, studioId)]);
  const credits = Number(personaBudget?.hf_credits_month ?? settings.persona_default_caps.hf_credits_month);
  const usd = (credits * profit.creditPriceCents) / 100;
  return Number.isFinite(usd) && usd > 0 ? Math.round(usd * 100) / 100 : 50;
}

export async function benchmarkFor(services: Pick<StudioServices, 'radar'>, studioId: string, niche: string): Promise<FormatBenchmark | null> {
  try {
    return await services.radar.formatBenchmarks({ studioId, niche });
  } catch {
    return null;
  }
}

export const createFormatPlanService: ServiceFactory<FormatPlanService> = (base: ServiceBase, services: () => StudioServices) => ({
  async recommend(q): Promise<FormatPlan | null> {
    const benchmark = await benchmarkFor(services(), q.studioId, q.niche);
    const budget = q.budgetUsdPerMonth ?? (await mediaBudgetUsd(base.db, q.studioId));
    return recommendPlan({ niche: q.niche, archetype: q.archetype, ladder: q.ladder, budgetUsdPerMonth: budget, benchmark });
  },
  async planFor(personaId): Promise<FormatPlan | null> {
    const p = await planInForce(base.db, personaId, base.now());
    if (!p) return null;
    const { version: _v, leverReason: _r, ...plan } = p;
    return plan;
  },
  async adoptPlan(db, q): Promise<void> {
    const now = base.now();
    // An Owner-edited draft plan stays 'owner'; the Studio Manager's recommendation is adopted as 'recommended'.
    const plan = validatePlan({ ...q.plan, source: q.plan.source === 'owner' ? 'owner' : 'recommended' });
    await savePlan(db, { studioId: q.studioId, personaId: q.personaId, plan, actor: q.actor, now, effectiveFrom: mondayOf(now), action: 'formats.plan_adopted' });
  },
});
