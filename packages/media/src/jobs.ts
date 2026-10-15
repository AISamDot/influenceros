import { enqueueOnceFor, MEDIA_RENDER_JOB, type JobHandlerMap, type MediaRenderPayload, type ScheduledTask, type StudioServices } from '@ios/agents';
import { BudgetExceededError, DeferJob, enqueue, notify } from '@ios/core';
import { BUDGET_DEFER_MS } from './config';
import { mediaDeps } from './deps';
import { buildLookPack, ensureProfile } from './profile';
import { renderSlot } from './render';
import { probePrices } from './spend';

/**
 * Stream E's queue (`media.*`) and schedules. Handlers are idempotent and resume from stored state; schedules only
 * enqueue. Media jobs run on the Mac (inline worker in dev, `pnpm worker` with DATABASE_URL).
 */
export const MEDIA_JOB = {
  render: MEDIA_RENDER_JOB,
  costProbe: 'media.cost_probe',
  preparePersona: 'media.prepare_persona',
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATS = ['talking', 'activity_text', 'voiceover', 'static', 'carousel'];
/** Slot statuses the media pipeline owns (a slot stuck in one without a live job gets re-queued). */
export const MEDIA_SLOT_STATUSES = ['media_queued', 'voice', 'q2', 'rendering', 'q3', 'q4'] as const;
/** After this many dead media.render jobs a slot is blocked ("media failed: …") until the Owner re-runs it. */
export const MEDIA_DEAD_LIMIT = 3;

export function parseRenderPayload(raw: unknown): MediaRenderPayload {
  const p = (raw ?? {}) as Partial<MediaRenderPayload>;
  if (!UUID_RE.test(String(p.slotId)) || !UUID_RE.test(String(p.personaId)) || !UUID_RE.test(String(p.scriptId))) throw new Error('media.render needs slotId, personaId and scriptId');
  if (!FORMATS.includes(String(p.format))) throw new Error('media.render: unknown format');
  return {
    slotId: p.slotId!,
    personaId: p.personaId!,
    scriptId: p.scriptId!,
    format: p.format!,
    voiceover: typeof p.voiceover === 'string' && p.voiceover.trim() ? p.voiceover : null,
    onScreenText: Array.isArray(p.onScreenText) ? p.onScreenText.filter((x): x is string => typeof x === 'string') : [],
    carousel: Array.isArray(p.carousel) ? p.carousel.filter((s) => s && typeof s.title === 'string').map((s) => ({ title: s.title, body: typeof s.body === 'string' ? s.body : '' })) : null,
    caption: typeof p.caption === 'string' ? p.caption : '',
    ctaKeyword: typeof p.ctaKeyword === 'string' ? p.ctaKeyword : '',
    hashtags: Array.isArray(p.hashtags) ? p.hashtags.filter((x): x is string => typeof x === 'string') : [],
    visualBrief: typeof p.visualBrief === 'string' ? p.visualBrief : '',
    evidence: Array.isArray(p.evidence) ? p.evidence.filter((x): x is string => typeof x === 'string') : [],
  };
}

async function studioOf(services: StudioServices, personaId: string): Promise<string> {
  return (await services.db.one<{ studio_id: string }>('SELECT studio_id FROM persona WHERE id = $1', [personaId])).studio_id;
}

/** The newest media.render payload for a slot (B's original, or a re-queued copy). */
export async function latestRenderPayload(services: StudioServices, slotId: string): Promise<MediaRenderPayload | null> {
  const row = await services.db.maybeOne<{ payload: MediaRenderPayload }>(`SELECT payload FROM job WHERE kind = $1 AND payload->>'slotId' = $2 ORDER BY created_at DESC LIMIT 1`, [MEDIA_RENDER_JOB, slotId]);
  return row ? parseRenderPayload(row.payload) : null;
}

/**
 * Re-runs the media of a slot: a media block (Q2/Q3/Q4 or repeated failures) is reopened with fresh fix loops, then
 * one media.render is queued from the slot's latest payload. Returns the job id, or null when nothing to do.
 */
export async function rerenderSlot(services: StudioServices, slotId: string): Promise<{ jobId: string | null; reopened: boolean }> {
  const { db } = services;
  const slot = await db.maybeOne<{ status: string; block_reason: string | null; persona_id: string }>('SELECT status, block_reason, persona_id FROM calendar_slot WHERE id = $1', [slotId]);
  if (!slot) return { jobId: null, reopened: false };
  const payload = await latestRenderPayload(services, slotId);
  if (!payload) return { jobId: null, reopened: false };
  const mediaBlock = slot.status === 'blocked' && /^(Q2|Q3|Q4|media failed)/.test(slot.block_reason ?? '');
  if (!mediaBlock && !(MEDIA_SLOT_STATUSES as readonly string[]).includes(slot.status)) return { jobId: null, reopened: false };
  if (mediaBlock) {
    await db.query(`UPDATE calendar_slot SET status = 'media_queued', block_reason = NULL, stage_changed_at = $2 WHERE id = $1`, [slotId, services.now()]);
    await db.query(`UPDATE media_render SET step = 'voice', loops = '{}'::jsonb, waiting = NULL, updated_at = now() WHERE slot_id = $1`, [slotId]);
  }
  const job = await enqueueOnceFor(db, { kind: MEDIA_RENDER_JOB, key: `render:${slotId}`, payload: payload as unknown as Record<string, unknown>, studioId: await studioOf(services, slot.persona_id), personaId: slot.persona_id, runAt: services.now() });
  return { jobId: job?.id ?? null, reopened: mediaBlock };
}

export const jobs: JobHandlerMap = {
  /** voice → Q2 → generate → Q3 → render → Q4 → final_gate + publish.prepare (or blocked with a report). */
  [MEDIA_JOB.render]: async (ctx) => {
    const payload = parseRenderPayload(ctx.job.payload);
    const out = await renderSlot(ctx.services, payload, { heartbeat: ctx.heartbeat });
    return { slotId: out.slotId, status: out.status, reason: out.reason ?? null, q4ReportId: out.q4ReportId ?? null, publishJobId: out.publishJobId ?? null, loops: out.loops ?? null };
  },
  /** `higgsfield generate cost` over the model grid → media_price. */
  [MEDIA_JOB.costProbe]: async (ctx) => ({ prices: (await probePrices(ctx.services)).length }),
  /** Soul ID + face reference + voice + look pack for one persona. */
  [MEDIA_JOB.preparePersona]: async (ctx) => {
    const personaId = String((ctx.job.payload as { personaId?: string }).personaId ?? ctx.job.persona_id ?? '');
    if (!UUID_RE.test(personaId)) throw new Error('media.prepare_persona needs payload.personaId');
    const deps = mediaDeps(ctx.services);
    const scope = { studioId: await studioOf(ctx.services, personaId), personaId, slotId: null, ref: { type: 'persona' as const, id: personaId } };
    try {
      const profile = await ensureProfile(ctx.services, deps, scope, { soul: true, voice: true });
      const look = profile.meta.look_pack_done ? [] : await buildLookPack(ctx.services, deps, scope, profile);
      if (look.length) await ctx.services.db.query(`UPDATE media_profile SET meta = meta || '{"look_pack_done": true}'::jsonb WHERE persona_id = $1`, [personaId]);
      return { soulId: profile.soulId, voiceId: profile.voiceId, looks: look.length };
    } catch (err) {
      if (err instanceof BudgetExceededError) throw new DeferJob(BUDGET_DEFER_MS, `budget cap: ${err.message}`);
      throw err;
    }
  },
};

const hoursSince = (now: Date, last: Date | null) => (last ? (now.getTime() - last.getTime()) / 3_600_000 : Number.POSITIVE_INFINITY);

async function enqueueOnce(services: StudioServices, kind: string, payload: Record<string, unknown> = {}, personaId: string | null = null): Promise<boolean> {
  const busy = await services.db.maybeOne(`SELECT 1 FROM job WHERE kind = $1 AND status IN ('queued','running') AND persona_id IS NOT DISTINCT FROM $2 LIMIT 1`, [kind, personaId]);
  if (busy) return false;
  await enqueue(services.db, { kind, payload, personaId, studioId: personaId ? await studioOf(services, personaId) : null, maxAttempts: 3, priority: 120, runAt: services.now() });
  return true;
}

/** Slots stuck in a media stage with no live media.render (worker died, job dead): re-queue, or block after 3 deaths. */
export async function sweepStuckRenders(services: StudioServices, now: Date): Promise<{ requeued: number; blocked: number }> {
  const stuck = await services.db.query<{ id: string; persona_id: string; studio_id: string; title: string; dead: number; last_error: string | null }>(
    `SELECT s.id, s.persona_id, p.studio_id, s.title,
            (SELECT count(*)::int FROM job j WHERE j.kind = $1 AND j.payload->>'slotId' = s.id::text AND j.status = 'dead') AS dead,
            (SELECT j.last_error FROM job j WHERE j.kind = $1 AND j.payload->>'slotId' = s.id::text AND j.status = 'dead' ORDER BY j.updated_at DESC LIMIT 1) AS last_error
       FROM calendar_slot s JOIN persona p ON p.id = s.persona_id
      WHERE s.status = ANY($2::text[]) AND COALESCE(s.stage_changed_at, s.created_at) < $3
        AND NOT EXISTS (SELECT 1 FROM job j WHERE j.kind = $1 AND j.payload->>'slotId' = s.id::text AND j.status IN ('queued','running'))
      LIMIT 50`,
    [MEDIA_RENDER_JOB, [...MEDIA_SLOT_STATUSES], new Date(now.getTime() - 3_600_000)],
  );
  let requeued = 0;
  let blocked = 0;
  for (const s of stuck) {
    if (s.dead >= MEDIA_DEAD_LIMIT) {
      const reason = `media failed: ${s.last_error ?? 'render jobs keep dying'}`.slice(0, 500);
      await services.db.query(`UPDATE calendar_slot SET status = 'blocked', block_reason = $2, stage_changed_at = $3 WHERE id = $1`, [s.id, reason, now]);
      await notify(services.db, { studioId: s.studio_id, personaId: s.persona_id, kind: 'system', severity: 'warn', title: `Media failed: ${s.title}`.slice(0, 160), body: reason, link: `/pipeline/${s.id}` });
      blocked += 1;
      continue;
    }
    const payload = await latestRenderPayload(services, s.id);
    if (!payload) continue;
    await enqueue(services.db, { kind: MEDIA_RENDER_JOB, payload: payload as unknown as Record<string, unknown>, studioId: s.studio_id, personaId: s.persona_id, runAt: new Date(now.getTime() + s.dead * 3_600_000) });
    requeued += 1;
  }
  return { requeued, blocked };
}

export const schedules: readonly ScheduledTask[] = [
  {
    /** Weekly: refresh the Higgsfield price table (the governor's estimates). */
    name: 'media.cost_probe',
    due: (now, last) => hoursSince(now, last) >= 7 * 24,
    run: async (services) => ({ enqueued: await enqueueOnce(services, MEDIA_JOB.costProbe) }),
  },
  {
    /** Daily: any persona about to publish without a Soul ID, voice or look pack gets one prepared. */
    name: 'media.prepare_personas',
    due: (now, last) => hoursSince(now, last) >= 24,
    async run(services) {
      const rows = await services.db.query<{ id: string }>(
        `SELECT p.id FROM persona p LEFT JOIN media_profile m ON m.persona_id = p.id
          WHERE p.state IN ('SETUP','TESTING','MONETISING','RE_ANGLE','SCALING','BRAND')
            AND (m.persona_id IS NULL OR m.soul_status <> 'ready' OR m.voice_id IS NULL OR COALESCE((m.meta->>'look_pack_done')::boolean, false) = false)
          ORDER BY p.created_at LIMIT 20`,
      );
      let queued = 0;
      for (const r of rows) if (await enqueueOnce(services, MEDIA_JOB.preparePersona, { personaId: r.id }, r.id)) queued += 1;
      return { queued };
    },
  },
  {
    /** Hourly: re-queue renders whose job died; block a slot after repeated deaths (Owner notified). */
    name: 'media.sweep',
    due: (now, last) => hoursSince(now, last) >= 1,
    run: async (services, now) => sweepStuckRenders(services, now),
  },
];
