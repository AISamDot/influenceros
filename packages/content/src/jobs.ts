import type { JobContext, JobHandlerMap, ScheduledTask, StudioServices } from '@ios/agents';
import { BudgetExceededError, DeferJob, enqueue, PUBLISHING_STATES } from '@ios/core';
import { json } from '@ios/db';
import { planWeek } from './calendar';
import { runMonetizationCycle } from './monetization';
import { processSlot } from './pipeline';
import { voiceCheck } from './qc';
import { asRecord, asString, DAY_MS, isoDate, mondayUtc } from './util';

/**
 * Queue handlers (`calendar.*`, `pipeline.*`, `monetization.*`, `qc.*`) and the schedules that feed them. Schedules
 * only enqueue (cheap, idempotent); handlers are idempotent and defer instead of failing when a budget cap is hit.
 */
export const JOB = {
  planWeek: 'calendar.plan_week',
  slot: 'pipeline.slot',
  monetization: 'monetization.cycle',
  voice: 'qc.voice',
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUDGET_DEFER_MS = 6 * 3_600_000;

async function hasActiveJob(services: StudioServices, kind: string, personaId: string | null, key?: string, value?: string): Promise<boolean> {
  const row = await services.db.maybeOne(
    `SELECT 1 FROM job WHERE kind = $1 AND status IN ('queued','running') AND persona_id IS NOT DISTINCT FROM $2 AND ($3::text IS NULL OR payload->>$3 = $4) LIMIT 1`,
    [kind, personaId, key ?? null, value ?? null],
  );
  return !!row;
}

async function studioOf(services: StudioServices, personaId: string): Promise<string> {
  return (await services.db.one<{ studio_id: string }>('SELECT studio_id FROM persona WHERE id = $1', [personaId])).studio_id;
}

/** Enqueues a slot for the pipeline unless one is already queued or running. Returns the job id, or null. */
export async function enqueueSlot(services: StudioServices, slotId: string, personaId: string): Promise<string | null> {
  if (await hasActiveJob(services, JOB.slot, personaId, 'slotId', slotId)) return null;
  const job = await enqueue(services.db, { kind: JOB.slot, studioId: await studioOf(services, personaId), personaId, payload: { slotId }, priority: 90, runAt: services.now() });
  return job.id;
}

export async function enqueuePlanWeek(services: StudioServices, personaId: string, weekStart: Date): Promise<string | null> {
  const ws = isoDate(mondayUtc(weekStart));
  if (await hasActiveJob(services, JOB.planWeek, personaId, 'weekStart', ws)) return null;
  const job = await enqueue(services.db, { kind: JOB.planWeek, studioId: await studioOf(services, personaId), personaId, payload: { weekStart: ws }, priority: 80, runAt: services.now() });
  return job.id;
}

export async function enqueueMonetization(services: StudioServices, personaId: string): Promise<string | null> {
  if (await hasActiveJob(services, JOB.monetization, personaId)) return null;
  const job = await enqueue(services.db, { kind: JOB.monetization, studioId: await studioOf(services, personaId), personaId, payload: {}, priority: 120, runAt: services.now() });
  return job.id;
}

const personaOf = (ctx: JobContext): string => {
  const id = ctx.job.persona_id;
  if (!id) throw new Error(`${ctx.job.kind} needs a persona_id`);
  return id;
};

function deferOnBudget(err: unknown): never {
  if (err instanceof BudgetExceededError) throw new DeferJob(BUDGET_DEFER_MS, `waiting: ${err.message}`);
  throw err;
}

export const jobs: JobHandlerMap = {
  /** Plans a persona's week, then queues every new slot for the pipeline. */
  [JOB.planWeek]: async (ctx) => {
    const personaId = personaOf(ctx);
    const ws = asString(ctx.job.payload.weekStart);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) throw new Error('calendar.plan_week needs payload.weekStart (YYYY-MM-DD)');
    const res = await planWeek(ctx.services, personaId, new Date(`${ws}T00:00:00Z`)).catch(deferOnBudget);
    for (const id of res.slotIds) await enqueueSlot(ctx.services, id, personaId);
    return { created: res.created, existing: res.existing, skipped: res.skipped ?? null, postsPerWeek: res.target?.postsPerWeek ?? null };
  },
  /** idea → script → Q1 → Gate → media.render for one slot (resumes from the slot's stage). */
  [JOB.slot]: async (ctx) => {
    const slotId = asString(ctx.job.payload.slotId);
    if (!UUID_RE.test(slotId)) throw new Error('pipeline.slot needs payload.slotId');
    try {
      const out = await processSlot(ctx.services, slotId);
      return { ...out };
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        await ctx.services.db.query(`UPDATE calendar_slot SET meta = meta || $2::jsonb WHERE id = $1`, [slotId, json({ waiting: `budget cap: ${err.message}`.slice(0, 200) })]);
      }
      return deferOnBudget(err);
    }
  },
  [JOB.monetization]: async (ctx) => {
    const personaId = personaOf(ctx);
    return runMonetizationCycle(ctx.services, personaId).catch(deferOnBudget);
  },
  /** Q2 for a voice track: { scriptId, audioUrl, assetId?, voiceId?, expectedVoiceId? }. IOS-3 enqueues it after TTS. */
  [JOB.voice]: async (ctx) => {
    const personaId = personaOf(ctx);
    const p = asRecord(ctx.job.payload);
    const scriptId = asString(p.scriptId);
    const audioUrl = asString(p.audioUrl);
    if (!UUID_RE.test(scriptId) || !/^https?:\/\//.test(audioUrl)) throw new Error('qc.voice needs payload.scriptId and payload.audioUrl');
    const studioId = await studioOf(ctx.services, personaId);
    const res = await voiceCheck(ctx.services, {
      studioId,
      personaId,
      scriptId,
      audioUrl,
      assetId: UUID_RE.test(asString(p.assetId)) ? asString(p.assetId) : undefined,
      voiceId: asString(p.voiceId) || null,
      expectedVoiceId: asString(p.expectedVoiceId) || null,
    }).catch(deferOnBudget);
    return { pass: res.pass, wer: res.wer, wpm: res.wpm, reportId: res.reportId };
  },
};

// ─── Schedules ───

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

async function activePersonas(services: StudioServices): Promise<Array<{ id: string }>> {
  return services.db.query<{ id: string }>(`SELECT id FROM persona WHERE state = ANY($1::text[]) ORDER BY created_at`, [[...PUBLISHING_STATES]]);
}

async function weekHasSlots(services: StudioServices, personaId: string, ws: Date): Promise<boolean> {
  const row = await services.db.maybeOne(
    `SELECT 1 FROM calendar_slot WHERE persona_id = $1 AND status <> 'skipped' AND (week_start = $2::date OR (slot_at >= $3 AND slot_at < $4)) LIMIT 1`,
    [personaId, isoDate(ws), ws, new Date(ws.getTime() + 7 * DAY_MS)],
  );
  return !!row;
}

export const schedules: readonly ScheduledTask[] = [
  {
    /** Daily: plan this week for any persona with nothing planned, and next week from Thursday on. */
    name: 'calendar.weekly_plan',
    due: (now, last) => !last || last < startOfUtcDay(now),
    async run(services, now) {
      const thisWeek = mondayUtc(now);
      const nextWeek = new Date(thisWeek.getTime() + 7 * DAY_MS);
      const planNext = (now.getUTCDay() + 6) % 7 >= 3;
      let queued = 0;
      for (const p of await activePersonas(services)) {
        for (const ws of planNext ? [thisWeek, nextWeek] : [thisWeek]) {
          if (await weekHasSlots(services, p.id, ws)) continue;
          if (await enqueuePlanWeek(services, p.id, ws)) queued += 1;
        }
      }
      return { queued };
    },
  },
  {
    /** Every 30 min: any planned slot in the next 8 days without a pipeline job gets one (catches deferrals and seeds). */
    name: 'pipeline.advance',
    due: (now, last) => !last || now.getTime() - last.getTime() >= 30 * 60_000,
    async run(services, now) {
      const slots = await services.db.query<{ id: string; persona_id: string }>(
        `SELECT s.id, s.persona_id FROM calendar_slot s JOIN persona p ON p.id = s.persona_id
          WHERE s.status IN ('planned','scripted','q1','gate') AND s.slot_at > $1 AND s.slot_at < $2 AND p.state = ANY($3::text[])
            AND NOT EXISTS (SELECT 1 FROM job j WHERE j.kind = $4 AND j.payload->>'slotId' = s.id::text AND j.status IN ('queued','running'))
          ORDER BY s.slot_at LIMIT 100`,
        [now, new Date(now.getTime() + 8 * DAY_MS), [...PUBLISHING_STATES], JOB.slot],
      );
      let queued = 0;
      for (const s of slots) if (await enqueueSlot(services, s.id, s.persona_id)) queued += 1;
      return { queued };
    },
  },
  {
    /** Weekly (Monday 06:00 UTC): the Monetization Agent's cycle for every active persona. */
    name: 'monetization.weekly_cycle',
    due: (now, last) => {
      const mark = new Date(mondayUtc(now).getTime() + 6 * 3_600_000);
      const latest = now >= mark ? mark : new Date(mark.getTime() - 7 * DAY_MS);
      return !last || last < latest;
    },
    async run(services) {
      let queued = 0;
      for (const p of await activePersonas(services)) if (await enqueueMonetization(services, p.id)) queued += 1;
      return { queued };
    },
  },
];
