import { type Actor, audit, type JobRow } from '@troupe/core';
import type { Db } from '@troupe/db';
import { KNOWLEDGE_JOBS } from './field-brain';
import { NEWS_JOBS } from './news';
import { enqueueOnce } from './util';

/** Queue an extra Field Brain build (deduplicated with the weekly refresh). Shared by the tool, the dashboard and the CLI. */
export async function requestFieldBrainBuild(db: Db, q: { studioId: string; niche: string; maxNodes?: number; actor?: Actor }): Promise<JobRow | null> {
  const niche = q.niche.trim().toLowerCase();
  const job = await enqueueOnce(db, {
    kind: KNOWLEDGE_JOBS.build,
    key: `build:${q.studioId}:${niche}`,
    payload: { studioId: q.studioId, niche, ...(q.maxNodes ? { maxNodes: q.maxNodes } : {}) },
    studioId: q.studioId,
    priority: 130,
  });
  if (q.actor) await audit(db, { studioId: q.studioId, actor: q.actor, action: 'knowledge.build_requested', entityType: 'niche', entityId: niche, data: { queued: !!job } });
  return job;
}

/** Queue an extra News Desk scan for a niche now (the daily scan runs anyway). */
export async function requestNewsScan(db: Db, q: { studioId: string; niche: string; actor?: Actor }): Promise<JobRow | null> {
  const niche = q.niche.trim().toLowerCase();
  const job = await enqueueOnce(db, {
    kind: NEWS_JOBS.scan,
    key: `scan:${q.studioId}:${niche}:manual`,
    payload: { studioId: q.studioId, niche },
    studioId: q.studioId,
    priority: 70,
  });
  if (q.actor) await audit(db, { studioId: q.studioId, actor: q.actor, action: 'news.scan_requested', entityType: 'niche', entityId: niche, data: { queued: !!job } });
  return job;
}
