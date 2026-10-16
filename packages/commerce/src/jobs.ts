import { enqueueOnceFor, type JobContext, type JobHandlerMap, type ScheduledTask, type StudioServices } from '@ios/agents';
import { BudgetExceededError, DeferJob, enqueue } from '@ios/core';
import { SEND_DUE_JOB, syncPendingOptOuts, WRITE_WELCOME_JOB } from './audience';
import { sweepPostLinks } from './attribution';
import { ensureMonthlyDrop, MEMBERSHIP_DROP_JOB } from './membership';
import { sendDueEmails, writeWelcomeSequence } from './sequences';
import { productSweep, syncStores } from './store';
import { asRecord, asString, monthKey, startOfUtcDay, UUID_RE } from './util';

/**
 * Stream G jobs (`store.*`, `email.*`, `membership.*`, `attribution.*`) and the schedules that enqueue them.
 * Schedules only enqueue (cheap, idempotent); handlers are idempotent and defer on a budget cap instead of failing.
 */
export const JOB = {
  storeSync: 'store.sync',
  productSweep: 'store.product_sweep',
  attribution: 'attribution.sweep',
  sendDue: SEND_DUE_JOB,
  writeWelcome: WRITE_WELCOME_JOB,
  drop: MEMBERSHIP_DROP_JOB,
} as const;

const DEFER_MS = 6 * 3_600_000;
const deferOnBudget = (err: unknown): never => {
  if (err instanceof BudgetExceededError) throw new DeferJob(DEFER_MS, err.message);
  throw err;
};

function personaOf(ctx: JobContext): string {
  const id = ctx.job.persona_id ?? asString(asRecord(ctx.job.payload).personaId);
  if (!UUID_RE.test(id)) throw new Error(`${ctx.job.kind} needs a persona`);
  return id;
}

async function studios(services: StudioServices, studioId: string | null): Promise<string[]> {
  if (studioId) return [studioId];
  return (await services.db.query<{ id: string }>('SELECT id FROM studio ORDER BY created_at')).map((r) => r.id);
}

export const jobs: JobHandlerMap = {
  [JOB.storeSync]: async (ctx) => {
    let stores = 0;
    let linked = 0;
    for (const s of await studios(ctx.services, ctx.job.studio_id)) {
      const r = await syncStores(ctx.services, s);
      stores += r.stores;
      linked += r.linked;
    }
    return { stores, linked };
  },
  [JOB.productSweep]: async (ctx) => {
    const changes = await productSweep(ctx.services, { studioId: ctx.job.studio_id ?? undefined }).catch(deferOnBudget);
    return { changes: changes.length };
  },
  [JOB.attribution]: async (ctx) => sweepPostLinks(ctx.services, { studioId: ctx.job.studio_id ?? undefined }),
  [JOB.sendDue]: async (ctx) => {
    // Opt-outs that didn't reach the provider yet (a transient error at unsubscribe time) are retried every tick.
    const optOuts = await syncPendingOptOuts(ctx.services);
    const res = { ...(await sendDueEmails(ctx.services, { limit: 100, studioId: ctx.job.studio_id ?? undefined })), optOutsPending: optOuts.pending };
    // A full batch means more may be due: queue another pass (the dedupe key frees up once this job finishes).
    if (res.sent >= 100) await enqueue(ctx.services.db, { kind: SEND_DUE_JOB, payload: { dedupe: `email.send_due:more:${Date.now()}` }, studioId: ctx.job.studio_id, priority: 50 });
    return res;
  },
  [JOB.writeWelcome]: async (ctx) => {
    const personaId = personaOf(ctx);
    const res = await writeWelcomeSequence(ctx.services, personaId).catch(deferOnBudget);
    if (res.status === 'active') await enqueueOnceFor(ctx.services.db, { kind: SEND_DUE_JOB, key: 'email.send_due', payload: {}, studioId: ctx.job.studio_id, priority: 50 });
    return res;
  },
  [JOB.drop]: async (ctx) => {
    const personaId = personaOf(ctx);
    const drop = await ensureMonthlyDrop(ctx.services, personaId).catch(deferOnBudget);
    return drop ? { month: drop.month, status: drop.status } : { skipped: 'no live membership' };
  },
};

const every = (ms: number) => (now: Date, last: Date | null) => !last || now.getTime() - last.getTime() >= ms;
const daily = (now: Date, last: Date | null) => !last || last < startOfUtcDay(now);

/** Studio-wide job, once at a time. */
const once = (kind: string) => async (services: StudioServices) => {
  await enqueueOnceFor(services.db, { kind, key: kind, payload: {} });
};

export const schedules: readonly ScheduledTask[] = [
  { name: 'store.sync', due: every(3_600_000), run: once(JOB.storeSync) },
  { name: 'store.product_sweep', due: every(10 * 60_000), run: once(JOB.productSweep) },
  { name: 'attribution.sweep', due: every(10 * 60_000), run: once(JOB.attribution) },
  { name: 'email.tick', due: every(5 * 60_000), run: once(JOB.sendDue) },
  {
    /** Daily: a welcome sequence for every persona with a site and a list but no active sequence. */
    name: 'email.welcome_sweep',
    due: daily,
    async run(services) {
      const rows = await services.db.query<{ id: string; studio_id: string }>(
        `SELECT p.id, p.studio_id FROM persona p
          WHERE p.state NOT IN ('PROPOSED','KILLED','RETIRED','ARCHIVED')
            AND EXISTS (SELECT 1 FROM subscriber s WHERE s.persona_id = p.id)
            AND NOT EXISTS (SELECT 1 FROM email_sequence q WHERE q.persona_id = p.id AND q.kind = 'welcome' AND q.status = 'active')`,
      );
      for (const r of rows) await enqueueOnceFor(services.db, { kind: JOB.writeWelcome, key: `welcome:${r.id}`, payload: { personaId: r.id }, studioId: r.studio_id, personaId: r.id });
    },
  },
  {
    /** Daily: this month's members drop for every persona with a live membership (ready, or briefed and pending). */
    name: 'membership.monthly_drop',
    due: daily,
    async run(services, now) {
      const rows = await services.db.query<{ persona_id: string; studio_id: string }>(
        `SELECT DISTINCT pr.persona_id, p.studio_id FROM product pr JOIN persona p ON p.id = pr.persona_id
          WHERE pr.ladder_rung = 'membership' AND pr.status = 'live' AND p.state NOT IN ('KILLED','RETIRED','ARCHIVED')
            AND NOT EXISTS (SELECT 1 FROM member_drop d WHERE d.persona_id = pr.persona_id AND d.month = $1 AND d.status = 'ready')`,
        [monthKey(now)],
      );
      for (const r of rows) {
        await enqueueOnceFor(services.db, { kind: JOB.drop, key: `drop:${r.persona_id}:${monthKey(now)}:${now.toISOString().slice(0, 10)}`, payload: { personaId: r.persona_id }, studioId: r.studio_id, personaId: r.persona_id });
      }
    },
  },
];
