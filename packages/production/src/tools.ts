import { CAMERA_STYLES, type CameraStyle, type Caller, type ToolDef } from '@troupe/agents';
import { fillTemplate, templatesFor } from '@troupe/content';
import { enqueue, POST_FORMATS, type PostFormat } from '@troupe/core';
import { json } from '@troupe/db';
import { checkVideoPrompt } from './compiler';
import { nicheFilter } from './niche';
import { productionOverview } from './read';
import { locationLocks } from './store';

/**
 * Stream K's agent tools (`prompt.*`, `production.*`, `look.*`, `location.*`). Reads are open to agents (the Studio
 * Manager and the Video Producer use them). Generating a look pack or locking places spends credits, so those
 * queue a job for the makers; re-picking a grid cell is the Owner's call.
 */

/** Job kinds stream K queues; @troupe/media runs them (generations go through the governor there). */
export const PRODUCTION_JOB = {
  /** Character sheet + detail strip + identity stack + 4 core refs + BOPA for one persona. */
  lookBuild: 'look.build',
  /** Location lock: 5 candidates per place, the pick and a second anchor angle. */
  lockLocations: 'production.lock_locations',
} as const;

type Raw = Record<string, unknown>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAKERS: readonly Caller[] = ['owner', 'system', 'video-producer', 'studio-manager'];
const READERS: readonly Caller[] = ['owner', 'system', 'video-producer', 'studio-manager', 'persona-manager', 'scriptwriter', 'stories-producer'];

function obj(raw: unknown, allowed: readonly string[]): Raw {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('input must be an object');
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`unknown input fields: ${extra.join(', ')}`);
  return raw as Raw;
}
const uuid = (r: Raw, k: string): string => {
  const v = r[k];
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new Error(`${k} must be a uuid`);
  return v;
};
const str = (r: Raw, k: string, max: number, required = false): string | null => {
  const v = r[k];
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`${k} is required`);
    return null;
  }
  if (typeof v !== 'string') throw new Error(`${k} must be a string`);
  return v.trim().slice(0, max);
};
const schema = (properties: Record<string, object>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const PID = { type: 'string', description: 'Persona id (uuid).' } as const;

async function studioOf(db: Parameters<ToolDef['run']>[0]['services']['db'], personaId: string): Promise<string> {
  return (await db.one<{ studio_id: string }>('SELECT studio_id FROM persona WHERE id = $1', [personaId])).studio_id;
}

const compileTool: ToolDef<{ persona_id: string; kind: 'image' | 'video'; scene: string; line: string | null; location: string | null; camera: CameraStyle | null }, unknown> = {
  name: 'prompt.compile',
  description:
    'Preview the compiled Higgsfield prompt for a persona (five image blocks or five video blocks, grounding, camera style, identity and location references). Read-only; spends nothing.',
  scope: 'persona',
  callers: READERS,
  inputSchema: schema(
    {
      persona_id: PID,
      kind: { type: 'string', enum: ['image', 'video'] },
      scene: { type: 'string', description: 'What happens in the frame (image) or the action (video).' },
      line: { type: 'string', description: 'Video only: the verbatim spoken line.' },
      location: { type: 'string', description: 'A place in the persona’s world (locked places use their anchor frames).' },
      camera: { type: 'string', enum: [...CAMERA_STYLES] },
    },
    ['persona_id', 'kind', 'scene'],
  ),
  parse(raw) {
    const r = obj(raw, ['persona_id', 'kind', 'scene', 'line', 'location', 'camera']);
    const kind = r.kind === 'video' ? 'video' : r.kind === 'image' ? 'image' : null;
    if (!kind) throw new Error('kind must be image or video');
    const camera = str(r, 'camera', 40);
    if (camera && !(CAMERA_STYLES as readonly string[]).includes(camera)) throw new Error(`camera must be one of ${CAMERA_STYLES.join(', ')}`);
    return { persona_id: uuid(r, 'persona_id'), kind, scene: str(r, 'scene', 600, true)!, line: str(r, 'line', 600), location: str(r, 'location', 200), camera: camera as CameraStyle | null };
  },
  async run(ctx, i) {
    const p = ctx.services.prompts;
    if (i.kind === 'image') return p.image({ personaId: i.persona_id, scene: i.scene, location: i.location, camera: i.camera });
    const compiled = await p.video({ personaId: i.persona_id, startFrame: 'the persona in the scene', action: i.scene, line: i.line, camera: i.camera, durationS: 5, location: i.location });
    return { ...compiled, checks: checkVideoPrompt(compiled, { line: i.line }) };
  },
};

const nicheTool: ToolDef<{ niche: string; premise: string | null; mechanic: string | null; archetype: string | null; hooks: string[] }, unknown> = {
  name: 'production.niche_filter',
  description:
    'The Persona Generator niche filter: "could a real creator build a personal brand by talking to camera about this?" Five questions (50–100 ideas, returning host, recognisable character, strong cheap hooks, a reason to come back) plus niche-vs-format, with the hook templates the niche can feed. Read-only.',
  scope: 'studio',
  callers: READERS,
  inputSchema: schema(
    { niche: { type: 'string' }, premise: { type: 'string' }, mechanic: { type: 'string' }, archetype: { type: 'string' }, hooks: { type: 'array', items: { type: 'string' } } },
    ['niche'],
  ),
  parse(raw) {
    const r = obj(raw, ['niche', 'premise', 'mechanic', 'archetype', 'hooks']);
    const hooks = Array.isArray(r.hooks) ? r.hooks.filter((h): h is string => typeof h === 'string').map((h) => h.slice(0, 200)).slice(0, 20) : [];
    return { niche: str(r, 'niche', 200, true)!, premise: str(r, 'premise', 600), mechanic: str(r, 'mechanic', 400), archetype: str(r, 'archetype', 200), hooks };
  },
  run: async (_ctx, i) => nicheFilter(i),
};

const hookTool: ToolDef<{ format: PostFormat | null; topic: string | null }, unknown> = {
  name: 'production.hook_templates',
  description: 'The hook-template library (3 mistakes, do this instead, myth vs fact, ranking, story, POV, quiz, beginner guide, reaction, triple hook…), best fits for a format first, filled with a topic. Patterns for inspiration, never lines to copy. Read-only.',
  scope: 'studio',
  callers: READERS,
  inputSchema: schema({ format: { type: 'string', enum: [...POST_FORMATS] }, topic: { type: 'string' } }, []),
  parse(raw) {
    const r = obj(raw, ['format', 'topic']);
    const format = str(r, 'format', 40);
    if (format && !(POST_FORMATS as readonly string[]).includes(format)) throw new Error('unknown format');
    return { format: format as PostFormat | null, topic: str(r, 'topic', 200) };
  },
  async run(ctx, i) {
    const custom = await ctx.services.db
      .query<{ id: string; name: string; hook_type: string; pattern: string; example: string; source: string }>(`SELECT id, name, hook_type, pattern, example, source FROM hook_template WHERE active AND source <> 'library' ORDER BY created_at LIMIT 20`)
      .catch(() => []);
    const lib = templatesFor(i.format ?? 'talking').map((t) => ({ id: t.id, name: t.name, type: t.type, pattern: t.pattern, example: i.topic ? fillTemplate(t, i.topic) : t.example, fits: i.format ? t.formats.includes(i.format) : true }));
    return { templates: lib, custom };
  },
};

const overviewTool: ToolDef<{ persona_id: string }, unknown> = {
  name: 'production.overview',
  description: "A persona's production playbook state: camera styles in rotation, the character sheet / identity stack / core refs / BOPA look pack, locked locations, and the camera and location each recent slot used.",
  scope: 'persona',
  callers: READERS,
  inputSchema: schema({ persona_id: PID }, ['persona_id']),
  parse: (raw) => ({ persona_id: uuid(obj(raw, ['persona_id']), 'persona_id') }),
  run: async (ctx, i) => productionOverview(ctx.services.db, i.persona_id),
};

const locationsTool: ToolDef<{ persona_id: string }, unknown> = {
  name: 'location.list',
  description: "The persona's recurring places and their location locks (pending or locked, with the anchor frames every still there references).",
  scope: 'persona',
  callers: READERS,
  inputSchema: schema({ persona_id: PID }, ['persona_id']),
  parse: (raw) => ({ persona_id: uuid(obj(raw, ['persona_id']), 'persona_id') }),
  run: async (ctx, i) => ({ locations: await locationLocks(ctx.services.db, i.persona_id) }),
};

const buildLookTool: ToolDef<{ persona_id: string }, unknown> = {
  name: 'look.build',
  description:
    "Queue the persona's production identity: the 5-view character sheet, the detail strip, the identity stack (face close-up + 2 full-body), 4 core references and the BOPA look pack. Each piece is made once; spends Higgsfield credits through the governor.",
  scope: 'persona',
  mutates: true,
  callers: MAKERS,
  ownerIntent: /\b(?:build|make|generate|create|redo|refresh)\b.*\b(?:look ?pack|character sheet|references?|bopa|identity)\b/i,
  inputSchema: schema({ persona_id: PID }, ['persona_id']),
  parse: (raw) => ({ persona_id: uuid(obj(raw, ['persona_id']), 'persona_id') }),
  async run(ctx, i) {
    const job = await enqueue(ctx.services.db, { kind: PRODUCTION_JOB.lookBuild, payload: { personaId: i.persona_id }, personaId: i.persona_id, studioId: await studioOf(ctx.services.db, i.persona_id), maxAttempts: 3, runAt: ctx.services.now() });
    return { job_id: job.id };
  },
};

const lockTool: ToolDef<{ persona_id: string; place: string | null; pick: number | null }, unknown> = {
  name: 'location.lock',
  description:
    'Queue the location lock for the persona’s recurring places (5 candidates per place, the pick and a second anchor angle). With `place` and `pick` (1–5) it re-locks that place on another candidate. Spends Higgsfield credits through the governor.',
  scope: 'persona',
  mutates: true,
  callers: MAKERS,
  ownerIntent: /\b(?:lock|re-?lock|pick|change|redo)\b.*\b(?:locations?|places?|set|kitchen|room|candidate)\b/i,
  inputSchema: schema({ persona_id: PID, place: { type: 'string' }, pick: { type: 'number', minimum: 1, maximum: 5 } }, ['persona_id']),
  parse(raw) {
    const r = obj(raw, ['persona_id', 'place', 'pick']);
    const pick = r.pick === undefined || r.pick === null ? null : Number(r.pick);
    if (pick !== null && (!Number.isInteger(pick) || pick < 1 || pick > 5)) throw new Error('pick must be 1–5');
    return { persona_id: uuid(r, 'persona_id'), place: str(r, 'place', 200), pick };
  },
  async run(ctx, i) {
    const job = await enqueue(ctx.services.db, {
      kind: PRODUCTION_JOB.lockLocations,
      payload: { personaId: i.persona_id, ...(i.place ? { place: i.place } : {}), ...(i.pick ? { pick: i.pick - 1 } : {}) },
      personaId: i.persona_id,
      studioId: await studioOf(ctx.services.db, i.persona_id),
      maxAttempts: 3,
      runAt: ctx.services.now(),
    });
    return { job_id: job.id };
  },
};

const pickTool: ToolDef<{ persona_id: string; grid: 'backgrounds' | 'poses'; cell: number }, unknown> = {
  name: 'look.pick',
  description: 'The Owner re-picks a BOPA grid cell (backgrounds 1–9 or poses 1–4); the next look.build upscales the new pick. Owner only.',
  scope: 'persona',
  ownerOnly: true,
  mutates: true,
  inputSchema: schema({ persona_id: PID, grid: { type: 'string', enum: ['backgrounds', 'poses'] }, cell: { type: 'number', minimum: 1, maximum: 9 } }, ['persona_id', 'grid', 'cell']),
  parse(raw) {
    const r = obj(raw, ['persona_id', 'grid', 'cell']);
    const grid = r.grid === 'poses' ? 'poses' : r.grid === 'backgrounds' ? 'backgrounds' : null;
    if (!grid) throw new Error('grid must be backgrounds or poses');
    const cell = Number(r.cell);
    if (!Number.isInteger(cell) || cell < 1 || cell > (grid === 'poses' ? 4 : 9)) throw new Error(`cell must be 1–${grid === 'poses' ? 4 : 9}`);
    return { persona_id: uuid(r, 'persona_id'), grid, cell };
  },
  async run(ctx, i) {
    const { db } = ctx.services;
    const gridKind = i.grid === 'poses' ? 'bopa_pose_grid' : 'bopa_background_grid';
    const pickKind = i.grid === 'poses' ? 'bopa_pose' : 'bopa_background';
    const g = await db.maybeOne<{ id: string }>(`SELECT id FROM production_identity WHERE persona_id = $1 AND kind = $2 AND status = 'active'`, [i.persona_id, gridKind]);
    if (!g) throw new Error('no grid yet: run look.build first');
    await db.query(`UPDATE production_identity SET meta = meta || $2::jsonb WHERE id = $1`, [g.id, json({ pick: i.cell - 1, picked_by: 'owner' })]);
    // The old upscale is retired; the next look.build makes the new one.
    await db.query(`UPDATE production_identity SET status = 'rejected' WHERE persona_id = $1 AND kind = $2 AND status <> 'rejected'`, [i.persona_id, pickKind]);
    const job = await enqueue(db, { kind: PRODUCTION_JOB.lookBuild, payload: { personaId: i.persona_id }, personaId: i.persona_id, studioId: await studioOf(db, i.persona_id), maxAttempts: 3, runAt: ctx.services.now() });
    return { ok: true, job_id: job.id };
  },
};

export const tools: ReadonlyArray<ToolDef<any, any>> = [compileTool, nicheTool, hookTool, overviewTool, locationsTool, buildLookTool, lockTool, pickTool];
