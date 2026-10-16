import { ApifyWeeklyCapError, enqueueOnceFor, type JobContext, type JobHandlerMap, type ScheduledTask, type StudioServices } from '@ios/agents';
import { BudgetExceededError, DeferJob } from '@ios/core';
import type { Db } from '@ios/db';
import { loadConfig, nicheKey } from './config';
import { discoverNiche, nichesToScan } from './discovery';
import { detectTrends, pushDemandSignals } from './insights';
import { weeklyRemix } from './remix';
import { postTrendReport } from './report';
import { reviewNiche } from './review';
import { isoDate, weekStartOf } from './scrape';
import { snapshotNiche } from './snapshot';

/**
 * Stream I's queue jobs and schedule. The weekly flow, per studio:
 *   radar.weekly (schedule, Mondays) → radar.scan per niche (discover → snapshot + score → review → trends →
 *   demand signals) → radar.finish (waits for the scans) → remix.weekly per active persona (Winner Finder shortlist →
 *   remix briefs + double-downs → ideas) → radar.report (the Trend Report in the Studio chat).
 * Every handler is idempotent and resumes from stored state. Over the Apify weekly cap a scan defers until the oldest
 * spend leaves the trailing 7 days (never raising the cap); over an LLM budget it defers too.
 */
export const JOB = {
  weekly: 'radar.weekly',
  scan: 'radar.scan',
  finish: 'radar.finish',
  report: 'radar.report',
  remix: 'remix.weekly',
} as const;

const HOUR = 3_600_000;
const ACTIVE_STATES = ['SETUP', 'TESTING', 'MONETISING', 'RE_ANGLE', 'SCALING', 'BRAND'];

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** When the oldest Apify debit in the trailing 7 days drops out (at least 1 h, at most 24 h away). */
async function capRetryMs(db: Db, studioId: string, now: Date): Promise<number> {
  const row = await db.maybeOne<{ at: Date | null }>(
    `SELECT min(created_at) AS at FROM credit_ledger WHERE studio_id = $1 AND provider = 'apify' AND entry_type = 'debit' AND created_at > $2`,
    [studioId, new Date(now.getTime() - 7 * 24 * HOUR)],
  );
  const free = row?.at ? new Date(row.at).getTime() + 7 * 24 * HOUR - now.getTime() : 24 * HOUR;
  return Math.min(24 * HOUR, Math.max(HOUR, free));
}

async function deferOnSpend<T>(services: StudioServices, studioId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApifyWeeklyCapError) throw new DeferJob(await capRetryMs(services.db, studioId, services.now()), err.message);
    if (err instanceof BudgetExceededError) throw new DeferJob(6 * HOUR, err.message);
    throw err;
  }
}

/** Enqueues this week's Radar run for a studio (once). */
export async function enqueueWeekly(services: StudioServices, studioId: string, opts: { force?: boolean } = {}): Promise<string | null> {
  const week = isoDate(weekStartOf(services.now()));
  const job = await enqueueOnceFor(
    services.db,
    { kind: JOB.weekly, key: `radar:weekly:${studioId}:${week}${opts.force ? `:${services.now().getTime()}` : ''}`, payload: { studioId, week }, studioId, priority: 120 },
    { ever: !opts.force },
  );
  return job?.id ?? null;
}

async function openJobs(db: Db, kind: string, prefix: string): Promise<number> {
  return (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM job WHERE kind = $1 AND status IN ('queued','running') AND payload->>'dedupe' LIKE $2`, [kind, `${prefix}%`])).n;
}

async function weekly({ services, job }: JobContext) {
  const studioId = str(job.payload.studioId) ?? job.studio_id;
  if (!studioId) throw new Error('radar.weekly needs a studioId');
  const week = str(job.payload.week) ?? isoDate(weekStartOf(services.now()));
  const cfg = await loadConfig(services.db, studioId);
  const scans = await nichesToScan(services.db, studioId, cfg, services.now());
  for (const s of scans) {
    await enqueueOnceFor(services.db, { kind: JOB.scan, key: `radar:scan:${studioId}:${s.niche}:${week}`, payload: { studioId, niche: s.niche, week }, studioId, priority: 120, maxAttempts: 4 }, { ever: true });
  }
  // Lower priority than the scans, so a worker runs them first; it defers itself while any scan is still open.
  await enqueueOnceFor(services.db, { kind: JOB.finish, key: `radar:finish:${studioId}:${week}`, payload: { studioId, week }, studioId, priority: 130 }, { ever: true });
  return { niches: scans.map((s) => s.niche) };
}

async function scan({ services, job, heartbeat }: JobContext) {
  const studioId = str(job.payload.studioId) ?? job.studio_id;
  const niche = str(job.payload.niche);
  if (!studioId || !niche) throw new Error('radar.scan needs studioId and niche');
  const { db } = services;
  const week = isoDate(weekStartOf(services.now()));
  const cfg = await loadConfig(db, studioId);
  const scanDef = (await nichesToScan(db, studioId, cfg, services.now())).find((s) => s.niche === nicheKey(niche)) ?? { niche: nicheKey(niche), hashtags: [niche.replace(/\s+/g, '')], keywords: [niche], accounts: [], personaIds: [], from: ['seed' as const] };
  return deferOnSpend(services, studioId, async () => {
    const discovered = await db.maybeOne(`SELECT 1 FROM radar_run WHERE studio_id = $1 AND niche = $2 AND kind = 'discover_done' AND week_start = $3`, [studioId, scanDef.niche, week]);
    let disc = null;
    if (!discovered) {
      disc = await discoverNiche(services, studioId, scanDef, cfg);
      await db.query(`INSERT INTO radar_run (studio_id, kind, actor, niche, max_items, items, status, week_start) VALUES ($1, 'discover_done', 'radar', $2, 0, $3, 'ok', $4)`, [studioId, scanDef.niche, disc.added, week]);
    }
    await heartbeat();
    const snap = await snapshotNiche(services, studioId, scanDef.niche, cfg);
    await heartbeat();
    const reviewed = await reviewNiche(services, studioId, scanDef.niche, cfg);
    const trends = await detectTrends(db, studioId, scanDef.niche, services.now());
    const signals = await pushDemandSignals(db, studioId, scanDef.niche, services.now());
    return { niche: scanDef.niche, discovered: disc, ...snap, reviewed, trends: trends.length, signals };
  });
}

async function finish({ services, job }: JobContext) {
  const studioId = str(job.payload.studioId) ?? job.studio_id;
  if (!studioId) throw new Error('radar.finish needs a studioId');
  const week = str(job.payload.week) ?? isoDate(weekStartOf(services.now()));
  if ((await openJobs(services.db, JOB.scan, `radar:scan:${studioId}:`)) > 0) throw new DeferJob(10 * 60_000, 'waiting for this week’s Radar scans');
  const personas = await services.db.query<{ id: string }>(`SELECT id FROM persona WHERE studio_id = $1 AND state = ANY($2::text[])`, [studioId, ACTIVE_STATES]);
  for (const p of personas) {
    await enqueueOnceFor(services.db, { kind: JOB.remix, key: `remix:weekly:${p.id}:${week}`, payload: { personaId: p.id, studioId, week }, studioId, personaId: p.id, priority: 120 }, { ever: true });
  }
  await enqueueOnceFor(services.db, { kind: JOB.report, key: `radar:report:${studioId}:${week}`, payload: { studioId, week }, studioId, priority: 130 }, { ever: true });
  return { personas: personas.length };
}

async function remix({ services, job }: JobContext) {
  const personaId = str(job.payload.personaId) ?? job.persona_id;
  if (!personaId) throw new Error('remix.weekly needs a personaId');
  const p = await services.db.one<{ studio_id: string }>('SELECT studio_id FROM persona WHERE id = $1', [personaId]);
  return deferOnSpend(services, p.studio_id, () => weeklyRemix(services, personaId));
}

async function report({ services, job }: JobContext) {
  const studioId = str(job.payload.studioId) ?? job.studio_id;
  if (!studioId) throw new Error('radar.report needs a studioId');
  const week = str(job.payload.week) ?? isoDate(weekStartOf(services.now()));
  const pending = await services.db.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM job WHERE kind = $1 AND status IN ('queued','running') AND studio_id = $2 AND payload->>'week' = $3`,
    [JOB.remix, studioId, week],
  );
  if (pending.n > 0) throw new DeferJob(5 * 60_000, 'waiting for this week’s remix briefs');
  return { messageId: await postTrendReport(services.db, studioId, services.now()) };
}

export const radarJobs: JobHandlerMap = {
  [JOB.weekly]: weekly,
  [JOB.scan]: scan,
  [JOB.finish]: finish,
  [JOB.remix]: remix,
  [JOB.report]: report,
};

/** Studios with something to scan: an active persona, a recent generator draft or Owner seeds. */
async function studiosToScan(db: Db, now: Date): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT s.id FROM studio s
      WHERE EXISTS (SELECT 1 FROM persona p WHERE p.studio_id = s.id AND p.state = ANY($1::text[]))
         OR EXISTS (SELECT 1 FROM persona_draft d WHERE d.studio_id = s.id AND d.status = 'active' AND d.updated_at > $2)
         OR EXISTS (SELECT 1 FROM radar_config c WHERE c.studio_id = s.id AND c.seeds <> '{}'::jsonb)`,
    [ACTIVE_STATES, new Date(now.getTime() - 21 * 24 * HOUR)],
  );
  return rows.map((r) => r.id);
}

export const radarSchedules: readonly ScheduledTask[] = [
  {
    name: 'radar.weekly',
    // Once per ISO week (Monday 00:00 UTC onwards); the job is deduplicated per studio and week.
    due: (now, last) => !last || weekStartOf(now).getTime() > weekStartOf(last).getTime(),
    run: async (services, now) => {
      const queued: string[] = [];
      for (const studioId of await studiosToScan(services.db, now)) if (await enqueueWeekly(services, studioId)) queued.push(studioId);
      return { queued: queued.length };
    },
  },
];
