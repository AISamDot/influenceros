import type { Db } from '@ios/db';
import { rankActions } from './actions';
import { forecastStudio, latestForecast } from './forecast';
import { listLeverActions } from './levers';
import { aggregate, loadFacts } from './pnl';
import type { ForecastBand, ProfitCardData } from './types';
import { isoDate, monthKey, mondayOf, startOfMonth, sum } from './util';

/** Month-to-date profit (all personas plus studio overhead), cents. */
export async function monthToDateProfit(db: Db, studioId: string, now: Date): Promise<number> {
  const rows = aggregate(await loadFacts(db, { studioId, from: startOfMonth(now), to: now }), 'persona');
  return sum(rows.map((r) => r.profitCents));
}

/** The rest-of-month forecast band: this week's stored studio forecast, or a quick fresh one. */
async function monthRemainder(db: Db, studioId: string, now: Date): Promise<ForecastBand> {
  const stored = await latestForecast(db, studioId, null);
  const fresh = stored && isoDate(mondayOf(stored.generatedAt)) === isoDate(mondayOf(now)) && monthKey(stored.generatedAt) === monthKey(now);
  if (fresh && stored.monthRemainderCents) return stored.monthRemainderCents;
  const f = await forecastStudio(db, { studioId, now, runs: 300 });
  return f.studio.monthRemainderCents ?? { p10: 0, median: 0, p90: 0 };
}

/** The Profit card on the Studio wall (PRD §3.11.6): month profit vs forecast, top 3 levers, top 3 opportunities. */
export async function profitCard(db: Db, studioId: string, now: Date = new Date()): Promise<ProfitCardData> {
  const [mtd, rem, levers, opportunities] = await Promise.all([
    monthToDateProfit(db, studioId, now),
    monthRemainder(db, studioId, now),
    listLeverActions(db, studioId, { limit: 3 }),
    rankActions(db, studioId, now, { limit: 3 }),
  ]);
  return {
    month: monthKey(now),
    profitCents: mtd,
    forecastCents: { p10: mtd + rem.p10, median: mtd + rem.median, p90: mtd + rem.p90 },
    topLevers: levers,
    opportunities,
  };
}
