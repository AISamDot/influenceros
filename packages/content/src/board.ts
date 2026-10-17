import type { GateCheck, MediaRenderPayload, PipelineStage, QcCheck } from '@troupe/agents';
import type { GateVerdict, PostFormat, PostPurpose } from '@troupe/core';
import type { Db } from '@troupe/db';
import type { Hook } from './hooks';
import { stageOf } from './pipeline';

/** Read models for the dashboard's Pipeline board and slot detail page. */

export interface BoardItem {
  slotId: string;
  personaId: string;
  personaName: string;
  personaSlug: string;
  personaTimezone: string;
  portraitUrl: string | null;
  slotAt: Date;
  window: string | null;
  format: PostFormat;
  purpose: PostPurpose;
  pillar: string | null;
  title: string;
  hook: string | null;
  status: string;
  stage: PipelineStage | null;
  thumbnailUrl: string | null;
  ctaKeyword: string | null;
  blockReason: string | null;
  waiting: string | null;
  gateVerdict: GateVerdict | null;
  q1Pass: boolean | null;
  q1Score: number | null;
  queued: boolean;
  /** IOS-3: the media render's step (voice, generate, q3, render, q4, done, blocked) and what it has cost so far. */
  mediaStep: string | null;
  mediaCredits: number | null;
  mediaUsd: number | null;
  /** The newest generated still while a render is in progress (the cover replaces it once Q4 passes). */
  renderThumbUrl: string | null;
}

export interface BoardColumn {
  key: string;
  label: string;
  stages: readonly PipelineStage[];
  /** IOS-3 owns these stages; the column shows what is waiting for them. */
  later?: boolean;
}

export const BOARD_COLUMNS: readonly BoardColumn[] = [
  { key: 'idea', label: 'Idea', stages: ['idea'] },
  { key: 'script', label: 'Script', stages: ['script'] },
  { key: 'q1', label: 'QC · Q1', stages: ['q1'] },
  { key: 'gate', label: 'Gate', stages: ['gate'] },
  { key: 'media_queued', label: 'Queued for media', stages: ['media_queued'] },
  { key: 'media', label: 'Voice · render · QC', stages: ['voice', 'q2', 'render', 'q3', 'q4'] },
  { key: 'final_gate', label: 'Final Gate', stages: ['final_gate'] },
  { key: 'scheduled', label: 'Scheduled', stages: ['scheduled'] },
  { key: 'live', label: 'Live', stages: ['live'] },
  { key: 'blocked', label: 'Blocked', stages: ['blocked'] },
];

export function columnOf(stage: PipelineStage | null): string | null {
  if (!stage) return null;
  return BOARD_COLUMNS.find((c) => c.stages.includes(stage))?.key ?? null;
}

export async function pipelineBoard(db: Db, studioId: string, opts: { from?: Date; to?: Date; personaId?: string | null; slotId?: string }): Promise<BoardItem[]> {
  const rows = await db.query<{
    id: string; persona_id: string; name: string; slug: string; timezone: string; portrait_url: string | null; slot_at: Date; posting_window: string | null;
    format: PostFormat; purpose: PostPurpose; pillar: string | null; title: string; status: string; thumbnail_url: string | null;
    cta_keyword: string | null; block_reason: string | null; waiting: string | null; hook: string | null; gate_verdict: GateVerdict | null;
    q1_pass: boolean | null; q1_score: number | null; queued: boolean; media_step: string | null; media_credits: string | null; media_usd: string | null;
    render_thumb: string | null;
  }>(
    `SELECT s.id, s.persona_id, p.name, p.slug, p.timezone, p.portrait_url, s.slot_at, s.posting_window, s.format, s.purpose, s.pillar, s.title, s.status,
            s.thumbnail_url, s.cta_keyword, s.block_reason, COALESCE(mr.waiting, s.meta->>'waiting') AS waiting, sc.hook,
            mr.step AS media_step, mr.credits AS media_credits, mr.usd_cost AS media_usd,
            (SELECT a.url FROM asset a WHERE a.slot_id = s.id AND a.role = 'still' AND COALESCE(a.render_meta->>'fake', 'false') <> 'true' ORDER BY a.created_at DESC LIMIT 1) AS render_thumb,
            (SELECT g.verdict FROM gate_result g WHERE g.subject_type = 'script' AND g.subject_id = s.script_id ORDER BY g.created_at DESC LIMIT 1) AS gate_verdict,
            (SELECT q.pass FROM qc_report q WHERE q.subject_type = 'script' AND q.subject_id = s.script_id AND q.stage = 'Q1' ORDER BY q.created_at DESC LIMIT 1) AS q1_pass,
            (SELECT q.score FROM qc_report q WHERE q.subject_type = 'script' AND q.subject_id = s.script_id AND q.stage = 'Q1' ORDER BY q.created_at DESC LIMIT 1) AS q1_score,
            EXISTS (SELECT 1 FROM job j WHERE j.kind = 'pipeline.slot' AND j.payload->>'slotId' = s.id::text AND j.status IN ('queued','running')) AS queued
       FROM calendar_slot s JOIN persona p ON p.id = s.persona_id LEFT JOIN script sc ON sc.id = s.script_id
       LEFT JOIN media_render mr ON mr.slot_id = s.id AND mr.script_id IS NOT DISTINCT FROM s.script_id
      WHERE p.studio_id = $1 AND ($5::uuid IS NOT NULL OR s.status <> 'skipped')
        AND ($2::timestamptz IS NULL OR s.slot_at >= $2) AND ($3::timestamptz IS NULL OR s.slot_at < $3)
        AND ($4::uuid IS NULL OR s.persona_id = $4) AND ($5::uuid IS NULL OR s.id = $5)
      ORDER BY s.slot_at`,
    [studioId, opts.from ?? null, opts.to ?? null, opts.personaId ?? null, opts.slotId ?? null],
  );
  return rows.map((r) => ({
    slotId: r.id,
    personaId: r.persona_id,
    personaName: r.name,
    personaSlug: r.slug,
    personaTimezone: r.timezone,
    portraitUrl: r.portrait_url,
    slotAt: new Date(r.slot_at),
    window: r.posting_window,
    format: r.format,
    purpose: r.purpose,
    pillar: r.pillar,
    title: r.title,
    hook: r.hook,
    status: r.status,
    stage: stageOf(r.status),
    thumbnailUrl: r.thumbnail_url,
    ctaKeyword: r.cta_keyword,
    blockReason: r.block_reason,
    waiting: r.waiting,
    gateVerdict: r.gate_verdict,
    q1Pass: r.q1_pass,
    q1Score: r.q1_score === null ? null : Number(r.q1_score),
    queued: r.queued,
    mediaStep: r.media_step,
    mediaCredits: r.media_credits === null ? null : Number(r.media_credits),
    mediaUsd: r.media_usd === null ? null : Number(r.media_usd),
    renderThumbUrl: r.render_thumb,
  }));
}

export interface SlotDetail {
  slot: BoardItem & { productName: string | null; meta: Record<string, unknown> };
  script: {
    id: string;
    version: number;
    status: string;
    hook: string | null;
    body: string;
    voiceover: string | null;
    caption: string | null;
    hashtags: string[];
    onScreenText: string[];
    carousel: Array<{ title: string; body: string }> | null;
    visualBrief: string | null;
    evidence: string[];
    claims: Array<{ text: string; evidence_id: string | null }>;
    wordCount: number | null;
    estSeconds: number | null;
    fixLoops: number;
    lab: Hook[];
    shipped: Hook | null;
    variants: Hook[];
  } | null;
  qc: Array<{ id: string; stage: string; pass: boolean; score: number | null; checks: QcCheck[]; loop: number | null; createdAt: Date }>;
  gate: Array<{ id: string; stage: string; verdict: GateVerdict; checks: GateCheck[]; createdAt: Date }>;
  media: { jobId: string; status: string; payload: MediaRenderPayload } | null;
}

export async function slotDetail(db: Db, studioId: string, slotId: string): Promise<SlotDetail | null> {
  const [item] = await pipelineBoard(db, studioId, { slotId });
  if (!item) return null;
  const extra = await db.one<{ product_name: string | null; meta: Record<string, unknown>; script_id: string | null }>(
    `SELECT pr.name AS product_name, s.meta, s.script_id FROM calendar_slot s LEFT JOIN product pr ON pr.id = s.product_id WHERE s.id = $1`,
    [slotId],
  );
  const sc = extra.script_id
    ? await db.maybeOne<{
        id: string; version: number; status: string; hook: string | null; body: string; voiceover: string | null; caption: string | null; hashtags: string[];
        on_screen_text: string[]; carousel: Array<{ title: string; body: string }> | null; visual_brief: string | null; evidence: string[];
        claims: Array<{ text: string; evidence_id: string | null }>; word_count: number | null; est_seconds: number | null; fix_loops: number;
        hooks: { lab?: Hook[]; shipped?: Hook; variants?: Hook[] };
      }>('SELECT * FROM script WHERE id = $1', [extra.script_id])
    : null;
  const qc = sc
    ? await db.query<{ id: string; stage: string; pass: boolean; score: number | null; details: { checks?: QcCheck[]; loop?: number }; created_at: Date }>(
        `SELECT id, stage, pass, score, details, created_at FROM qc_report WHERE subject_type = 'script' AND subject_id = $1 ORDER BY created_at`,
        [sc.id],
      )
    : [];
  const gate = sc
    ? await db.query<{ id: string; stage: string; verdict: GateVerdict; checks: GateCheck[]; created_at: Date }>(
        `SELECT id, stage, verdict, checks, created_at FROM gate_result WHERE subject_type = 'script' AND subject_id = $1 ORDER BY created_at`,
        [sc.id],
      )
    : [];
  const media = sc
    ? await db.maybeOne<{ id: string; status: string; payload: MediaRenderPayload }>(
        `SELECT id, status, payload FROM job WHERE kind = 'media.render' AND payload->>'scriptId' = $1 ORDER BY created_at DESC LIMIT 1`,
        [sc.id],
      )
    : null;
  return {
    slot: { ...item, productName: extra.product_name, meta: extra.meta ?? {} },
    script: sc
      ? {
          id: sc.id,
          version: sc.version,
          status: sc.status,
          hook: sc.hook,
          body: sc.body,
          voiceover: sc.voiceover,
          caption: sc.caption,
          hashtags: sc.hashtags ?? [],
          onScreenText: sc.on_screen_text ?? [],
          carousel: sc.carousel,
          visualBrief: sc.visual_brief,
          evidence: sc.evidence ?? [],
          claims: sc.claims ?? [],
          wordCount: sc.word_count,
          estSeconds: sc.est_seconds === null ? null : Number(sc.est_seconds),
          fixLoops: sc.fix_loops,
          lab: sc.hooks?.lab ?? [],
          shipped: sc.hooks?.shipped ?? null,
          variants: sc.hooks?.variants ?? [],
        }
      : null,
    qc: qc.map((q) => ({ id: q.id, stage: q.stage, pass: q.pass, score: q.score === null ? null : Number(q.score), checks: q.details?.checks ?? [], loop: q.details?.loop ?? null, createdAt: new Date(q.created_at) })),
    gate: gate.map((g) => ({ id: g.id, stage: g.stage, verdict: g.verdict, checks: g.checks ?? [], createdAt: new Date(g.created_at) })),
    media: media ? { jobId: media.id, status: media.status, payload: media.payload } : null,
  };
}
