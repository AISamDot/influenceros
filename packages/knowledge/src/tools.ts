import type { Caller, KnowledgeHit, ToolDef } from '@ios/agents';
import { LAUNCH_FILES, readPersonaDoc } from '@ios/core/seed';
import { fieldBrainStatus } from './field-brain';
import { reactionQueue } from './news';
import { personasSourceDir } from './personas';
import { requestFieldBrainBuild, requestNewsScan } from './requests';
import { latestBriefing } from './service';
import { trimText } from './util';

/**
 * Agent tools in the `knowledge.*` and `news.*` namespaces. Reads are open to every agent; the two that queue
 * paid work are limited to the Studio Manager, the Owner and the system. Inputs are snake_case and validated here.
 */

type Raw = Record<string, unknown>;

function obj(raw: unknown, allowed: readonly string[]): Raw {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('input must be an object');
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) throw new Error(`unexpected field: ${k}`);
  return raw as Raw;
}
function reqStr(r: Raw, k: string, max = 500): string {
  const v = r[k];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${k} is required`);
  if (v.length > max) throw new Error(`${k} is longer than ${max} characters`);
  return v.trim();
}
function optInt(r: Raw, k: string, lo: number, hi: number): number | undefined {
  const v = r[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new Error(`${k} must be an integer from ${lo} to ${hi}`);
  return v;
}

const REQUESTERS: readonly Caller[] = ['studio-manager', 'owner', 'system'];

const hitJson = (h: KnowledgeHit) => ({
  kind: h.kind,
  id: h.id,
  title: h.title,
  text: h.text,
  citations: h.citations,
  score: Math.round(h.score * 1000) / 1000,
  last_verified_at: h.lastVerifiedAt ? h.lastVerifiedAt.toISOString() : null,
});

export const retrieveTool: ToolDef<{ niche: string; query: string; k?: number; kinds?: Array<'node' | 'news'> }, unknown> = {
  name: 'knowledge.retrieve',
  description:
    'Search the niche Field Brain (cited curriculum nodes) and recent news by meaning. Call it before writing any factual claim: every claim in a script, caption, product or reply must cite the id of a hit (store the ids as evidence). Returns up to k hits with text, citations, score and last-verified date.',
  scope: 'studio',
  untrustedOutput: true, // news, web research or comment text: it taints the run (mutating tools then need the Owner's ask)
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['niche', 'query'],
    properties: {
      niche: { type: 'string', description: "The persona's niche, e.g. 'dating'." },
      query: { type: 'string', description: 'What you need to know, in plain words.' },
      k: { type: 'integer', minimum: 1, maximum: 25 },
      kinds: { type: 'array', items: { type: 'string', enum: ['node', 'news'] } },
    },
  },
  parse(raw) {
    const r = obj(raw, ['niche', 'query', 'k', 'kinds']);
    const kinds = r.kinds === undefined ? undefined : r.kinds;
    if (kinds !== undefined && (!Array.isArray(kinds) || kinds.some((x) => x !== 'node' && x !== 'news'))) throw new Error("kinds must be a list of 'node' and/or 'news'");
    return { niche: reqStr(r, 'niche', 120), query: reqStr(r, 'query', 2000), k: optInt(r, 'k', 1, 25), kinds: kinds as Array<'node' | 'news'> | undefined };
  },
  async run(ctx, input) {
    const hits = await ctx.services.knowledge.retrieve({ studioId: ctx.studioId, niche: input.niche, query: input.query, k: input.k, kinds: input.kinds });
    return { hits: hits.map(hitJson) };
  },
};

export const statusTool: ToolDef<{ niche?: string }, unknown> = {
  name: 'knowledge.field_brain_status',
  description: "How complete each niche's Field Brain is: nodes, researched and embedded nodes, canon sources, experts, feeds, last verification and the last build.",
  scope: 'studio',
  inputSchema: { type: 'object', additionalProperties: false, properties: { niche: { type: 'string' } } },
  parse(raw) {
    const r = obj(raw ?? {}, ['niche']);
    return { niche: r.niche === undefined ? undefined : reqStr(r, 'niche', 120) };
  },
  async run(ctx, input) {
    const rows = await fieldBrainStatus(ctx.services, ctx.studioId, input.niche);
    return { niches: rows.map((r) => ({ ...r, lastVerifiedAt: r.lastVerifiedAt ? new Date(r.lastVerifiedAt).toISOString() : null, lastBuild: r.lastBuild ? { ...r.lastBuild, startedAt: new Date(r.lastBuild.startedAt).toISOString(), finishedAt: r.lastBuild.finishedAt ? new Date(r.lastBuild.finishedAt).toISOString() : null } : null })) };
  },
};

export const requestBuildTool: ToolDef<{ niche: string; max_nodes?: number }, unknown> = {
  name: 'knowledge.request_build',
  description: "Queue a (re)build of a niche's Field Brain: map the field, plan the curriculum, research stale nodes. Costs LLM budget; the weekly refresh already does this, so use it for a new niche or after a big news shift.",
  scope: 'studio',
  callers: REQUESTERS,
  mutates: true,
  ownerIntent: /\b(?:build|re-?build|refresh|update|research|map)\b.*\b(?:field\s*brains?|knowledge(?:\s*base)?|curriculum)\b/i,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['niche'],
    properties: { niche: { type: 'string' }, max_nodes: { type: 'integer', minimum: 10, maximum: 200 } },
  },
  parse(raw) {
    const r = obj(raw, ['niche', 'max_nodes']);
    return { niche: reqStr(r, 'niche', 120).toLowerCase(), max_nodes: optInt(r, 'max_nodes', 10, 200) };
  },
  async run(ctx, input) {
    const job = await requestFieldBrainBuild(ctx.services.db, { studioId: ctx.studioId, niche: input.niche, maxNodes: input.max_nodes });
    return { queued: job !== null, job_id: job?.id ?? null };
  },
};

const DOCS = { bible: 'bible', look_prompts: 'lookPrompts', content_plan: 'contentPlan', field_brain_seed: 'fieldBrainSeed' } as const;

export const personaDocTool: ToolDef<{ persona_id: string; doc: keyof typeof DOCS }, unknown> = {
  name: 'knowledge.persona_doc',
  description: `Read one of a launch persona's source documents (${Object.values(LAUNCH_FILES).join(', ')}): the full bible, the Higgsfield look prompts, the launch content plan with scripts, or the Field Brain seed.`,
  scope: 'persona',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['persona_id', 'doc'],
    properties: { persona_id: { type: 'string', format: 'uuid' }, doc: { type: 'string', enum: Object.keys(DOCS) } },
  },
  parse(raw) {
    const r = obj(raw, ['persona_id', 'doc']);
    const doc = reqStr(r, 'doc', 40);
    if (!(doc in DOCS)) throw new Error(`doc must be one of ${Object.keys(DOCS).join(', ')}`);
    return { persona_id: reqStr(r, 'persona_id', 40), doc: doc as keyof typeof DOCS };
  },
  async run(ctx, input) {
    const p = await ctx.services.db.one<{ slug: string; file: string | null }>(
      `SELECT p.slug, (SELECT b.content->'source_document'->>'file' FROM persona_bible b WHERE b.persona_id = p.id ORDER BY b.version DESC LIMIT 1) AS file
         FROM persona p WHERE p.id = $1`,
      [input.persona_id],
    );
    // The source folder first, then the archive a restored persona came from; never for a Persona Generator persona.
    const text = readPersonaDoc(p.slug, DOCS[input.doc], personasSourceDir(), { archive: !(p.file ?? '').startsWith('generator/') });
    return { slug: p.slug, doc: input.doc, found: text.length > 0, text: trimText(text, 120_000) };
  },
};

export const latestBriefingTool: ToolDef<{ persona_id: string }, unknown> = {
  name: 'news.latest_briefing',
  description: "The persona's latest morning briefing: scored stories with why they matter and the persona's take, plus fast-reaction ideas. Use it for daily plans and replies that touch the news.",
  scope: 'persona',
  untrustedOutput: true, // news, web research or comment text: it taints the run (mutating tools then need the Owner's ask)
  inputSchema: { type: 'object', additionalProperties: false, required: ['persona_id'], properties: { persona_id: { type: 'string', format: 'uuid' } } },
  parse(raw) {
    return { persona_id: reqStr(obj(raw, ['persona_id']), 'persona_id', 40) };
  },
  async run(ctx, input) {
    const b = await latestBriefing(ctx.services.db, input.persona_id);
    return b ? { ...b, reactionIdeas: b.reactionIdeas.map((r) => ({ ...r, expiresAt: r.expiresAt.toISOString() })) } : null;
  },
};

export const reactionQueueTool: ToolDef<{ persona_id: string }, unknown> = {
  name: 'news.reaction_queue',
  description: 'Open fast-reaction ideas from the News Desk for this persona (not expired, not yet scripted). Each should publish within 24–72 hours of the news.',
  scope: 'persona',
  untrustedOutput: true, // news, web research or comment text: it taints the run (mutating tools then need the Owner's ask)
  inputSchema: { type: 'object', additionalProperties: false, required: ['persona_id'], properties: { persona_id: { type: 'string', format: 'uuid' } } },
  parse(raw) {
    return { persona_id: reqStr(obj(raw, ['persona_id']), 'persona_id', 40) };
  },
  async run(ctx, input) {
    const rows = await reactionQueue(ctx.services, input.persona_id);
    return { ideas: rows.map((r) => ({ id: r.id, title: r.title, hooks: r.hook_options, source: r.source, created_at: new Date(r.created_at).toISOString() })) };
  },
};

export const requestScanTool: ToolDef<{ niche: string }, unknown> = {
  name: 'news.request_scan',
  description: "Queue an extra News Desk scan for a niche now (the daily 05:00 UTC scan already runs). New items are deduped and scored, and today's briefings are queued.",
  scope: 'studio',
  callers: REQUESTERS,
  mutates: true,
  ownerIntent: /\b(?:re-?scan|scan|run|refresh|fetch|queue)\b.*\b(?:news|feeds?|scan)\b/i,
  inputSchema: { type: 'object', additionalProperties: false, required: ['niche'], properties: { niche: { type: 'string' } } },
  parse(raw) {
    return { niche: reqStr(obj(raw, ['niche']), 'niche', 120).toLowerCase() };
  },
  async run(ctx, input) {
    const job = await requestNewsScan(ctx.services.db, { studioId: ctx.studioId, niche: input.niche });
    return { queued: job !== null, job_id: job?.id ?? null };
  },
};

export const tools: ReadonlyArray<ToolDef<any, any>> = [retrieveTool, statusTool, requestBuildTool, personaDocTool, latestBriefingTool, reactionQueueTool, requestScanTool];
