import { enqueueOnceFor, type JobHandlerMap, PUBLISH_PREPARE_JOB, type ScheduledTask, type StudioServices } from '@troupe/agents';
import { BudgetExceededError, DeferJob, notify, PUBLISHING_STATES } from '@troupe/core';
import { JOB as ACCOUNTS_JOB, enqueueSync, syncAccounts } from './accounts';
import { detectAnomalies } from './anomalies';
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

/** After this many dead publish.prepare jobs for one slot, the sweep blocks the slot and tells the Owner. */
export const PREPARE_DEAD_LIMIT = 3;

/**
 * Slots stuck in final_gate (media done) with no live publish.prepare: the job died after its retries (Gate LLM or
 * storage errors). Re-queue it from the newest payload, or block the slot after PREPARE_DEAD_LIMIT deaths.
 */
export async function sweepStuckPrepares(services: StudioServices, now: Date): Promise<{ requeued: number; blocked: number }> {
  const { db } = services;
  const stuck = await db.query<{ id: string; persona_id: string; studio_id: string; title: string; dead: number; last_error: string | null }>(
    `SELECT s.id, s.persona_id, p.studio_id, s.title,
            (SELECT count(*)::int FROM job j WHERE j.kind = $1 AND j.payload->>'slotId' = s.id::text AND j.status = 'dead') AS dead,
            (SELECT j.last_error FROM job j WHERE j.kind = $1 AND j.payload->>'slotId' = s.id::text AND j.status = 'dead' ORDER BY j.updated_at DESC LIMIT 1) AS last_error
       FROM calendar_slot s JOIN persona p ON p.id = s.persona_id
      WHERE s.status = 'final_gate' AND COALESCE(s.stage_changed_at, s.created_at) < $2
        AND NOT EXISTS (SELECT 1 FROM job j WHERE j.kind = $1 AND j.payload->>'slotId' = s.id::text AND j.status IN ('queued','running'))
      LIMIT 50`,
    [PUBLISH_PREPARE_JOB, new Date(now.getTime() - HOUR_MS)],
  );
  let requeued = 0;
  let blocked = 0;
  for (const s of stuck) {
    if (s.dead >= PREPARE_DEAD_LIMIT) {
      const reason = `publish prepare failed: ${s.last_error ?? 'jobs keep dying'}`.slice(0, 500);
      await db.query(`UPDATE calendar_slot SET status = 'blocked', block_reason = $2, stage_changed_at = $3 WHERE id = $1 AND status = 'final_gate'`, [s.id, reason, now]);
      await notify(db, { studioId: s.studio_id, personaId: s.persona_id, kind: 'publish', severity: 'warn', title: `Publishing failed: ${s.title}`.slice(0, 160), body: reason, link: `/pipeline/${s.id}` });
      blocked += 1;
      continue;
    }
    const last = await db.maybeOne<{ payload: Record<string, unknown> }>(`SELECT payload FROM job WHERE kind = $1 AND payload->>'slotId' = $2 ORDER BY created_at DESC LIMIT 1`, [PUBLISH_PREPARE_JOB, s.id]);
    if (!last) continue;
    const { dedupe: _dedupe, ...payload } = last.payload;
    const job = await enqueueOnceFor(db, { kind: PUBLISH_PREPARE_JOB, key: `slot:${s.id}`, payload, studioId: s.studio_id, personaId: s.persona_id, runAt: new Date(now.getTime() + s.dead * HOUR_MS) });
    if (job) requeued += 1;
  }
  return { requeued, blocked };
}

export const schedules: readonly ScheduledTask[] = [
  /** Slots stuck in final_gate whose publish.prepare died: re-queue, or block after repeated deaths. */
  { name: 'publish.sweep', due: every(30 * 60_000), run: async (services, now) => sweepStuckPrepares(services, now) },
  /** Approved posts whose time has come → publish.post (kill switches checked first); live posts → slot 'live'. */
  { name: 'publish.due', due: every(60_000), run: async (services, now) => ({ queued: await enqueueDuePosts(services, now) }) },
  /** Polling fallback for comments and DMs (FR-8.1: every 5–15 minutes). */
  {
    name: 'community.poll',
    due: every(10 * 60_000),
    run: async (services, now) => ({ queued: !!(await enqueueOnceFor(services.db, { kind: JOB.poll, key: 'community:poll', payload: {}, priority: 100, runAt: now })) }),
  },
  /** Anomaly alerts (views collapse, refund and cost spikes; FR-13.4). Takedowns trip the breaker as they arrive. */
  { name: 'analytics.anomalies', due: every(HOUR_MS), run: async (services, now) => ({ findings: (await detectAnomalies(services, now)).length }) },
  /** Metric windows (1h/24h/72h/7d) for live posts. */
  { name: 'analytics.pull', due: every(15 * 60_000), run: async (services, now) => ({ queued: await enqueuePull(services, now) }) },
  /** Links accounts the Owner connected in Zernio and refreshes AI-label status. */
  { name: 'accounts.sync', due: every(6 * HOUR_MS), run: async (services) => ({ queued: await enqueueSync(services) }) },
];
