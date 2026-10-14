import type { ScheduledTask, StudioServices } from '@ios/agents';
import { pendingEmbeddings } from './embed';
import { KNOWLEDGE_JOBS } from './field-brain';
import { NEWS_JOBS } from './news';
import { PERSONA_JOBS } from './personas';
import { ACTIVE_PERSONA_SQL, enqueueOnce } from './util';

/**
 * Schedules run on every tick (Vercel Cron / the local ticker). Each one only enqueues work, deduplicated by key,
 * so a double run is harmless.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Due once a day, at or after `hourUtc`. */
export function dailyAt(hourUtc: number): ScheduledTask['due'] {
  return (now, last) => {
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc);
    return now.getTime() >= today && (!last || last.getTime() < today);
  };
}

export const every = (ms: number): ScheduledTask['due'] => (now, last) => !last || now.getTime() - last.getTime() >= ms;

async function studioNiches(services: StudioServices): Promise<Array<{ studioId: string; niche: string }>> {
  const rows = await services.db.query<{ studio_id: string; niche: string }>(
    `SELECT DISTINCT studio_id, lower(niche) AS niche FROM persona WHERE ${ACTIVE_PERSONA_SQL} ORDER BY 1, 2`,
  );
  return rows.map((r) => ({ studioId: r.studio_id, niche: r.niche }));
}

/** 05:00 UTC: the News Desk scans every occupied niche; each scan queues that niche's morning briefings. */
export const dailyNewsScan: ScheduledTask = {
  name: 'news.daily_scan',
  due: dailyAt(5),
  async run(services, now) {
    let queued = 0;
    const day = now.toISOString().slice(0, 10);
    for (const { studioId, niche } of await studioNiches(services)) {
      if (await enqueueOnce(services.db, { kind: NEWS_JOBS.scan, key: `scan:${studioId}:${niche}:${day}`, payload: { studioId, niche }, studioId, priority: 80 })) queued += 1;
    }
    return { queued };
  },
};

/** Weekly: rebuild every occupied niche's Field Brain (new nodes, re-research of nodes older than 7 days). */
export const weeklyFieldBrainRefresh: ScheduledTask = {
  name: 'knowledge.weekly_refresh',
  due: every(7 * DAY),
  async run(services) {
    let queued = 0;
    for (const { studioId, niche } of await studioNiches(services)) {
      if (await enqueueOnce(services.db, { kind: KNOWLEDGE_JOBS.build, key: `build:${studioId}:${niche}`, payload: { studioId, niche }, studioId, priority: 150 })) queued += 1;
    }
    return { queued };
  },
};

/** Every 10 minutes: embed rows that have no vector yet (seeded nodes, a changed embedder). */
export const embedPendingTask: ScheduledTask = {
  name: 'knowledge.embed_pending',
  due: every(10 * 60_000),
  async run(services) {
    const pending = await pendingEmbeddings(services);
    if (!pending.nodes && !pending.news) return { queued: 0 };
    const job = await enqueueOnce(services.db, { kind: KNOWLEDGE_JOBS.embed, key: 'embed', payload: {}, priority: 110 });
    return { queued: job ? 1 : 0, ...pending };
  },
};

/** Every 6 hours: pick up new or edited launch-persona documents (cheap when nothing changed; the worker resolves the folder). */
export const personaSync: ScheduledTask = {
  name: 'knowledge.persona_sync',
  due: every(6 * HOUR),
  async run(services) {
    const studio = await services.db.maybeOne<{ id: string }>('SELECT id FROM studio ORDER BY created_at LIMIT 1');
    if (!studio) return { queued: 0 };
    const job = await enqueueOnce(services.db, { kind: PERSONA_JOBS.import, key: 'persona-import', payload: { studioId: studio.id }, studioId: studio.id, priority: 140 });
    return { queued: job ? 1 : 0 };
  },
};

export const schedules: readonly ScheduledTask[] = [dailyNewsScan, weeklyFieldBrainRefresh, embedPendingTask, personaSync];
