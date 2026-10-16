import type { Db } from '@ios/db';
import {
  estimateTokens,
  higgsfieldCredits,
  llmCostUsd,
  type ImageVideoProvider,
  type LlmProvider,
  type Providers,
  type TalkingProvider,
  type VoiceProvider,
} from '@ios/providers';
import { releaseHold, reserve, settleHold, type Unit } from './governor';
import type { CostRef } from './types';

export interface MeterContext {
  studioId: string;
  personaId?: string | null;
  /** Which agent/worker is spending (recorded on agent_run and the ledger). */
  agent: string;
  /** What the spend is for (credit_ledger.ref_type / ref_id), for the Profit Engine's P&L. */
  ref?: CostRef;
}

/**
 * Runs a paid provider call under the governor: reserve the estimate first (refused if it would pass a cap, and
 * serialised with every other reservation, so concurrent calls can't all fit in the same headroom), then settle
 * the hold to the actual cost (recorded even if it overshoots the estimate, since it was incurred), or release it
 * if the call fails (debiting what a failed call reports it spent, `err.costUsd`).
 */
export async function metered<T>(
  db: Db,
  ctx: MeterContext,
  spec: { unit: Unit; estimate: number; provider: string; operation: string },
  call: () => Promise<T>,
  actual: (r: T) => number,
): Promise<T> {
  const base = {
    studioId: ctx.studioId,
    personaId: ctx.personaId,
    unit: spec.unit,
    provider: spec.provider,
    operation: spec.operation,
    refType: ctx.ref?.type,
    refId: ctx.ref?.id,
    meta: { agent: ctx.agent },
  };
  const holdId = await reserve(db, { ...base, amount: spec.estimate });
  let result: T;
  try {
    result = await call();
  } catch (err) {
    // A provider that spent money before failing reports it as `err.costUsd` (e.g. web research that ran several
    // streams and then returned unusable output), or `err.credits` for credit units (e.g. Soul ID stills bought before
    // the final step failed): debit that, since it was incurred. `err.settleAtEstimate` (a job submitted and then lost
    // to a timeout: it keeps running and bills) debits the estimate. Otherwise nothing was spent.
    const e = err as { costUsd?: unknown; credits?: unknown; settleAtEstimate?: unknown } | null;
    const reported = spec.unit === 'hf_credits' ? (e?.credits ?? e?.costUsd) : e?.costUsd;
    const spent = e?.settleAtEstimate === true ? Math.max(spec.estimate, typeof reported === 'number' && Number.isFinite(reported) ? reported : 0) : reported;
    if (typeof spent === 'number' && Number.isFinite(spent) && spent > 0) {
      await settleHold(db, holdId, { ...base, amount: spent, meta: { ...base.meta, failed: true } }).catch(() => releaseHold(db, holdId));
    } else {
      await releaseHold(db, holdId);
    }
    throw err;
  }
  await settleHold(db, holdId, { ...base, amount: actual(result) });
  return result;
}

/**
 * What a credit-billed result settles at: the reported credits, or the estimate when the vendor reported none (or 0)
 * for a paid job. A missing cost is unknown, never free (else caps would never trip).
 */
export function creditsToSettle(r: { credits?: number; creditsUnknown?: boolean }, estimate: number): number {
  const c = r.credits;
  return r.creditsUnknown || typeof c !== 'number' || !Number.isFinite(c) || c <= 0 ? estimate : c;
}
const settled = (estimate: number) => (r: { credits?: number; creditsUnknown?: boolean }) => creditsToSettle(r, estimate);

/** Wraps the paid providers so every call is checked and debited. Free providers pass through. */
export function meteredProviders(db: Db, raw: Providers, ctx: MeterContext): Providers {
  const llm: LlmProvider = {
    name: raw.llm.name,
    async complete(req) {
      const inTok = estimateTokens((req.cached ?? []).map((b) => b.text).join('\n') + (req.system ?? '') + req.messages.map((m) => m.content).join('\n'));
      const estimate = llmCostUsd(req.tier, inTok, req.maxTokens ?? 1024);
      const startedAt = new Date();
      const res = await metered(db, ctx, { unit: 'llm_usd', estimate, provider: raw.llm.name, operation: `complete:${req.tier}` }, () => raw.llm.complete(req), (r) => r.costUsd);
      await db.query(
        `INSERT INTO agent_run (studio_id, persona_id, agent, model, input_tokens, output_tokens, cost_usd, outcome, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ok', $8, now())`,
        [ctx.studioId, ctx.personaId ?? null, ctx.agent, res.model, res.inputTokens, res.outputTokens, res.costUsd, startedAt],
      );
      return res;
    },
  };

  const hf = raw.imageVideo;
  const credits = (op: Parameters<typeof higgsfieldCredits>[0], d?: number) => higgsfieldCredits(op, d);
  const spec = (operation: string, estimate: number) => ({ unit: 'hf_credits' as const, estimate, provider: hf.name, operation });
  const imageVideo: ImageVideoProvider = {
    name: hf.name,
    createSoulId: (req) => metered(db, ctx, spec('soul_id', credits('soul_id')), () => hf.createSoulId(req), settled(credits('soul_id'))),
    generateStill: (req) => metered(db, ctx, spec('still', credits('still')), () => hf.generateStill(req), settled(credits('still'))),
    imageToVideo: (req) =>
      metered(db, ctx, spec('image_to_video', credits('image_to_video', req.durationS)), () => hf.imageToVideo(req), settled(credits('image_to_video', req.durationS))),
    talkingWithAudio: (req) =>
      // Unknown audio length: reserve for 60 s (2x the usual 30 s clip) rather than under-reserve.
      metered(db, ctx, spec('talking_with_audio', credits('talking_with_audio', req.durationS ?? 60)), () => hf.talkingWithAudio(req), settled(credits('talking_with_audio', req.durationS ?? 60))),
    costProbe: (req) => hf.costProbe(req), // free
    upload: (req) => hf.upload(req), // free
  };

  const talking: TalkingProvider = {
    name: raw.talking.name,
    async render(req) {
      if (raw.talking.name === 'higgsfield-seedance') {
        return metered(db, ctx, spec('talking_seedance', credits('talking_with_audio', req.durationS)), () => raw.talking.render(req), settled(credits('talking_with_audio', req.durationS)));
      }
      return metered(
        db,
        ctx,
        { unit: 'media_usd', estimate: req.durationS * 0.06, provider: raw.talking.name, operation: 'talking' },
        () => raw.talking.render(req),
        (r) => r.costUsd,
      );
    },
  };

  const voice: VoiceProvider = {
    name: raw.voice.name,
    designVoice: (req) => raw.voice.designVoice(req),
    tts: (req) =>
      metered(
        db,
        ctx,
        { unit: 'media_usd', estimate: req.text.length * 0.0002, provider: raw.voice.name, operation: 'tts' },
        () => raw.voice.tts(req),
        (r) => r.costUsd,
      ),
  };

  return { ...raw, llm, imageVideo, talking, voice };
}
