import { enqueueOnceFor, type JobHandlerMap, type ScheduledTask, type StudioServices } from '@ios/agents';
import { BudgetExceededError, DeferJob, PUBLISHING_STATES } from '@ios/core';
import { JOB as ACCOUNTS_JOB, enqueueSync, syncAccounts } from './accounts';
import { JOB as ANALYTICS_JOB, enqueuePull, pullMetrics } from './analytics';
import { enqueueHandle, handleCommunity, JOB as COMMUNITY_JOB, pollCommunity } from './community';
import { enqueueDuePosts, JOB as PUBLISH_JOB, parsePreparePayload, preparePublish, publishOne } from './publishing';
import { asString, every, HOUR_MS, UUID_RE } from './util';

/** Every job kind stream F registers (contracts §4: publish.*, community.*, analytics.*, accounts.*). */
export const JOB = {
  ...PUBLISH_JOB,
  ...COMMUNITY_JOB,
  ...ANALYTICS_JOB,
  ...ACCOUNTS_JOB,
} as const;

const BUDGET_DEFER_MS = 6 * HOUR_MS;
function deferOnBudget(err: unknown): never {
  if (err instanceof BudgetExceededError) throw new DeferJob(BUDGET_DEFER_MS, `waiting: ${err.message}`);
  throw err;
}

const personaOf = (payload: Record<string, unknown>, jobPersona: string | null): string => {
  const id = asString(payload.personaId) || jobPersona || '';
  if (!UUID_RE.test(id)) throw new Error('needs a personaId');
  return id;
};

export const jobs: JobHandlerMap = {
  /** E hands over a rendered slot: posts per platform → post Q4 → Gate → approval → slot 'scheduled'. */
  [JOB.prepare]: async (ctx) => preparePublish(ctx.services, parsePreparePayload(ctx.job.payload)).catch(deferOnBudget),
  /** One approved post at its time: upload → core publishPost → verify → live. */
  [JOB.post]: async (ctx) => {
    const postId = asString(ctx.job.payload.postId);
    if (!UUID_RE.test(postId)) throw new Error('publish.post needs payload.postId');
    return publishOne(ctx.services, postId);
  },
  /** Polls comments and DMs for one persona (or every publishing persona), then queues handling. */
  [JOB.poll]: async (ctx) => {
    const ids = asString(ctx.job.payload.personaId) ? [personaOf(ctx.job.payload, ctx.job.persona_id)] : await publishingPersonas(ctx.services);
    const out: Record<string, unknown> = {};
    for (const id of ids) {
      if (!(await ctx.heartbeat())) break;
      const r = await pollCommunity(ctx.services, id);
      out[id] = r;
      const p = await ctx.services.db.one<{ studio_id: string }>('SELECT studio_id FROM persona WHERE id = $1', [id]);
      if (r.comments || r.dms) await enqueueHandle(ctx.services, id, p.studio_id);
    }
    return out;
  },
  [JOB.handle]: async (ctx) => handleCommunity(ctx.services, personaOf(ctx.job.payload, ctx.job.persona_id)).catch(deferOnBudget),
  [JOB.pull]: async (ctx) => pullMetrics(ctx.services, { heartbeat: ctx.heartbeat, personaId: UUID_RE.test(asString(ctx.job.payload.personaId)) ? asString(ctx.job.payload.personaId) : undefined }),
  [JOB.sync]: async (ctx) => syncAccounts(ctx.services),
};

async function publishingPersonas(services: StudioServices): Promise<string[]> {
  const rows = await services.db.query<{ id: string }>(`SELECT id FROM persona WHERE state = ANY($1::text[]) ORDER BY id`, [PUBLISHING_STATES]);
  return rows.map((r) => r.id);
}

export const schedules: readonly ScheduledTask[] = [
  /** Approved posts whose time has come → publish.post (kill switches checked first); live posts → slot 'live'. */
  { name: 'publish.due', due: every(60_000), run: async (services, now) => ({ queued: await enqueueDuePosts(services, now) }) },
  /** Polling fallback for comments and DMs (FR-8.1: every 5–15 minutes). */
  {
    name: 'community.poll',
    due: every(10 * 60_000),
    run: async (services, now) => ({ queued: !!(await enqueueOnceFor(services.db, { kind: JOB.poll, key: 'community:poll', payload: {}, priority: 100, runAt: now })) }),
  },
  /** Metric windows (1h/24h/72h/7d) for live posts. */
  { name: 'analytics.pull', due: every(15 * 60_000), run: async (services, now) => ({ queued: await enqueuePull(services, now) }) },
  /** Links accounts the Owner connected in Zernio and refreshes AI-label status. */
  { name: 'accounts.sync', due: every(6 * HOUR_MS), run: async (services) => ({ queued: await enqueueSync(services) }) },
];
