import { type Caller, HIGHLIGHT_SETS, STORY_FRAME_KINDS, type StoryFrameKind, type ToolContext, type ToolDef } from '@ios/agents';
import { OWNER, POST_FORMATS, type PostFormat } from '@ios/core';
import { curateHighlights, highlightsFor } from './curate';
import { defaultPlan, editPlan, type PlanPatch, recommendPlan } from './plan';
import { mediaBudgetUsd, benchmarkFor } from './service';
import { planHistory, planInForce, savePlan } from './store';
import { approveStoryFrame, framesFor, storyStats } from './stories';
import { enqueuePlanDay } from './jobs';
import { localDate } from './time';

/**
 * Stream L tools (namespaces `formats.*`, `stories.*`, `highlights.*`). Studio Manager and Persona Manager can read and
 * steer a persona's Format Plan in chat; the Owner can do everything from the dashboard. Mutating tools carry an
 * `ownerIntent`, so a run over untrusted text (comments, scraped captions) can never edit a plan by itself.
 */

const READERS: readonly Caller[] = ['studio-manager', 'persona-manager', 'profit-engine', 'stories-producer', 'owner', 'system'];
const EDITORS: readonly Caller[] = ['studio-manager', 'persona-manager', 'owner'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PID = { type: 'string', description: 'Persona id (uuid).' } as const;

function obj(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('input must be an object');
  return raw as Record<string, unknown>;
}
function only(o: Record<string, unknown>, keys: readonly string[]) {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`unknown input keys: ${extra.join(', ')}`);
}
function pid(o: Record<string, unknown>): string {
  if (typeof o.persona_id !== 'string' || !UUID_RE.test(o.persona_id)) throw new Error('persona_id must be a uuid');
  return o.persona_id;
}
const isFormat = (f: string): f is PostFormat => (POST_FORMATS as readonly string[]).includes(f);

async function studioPersona(ctx: ToolContext, personaId: string) {
  const p = await ctx.services.db.maybeOne<{ id: string; studio_id: string; name: string; niche: string; timezone: string }>('SELECT id, studio_id, name, niche, timezone FROM persona WHERE id = $1 AND studio_id = $2', [personaId, ctx.studioId]);
  if (!p) throw new Error(`persona ${personaId} is not in this studio`);
  return p;
}

const planGet: ToolDef<{ persona_id: string }, unknown> = {
  name: 'formats.plan_get',
  description: "The persona's Format Plan in force: weekly feed posts per format (with reason and cost), optional formats on/off, Stories per day and their mix, the last versions and any Profit Engine move.",
  scope: 'persona',
  callers: READERS,
  inputSchema: { type: 'object', additionalProperties: false, required: ['persona_id'], properties: { persona_id: PID } },
  parse: (raw) => {
    const o = obj(raw);
    only(o, ['persona_id']);
    return { persona_id: pid(o) };
  },
  async run(ctx, input) {
    await studioPersona(ctx, input.persona_id);
    const plan = await planInForce(ctx.services.db, input.persona_id, ctx.services.now());
    const history = await planHistory(ctx.services.db, input.persona_id, 5);
    return { plan, history: history.map((h) => ({ version: h.version, source: h.source, reason: h.reason, effective_from: h.effectiveFrom, by: h.createdBy })), note: plan ? null : 'No plan yet: the studio default (2/2/1/2/2/1, 4 Stories a day) applies.' };
  },
};

const COUNTS = { type: 'object', description: 'Weekly posts per format, e.g. {"static": 3, "text_note": 1}. 0 switches an optional format off.', additionalProperties: { type: 'integer', minimum: 0, maximum: 21 } } as const;
const ENABLED = { type: 'object', description: 'Switch optional formats on or off, e.g. {"meme": true}.', additionalProperties: { type: 'boolean' } } as const;

const planEdit: ToolDef<{ persona_id: string; patch: PlanPatch }, unknown> = {
  name: 'formats.plan_edit',
  description:
    "Edits a persona's Format Plan (a new version, effective for the next week planned): weekly counts per format, optional formats on/off, Stories per day and their daily mix. Core formats (talking, activity_text, voiceover, static, carousel) keep ≥ 1; the total stays 7–21 a week; Stories 3–5 a day. Use when the Owner asks to change the mix.",
  scope: 'persona',
  callers: EDITORS,
  mutates: true,
  ownerIntent: /\b(?:change|set|edit|update|switch|turn|add|drop|cut|raise|lower|increase|reduce|make|use)\b.*\b(?:formats?|plan|mix|carousels?|static|stills?|talking|voiceovers?|reels?|stor(?:y|ies)|memes?|notes?|photo dumps?|posts?)\b/i,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['persona_id'],
    properties: {
      persona_id: PID,
      counts: COUNTS,
      enabled: ENABLED,
      stories_per_day: { type: 'integer', minimum: 3, maximum: 5 },
      story_mix: { type: 'object', description: `Frames a day per kind (${STORY_FRAME_KINDS.join(', ')}).`, additionalProperties: { type: 'integer', minimum: 0, maximum: 3 } },
      note: { type: 'string', description: 'Why (shown on the plan).' },
    },
  },
  parse: (raw) => {
    const o = obj(raw);
    only(o, ['persona_id', 'counts', 'enabled', 'stories_per_day', 'story_mix', 'note']);
    const counts: Partial<Record<PostFormat, number>> = {};
    for (const [k, v] of Object.entries(obj(o.counts))) {
      if (!isFormat(k)) throw new Error(`unknown format ${k}`);
      if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 21) throw new Error(`${k}: a whole number 0–21`);
      counts[k] = v as number;
    }
    const enabled: Partial<Record<PostFormat, boolean>> = {};
    for (const [k, v] of Object.entries(obj(o.enabled))) {
      if (!isFormat(k)) throw new Error(`unknown format ${k}`);
      if (typeof v !== 'boolean') throw new Error(`enabled.${k} must be true or false`);
      enabled[k] = v;
    }
    const storyMix: Partial<Record<StoryFrameKind, number>> = {};
    for (const [k, v] of Object.entries(obj(o.story_mix))) {
      if (!(STORY_FRAME_KINDS as readonly string[]).includes(k)) throw new Error(`unknown story frame kind ${k}`);
      if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 3) throw new Error(`story_mix.${k}: 0–3`);
      storyMix[k as StoryFrameKind] = v as number;
    }
    const spd = o.stories_per_day === undefined ? undefined : Number(o.stories_per_day);
    if (spd !== undefined && (!Number.isInteger(spd) || spd < 3 || spd > 5)) throw new Error('stories_per_day: 3–5');
    const note = typeof o.note === 'string' ? o.note.trim().slice(0, 200) : undefined;
    const patch: PlanPatch = {
      ...(Object.keys(counts).length ? { counts } : {}),
      ...(Object.keys(enabled).length ? { enabled } : {}),
      ...(spd !== undefined ? { storiesPerDay: spd } : {}),
      ...(Object.keys(storyMix).length ? { storyMix } : {}),
      ...(note ? { note } : {}),
    };
    if (!patch.counts && !patch.enabled && patch.storiesPerDay === undefined && !patch.storyMix) throw new Error('nothing to change');
    return { persona_id: pid(o), patch };
  },
  async run(ctx, input) {
    const p = await studioPersona(ctx, input.persona_id);
    const now = ctx.services.now();
    const current = await planInForce(ctx.services.db, p.id, now);
    const base = current ? (({ version: _v, leverReason: _l, ...rest }) => rest)(current) : defaultPlan();
    const next = editPlan(base, input.patch, 'owner');
    const v = await savePlan(ctx.services.db, { studioId: p.studio_id, personaId: p.id, plan: next, actor: ctx.actor, now, action: 'formats.plan_edited' });
    return { version: v.version, posts_per_week: next.postsPerWeek, stories_per_day: next.stories.perDay, cost_per_week_usd: next.costPerWeekUsd, reason: next.reason };
  },
};

const recommend: ToolDef<{ persona_id: string; apply: boolean }, unknown> = {
  name: 'formats.recommend',
  description:
    "The Studio Manager's Format Plan recommendation for a persona (archetype, the Growth Radar's niche benchmark or the default, the product ladder, the budget). With apply=true it becomes the persona's plan (for personas launched before Format Plans).",
  scope: 'persona',
  callers: ['studio-manager', 'owner', 'system'],
  mutates: true,
  ownerIntent: /\b(?:recommend|re-?plan|apply|adopt|set up|redo)\b.*\b(?:formats?|plan|mix)\b/i,
  inputSchema: { type: 'object', additionalProperties: false, required: ['persona_id'], properties: { persona_id: PID, apply: { type: 'boolean' } } },
  parse: (raw) => {
    const o = obj(raw);
    only(o, ['persona_id', 'apply']);
    return { persona_id: pid(o), apply: o.apply === true };
  },
  async run(ctx, input) {
    const p = await studioPersona(ctx, input.persona_id);
    const db = ctx.services.db;
    const bible = await db.maybeOne<{ content: Record<string, unknown> }>(`SELECT content FROM persona_bible WHERE persona_id = $1 ORDER BY (status = 'approved') DESC, version DESC LIMIT 1`, [p.id]);
    const identity = bible?.content.identity;
    const archetype = typeof identity === 'string' ? identity.slice(0, 300) : JSON.stringify(identity ?? '').slice(0, 300);
    const ladder = await db.query<{ rung: string; price_cents: number }>(`SELECT ladder_rung AS rung, price_cents FROM product WHERE persona_id = $1 ORDER BY price_cents`, [p.id]);
    const budgetRow = await db.one<{ budget: Record<string, unknown> }>('SELECT budget FROM persona WHERE id = $1', [p.id]);
    const plan = recommendPlan({
      niche: p.niche,
      archetype,
      ladder: ladder.map((l) => ({ rung: l.rung, priceCents: l.price_cents })),
      budgetUsdPerMonth: await mediaBudgetUsd(db, p.studio_id, budgetRow.budget),
      benchmark: await benchmarkFor(ctx.services, p.studio_id, p.niche),
    });
    if (!input.apply) return { plan, applied: false };
    const v = await savePlan(db, { studioId: p.studio_id, personaId: p.id, plan, actor: ctx.actor, now: ctx.services.now(), action: 'formats.plan_recommended' });
    return { plan, applied: true, version: v.version };
  },
};

const storiesToday: ToolDef<{ persona_id: string; date: string | null }, unknown> = {
  name: 'stories.today',
  description: "A persona's Story frames for a day (kind, time, text, QC and Gate status, publish status), with the last 14 days of story results per kind.",
  scope: 'persona',
  callers: READERS,
  inputSchema: { type: 'object', additionalProperties: false, required: ['persona_id'], properties: { persona_id: PID, date: { type: 'string', description: 'YYYY-MM-DD (persona-local); default today.' } } },
  parse: (raw) => {
    const o = obj(raw);
    only(o, ['persona_id', 'date']);
    const date = o.date === undefined ? null : String(o.date);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
    return { persona_id: pid(o), date };
  },
  async run(ctx, input) {
    const p = await studioPersona(ctx, input.persona_id);
    const now = ctx.services.now();
    const date = input.date ?? localDate(now, p.timezone);
    const frames = await framesFor(ctx.services, p.id, date);
    const posts = frames.length
      ? await ctx.services.db.query<{ story_frame_id: string; platform: string; status: string; reason: string | null }>(`SELECT story_frame_id, platform, status, reason FROM story_post WHERE story_frame_id = ANY($1::uuid[])`, [frames.map((f) => f.id)])
      : [];
    return {
      date,
      frames: frames.map((f) => ({ id: f.id, seq: f.seq, kind: f.kind, at: f.planned_at, status: f.status, text: f.text, gate: f.gate_verdict, block_reason: f.block_reason, published: posts.filter((x) => x.story_frame_id === f.id) })),
      results: await storyStats(ctx.services, p.id, now, 14),
    };
  },
};

const storiesPlanDay: ToolDef<{ persona_id: string }, unknown> = {
  name: 'stories.plan_day',
  description: "Queues today's Story frames for a persona now (normally automatic each morning).",
  scope: 'persona',
  callers: ['studio-manager', 'persona-manager', 'owner', 'system'],
  mutates: true,
  ownerIntent: /\b(?:make|plan|do|start|queue|post)\b.*\bstor(?:y|ies)\b/i,
  inputSchema: { type: 'object', additionalProperties: false, required: ['persona_id'], properties: { persona_id: PID } },
  parse: (raw) => {
    const o = obj(raw);
    only(o, ['persona_id']);
    return { persona_id: pid(o) };
  },
  async run(ctx, input) {
    const p = await studioPersona(ctx, input.persona_id);
    const date = localDate(ctx.services.now(), p.timezone);
    const job = await enqueuePlanDay(ctx.services.db, { studioId: p.studio_id, personaId: p.id, date });
    return { date, queued: !!job };
  },
};

const storiesApprove: ToolDef<{ persona_id: string; frame_id: string }, unknown> = {
  name: 'stories.approve',
  description: 'The Owner releases a Story frame held for approval (Gate amber or an L0 persona). Red or failed-QC frames stay blocked.',
  scope: 'persona',
  ownerOnly: true,
  mutates: true,
  inputSchema: { type: 'object', additionalProperties: false, required: ['persona_id', 'frame_id'], properties: { persona_id: PID, frame_id: { type: 'string' } } },
  parse: (raw) => {
    const o = obj(raw);
    only(o, ['persona_id', 'frame_id']);
    if (typeof o.frame_id !== 'string' || !UUID_RE.test(o.frame_id)) throw new Error('frame_id must be a uuid');
    return { persona_id: pid(o), frame_id: o.frame_id };
  },
  async run(ctx, input) {
    await studioPersona(ctx, input.persona_id);
    const f = await ctx.services.db.maybeOne('SELECT 1 FROM story_frame WHERE id = $1 AND persona_id = $2', [input.frame_id, input.persona_id]);
    if (!f) throw new Error('no such frame for this persona');
    const row = await approveStoryFrame(ctx.services, input.frame_id, ctx.actor.type === 'owner' ? ctx.actor : OWNER);
    return { id: row.id, status: row.status };
  },
};

const highlightsGet: ToolDef<{ persona_id: string }, unknown> = {
  name: 'highlights.get',
  description: `A persona's Story highlight sets (${HIGHLIGHT_SETS.join(', ')}) and the frames in each.`,
  scope: 'persona',
  callers: READERS,
  inputSchema: { type: 'object', additionalProperties: false, required: ['persona_id'], properties: { persona_id: PID } },
  parse: (raw) => {
    const o = obj(raw);
    only(o, ['persona_id']);
    return { persona_id: pid(o) };
  },
  async run(ctx, input) {
    await studioPersona(ctx, input.persona_id);
    return { sets: await highlightsFor(ctx.services, input.persona_id) };
  },
};

const highlightsCurate: ToolDef<{ persona_id: string }, unknown> = {
  name: 'highlights.curate',
  description: 'Refreshes the Story highlight sets from the best published frames (normally weekly, by the Persona Manager).',
  scope: 'persona',
  callers: ['persona-manager', 'studio-manager', 'owner', 'system'],
  mutates: true,
  ownerIntent: /\b(?:refresh|update|curate|redo|fix)\b.*\bhighlights?\b/i,
  inputSchema: { type: 'object', additionalProperties: false, required: ['persona_id'], properties: { persona_id: PID } },
  parse: (raw) => {
    const o = obj(raw);
    only(o, ['persona_id']);
    return { persona_id: pid(o) };
  },
  async run(ctx, input) {
    await studioPersona(ctx, input.persona_id);
    return { sets: await curateHighlights(ctx.services, input.persona_id, ctx.actor) };
  },
};

export const formatsTools: ReadonlyArray<ToolDef<any, any>> = [planGet, planEdit, recommend, storiesToday, storiesPlanDay, storiesApprove, highlightsGet, highlightsCurate];
