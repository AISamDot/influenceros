import type { StudioServices } from '@ios/agents';
import { type CostRef, creditsToSettle, metered, notify } from '@ios/core';
import { type Db, json } from '@ios/db';
import { type HiggsfieldOperation, higgsfieldCredits } from '@ios/providers';
import { GEN_RESOLUTION, type MediaModels, mediaModels, PROBE_GRID } from './config';

/**
 * Credits and money for media (docs/IOS-34-CONTRACTS.md §5.2). Every Higgsfield call reserves its estimate from the
 * probed price table (`media_price`, written by `higgsfield generate cost`) and settles with the credits the CLI
 * reports; ElevenLabs and fal settle in `media_usd`. Each paid call also lands in `media_generation` and on the slot's
 * render totals, so the Pipeline board and the P&L see what a post cost.
 */

/** Credits for an operation from the probed price table (scaled per started step), else the built-in estimate. */
export async function estimateCredits(db: Db, q: { operation: HiggsfieldOperation; model: string; durationS?: number }): Promise<number> {
  const rows = await db.query<{ duration_s: number; credits: string }>(
    `SELECT duration_s, credits FROM media_price WHERE operation = $1 AND model = $2 AND resolution = $3 ORDER BY duration_s`,
    [q.operation, q.model, GEN_RESOLUTION],
  );
  if (!rows.length) return higgsfieldCredits(q.operation, q.durationS ?? 5);
  const d = q.durationS ?? 0;
  const fit = rows.find((r) => r.duration_s >= d) ?? rows.at(-1)!;
  const credits = Number(fit.credits);
  return fit.duration_s > 0 && d > fit.duration_s ? Math.ceil((credits * d) / fit.duration_s) : credits;
}

/**
 * Runs the cost probe over the grid and writes the price table. Free (no job is submitted). A probe that reports no
 * price (0 or missing) is never stored, since a 0 price would reserve 0 and caps would never trip: the built-in
 * estimate stays in force and the Owner is told once per run.
 */
export async function probePrices(services: StudioServices, models: MediaModels = mediaModels(), opts: { studioId?: string } = {}): Promise<Array<{ operation: string; model: string; durationS: number; credits: number }>> {
  const out: Array<{ operation: string; model: string; durationS: number; credits: number }> = [];
  const missing: string[] = [];
  for (const g of PROBE_GRID) {
    const model = models[g.model] as string;
    for (const durationS of g.durations) {
      const { credits } = await services.providers.imageVideo.costProbe({ operation: g.operation, model, durationS: durationS || undefined, resolution: GEN_RESOLUTION });
      if (!(Number.isFinite(credits) && credits > 0)) {
        missing.push(`${g.operation} ${model}${durationS ? ` ${durationS}s` : ''}`);
        continue;
      }
      await services.db.query(
        `INSERT INTO media_price (operation, model, resolution, duration_s, credits, source, probed_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (operation, model, resolution, duration_s) DO UPDATE SET credits = EXCLUDED.credits, source = EXCLUDED.source, probed_at = EXCLUDED.probed_at`,
        [g.operation, model, GEN_RESOLUTION, durationS, credits, services.providers.imageVideo.name, services.now()],
      );
      out.push({ operation: g.operation, model, durationS, credits });
    }
  }
  if (missing.length) {
    const studioId = opts.studioId ?? (await services.db.maybeOne<{ id: string }>('SELECT id FROM studio ORDER BY created_at LIMIT 1'))?.id;
    if (studioId) {
      await notify(services.db, {
        studioId,
        kind: 'system',
        severity: 'warn',
        title: 'Higgsfield price probe returned no price',
        body: `No price came back for ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ` and ${missing.length - 6} more` : ''}. Media keeps reserving the built-in estimates; check the Higgsfield CLI output (\`higgsfield generate cost … --json\`).`,
        link: '/settings',
      });
    }
  }
  return out;
}

export interface SpendScope {
  readonly studioId: string;
  readonly personaId: string;
  readonly slotId: string | null;
  readonly ref: CostRef;
}

async function logGeneration(db: Db, s: SpendScope, g: { operation: string; provider: string; model?: string | null; jobId?: string | null; url?: string | null; credits: number; usd: number; meta?: Record<string, unknown> }) {
  await db.query(
    `INSERT INTO media_generation (persona_id, slot_id, operation, provider, model, job_id, url, credits, usd_cost, meta) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [s.personaId, s.slotId, g.operation, g.provider, g.model ?? null, g.jobId ?? null, g.url ?? null, g.credits, g.usd, json(g.meta ?? {})],
  );
  if (s.slotId) await db.query(`UPDATE media_render SET credits = credits + $2, usd_cost = usd_cost + $3, updated_at = now() WHERE slot_id = $1`, [s.slotId, g.credits, g.usd]);
}

/**
 * A Higgsfield call under the governor (unit hf_credits), settled at the credits the job actually cost; when the CLI
 * reported no cost (or 0) for the paid job, it settles at the estimate and the generation is flagged
 * (meta.credits_unreported), so missing cost data can never make spend free.
 */
export async function hfSpend<T extends { credits?: number; creditsUnknown?: boolean; jobId?: string; url?: string; soulId?: string }>(
  services: StudioServices,
  scope: SpendScope,
  spec: { operation: HiggsfieldOperation | 'tts'; model: string; durationS?: number; provider?: string; extraEstimate?: number; estimate?: number },
  call: () => Promise<T>,
): Promise<T & { credits: number }> {
  const estimate = (spec.estimate ?? (spec.operation === 'tts' ? 0 : await estimateCredits(services.db, { ...spec, operation: spec.operation }))) + (spec.extraEstimate ?? 0);
  const provider = spec.provider ?? services.providers.imageVideo.name;
  const r = await metered(
    services.db,
    { studioId: scope.studioId, personaId: scope.personaId, agent: 'video-producer', ref: scope.ref },
    { unit: 'hf_credits', estimate, provider, operation: spec.operation },
    call,
    (x) => creditsToSettle(x, estimate),
  );
  const credits = creditsToSettle(r, estimate);
  const unreported = credits !== r.credits;
  await logGeneration(services.db, scope, {
    operation: spec.operation,
    provider,
    model: spec.model,
    jobId: r.jobId ?? r.soulId ?? null,
    url: r.url ?? null,
    credits,
    usd: 0,
    meta: { estimate, ...(unreported ? { credits_unreported: true } : {}) },
  });
  return { ...r, credits };
}

/** A USD-billed media call (ElevenLabs TTS, fal avatar) under the governor (unit media_usd). */
export async function usdSpend<T extends { costUsd: number; url?: string; jobId?: string }>(
  services: StudioServices,
  scope: SpendScope,
  spec: { operation: string; provider: string; estimate: number; model?: string },
  call: () => Promise<T>,
): Promise<T> {
  const r = await metered(
    services.db,
    { studioId: scope.studioId, personaId: scope.personaId, agent: 'video-producer', ref: scope.ref },
    { unit: 'media_usd', estimate: spec.estimate, provider: spec.provider, operation: spec.operation },
    call,
    (x) => x.costUsd,
  );
  await logGeneration(services.db, scope, { operation: spec.operation, provider: spec.provider, model: spec.model, jobId: r.jobId ?? null, url: r.url ?? null, credits: 0, usd: r.costUsd });
  return r;
}
