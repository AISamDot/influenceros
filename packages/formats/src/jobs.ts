import { enqueueOnceFor, type JobHandlerMap, type ScheduledTask, type StudioServices } from '@ios/agents';
import { BudgetExceededError, DeferJob, PUBLISHING_STATES } from '@ios/core';
import type { Db } from '@ios/db';
import { curateHighlights, tuneStories } from './curate';
import { ingestStoryMetrics, planStoryDay, produceStoryFrame, publishStoryFrame, queueDueStories, STORY_JOB } from './stories';
import { localDate, localTime } from './time';

/**
 * Stream L jobs and schedules. Schedules only enqueue (cheap, idempotent); the work runs in the worker.
 *  - stories.daily (every 30 min): each publishing persona whose local time is past 06:00 gets today's frames planned once;
 *  - stories.plan_day → one stories.produce per frame; stories.publish_due (every 5 min) → stories.publish once a
 *    frame's time has come (frames that missed their day are skipped);
 *  - stories.metrics (every 6 h) · highlights.weekly · formats.weekly_tune (the Stories lever).
 */

/** Local hour after which a persona's Story day is planned. */
export const STORY_DAY_STARTS_AT = 6;

export const enqueuePlanDay = (db: Db, q: { studioId: string; personaId: string; date: string }) =>
  enqueueOnceFor(db, { kind: STORY_JOB.plan, key: `stories:${q.personaId}:${q.date}`, payload: { personaId: q.personaId, date: q.date }, studioId: q.studioId, personaId: q.personaId, priority: 90 }, { ever: true });

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** A spent budget (media or the persona's LLM cap, e.g. the stories-producer or the Gate run) waits, no attempt spent. */
async function deferOnBudget<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BudgetExceededError) throw new DeferJob(6 * 3_600_000, `budget: ${err.message}`);
    throw err;
  }
}

export const formatsJobs: JobHandlerMap = {
  [STORY_JOB.plan]: async ({ services, job }) => {
    const personaId = str(job.payload.personaId);
    if (!personaId) throw new Error('stories.plan_day: personaId required');
    const frames = await deferOnBudget(() => planStoryDay(services, personaId, str(job.payload.date) ?? undefined));
    let queued = 0;
    for (const f of frames.filter((x) => x.status === 'planned')) {
      const j = await enqueueOnceFor(services.db, { kind: STORY_JOB.produce, key: `produce:${f.id}`, payload: { frameId: f.id }, studioId: f.studio_id, personaId, priority: 80 }, { ever: true });
      if (j) queued += 1;
    }
    return { frames: frames.length, queued };
  },
  [STORY_JOB.produce]: async ({ services, job }) => {
    const frameId = str(job.payload.frameId);
    if (!frameId) throw new Error('stories.produce: frameId required');
    const f = await deferOnBudget(() => produceStoryFrame(services, frameId));
    return { frameId, status: f.status, gate: f.gate_verdict };
  },
  [STORY_JOB.publish]: async ({ services, job }) => {
    const frameId = str(job.payload.frameId);
    if (!frameId) throw new Error('stories.publish: frameId required');
    return publishStoryFrame(services, frameId);
  },
  [STORY_JOB.metrics]: async ({ services, job }) => ingestStoryMetrics(services, { personaId: str(job.payload.personaId) ?? undefined }),
  [STORY_JOB.highlights]: async ({ services, job }) => {
    const ids = str(job.payload.personaId) ? [str(job.payload.personaId)!] : (await publishingPersonas(services)).map((p) => p.id);
    for (const id of ids) await curateHighlights(services, id);
    return { personas: ids.length };
  },
  [STORY_JOB.tune]: async ({ services, job }) => {
    const ids = str(job.payload.personaId) ? [str(job.payload.personaId)!] : (await publishingPersonas(services)).map((p) => p.id);
    const moved = [];
    for (const id of ids) {
      const r = await tuneStories(services, id);
      if (r) moved.push({ personaId: id, ...r });
    }
    return { personas: ids.length, moved };
  },
};

async function publishingPersonas(services: Pick<StudioServices, 'db'>) {
  return services.db.query<{ id: string; studio_id: string; timezone: string }>(`SELECT id, studio_id, timezone FROM persona WHERE state = ANY($1::text[]) ORDER BY created_at`, [[...PUBLISHING_STATES]]);
}

const minutesSince = (now: Date, last: Date | null) => (last ? (now.getTime() - last.getTime()) / 60_000 : Number.POSITIVE_INFINITY);

/** Plans today's Story frames for every publishing persona past its local morning (once per persona-day). */
export async function scheduleStoryDays(services: StudioServices, now: Date): Promise<{ queued: number }> {
  let queued = 0;
  for (const p of await publishingPersonas(services)) {
    if (Number(localTime(now, p.timezone).slice(0, 2)) < STORY_DAY_STARTS_AT) continue;
    const date = localDate(now, p.timezone);
    const done = await services.db.maybeOne('SELECT 1 FROM story_frame WHERE persona_id = $1 AND story_date = $2::date LIMIT 1', [p.id, date]);
    if (done) continue;
    if (await enqueuePlanDay(services.db, { studioId: p.studio_id, personaId: p.id, date })) queued += 1;
  }
  return { queued };
}

export const formatsSchedules: readonly ScheduledTask[] = [
  { name: 'stories.daily', due: (now, last) => minutesSince(now, last) >= 30, run: (services, now) => scheduleStoryDays(services, now) },
  { name: 'stories.publish_due', due: (now, last) => minutesSince(now, last) >= 5, run: (services, now) => queueDueStories(services, now) },
  {
    name: 'stories.metrics',
    due: (now, last) => minutesSince(now, last) >= 6 * 60,
    run: async (services, now) => ({ enqueued: !!(await enqueueOnceFor(services.db, { kind: STORY_JOB.metrics, key: `story-metrics:${now.toISOString().slice(0, 13)}`, payload: {}, priority: 120 })) }),
  },
  {
    name: 'highlights.weekly',
    due: (now, last) => minutesSince(now, last) >= 7 * 24 * 60,
    run: async (services, now) => ({ enqueued: !!(await enqueueOnceFor(services.db, { kind: STORY_JOB.highlights, key: `highlights:${now.toISOString().slice(0, 10)}`, payload: {}, priority: 140 })) }),
  },
  {
    name: 'formats.weekly_tune',
    due: (now, last) => minutesSince(now, last) >= 7 * 24 * 60,
    run: async (services, now) => ({ enqueued: !!(await enqueueOnceFor(services.db, { kind: STORY_JOB.tune, key: `stories-tune:${now.toISOString().slice(0, 10)}`, payload: {}, priority: 140 })) }),
  },
];
