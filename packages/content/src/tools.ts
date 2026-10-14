import type { Caller, ToolDef } from '@ios/agents';
import type { PostFormat, PostPurpose } from '@ios/core';
import { mondayUtc } from './util';
import { pipelineBoard, slotDetail } from './board';
import { planWeek } from './calendar';
import { gateReply, gateRules, verdictOf, type GateSubjectKind } from './gate';
import { runHookLab } from './hooks';
import { addSignal, backlog, briefProduct, buildListingPack, planLaunch, type Rung } from './monetization';
import { loadPersonaContext } from './persona';
import { enqueueMonetization, enqueueSlot } from './jobs';
import { voiceCheck } from './qc';

/**
 * Agent tools for stream B's namespaces (calendar.*, hooks.*, script.*, qc.*, gate.*, monetization.*, pipeline.*).
 * Persona-scoped tools take `persona_id` (the registry checks scope and studio); every id they read is re-checked
 * against that persona here. Nothing here can release a Gate red or approve a product: those are Owner actions.
 */

type Raw = Record<string, unknown>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATS = ['talking', 'activity_text', 'voiceover', 'static', 'carousel'] as const;
const PURPOSES = ['reach', 'trust', 'sell'] as const;
const RUNGS = ['lead_magnet', 'entry', 'addon', 'core_bundle', 'upsell', 'product_2_3', 'marketplace', 'membership', 'course'] as const;
const GATE_KINDS = ['script', 'caption', 'listing', 'launch'] as const;

function obj(raw: unknown, allowed: readonly string[]): Raw {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('input must be an object');
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`unknown input fields: ${extra.join(', ')}`);
  return raw as Raw;
}
function str(r: Raw, k: string, o: { optional?: boolean; max?: number } = {}): string | undefined {
  const v = r[k];
  if (v === undefined || v === null) {
    if (o.optional) return undefined;
    throw new Error(`${k} is required`);
  }
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${k} must be a non-empty string`);
  if (v.length > (o.max ?? 2000)) throw new Error(`${k} is too long`);
  return v.trim();
}
const uuid = (r: Raw, k: string, optional = false) => {
  const v = str(r, k, { optional });
  if (v !== undefined && !UUID_RE.test(v)) throw new Error(`${k} must be a uuid`);
  return v;
};
function oneOf<T extends string>(r: Raw, k: string, values: readonly T[], optional = false): T | undefined {
  const v = str(r, k, { optional });
  if (v !== undefined && !values.includes(v as T)) throw new Error(`${k} must be one of ${values.join(', ')}`);
  return v as T | undefined;
}
const date = (r: Raw, k: string) => {
  const v = str(r, k, { optional: true });
  if (v !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${k} must be YYYY-MM-DD`);
  return v;
};
const schema = (properties: Record<string, object>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const S = { type: 'string' } as const;
const PID = { type: 'string', description: 'Persona id (uuid).' } as const;

const MAKERS: readonly Caller[] = ['studio-manager', 'persona-manager', 'calendar-planner', 'scriptwriter', 'owner', 'system'];
const MONEY: readonly Caller[] = ['monetization-agent', 'studio-manager', 'persona-manager', 'owner', 'system'];

async function ownedSlot(ctx: { services: { db: { maybeOne: (q: string, p: unknown[]) => Promise<unknown> } } }, slotId: string, personaId: string) {
  const ok = await ctx.services.db.maybeOne('SELECT 1 FROM calendar_slot WHERE id = $1 AND persona_id = $2', [slotId, personaId]);
  if (!ok) throw new Error('slot not found for this persona');
}
async function ownedProduct(ctx: { services: { db: { maybeOne: (q: string, p: unknown[]) => Promise<unknown> } } }, productId: string, personaId: string) {
  const ok = await ctx.services.db.maybeOne('SELECT 1 FROM product WHERE id = $1 AND persona_id = $2', [productId, personaId]);
  if (!ok) throw new Error('product not found for this persona');
}

const planWeekTool: ToolDef<{ persona_id: string; week_start?: string; run_pipeline: boolean }, unknown> = {
  name: 'calendar.plan_week',
  description: "Plan a persona's week: 10 posts (more for winners) with the format and purpose mix, posting windows, CTA keywords and sell slots. Leaves an already-planned week alone. Optionally queues every new slot for the pipeline.",
  scope: 'persona',
  mutates: true,
  callers: MAKERS,
  inputSchema: schema({ persona_id: PID, week_start: { type: 'string', description: 'Any date in the week (YYYY-MM-DD); default next week.' }, run_pipeline: { type: 'boolean' } }, ['persona_id']),
  parse: (raw) => {
    const r = obj(raw, ['persona_id', 'week_start', 'run_pipeline']);
    return { persona_id: uuid(r, 'persona_id')!, week_start: date(r, 'week_start'), run_pipeline: r.run_pipeline !== false };
  },
  async run(ctx, i) {
    const thisWeek = mondayUtc(ctx.services.now());
    const nextWeek = new Date(thisWeek.getTime() + 7 * 86_400_000);
    const ws = i.week_start ? new Date(`${i.week_start}T00:00:00Z`) : nextWeek;
    // Agents plan only this week or next (as the Owner's own route does); later weeks are the daily schedule's job,
    // so one turn can't queue months of paid script, Gate and QC runs.
    const monday = mondayUtc(ws).getTime();
    if (ctx.caller !== 'owner' && monday !== thisWeek.getTime() && monday !== nextWeek.getTime()) {
      throw new Error('week_start must be in this week or next week');
    }
    const res = await planWeek(ctx.services, i.persona_id, ws);
    let queued = 0;
    if (i.run_pipeline) for (const id of res.slotIds) if (await enqueueSlot(ctx.services, id, i.persona_id)) queued += 1;
    return { created: res.created, existing: res.existing, skipped: res.skipped ?? null, posts_per_week: res.target?.postsPerWeek ?? null, queued };
  },
};

const weekTool: ToolDef<{ persona_id: string; week_start?: string }, unknown> = {
  name: 'calendar.week',
  description: "A persona's planned week: each slot's time, format, purpose, pillar, title, CTA keyword and pipeline stage.",
  scope: 'persona',
  inputSchema: schema({ persona_id: PID, week_start: S }, ['persona_id']),
  parse: (raw) => {
    const r = obj(raw, ['persona_id', 'week_start']);
    return { persona_id: uuid(r, 'persona_id')!, week_start: date(r, 'week_start') };
  },
  async run(ctx, i) {
    const from = mondayUtc(i.week_start ? new Date(`${i.week_start}T00:00:00Z`) : ctx.services.now());
    const items = await pipelineBoard(ctx.services.db, ctx.studioId, { from, to: new Date(from.getTime() + 7 * 86_400_000), personaId: i.persona_id });
    return items.map((x) => ({ slot_id: x.slotId, at: x.slotAt.toISOString(), window: x.window, format: x.format, purpose: x.purpose, pillar: x.pillar, title: x.title, hook: x.hook, cta_keyword: x.ctaKeyword, stage: x.stage, block_reason: x.blockReason }));
  },
};

const hookLabTool: ToolDef<{ persona_id: string; title: string; format: PostFormat; purpose: PostPurpose }, unknown> = {
  name: 'hooks.lab',
  description: 'Run the hook-lab on an idea: 10 hooks across types, scored, with the one to ship and 2 A/B variants. Read-only.',
  scope: 'persona',
  callers: MAKERS,
  inputSchema: schema({ persona_id: PID, title: S, format: { type: 'string', enum: [...FORMATS] }, purpose: { type: 'string', enum: [...PURPOSES] } }, ['persona_id', 'title']),
  parse: (raw) => {
    const r = obj(raw, ['persona_id', 'title', 'format', 'purpose']);
    return { persona_id: uuid(r, 'persona_id')!, title: str(r, 'title', { max: 200 })!, format: oneOf(r, 'format', FORMATS, true) ?? 'talking', purpose: oneOf(r, 'purpose', PURPOSES, true) ?? 'reach' };
  },
  async run(ctx, i) {
    const pctx = await loadPersonaContext(ctx.services.db, i.persona_id);
    const lab = await runHookLab(ctx.services, { ctx: pctx, title: i.title, pillar: null, format: i.format, purpose: i.purpose, costRef: { type: 'persona', id: i.persona_id } });
    return { shipped: lab.shipped, variants: lab.variants, hooks: lab.hooks };
  },
};

const scriptGetTool: ToolDef<{ persona_id: string; slot_id: string }, unknown> = {
  name: 'script.get',
  description: "A slot's current script: shipped hook, A/B variants, the scored hook-lab, body, voiceover text, caption, on-screen text, carousel, evidence, plus its Q1 and Gate results.",
  scope: 'persona',
  inputSchema: schema({ persona_id: PID, slot_id: S }, ['persona_id', 'slot_id']),
  parse: (raw) => {
    const r = obj(raw, ['persona_id', 'slot_id']);
    return { persona_id: uuid(r, 'persona_id')!, slot_id: uuid(r, 'slot_id')! };
  },
  async run(ctx, i) {
    await ownedSlot(ctx, i.slot_id, i.persona_id);
    return slotDetail(ctx.services.db, ctx.studioId, i.slot_id);
  },
};

const gateCheckTool: ToolDef<{ persona_id: string; text: string; kind: GateSubjectKind; purpose?: PostPurpose }, unknown> = {
  name: 'gate.check',
  description: 'Pre-check text against the Compliance Gate rules (legal/platform lines only). Returns green/amber/red with the rule hits. Does not record a gate result; the pipeline runs the real Gate.',
  scope: 'persona',
  inputSchema: schema({ persona_id: PID, text: S, kind: { type: 'string', enum: [...GATE_KINDS] }, purpose: { type: 'string', enum: [...PURPOSES] } }, ['persona_id', 'text']),
  parse: (raw) => {
    const r = obj(raw, ['persona_id', 'text', 'kind', 'purpose']);
    return { persona_id: uuid(r, 'persona_id')!, text: str(r, 'text', { max: 8000 })!, kind: oneOf(r, 'kind', GATE_KINDS, true) ?? 'script', purpose: oneOf(r, 'purpose', PURPOSES, true) };
  },
  async run(_ctx, i) {
    const checks = gateRules({ kind: i.kind, text: i.text, purpose: i.purpose }).filter((c) => c.verdict !== 'green');
    return { verdict: verdictOf(checks), findings: checks };
  },
};

const gateReplyTool: ToolDef<{ persona_id: string; incoming: string; reply: string; subject_id?: string }, unknown> = {
  name: 'gate.check_reply',
  description: 'Run the Gate on a community reply before it is sent (recorded as a gate result). Red when it denies being AI to a sincere question, or crosses a legal line.',
  scope: 'persona',
  mutates: true,
  inputSchema: schema({ persona_id: PID, incoming: S, reply: S, subject_id: { type: 'string', description: 'Comment or DM id being answered.' } }, ['persona_id', 'incoming', 'reply']),
  parse: (raw) => {
    const r = obj(raw, ['persona_id', 'incoming', 'reply', 'subject_id']);
    return { persona_id: uuid(r, 'persona_id')!, incoming: str(r, 'incoming', { max: 4000 })!, reply: str(r, 'reply', { max: 4000 })!, subject_id: uuid(r, 'subject_id', true) };
  },
  async run(ctx, i) {
    const res = await gateReply(ctx.services, { studioId: ctx.studioId, personaId: i.persona_id, incoming: i.incoming, reply: i.reply, subjectId: i.subject_id });
    return { verdict: res.verdict, findings: res.checks.filter((c) => c.verdict !== 'green'), gate_result_id: res.gateResultId };
  },
};

const qcReportTool: ToolDef<{ persona_id: string; slot_id: string }, unknown> = {
  name: 'qc.report',
  description: "A slot's QC reports (Q1 script loops, Q2 voice) with every check and its severity.",
  scope: 'persona',
  inputSchema: schema({ persona_id: PID, slot_id: S }, ['persona_id', 'slot_id']),
  parse: (raw) => {
    const r = obj(raw, ['persona_id', 'slot_id']);
    return { persona_id: uuid(r, 'persona_id')!, slot_id: uuid(r, 'slot_id')! };
  },
  async run(ctx, i) {
    await ownedSlot(ctx, i.slot_id, i.persona_id);
    return (await slotDetail(ctx.services.db, ctx.studioId, i.slot_id))?.qc ?? [];
  },
};

const voiceCheckTool: ToolDef<{ persona_id: string; script_id: string; audio_url: string }, unknown> = {
  name: 'qc.voice_check',
  description: 'QC Q2: re-transcribe a voice track and diff it against the script (word-error rate, misheard words, pace, pauses, cut-off ending). Run before any avatar credits are spent.',
  scope: 'persona',
  mutates: true,
  callers: ['quality-control', 'studio-manager', 'owner', 'system'],
  inputSchema: schema({ persona_id: PID, script_id: S, audio_url: S }, ['persona_id', 'script_id', 'audio_url']),
  parse: (raw) => {
    const r = obj(raw, ['persona_id', 'script_id', 'audio_url']);
    const audio = str(r, 'audio_url', { max: 2000 })!;
    if (!/^https?:\/\//.test(audio)) throw new Error('audio_url must be http(s)');
    return { persona_id: uuid(r, 'persona_id')!, script_id: uuid(r, 'script_id')!, audio_url: audio };
  },
  async run(ctx, i) {
    const res = await voiceCheck(ctx.services, { studioId: ctx.studioId, personaId: i.persona_id, scriptId: i.script_id, audioUrl: i.audio_url });
    return { pass: res.pass, wer: res.wer, wpm: res.wpm, checks: res.checks, report_id: res.reportId };
  },
};

const signalTool: ToolDef<{ persona_id: string; source: string; text: string; topic?: string; weight?: number }, unknown> = {
  name: 'monetization.add_signal',
  description: 'Record a demand signal (a repeated question, a "where can I get this?" comment, a market best-seller) for the Product Opportunity Score.',
  scope: 'persona',
  mutates: true,
  callers: MONEY,
  inputSchema: schema({ persona_id: PID, source: S, text: S, topic: S, weight: { type: 'number' } }, ['persona_id', 'source', 'text']),
  parse: (raw) => {
    const r = obj(raw, ['persona_id', 'source', 'text', 'topic', 'weight']);
    const w = r.weight === undefined ? undefined : Number(r.weight);
    if (w !== undefined && !(w > 0 && w <= 10)) throw new Error('weight must be between 0 and 10');
    return { persona_id: uuid(r, 'persona_id')!, source: str(r, 'source', { max: 40 })!, text: str(r, 'text', { max: 1000 })!, topic: str(r, 'topic', { optional: true, max: 120 }), weight: w };
  },
  async run(ctx, i) {
    return { id: await addSignal(ctx.services.db, { personaId: i.persona_id, source: i.source, text: i.text, topic: i.topic, weight: i.weight }) };
  },
};

const backlogTool: ToolDef<{ persona_id: string }, unknown> = {
  name: 'monetization.backlog',
  description: "The persona's ranked product opportunity backlog (Product Opportunity Score 0–100 with its eight factors and evidence).",
  scope: 'persona',
  inputSchema: schema({ persona_id: PID }, ['persona_id']),
  parse: (raw) => ({ persona_id: uuid(obj(raw, ['persona_id']), 'persona_id')! }),
  run: async (ctx, i) => backlog(ctx.services.db, i.persona_id),
};

const briefTool: ToolDef<{ persona_id: string; opportunity_id?: string; rung?: Rung; title?: string }, unknown> = {
  name: 'monetization.brief',
  description: 'Write a product brief (promise, audience, outline, format, pages, bonuses, price inside the band, ladder rung, upsell) and create the product at status brief.',
  scope: 'persona',
  mutates: true,
  callers: MONEY,
  inputSchema: schema({ persona_id: PID, opportunity_id: S, rung: { type: 'string', enum: [...RUNGS] }, title: S }, ['persona_id']),
  parse: (raw) => {
    const r = obj(raw, ['persona_id', 'opportunity_id', 'rung', 'title']);
    return { persona_id: uuid(r, 'persona_id')!, opportunity_id: uuid(r, 'opportunity_id', true), rung: oneOf(r, 'rung', RUNGS, true), title: str(r, 'title', { optional: true, max: 120 }) };
  },
  async run(ctx, i) {
    if (i.opportunity_id) {
      const ok = await ctx.services.db.maybeOne('SELECT 1 FROM product_opportunity WHERE id = $1 AND persona_id = $2', [i.opportunity_id, i.persona_id]);
      if (!ok) throw new Error('opportunity not found for this persona');
    }
    const res = await briefProduct(ctx.services, { personaId: i.persona_id, opportunityId: i.opportunity_id, rung: i.rung, title: i.title });
    return { product_id: res.productId, brief_id: res.briefId, brief: res.brief };
  },
};

const listingTool: ToolDef<{ persona_id: string; product_id: string }, unknown> = {
  name: 'monetization.listing_pack',
  description: 'Write the listing pack for a product: Lemon Squeezy fields and an Etsy variant, both passed through the Gate.',
  scope: 'persona',
  mutates: true,
  callers: MONEY,
  inputSchema: schema({ persona_id: PID, product_id: S }, ['persona_id', 'product_id']),
  parse: (raw) => {
    const r = obj(raw, ['persona_id', 'product_id']);
    return { persona_id: uuid(r, 'persona_id')!, product_id: uuid(r, 'product_id')! };
  },
  async run(ctx, i) {
    await ownedProduct(ctx, i.product_id, i.persona_id);
    return buildListingPack(ctx.services, i.product_id);
  },
};

const launchTool: ToolDef<{ persona_id: string; product_id: string; starts_on?: string }, unknown> = {
  name: 'monetization.launch_plan',
  description: 'Plan a launch: teaser → reveal → walkthrough → FAQ → last call (only with a real deadline), waitlist email, thank-you upsell, bundle and attribution coupon. Sell slots pick the beats up once v1 is approved.',
  scope: 'persona',
  mutates: true,
  callers: MONEY,
  inputSchema: schema({ persona_id: PID, product_id: S, starts_on: S }, ['persona_id', 'product_id']),
  parse: (raw) => {
    const r = obj(raw, ['persona_id', 'product_id', 'starts_on']);
    return { persona_id: uuid(r, 'persona_id')!, product_id: uuid(r, 'product_id')!, starts_on: date(r, 'starts_on') };
  },
  async run(ctx, i) {
    await ownedProduct(ctx, i.product_id, i.persona_id);
    return planLaunch(ctx.services, { productId: i.product_id, startsOn: i.starts_on ? new Date(`${i.starts_on}T00:00:00Z`) : undefined });
  },
};

const cycleTool: ToolDef<{ persona_id: string }, unknown> = {
  name: 'monetization.run_cycle',
  description: "Queue the Monetization Agent's cycle for a persona now (signal intake, scoring, validation, briefs, listing packs, launch plans).",
  scope: 'persona',
  mutates: true,
  callers: MONEY,
  inputSchema: schema({ persona_id: PID }, ['persona_id']),
  parse: (raw) => ({ persona_id: uuid(obj(raw, ['persona_id']), 'persona_id')! }),
  run: async (ctx, i) => ({ job_id: await enqueueMonetization(ctx.services, i.persona_id) }),
};

const boardTool: ToolDef<{ persona_id?: string; days?: number }, unknown> = {
  name: 'pipeline.board',
  description: 'The Pipeline board: every slot in the next days by stage (idea, script, Q1, Gate, queued for media, …, blocked with the reason).',
  scope: 'studio',
  inputSchema: schema({ persona_id: S, days: { type: 'integer', description: 'Days ahead, 1–21 (default 8).' } }, []),
  parse: (raw) => {
    const r = obj(raw ?? {}, ['persona_id', 'days']);
    const days = r.days === undefined ? 8 : Number(r.days);
    if (!Number.isInteger(days) || days < 1 || days > 21) throw new Error('days must be 1–21');
    return { persona_id: uuid(r, 'persona_id', true), days };
  },
  async run(ctx, i) {
    const now = ctx.services.now();
    const personaId = ctx.personaId ?? i.persona_id ?? null;
    const items = await pipelineBoard(ctx.services.db, ctx.studioId, { from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + (i.days ?? 8) * 86_400_000), personaId });
    const byStage: Record<string, number> = {};
    for (const x of items) byStage[x.stage ?? 'none'] = (byStage[x.stage ?? 'none'] ?? 0) + 1;
    return {
      by_stage: byStage,
      blocked: items.filter((x) => x.stage === 'blocked').map((x) => ({ slot_id: x.slotId, persona: x.personaName, title: x.title, reason: x.blockReason })),
      slots: items.slice(0, 60).map((x) => ({ slot_id: x.slotId, persona: x.personaName, at: x.slotAt.toISOString(), format: x.format, purpose: x.purpose, title: x.title, stage: x.stage })),
    };
  },
};

const runSlotTool: ToolDef<{ persona_id: string; slot_id: string }, unknown> = {
  name: 'pipeline.run_slot',
  description: 'Queue one slot for the pipeline (idea → script → Q1 → Gate → media). Safe to repeat: a queued slot is not queued twice.',
  scope: 'persona',
  mutates: true,
  callers: MAKERS,
  inputSchema: schema({ persona_id: PID, slot_id: S }, ['persona_id', 'slot_id']),
  parse: (raw) => {
    const r = obj(raw, ['persona_id', 'slot_id']);
    return { persona_id: uuid(r, 'persona_id')!, slot_id: uuid(r, 'slot_id')! };
  },
  async run(ctx, i) {
    await ownedSlot(ctx, i.slot_id, i.persona_id);
    return { job_id: await enqueueSlot(ctx.services, i.slot_id, i.persona_id) };
  },
};

export const tools: ReadonlyArray<ToolDef<any, any>> = [
  planWeekTool,
  weekTool,
  hookLabTool,
  scriptGetTool,
  gateCheckTool,
  gateReplyTool,
  qcReportTool,
  voiceCheckTool,
  signalTool,
  backlogTool,
  briefTool,
  listingTool,
  launchTool,
  cycleTool,
  boardTool,
  runSlotTool,
];
