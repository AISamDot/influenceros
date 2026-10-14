import type { JobContext, JobHandlerMap, ScheduledTask, StudioServices } from '@ios/agents';
import { runWeeklyCycle } from './cycle';
import { forecastStudio, storeForecasts } from './forecast';
import { measureLevers } from './levers';
import { enqueueOnce } from './scheduler';
import { addDays, isoDate, mondayOf, startOfDay } from './util';

/** Job kinds (namespace `profit.*`). */
export const PROFIT_JOBS = {
  weeklyCycle: 'profit.weekly_cycle',
  measure: 'profit.measure',
  forecast: 'profit.forecast',
} as const;

/** The weekly cycle runs from Monday 06:00 UTC (the week's data is in by then). */
export const WEEKLY_CYCLE_HOUR_UTC = 6;
/** Daily lever measurement at 05:00 UTC. */
export const DAILY_MEASURE_HOUR_UTC = 5;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function studioOf(ctx: JobContext): string {
  const id = ctx.job.payload.studio_id ?? ctx.job.studio_id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error(`${ctx.job.kind}: payload.studio_id missing`);
  return id;
}

export const profitJobs: JobHandlerMap = {
  [PROFIT_JOBS.weeklyCycle]: async (ctx) => runWeeklyCycle(ctx.services, studioOf(ctx), ctx.services.now(), ctx.heartbeat),
  [PROFIT_JOBS.measure]: async (ctx) => {
    const r = await measureLevers(ctx.services.db, studioOf(ctx), ctx.services.now());
    return { measured: r.measured.length, reverted: r.reverted.length };
  },
  [PROFIT_JOBS.forecast]: async (ctx) => {
    const studioId = studioOf(ctx);
    const now = ctx.services.now();
    const f = await forecastStudio(ctx.services.db, { studioId, now });
    await storeForecasts(ctx.services.db, studioId, f, now);
    return { median: f.studio.totalCents.median, personas: f.personas.length };
  },
};

/** The most recent `hour`:00 UTC on a Monday at or before `now`. */
export function lastWeeklyMark(now: Date, hour = WEEKLY_CYCLE_HOUR_UTC): Date {
  const m = new Date(mondayOf(now).getTime() + hour * 3_600_000);
  return m <= now ? m : addDays(m, -7);
}
/** The most recent `hour`:00 UTC at or before `now`. */
export function lastDailyMark(now: Date, hour = DAILY_MEASURE_HOUR_UTC): Date {
  const m = new Date(startOfDay(now).getTime() + hour * 3_600_000);
  return m <= now ? m : addDays(m, -1);
}

const studios = (s: StudioServices) => s.db.query<{ id: string }>('SELECT id FROM studio ORDER BY created_at');

export const profitSchedules: readonly ScheduledTask[] = [
  {
    name: 'profit.weekly_cycle',
    due: (now, last) => !last || last < lastWeeklyMark(now),
    async run(services, now) {
      const week = isoDate(mondayOf(now));
      for (const { id } of await studios(services)) {
        await enqueueOnce(services.db, { kind: PROFIT_JOBS.weeklyCycle, studioId: id, payload: { studio_id: id, week_start: week }, priority: 50 });
      }
    },
  },
  {
    name: 'profit.daily_measure',
    due: (now, last) => !last || last < lastDailyMark(now),
    async run(services, now) {
      const day = isoDate(now);
      for (const { id } of await studios(services)) {
        await enqueueOnce(services.db, { kind: PROFIT_JOBS.measure, studioId: id, payload: { studio_id: id, day }, priority: 120 });
      }
    },
  },
];
