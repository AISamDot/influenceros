import { type Db, json } from '@ios/db';
import { weeklySeries, type WeekPoint } from './pnl';
import { getProfitSettings } from './settings';
import type { Forecast, ForecastBand } from './types';
import { addDays, clamp, DAY_MS, hashSeed, isoDate, mean, mondayOf, mulberry32, normal, quantileSorted, round, startOfDay, startOfNextMonth, sum, WEEK_MS } from './util';

/**
 * Rolling 90-day profit forecast (PRD §3.11.4, FR-24.4): a small Monte Carlo per persona fitted on its recent
 * weekly P&L, summed run by run into the studio total. Deterministic for a given seed, so a forecast is
 * reproducible and testable.
 *
 * Per persona, from the last full weeks since it became active (up to 8):
 *  - gross sales: log-linear trend (growth shrunk toward 0 when history is short, clamped to ±20%/week) with
 *    lognormal week-to-week noise from the fit residuals (σ 0.15–1.0; 0.5 when there are < 3 weeks);
 *  - fees and refunds: the persona's historical share of gross (11% when it has no sales yet, PRD Appendix E);
 *  - cost: the recent weekly level with 10% noise.
 * Each run also draws its own growth rate (parameter uncertainty), so the fan widens with the horizon.
 */

export const HORIZON_WEEKS = 13; // 91 days
export const HISTORY_WEEKS = 8;
/** Weeks averaged for the gross and cost level. */
export const LEVEL_WEEKS = 6;
const DEFAULT_FEE_RATE = 0.11;
const ACTIVE_STATES = ['SETUP', 'TESTING', 'RE_ANGLE', 'MONETISING', 'SCALING', 'BRAND'] as const;

export interface ForecastInputs {
  weeksOfHistory: number;
  grossLevelCents: number;
  growth: number;
  volatility: number;
  costLevelCents: number;
  feeRate: number;
}

/**
 * Fits the model to a weekly series (oldest first). Leading weeks with no activity are ignored. The current
 * partial week (`partial`, scaled to a full week) joins the level estimates with weight elapsed/7 once two days have
 * passed, so a change this week shows up before the week closes.
 */
export function fitSeries(history: readonly WeekPoint[], partial?: { grossCents: number; costCents: number; elapsedDays: number }): ForecastInputs {
  const first = history.findIndex((w) => w.grossCents > 0 || w.costCents > 0 || w.posts > 0);
  const h = first < 0 ? [] : history.slice(first);
  const n = h.length;
  // Level: the mean of the last LEVEL_WEEKS weeks, so lumpy sales (a sale every other week) don't make the level
  // depend on which week the history happens to end on.
  const recent = h.slice(-Math.min(LEVEL_WEEKS, n));
  const gross = h.map((w) => w.grossCents);
  const grossSum = sum(gross);
  const feeRate = grossSum > 0 ? clamp(sum(h.map((w) => w.feesCents + w.refundsCents)) / grossSum, 0, 0.5) : DEFAULT_FEE_RATE;
  let growth = 0;
  let volatility = 0.5;
  if (n >= 3 && grossSum > 0) {
    const slopeOf = (vals: readonly number[]) => {
      const ys = vals.map((g) => Math.log(g + 500));
      const xs = ys.map((_, i) => i);
      const mx = mean(xs);
      const my = mean(ys);
      const sxx = sum(xs.map((x) => (x - mx) ** 2));
      return sxx ? sum(xs.map((x, i) => (x - mx) * (ys[i]! - my))) / sxx : 0;
    };
    // When zero weeks are common, fit the trend on 2-week sums (newest pairs first) so the zeros don't set it.
    const zeroShare = gross.filter((g) => g <= 0).length / n;
    let slope: number;
    if (zeroShare >= 0.25 && n >= 4) {
      const pairs: number[] = [];
      for (let i = n; i - 2 >= 0; i -= 2) pairs.unshift(gross[i - 2]! + gross[i - 1]!);
      slope = slopeOf(pairs) / 2;
    } else {
      slope = slopeOf(gross);
    }
    const y = gross.map((g) => Math.log(g + 500));
    const mx = (n - 1) / 2;
    const my = mean(y);
    const resid = y.map((v, i) => v - (my + slope * (i - mx)));
    const sd = Math.sqrt(sum(resid.map((r) => r * r)) / Math.max(1, n - 2));
    growth = clamp(slope * (n / (n + 4)), -0.2, 0.2);
    volatility = clamp(sd, 0.15, 1);
  }
  const level = (pick: (w: { grossCents: number; costCents: number }) => number) => {
    const full = recent.map(pick);
    const weight = partial && partial.elapsedDays >= 2 ? Math.min(1, partial.elapsedDays / 7) : 0;
    if (!weight) return mean(full);
    const rate = (pick(partial!) / partial!.elapsedDays) * 7;
    return (sum(full) + weight * rate) / (full.length + weight);
  };
  return {
    weeksOfHistory: n,
    grossLevelCents: level((w) => w.grossCents),
    growth,
    volatility,
    costLevelCents: level((w) => w.costCents),
    feeRate,
  };
}

/** Runs × (HORIZON_WEEKS + 1) weekly profit draws; index 0 is the current week. */
export function simulate(inputs: ForecastInputs, runs: number, rand: () => number): Float64Array[] {
  const out: Float64Array[] = [];
  const { grossLevelCents: r0, volatility: s, costLevelCents: c0, feeRate } = inputs;
  for (let r = 0; r < runs; r++) {
    const g = inputs.growth + 0.03 * normal(rand);
    const row = new Float64Array(HORIZON_WEEKS + 1);
    for (let k = 0; k <= HORIZON_WEEKS; k++) {
      const gross = r0 > 0 ? r0 * Math.exp(g * k - (s * s) / 2 + s * normal(rand)) : 0;
      const cost = c0 > 0 ? c0 * Math.exp(-0.005 + 0.1 * normal(rand)) : 0;
      row[k] = gross * (1 - feeRate) - cost;
    }
    out.push(row);
  }
  return out;
}

function band(values: number[]): ForecastBand {
  const s = [...values].sort((a, b) => a - b);
  return { p10: round(quantileSorted(s, 0.1)), median: round(quantileSorted(s, 0.5)), p90: round(quantileSorted(s, 0.9)) };
}

/** Day weights per simulated week for "tomorrow → end of month". */
function monthWeights(now: Date, monday: Date): number[] {
  const w = new Array<number>(HORIZON_WEEKS + 1).fill(0);
  const end = startOfNextMonth(now);
  for (let d = addDays(startOfDay(now), 1); d < end; d = addDays(d, 1)) {
    const k = Math.floor((d.getTime() - monday.getTime()) / WEEK_MS);
    if (k >= 0 && k <= HORIZON_WEEKS) w[k]! += 1 / 7;
  }
  return w;
}

function summarise(personaId: string | null, runs: Float64Array[], monday: Date, weights: number[], now: Date, weeksOfHistory: number): Forecast {
  const weekly: Forecast['weekly'] = [];
  for (let k = 1; k <= HORIZON_WEEKS; k++) {
    weekly.push({ weekStart: isoDate(new Date(monday.getTime() + k * WEEK_MS)), ...band(runs.map((r) => r[k]!)) });
  }
  // Negative weeks are judged on the expected (mean) profit: with skewed sales the median sits well below the mean,
  // and a persona earning money on average must not read as a loss.
  let negativeWeeks = 0;
  for (let k = 1; k <= HORIZON_WEEKS; k++) {
    if (mean(runs.map((r) => r[k]!)) < 0) negativeWeeks++;
    else break;
  }
  return {
    personaId,
    horizonDays: 90,
    runs: runs.length,
    weekly,
    totalCents: band(runs.map((r) => sum(Array.from(r.subarray(1))))),
    negativeWeeks,
    generatedAt: now,
    monthRemainderCents: band(runs.map((r) => sum(weights.map((w, k) => w * r[k]!)))),
    weeksOfHistory,
  };
}

export interface StudioForecast {
  studio: Forecast;
  personas: Forecast[];
  inputs: Map<string, ForecastInputs>;
}

/**
 * Forecasts every active persona and the studio total (personas + studio overhead, summed per run).
 * `seed` fixes the randomness (default: derived from the studio and the week, so a week's forecast is stable).
 */
export async function forecastStudio(
  db: Db,
  q: { studioId: string; now: Date; runs?: number; seed?: number; personaId?: string | null },
): Promise<StudioForecast> {
  const settings = await getProfitSettings(db, q.studioId);
  const runs = q.runs ?? settings.forecastRuns;
  const monday = mondayOf(q.now);
  const personas = await db.query<{ id: string }>(
    `SELECT id FROM persona WHERE studio_id = $1 AND state = ANY($2::text[]) AND ($3::uuid IS NULL OR id = $3) ORDER BY id`,
    [q.studioId, [...ACTIVE_STATES], q.personaId ?? null],
  );
  const series = await weeklySeries(db, { studioId: q.studioId, before: monday, weeks: HISTORY_WEEKS, personaId: q.personaId });
  // The current (partial) week, for personas with no full week yet.
  const partial = await weeklySeries(db, { studioId: q.studioId, before: addDays(monday, 7), weeks: 1, personaId: q.personaId });
  const elapsedDays = Math.max(1, (q.now.getTime() - monday.getTime()) / DAY_MS);
  const weights = monthWeights(q.now, monday);
  const baseSeed = q.seed ?? hashSeed(`${q.studioId}:${isoDate(monday)}`);

  const total: Float64Array[] = Array.from({ length: runs }, () => new Float64Array(HORIZON_WEEKS + 1));
  const out: Forecast[] = [];
  const inputs = new Map<string, ForecastInputs>();
  for (const { id } of personas) {
    const hist = series.byPersona.get(id) ?? [];
    const cur = partial.byPersona.get(id)?.[0];
    const fit = fitSeries(hist, cur ? { grossCents: cur.grossCents, costCents: cur.costCents, elapsedDays } : undefined);
    inputs.set(id, fit);
    const sims = simulate(fit, runs, mulberry32(baseSeed ^ hashSeed(id)));
    for (let r = 0; r < runs; r++) for (let k = 0; k <= HORIZON_WEEKS; k++) total[r]![k]! += sims[r]![k]!;
    out.push(summarise(id, sims, monday, weights, q.now, fit.weeksOfHistory));
  }
  if (!q.personaId) {
    // Studio overhead (studio-level debits) as a cost-only series.
    const recent = series.studioOverhead.slice(-3);
    const overhead: ForecastInputs = { weeksOfHistory: HISTORY_WEEKS, grossLevelCents: 0, growth: 0, volatility: 0.5, costLevelCents: mean(recent), feeRate: 0 };
    inputs.set('studio', overhead);
    const sims = simulate(overhead, runs, mulberry32(baseSeed ^ hashSeed('studio')));
    for (let r = 0; r < runs; r++) for (let k = 0; k <= HORIZON_WEEKS; k++) total[r]![k]! += sims[r]![k]!;
  }
  const maxHistory = Math.max(0, ...out.map((f) => f.weeksOfHistory ?? 0));
  return { studio: summarise(null, total, monday, weights, q.now, maxHistory), personas: out, inputs };
}

/** Stores this week's forecasts (one row per scope and week; a re-run replaces it). */
export async function storeForecasts(db: Db, studioId: string, f: StudioForecast, now: Date): Promise<void> {
  const week = isoDate(mondayOf(now));
  for (const fc of [f.studio, ...f.personas]) {
    await db.query(
      `INSERT INTO profit_forecast (studio_id, persona_id, week_start, horizon_days, runs, weekly, total, month_remainder, negative_weeks, inputs, generated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11)
       ON CONFLICT (studio_id, COALESCE(persona_id::text, ''), week_start) DO UPDATE SET
         runs = EXCLUDED.runs, weekly = EXCLUDED.weekly, total = EXCLUDED.total, month_remainder = EXCLUDED.month_remainder,
         negative_weeks = EXCLUDED.negative_weeks, inputs = EXCLUDED.inputs, generated_at = EXCLUDED.generated_at`,
      [
        studioId,
        fc.personaId,
        week,
        fc.horizonDays,
        fc.runs,
        json(fc.weekly),
        json(fc.totalCents),
        json(fc.monthRemainderCents ?? null),
        fc.negativeWeeks,
        json({ ...(f.inputs.get(fc.personaId ?? 'studio') ?? {}), weeksOfHistory: fc.weeksOfHistory ?? 0 }),
        now,
      ],
    );
  }
}

interface ForecastRow {
  persona_id: string | null;
  runs: number;
  weekly: Forecast['weekly'];
  total: ForecastBand;
  month_remainder: ForecastBand | null;
  negative_weeks: number;
  inputs: { weeksOfHistory?: number };
  generated_at: Date;
}
const fromRow = (r: ForecastRow): Forecast => ({
  personaId: r.persona_id,
  horizonDays: 90,
  runs: r.runs,
  weekly: r.weekly,
  totalCents: r.total,
  negativeWeeks: r.negative_weeks,
  generatedAt: new Date(r.generated_at),
  ...(r.month_remainder ? { monthRemainderCents: r.month_remainder } : {}),
  weeksOfHistory: r.inputs?.weeksOfHistory ?? 0,
});

/** The most recent stored forecast for a scope (persona id, or null for the studio total). */
export async function latestForecast(db: Db, studioId: string, personaId: string | null): Promise<Forecast | null> {
  const r = await db.maybeOne<ForecastRow>(
    `SELECT * FROM profit_forecast WHERE studio_id = $1 AND persona_id IS NOT DISTINCT FROM $2 ORDER BY week_start DESC, generated_at DESC LIMIT 1`,
    [studioId, personaId],
  );
  return r ? fromRow(r) : null;
}

/** This week's stored persona forecasts. */
export async function weekForecasts(db: Db, studioId: string, now: Date): Promise<Forecast[]> {
  const rows = await db.query<ForecastRow>(
    `SELECT * FROM profit_forecast WHERE studio_id = $1 AND persona_id IS NOT NULL AND week_start = $2`,
    [studioId, isoDate(mondayOf(now))],
  );
  return rows.map(fromRow);
}

