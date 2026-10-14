import { type GateCheck, MEDIA_RENDER_JOB, type MediaRenderPayload, type PipelineStage, type QcCheck, type StudioServices } from '@ios/agents';
import { type CostRef, enqueue, notify, type PostFormat, type PostPurpose, thumbnailUri } from '@ios/core';
import { json } from '@ios/db';
import { runGate, saveGateResult } from './gate';
import { type Hook, type HookLab, type HookType, runHookLab } from './hooks';
import { loadPersonaContext, type PersonaContext } from './persona';
import { checkScript, saveQcReport } from './qc';
import { type ScriptBrief, type ScriptDraft, SPOKEN, writeScript } from './script';
import { asString } from './util';

/**
 * The content pipeline (FR-4, FR-21.1, §3.4): idea → script (hook-lab + Scriptwriter) → Q1 (max 2 maker fix loops)
 * → Gate (pre-render) → queued for media (`media.render`, IOS-3). Every step is idempotent and resumes from the
 * slot's status, so a retried job never redoes finished work or enqueues media twice. Red never proceeds.
 */

export const MAX_FIX_LOOPS = 2;

/** calendar_slot.status → Pipeline board stage. */
export function stageOf(status: string): PipelineStage | null {
  switch (status) {
    case 'planned':
      return 'idea';
    case 'scripted':
      return 'script';
    case 'rendering':
      return 'render';
    case 'qc':
      return 'final_gate';
    case 'skipped':
      return null;
    default:
      return status as PipelineStage;
  }
}

export interface SlotRow {
  id: string;
  persona_id: string;
  slot_at: Date;
  format: PostFormat;
  purpose: PostPurpose;
  pillar: string | null;
  title: string;
  status: string;
  idea_id: string | null;
  script_id: string | null;
  cta_keyword: string | null;
  product_id: string | null;
  block_reason: string | null;
  meta: Record<string, unknown>;
}

export interface SlotOutcome {
  readonly slotId: string;
  readonly status: string;
  readonly scriptId: string | null;
  readonly verdict?: 'green' | 'amber' | 'red';
  readonly q1Pass?: boolean;
  readonly fixLoops?: number;
  readonly blockReason?: string | null;
  readonly mediaJobId?: string | null;
}

async function setStatus(services: StudioServices, slotId: string, status: string, extra: { blockReason?: string | null; scriptId?: string } = {}) {
  await services.db.query(
    `UPDATE calendar_slot SET status = $2, block_reason = $3, script_id = COALESCE($4, script_id), stage_changed_at = $5 WHERE id = $1`,
    [slotId, status, extra.blockReason ?? null, extra.scriptId ?? null, services.now()],
  );
}

interface ScriptRow {
  id: string;
  version: number;
  hooks: { lab?: Hook[]; shipped?: Hook; variants?: Hook[] };
  hook: string;
  body: string;
  caption: string | null;
  cta_keyword: string | null;
  hashtags: string[];
  on_screen_text: string[];
  carousel: Array<{ title: string; body: string }> | null;
  visual_brief: string | null;
  evidence: string[];
  claims: Array<{ text: string; evidence_id: string | null }>;
  voiceover: string | null;
  fix_loops: number;
}

const draftOf = (s: ScriptRow): ScriptDraft => ({
  hook: s.hook,
  body: s.body,
  caption: s.caption ?? '',
  ctaKeyword: s.cta_keyword ?? '',
  hashtags: s.hashtags ?? [],
  onScreenText: s.on_screen_text ?? [],
  carousel: s.carousel,
  visualBrief: s.visual_brief ?? '',
  claims: (s.claims ?? []).map((c) => ({ text: c.text, evidenceId: c.evidence_id })),
});

async function saveDraft(services: StudioServices, scriptId: string, d: ScriptDraft, extra: { voiceover?: string | null; wordCount?: number; estSeconds?: number | null; fixLoops?: number; status?: string; evidence?: string[] } = {}) {
  await services.db.query(
    `UPDATE script SET hook = $2, body = $3, caption = $4, cta_keyword = $5, hashtags = $6, on_screen_text = $7::jsonb, carousel = $8::jsonb,
            visual_brief = $9, claims = $10::jsonb, voiceover = COALESCE($11, voiceover), word_count = COALESCE($12, word_count),
            est_seconds = COALESCE($13, est_seconds), fix_loops = COALESCE($14, fix_loops), status = COALESCE($15, status),
            evidence = COALESCE($16::jsonb, evidence)
      WHERE id = $1`,
    [
      scriptId,
      d.hook,
      d.body,
      d.caption,
      d.ctaKeyword,
      d.hashtags,
      json(d.onScreenText),
      d.carousel ? json(d.carousel) : null,
      d.visualBrief,
      json(d.claims.map((c) => ({ text: c.text, evidence_id: c.evidenceId }))),
      extra.voiceover ?? null,
      extra.wordCount ?? null,
      extra.estSeconds ?? null,
      extra.fixLoops ?? null,
      extra.status ?? null,
      extra.evidence ? json(extra.evidence) : null,
    ],
  );
}

/**
 * Q1 with the maker's fix loop: grade; on a blocker/major the Scriptwriter revises (at most MAX_FIX_LOOPS times),
 * every pass saved as its own qc_report. Returns the final draft, its grade and the loops used.
 */
export async function q1WithFixes(
  services: StudioServices,
  args: { brief: ScriptBrief; draft: ScriptDraft; scriptId: string; costRef?: CostRef; evidenceIds: readonly string[] },
): Promise<{ draft: ScriptDraft; grade: ReturnType<typeof checkScript>; loops: number; reportIds: string[] }> {
  const { brief } = args;
  let draft = args.draft;
  const reportIds: string[] = [];
  for (let loop = 0; ; loop++) {
    const grade = checkScript(draft, { format: brief.format, expectedKeyword: brief.ctaKeyword, ctx: brief.ctx, evidenceIds: args.evidenceIds });
    reportIds.push(
      await saveQcReport(services, {
        personaId: brief.ctx.persona.id,
        subjectType: 'script',
        subjectId: args.scriptId,
        stage: 'Q1',
        pass: grade.pass,
        score: grade.score,
        checks: grade.checks,
        extra: { loop, word_count: grade.wordCount, est_seconds: grade.estSeconds, tts_rewrites: grade.ttsRisks.slice(0, 20) },
      }),
    );
    if (grade.pass || loop >= MAX_FIX_LOOPS) return { draft, grade, loops: loop, reportIds };
    const defects: QcCheck[] = grade.checks.filter((c) => !c.pass);
    const revised = await writeScript(services, brief, { costRef: args.costRef, revise: { previous: draft, defects } });
    draft = revised.draft;
  }
}

const failingSummary = (checks: readonly QcCheck[]) =>
  checks
    .filter((c) => !c.pass && c.severity !== 'minor')
    .map((c) => c.message)
    .join(' ');
const redSummary = (checks: readonly GateCheck[]) =>
  checks
    .filter((c) => c.verdict === 'red')
    .map((c) => `${c.rule.replace(/_/g, ' ')}: ${c.message}`)
    .join(' ');

async function existingMediaJob(services: StudioServices, scriptId: string): Promise<string | null> {
  const row = await services.db.maybeOne<{ id: string }>(
    `SELECT id FROM job WHERE kind = $1 AND payload->>'scriptId' = $2 AND status <> 'dead' ORDER BY created_at DESC LIMIT 1`,
    [MEDIA_RENDER_JOB, scriptId],
  );
  return row?.id ?? null;
}

export function mediaPayload(slot: Pick<SlotRow, 'id' | 'persona_id' | 'format'>, scriptId: string, d: ScriptDraft, voiceover: string | null, evidence: readonly string[]): MediaRenderPayload {
  return {
    slotId: slot.id,
    personaId: slot.persona_id,
    scriptId,
    format: slot.format,
    voiceover: SPOKEN.includes(slot.format) ? voiceover : null,
    onScreenText: slot.format === 'carousel' ? [] : d.onScreenText,
    carousel: slot.format === 'carousel' ? d.carousel : null,
    caption: d.caption,
    ctaKeyword: d.ctaKeyword,
    hashtags: d.hashtags,
    visualBrief: d.visualBrief,
    evidence: [...evidence],
  };
}

/**
 * Runs (or resumes) one slot through idea → script → Q1 → Gate → media_queued. Budget refusals propagate
 * (BudgetExceededError) so the job can defer; the slot keeps its stage.
 */
export async function processSlot(services: StudioServices, slotId: string): Promise<SlotOutcome> {
  const { db } = services;
  const slot = await db.one<SlotRow>('SELECT * FROM calendar_slot WHERE id = $1', [slotId]);
  const done = (status: string, more: Partial<SlotOutcome> = {}): SlotOutcome => ({ slotId, status, scriptId: slot.script_id, ...more });
  if (!['planned', 'scripted', 'q1', 'gate'].includes(slot.status)) return done(slot.status, { blockReason: slot.block_reason });
  const ctx: PersonaContext = await loadPersonaContext(db, slot.persona_id);
  if (['KILLED', 'RETIRED'].includes(ctx.persona.state)) {
    await setStatus(services, slotId, 'skipped', { blockReason: `persona is ${ctx.persona.state}` });
    return done('skipped');
  }
  const costRef: CostRef = { type: 'calendar_slot', id: slotId };
  const studioId = ctx.persona.studio_id;
  const ctaKeyword = (slot.cta_keyword ?? ctx.leadKeyword).toUpperCase();
  const ctaDelivers = asString(slot.meta?.cta_delivers, ctx.keywords.find((k) => k.keyword === ctaKeyword)?.delivers ?? 'the free guide');
  const product = slot.product_id ? await db.maybeOne<{ name: string }>('SELECT name FROM product WHERE id = $1', [slot.product_id]) : null;
  const knowledge = await services.knowledge.retrieve({ studioId, niche: ctx.persona.niche, query: `${slot.title} ${slot.pillar ?? ''}`.trim(), k: 4 });
  const evidenceIds = knowledge.map((k) => k.id);

  // ── idea ──
  if (!slot.idea_id) {
    const idea = await db.one<{ id: string }>(
      `INSERT INTO idea (persona_id, title, pillar, format, purpose, source, status, cta_keyword, product_id) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'booked', $7, $8) RETURNING id`,
      [slot.persona_id, slot.title, slot.pillar, slot.format, slot.purpose, json({ type: 'slot', slot_id: slotId }), ctaKeyword, slot.product_id],
    );
    await db.query('UPDATE calendar_slot SET idea_id = $2, cta_keyword = $3 WHERE id = $1', [slotId, idea.id, ctaKeyword]);
    slot.idea_id = idea.id;
  }

  // ── script (hook-lab + Scriptwriter) ──
  let script = slot.script_id ? await db.maybeOne<ScriptRow>('SELECT * FROM script WHERE id = $1', [slot.script_id]) : null;
  let lab: Pick<HookLab, 'shipped' | 'variants' | 'hooks'> | null = script?.hooks?.shipped
    ? { shipped: script.hooks.shipped, variants: script.hooks.variants ?? [], hooks: script.hooks.lab ?? [] }
    : null;
  const brief = (shipped: Hook, variants: readonly Hook[]): ScriptBrief => ({
    ctx,
    title: slot.title,
    pillar: slot.pillar,
    format: slot.format,
    purpose: slot.purpose,
    ctaKeyword,
    ctaDelivers,
    productName: product?.name ?? null,
    hook: shipped,
    variants,
    knowledge,
  });
  if (!script || slot.status === 'planned') {
    const past = await db.query<{ hook: string; type: HookType | null }>(
      `SELECT hook, hooks->'shipped'->>'type' AS type FROM script WHERE persona_id = $1 AND hook IS NOT NULL ORDER BY created_at DESC LIMIT 30`,
      [slot.persona_id],
    );
    const ran = await runHookLab(services, {
      ctx,
      title: slot.title,
      pillar: slot.pillar,
      format: slot.format,
      purpose: slot.purpose,
      costRef,
      recent: past.map((r) => r.hook),
      recentTypes: past.map((r) => r.type).filter((t): t is HookType => !!t),
    });
    lab = ran;
    const { draft } = await writeScript(services, brief(ran.shipped, ran.variants), { costRef });
    const version = (await db.one<{ v: number }>('SELECT COALESCE(max(version), 0)::int + 1 AS v FROM script WHERE slot_id = $1', [slotId])).v;
    script = await db.one<ScriptRow>(
      `INSERT INTO script (persona_id, idea_id, slot_id, version, format, hooks, hook, body, caption, cta_keyword, hashtags, on_screen_text, carousel,
                           visual_brief, evidence, claims, status, meta)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15::jsonb, $16::jsonb, 'draft', $17::jsonb) RETURNING *`,
      [
        slot.persona_id,
        slot.idea_id,
        slotId,
        version,
        slot.format,
        json({ shipped: ran.shipped, variants: ran.variants, lab: ran.hooks }),
        draft.hook,
        draft.body,
        draft.caption,
        ctaKeyword,
        draft.hashtags,
        json(draft.onScreenText),
        draft.carousel ? json(draft.carousel) : null,
        draft.visualBrief,
        json(evidenceIds.filter((id) => draft.claims.some((c) => c.evidenceId === id))),
        json(draft.claims.map((c) => ({ text: c.text, evidence_id: c.evidenceId }))),
        json({ hook_lab_run: ran.runId }),
      ],
    );
    await db.query(`UPDATE idea SET status = 'scripted', hook_options = $2::jsonb WHERE id = $1`, [slot.idea_id, json(ran.hooks.map((h) => ({ text: h.text, type: h.type, score: h.score })))]);
    await db.query('UPDATE calendar_slot SET thumbnail_url = $2 WHERE id = $1', [slotId, thumbnailUri(ran.shipped.text, ctx.hue, slot.format, version)]);
    await setStatus(services, slotId, 'scripted', { scriptId: script.id });
    slot.status = 'scripted';
  }
  if (!script || !lab) throw new Error(`slot ${slotId}: script missing after the script stage`);
  const scriptBrief = brief(lab.shipped, lab.variants);

  // ── Q1 (+ maker fix loops) ──
  let draft = draftOf(script);
  if (slot.status === 'scripted' || slot.status === 'q1') {
    await setStatus(services, slotId, 'q1');
    await db.query(`UPDATE script SET status = 'qc' WHERE id = $1`, [script.id]);
    const q1 = await q1WithFixes(services, { brief: scriptBrief, draft, scriptId: script.id, costRef, evidenceIds });
    draft = q1.draft;
    const evidence = evidenceIds.filter((id) => draft.claims.some((c) => c.evidenceId === id));
    await saveDraft(services, script.id, draft, {
      voiceover: q1.grade.voiceover,
      wordCount: q1.grade.wordCount,
      estSeconds: q1.grade.estSeconds,
      fixLoops: q1.loops,
      status: q1.grade.pass ? 'gate' : 'rejected',
      evidence,
    });
    script.voiceover = q1.grade.voiceover;
    script.evidence = evidence;
    if (!q1.grade.pass) {
      const reason = `Q1: ${failingSummary(q1.grade.checks)}`.slice(0, 500);
      await setStatus(services, slotId, 'blocked', { blockReason: reason });
      await notify(db, { studioId, personaId: slot.persona_id, kind: 'system', severity: 'warn', title: `QC blocked a script: ${slot.title}`, body: reason, link: `/pipeline/${slotId}` });
      return done('blocked', { scriptId: script.id, q1Pass: false, fixLoops: q1.loops, blockReason: reason });
    }
    await setStatus(services, slotId, 'gate');
    slot.status = 'gate';
  }

  // ── Compliance Gate (pre-render) ──
  const text = [draft.hook, draft.body, draft.caption, ...draft.onScreenText, ...(draft.carousel ?? []).flatMap((s) => [s.title, s.body]), draft.hashtags.join(' ')].join('\n');
  const gate = await runGate(services, {
    studioId,
    personaId: slot.persona_id,
    input: { kind: 'script', text, purpose: slot.purpose, evidenceIds: script.evidence ?? [] },
    cached: ctx.cached,
    costRef,
    label: `gate: ${slot.format} script`,
  });
  await saveGateResult(services, { personaId: slot.persona_id, subjectType: 'script', subjectId: script.id, stage: 'pre_render', verdict: gate.verdict, checks: gate.checks });
  if (gate.verdict === 'red') {
    const reason = `Gate red: ${redSummary(gate.checks)}`.slice(0, 500);
    await db.query(`UPDATE script SET status = 'rejected' WHERE id = $1`, [script.id]);
    await setStatus(services, slotId, 'blocked', { blockReason: reason });
    await notify(db, { studioId, personaId: slot.persona_id, kind: 'escalation', severity: 'warn', title: `Gate blocked: ${slot.title}`, body: reason, link: `/pipeline/${slotId}` });
    return done('blocked', { scriptId: script.id, verdict: 'red', q1Pass: true, blockReason: reason });
  }
  await db.query(`UPDATE script SET status = 'approved', meta = meta || $2::jsonb WHERE id = $1`, [script.id, json({ gate: gate.verdict })]);

  // ── queued for media (IOS-3 registers the media.render handler) ──
  let mediaJobId = await existingMediaJob(services, script.id);
  if (!mediaJobId) {
    const payload = mediaPayload(slot, script.id, draft, script.voiceover, script.evidence ?? []);
    const job = await enqueue(db, { kind: MEDIA_RENDER_JOB, studioId, personaId: slot.persona_id, payload: payload as unknown as Record<string, unknown>, runAt: services.now() });
    mediaJobId = job.id;
  }
  await db.query(`UPDATE calendar_slot SET meta = meta || $2::jsonb WHERE id = $1`, [slotId, json({ gate: gate.verdict, media_job_id: mediaJobId })]);
  await setStatus(services, slotId, 'media_queued');
  return done('media_queued', { scriptId: script.id, verdict: gate.verdict, q1Pass: true, mediaJobId });
}
