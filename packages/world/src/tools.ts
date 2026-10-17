import { type Caller, enqueueOnceFor, fingerprintOf, type ToolDef } from '@troupe/agents';
import { POST_FORMATS, type PostFormat } from '@troupe/core';
import type { Db } from '@troupe/db';
import { contradictions, continuityChecks, extractFacts } from './continuity';
import { groundingFor, ledgerOf, loadWorld, backfillWorld, updateBible } from './service';
import { checkConceptFingerprint } from './norepeat';
import { listPins, moodBoard, pickPins, searchInspiration } from './inspiration';
import { WORLD_JOBS } from './jobs';
import { PIN_KINDS, type PinKind } from './pinterest';
import { BEAT_KINDS, type BeatKind } from './model';
import { storylineView } from './storyline';
import { addBeat, extendStoryline, steerStoryline } from './upkeep';

/**
 * Stream J tools: `world.*`, `storyline.*`, `continuity.*`, `norepeat.*`, `inspiration.*`, `pinterest.*`.
 * Reads are open to the studio's agents. Writes are for the Owner and the managers, and need the Owner's ask from an
 * untrusted run (`ownerIntent`). Inspiration search and board reads return pin text (third-party): `untrustedOutput`.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READERS: readonly Caller[] = ['owner', 'system', 'studio-manager', 'persona-manager', 'scriptwriter', 'calendar-planner', 'quality-control', 'continuity-keeper', 'video-producer', 'stories-producer', 'trend-scout', 'community-manager'];
const MANAGERS: readonly Caller[] = ['owner', 'persona-manager', 'studio-manager'];
const STORY_STEERERS: readonly Caller[] = ['owner', 'persona-manager', 'studio-manager', 'system'];
const INSPIRATION: readonly Caller[] = ['owner', 'studio-manager'];

function obj(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('input must be an object');
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`unknown input keys: ${extra.join(', ')}`);
  return o;
}
const uuid = (o: Record<string, unknown>, k: string): string => {
  const v = o[k];
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new Error(`${k} must be a uuid`);
  return v;
};
const optUuid = (o: Record<string, unknown>, k: string): string | null => (o[k] === undefined || o[k] === null ? null : uuid(o, k));
const text = (o: Record<string, unknown>, k: string, max = 600, min = 1): string => {
  const v = o[k];
  if (typeof v !== 'string' || v.trim().length < min) throw new Error(`${k} is required`);
  return v.trim().slice(0, max);
};
const optText = (o: Record<string, unknown>, k: string, max = 300): string | null => (typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string).trim().slice(0, max) : null);
const optInt = (o: Record<string, unknown>, k: string, lo: number, hi: number): number | undefined => {
  if (o[k] === undefined || o[k] === null) return undefined;
  const n = Number(o[k]);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${k} must be an integer from ${lo} to ${hi}`);
  return n;
};
const P = { persona_id: { type: 'string', description: 'persona uuid' } } as const;
const schema = (props: Record<string, unknown>, required: readonly string[]) => ({ type: 'object', additionalProperties: false, properties: props, required });

const worldView: ToolDef<{ persona_id: string }, unknown> = {
  name: 'world.view',
  description: "The persona's World Bible: place, home, recurring places, cast, routine, seasons, local holidays and local life.",
  scope: 'persona',
  callers: READERS,
  inputSchema: schema(P, ['persona_id']),
  parse: (raw) => ({ persona_id: uuid(obj(raw, ['persona_id']), 'persona_id') }),
  async run(ctx, i) {
    const w = await loadWorld(ctx.services.db, i.persona_id);
    return w ? { version: w.row.version, summary: w.row.summary, bible: w.bible } : { bible: null, note: 'no World Bible yet (world.backfill drafts one)' };
  },
};

const worldGrounding: ToolDef<{ persona_id: string; at: Date | null }, unknown> = {
  name: 'world.grounding',
  description: "The persona's real local moment (date, season, time of day, sun, weather, nearby holidays) now or at an ISO time, with the grounding block for prompts.",
  scope: 'persona',
  callers: READERS,
  inputSchema: schema({ ...P, at: { type: 'string', description: 'ISO time (default now)' } }, ['persona_id']),
  parse: (raw) => {
    const o = obj(raw, ['persona_id', 'at']);
    const at = optText(o, 'at', 40);
    const d = at ? new Date(at) : null;
    if (d && Number.isNaN(d.getTime())) throw new Error('at must be an ISO time');
    return { persona_id: uuid(o, 'persona_id'), at: d };
  },
  run: (ctx, i) => groundingFor(ctx.services, i.persona_id, i.at ?? ctx.services.now()),
};

const worldUpdate: ToolDef<{ persona_id: string; patch: Record<string, unknown>; change: string | null }, unknown> = {
  name: 'world.update',
  description: 'Edits the World Bible (cast, recurringPlaces, routine, home, seasons, holidays, localEvents, localLife, self). The place itself stays. New cast members join the continuity ledger.',
  scope: 'persona',
  callers: MANAGERS,
  mutates: true,
  ownerIntent: /\b(?:add|change|edit|update|rename|remove|set|give|make|move)\b.*\b(?:world|bible|cast|neighbou?r|sister|brother|friend|routine|home|house|holiday|places?|town)\b/i,
  inputSchema: schema({ ...P, patch: { type: 'object' }, change: { type: 'string' } }, ['persona_id', 'patch']),
  parse: (raw) => {
    const o = obj(raw, ['persona_id', 'patch', 'change']);
    if (!o.patch || typeof o.patch !== 'object' || Array.isArray(o.patch)) throw new Error('patch must be an object');
    const allowed = ['self', 'home', 'recurringPlaces', 'cast', 'routine', 'seasons', 'holidays', 'localEvents', 'localLife', 'place'];
    const bad = Object.keys(o.patch).filter((k) => !allowed.includes(k));
    if (bad.length) throw new Error(`cannot edit: ${bad.join(', ')}`);
    return { persona_id: uuid(o, 'persona_id'), patch: o.patch as Record<string, unknown>, change: optText(o, 'change') };
  },
  async run(ctx, i) {
    const r = await updateBible(ctx.services.db, { personaId: i.persona_id, patch: i.patch, actor: ctx.actor, change: i.change ?? undefined });
    return { version: r.version };
  },
};

const worldBackfill: ToolDef<{ persona_id: string }, unknown> = {
  name: 'world.backfill',
  description: 'Drafts and adopts a World Bible and storyline for a persona that has none (launched before IOS-5 or restored from the archive).',
  scope: 'persona',
  callers: [...MANAGERS, 'system'],
  mutates: true,
  ownerIntent: /\b(?:create|write|draft|build|make|give)\b.*\b(?:world|bible|storyline)\b/i,
  inputSchema: schema(P, ['persona_id']),
  parse: (raw) => ({ persona_id: uuid(obj(raw, ['persona_id']), 'persona_id') }),
  run: (ctx, i) => backfillWorld(ctx.services, { personaId: i.persona_id, actor: ctx.actor }),
};

const storyView: ToolDef<{ persona_id: string }, unknown> = {
  name: 'storyline.view',
  description: "The persona's season arc: chapters (tension → payoff), beats by week and their status, running gags and callbacks.",
  scope: 'persona',
  callers: READERS,
  inputSchema: schema(P, ['persona_id']),
  parse: (raw) => ({ persona_id: uuid(obj(raw, ['persona_id']), 'persona_id') }),
  run: async (ctx, i) => (await storylineView(ctx.services.db, i.persona_id, ctx.services.now())) ?? { arc: null },
};

const storySteer: ToolDef<{ persona_id: string; instruction: string }, unknown> = {
  name: 'storyline.steer',
  description: "Steers the storyline from the Owner's instruction: rewrites, adds or drops upcoming beats (never posted ones) and updates the still-planned slots.",
  scope: 'persona',
  callers: STORY_STEERERS,
  mutates: true,
  ownerIntent: /\b(?:steer|change|rewrite|move|add|drop|cut|make|have|let|bring)\b.*\b(?:storyline|story ?line|story|arc|chapter|beats?|plot|episode)\b/i,
  inputSchema: schema({ ...P, instruction: { type: 'string' } }, ['persona_id', 'instruction']),
  parse: (raw) => {
    const o = obj(raw, ['persona_id', 'instruction']);
    return { persona_id: uuid(o, 'persona_id'), instruction: text(o, 'instruction', 600, 4) };
  },
  run: (ctx, i) => steerStoryline(ctx.services, { personaId: i.persona_id, instruction: i.instruction, actor: ctx.actor }),
};

const storyAddBeat: ToolDef<{ persona_id: string; text: string; week?: number; kind?: BeatKind }, unknown> = {
  name: 'storyline.add_beat',
  description: 'Adds one beat to the active arc (week defaults to the current one).',
  scope: 'persona',
  callers: STORY_STEERERS,
  mutates: true,
  ownerIntent: /\b(?:add|put|slot|include)\b.*\b(?:beat|storyline|story|arc|chapter)\b/i,
  inputSchema: schema({ ...P, text: { type: 'string' }, week: { type: 'integer' }, kind: { type: 'string', enum: BEAT_KINDS } }, ['persona_id', 'text']),
  parse: (raw) => {
    const o = obj(raw, ['persona_id', 'text', 'week', 'kind']);
    if (o.kind !== undefined && !BEAT_KINDS.includes(o.kind as BeatKind)) throw new Error('unknown beat kind');
    const kind = o.kind as BeatKind | undefined;
    return { persona_id: uuid(o, 'persona_id'), text: text(o, 'text', 300, 4), week: optInt(o, 'week', 1, 52), kind };
  },
  run: (ctx, i) => addBeat(ctx.services, { personaId: i.persona_id, text: i.text, week: i.week, kind: i.kind }),
};

const storyExtend: ToolDef<{ persona_id: string }, unknown> = {
  name: 'storyline.extend',
  description: 'Starts the next season arc now (callbacks to the open cliffhangers and the beats the audience liked best).',
  scope: 'persona',
  callers: STORY_STEERERS,
  mutates: true,
  ownerIntent: /\b(?:extend|start|begin|write|plan)\b.*\b(?:season|arc|storyline)\b/i,
  inputSchema: schema(P, ['persona_id']),
  parse: (raw) => ({ persona_id: uuid(obj(raw, ['persona_id']), 'persona_id') }),
  run: (ctx, i) => extendStoryline(ctx.services, { personaId: i.persona_id, actor: ctx.actor, force: true }),
};

const contFacts: ToolDef<{ persona_id: string }, unknown> = {
  name: 'continuity.facts',
  description: "The persona's continuity ledger: every stated fact (people, pets, age, events, possessions, opinions, home) and where it was said.",
  scope: 'persona',
  callers: READERS,
  inputSchema: schema(P, ['persona_id']),
  parse: (raw) => ({ persona_id: uuid(obj(raw, ['persona_id']), 'persona_id') }),
  run: async (ctx, i) => ({ facts: (await ledgerOf(ctx.services.db, i.persona_id)).map((f) => ({ id: f.id, kind: f.kind, subject: f.subject, value: f.value, statement: f.statement, source: f.sourceType })) }),
};

const contCheck: ToolDef<{ persona_id: string; text: string }, unknown> = {
  name: 'continuity.check',
  description: 'Checks a draft text against the continuity ledger (the deterministic pass; Q1 also runs it on every script).',
  scope: 'persona',
  callers: READERS,
  inputSchema: schema({ ...P, text: { type: 'string' } }, ['persona_id', 'text']),
  parse: (raw) => {
    const o = obj(raw, ['persona_id', 'text']);
    return { persona_id: uuid(o, 'persona_id'), text: text(o, 'text', 6000) };
  },
  async run(ctx, i) {
    const w = await loadWorld(ctx.services.db, i.persona_id);
    const found = contradictions(extractFacts(i.text), await ledgerOf(ctx.services.db, i.persona_id), ctx.services.now(), w?.bible.place ?? null);
    return { checks: continuityChecks(found) };
  },
};

const contRetract: ToolDef<{ persona_id: string; fact_id: string }, unknown> = {
  name: 'continuity.retract',
  description: 'Retracts a ledger fact that was recorded by mistake (the Owner or the Persona Manager; the history keeps it).',
  scope: 'persona',
  callers: ['owner', 'persona-manager'],
  mutates: true,
  ownerIntent: /\b(?:retract|remove|delete|forget|drop)\b.*\b(?:fact|ledger|continuity)\b/i,
  inputSchema: schema({ ...P, fact_id: { type: 'string' } }, ['persona_id', 'fact_id']),
  parse: (raw) => {
    const o = obj(raw, ['persona_id', 'fact_id']);
    return { persona_id: uuid(o, 'persona_id'), fact_id: uuid(o, 'fact_id') };
  },
  async run(ctx, i) {
    const r = await ctx.services.db.query(`UPDATE continuity_fact SET status = 'retracted' WHERE id = $1 AND persona_id = $2 RETURNING id`, [i.fact_id, i.persona_id]);
    return { retracted: r.length };
  },
};

const noRepeat: ToolDef<{ persona_id: string | null; premise: string; hook_type: string | null; topic: string; format: PostFormat; key_line: string; series: string | null }, unknown> = {
  name: 'norepeat.check',
  description: "Checks a concept against the persona's history (or the studio's, without a persona): premise, hook type, topic, format, key line; series episodes must add a new beat.",
  scope: 'studio',
  callers: READERS,
  inputSchema: schema(
    { persona_id: { type: 'string' }, premise: { type: 'string' }, hook_type: { type: 'string' }, topic: { type: 'string' }, format: { type: 'string', enum: POST_FORMATS }, key_line: { type: 'string' }, series: { type: 'string' } },
    ['premise', 'topic', 'format', 'key_line'],
  ),
  parse: (raw) => {
    const o = obj(raw, ['persona_id', 'premise', 'hook_type', 'topic', 'format', 'key_line', 'series']);
    if (!POST_FORMATS.includes(o.format as PostFormat)) throw new Error('unknown format');
    return { persona_id: optUuid(o, 'persona_id'), premise: text(o, 'premise', 300), hook_type: optText(o, 'hook_type', 40), topic: text(o, 'topic', 200), format: o.format as PostFormat, key_line: text(o, 'key_line', 400), series: optText(o, 'series', 120) };
  },
  async run(ctx, i) {
    if (i.persona_id && !(await ctx.services.db.maybeOne('SELECT 1 FROM persona WHERE id = $1 AND studio_id = $2', [i.persona_id, ctx.studioId]))) throw new Error('persona is not in this studio');
    if (ctx.personaId && i.persona_id && i.persona_id !== ctx.personaId) throw new Error('a persona-scoped caller may only check its own persona');
    const fp = { ...fingerprintOf({ title: i.premise, hookType: i.hook_type, pillar: i.topic, niche: i.topic, format: i.format, hook: i.key_line }), series: i.series };
    return checkConceptFingerprint(ctx.services, { studioId: ctx.studioId, personaId: i.persona_id ?? ctx.personaId, fingerprint: fp });
  },
};

const scopeOf = (o: Record<string, unknown>) => {
  const draftId = optUuid(o, 'draft_id');
  const personaId = optUuid(o, 'persona_id');
  if (!draftId && !personaId) throw new Error('draft_id or persona_id is required');
  return { draftId, personaId };
};
async function assertScope(ctx: { services: { db: Db }; studioId: string }, s: { draftId: string | null; personaId: string | null }) {
  if (s.draftId && !(await ctx.services.db.maybeOne('SELECT 1 FROM persona_draft WHERE id = $1 AND studio_id = $2', [s.draftId, ctx.studioId]))) throw new Error('draft is not in this studio');
  if (s.personaId && !(await ctx.services.db.maybeOne('SELECT 1 FROM persona WHERE id = $1 AND studio_id = $2', [s.personaId, ctx.studioId]))) throw new Error('persona is not in this studio');
}

const inspSearch: ToolDef<{ query: string; draft_id: string | null; persona_id: string | null; limit?: number }, unknown> = {
  name: 'inspiration.search',
  description:
    'Searches Pinterest for mood and format inspiration (palette, wardrobe, settings, aesthetics, motion trends) for a generator draft or a persona: the official API where it allows, else the Apify scraper (low volume, weekly cap). Never search for a real person or a face to copy.',
  scope: 'studio',
  callers: INSPIRATION,
  mutates: true,
  untrustedOutput: true,
  ownerIntent: /\b(?:search|find|look|pull|get)\b.*\b(?:pinterest|pins?|inspiration|mood ?board|references?)\b/i,
  inputSchema: schema({ query: { type: 'string' }, draft_id: { type: 'string' }, persona_id: { type: 'string' }, limit: { type: 'integer' } }, ['query']),
  parse: (raw) => {
    const o = obj(raw, ['query', 'draft_id', 'persona_id', 'limit']);
    const s = scopeOf(o);
    return { query: text(o, 'query', 100, 2), draft_id: s.draftId, persona_id: s.personaId, limit: optInt(o, 'limit', 1, 30) };
  },
  async run(ctx, i) {
    await assertScope(ctx, { draftId: i.draft_id, personaId: i.persona_id });
    const r = await searchInspiration(ctx.services, { studioId: ctx.studioId, draftId: i.draft_id, personaId: i.persona_id, query: i.query, limit: i.limit, agent: ctx.caller === 'owner' ? 'owner' : ctx.caller });
    return { source: r.source, costUsd: r.costUsd, pins: r.pins.map((p) => ({ pin_row_id: p.rowId, title: p.title.slice(0, 120), url: p.url })) };
  },
};

const inspPick: ToolDef<{ pin_row_ids: string[]; draft_id: string | null; persona_id: string | null; picked: boolean }, unknown> = {
  name: 'inspiration.pick',
  description: 'Picks (or unpicks) pins into the mood board and rewrites its descriptors. Mood and format only: pins are never a face or identity reference.',
  scope: 'studio',
  callers: INSPIRATION,
  mutates: true,
  ownerIntent: /\b(?:pick|add|use|keep|save|choose|remove|unpick)\b.*\b(?:pins?|inspiration|mood ?board)\b/i,
  inputSchema: schema({ pin_row_ids: { type: 'array', items: { type: 'string' } }, draft_id: { type: 'string' }, persona_id: { type: 'string' }, picked: { type: 'boolean' } }, ['pin_row_ids']),
  parse: (raw) => {
    const o = obj(raw, ['pin_row_ids', 'draft_id', 'persona_id', 'picked']);
    if (!Array.isArray(o.pin_row_ids) || !o.pin_row_ids.length || o.pin_row_ids.length > 30 || o.pin_row_ids.some((x) => typeof x !== 'string' || !UUID_RE.test(x))) throw new Error('pin_row_ids must be 1–30 uuids');
    const s = scopeOf(o);
    return { pin_row_ids: o.pin_row_ids as string[], draft_id: s.draftId, persona_id: s.personaId, picked: o.picked !== false };
  },
  async run(ctx, i) {
    await assertScope(ctx, { draftId: i.draft_id, personaId: i.persona_id });
    return pickPins(ctx.services, { studioId: ctx.studioId, draftId: i.draft_id, personaId: i.persona_id, pinRowIds: i.pin_row_ids, picked: i.picked });
  },
};

const inspBoard: ToolDef<{ draft_id: string | null; persona_id: string | null }, unknown> = {
  name: 'inspiration.board',
  description: 'The mood board of a draft or persona: the text descriptors (use them as mood) and the picked pins (titles are third-party text).',
  scope: 'studio',
  callers: [...INSPIRATION, 'persona-manager', 'video-producer', 'stories-producer', 'system'],
  untrustedOutput: true,
  inputSchema: schema({ draft_id: { type: 'string' }, persona_id: { type: 'string' } }, []),
  parse: (raw) => {
    const s = scopeOf(obj(raw, ['draft_id', 'persona_id']));
    return { draft_id: s.draftId, persona_id: s.personaId };
  },
  async run(ctx, i) {
    await assertScope(ctx, { draftId: i.draft_id, personaId: i.persona_id });
    const b = await moodBoard(ctx.services.db, { draftId: i.draft_id, personaId: i.persona_id });
    const candidates = await listPins(ctx.services.db, { studioId: ctx.studioId, draftId: i.draft_id, personaId: i.persona_id }, { picked: false });
    return { descriptors: b.descriptors, picked: b.pins.map((p) => ({ title: p.title.slice(0, 120), url: p.url })), candidates: candidates.slice(0, 20).map((p) => ({ pin_row_id: p.id, title: p.title.slice(0, 120) })) };
  },
};

const pinBoards: ToolDef<Record<string, never>, unknown> = {
  name: 'pinterest.boards',
  description: "The studio's Pinterest boards (one per persona) and recent pins, live or pending the key.",
  scope: 'studio',
  callers: READERS,
  inputSchema: schema({}, []),
  parse: (raw) => (obj(raw ?? {}, []), {}),
  async run(ctx) {
    const boards = await ctx.services.db.query(`SELECT b.persona_id, p.name AS persona, b.board_id, b.name, b.live FROM pinterest_board b JOIN persona p ON p.id = b.persona_id WHERE b.studio_id = $1 ORDER BY p.name`, [ctx.studioId]);
    const pins = await ctx.services.db.query(`SELECT persona_id, kind, ref_id, url, live, status, error, created_at FROM pinterest_pin WHERE studio_id = $1 ORDER BY created_at DESC LIMIT 30`, [ctx.studioId]);
    return { live: !ctx.services.providers.pinterest.name.startsWith('fake'), boards, pins };
  },
};

const pinPublish: ToolDef<{ persona_id: string; kind: PinKind; ref_id: string }, unknown> = {
  name: 'pinterest.publish',
  description: "Queues a pin of a live product or carousel on the persona's Pinterest board (AI disclosure added; kill switches respected).",
  scope: 'persona',
  callers: ['owner', 'persona-manager', 'monetization-agent', 'system'],
  mutates: true,
  ownerIntent: /\b(?:pin|post|publish|share|put)\b.*\b(?:pinterest|pin|board)\b/i,
  inputSchema: schema({ ...P, kind: { type: 'string', enum: PIN_KINDS }, ref_id: { type: 'string' } }, ['persona_id', 'kind', 'ref_id']),
  parse: (raw) => {
    const o = obj(raw, ['persona_id', 'kind', 'ref_id']);
    if (!PIN_KINDS.includes(o.kind as PinKind)) throw new Error('kind must be product or carousel');
    return { persona_id: uuid(o, 'persona_id'), kind: o.kind as PinKind, ref_id: uuid(o, 'ref_id') };
  },
  async run(ctx, i) {
    const job = await enqueueOnceFor(ctx.services.db, { kind: WORLD_JOBS.pin, key: `pin:${i.kind}:${i.ref_id}`, payload: { personaId: i.persona_id, kind: i.kind, refId: i.ref_id }, studioId: ctx.studioId, personaId: i.persona_id, priority: 120 });
    return { queued: !!job, jobId: job?.id ?? null };
  },
};

export const WORLD_TOOLS: ReadonlyArray<ToolDef<any, any>> = [
  worldView,
  worldGrounding,
  worldUpdate,
  worldBackfill,
  storyView,
  storySteer,
  storyAddBeat,
  storyExtend,
  contFacts,
  contCheck,
  contRetract,
  noRepeat,
  inspSearch,
  inspPick,
  inspBoard,
  pinBoards,
  pinPublish,
];
