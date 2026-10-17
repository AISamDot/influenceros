import type { Caller, ToolDef } from '@troupe/agents';
import { enqueue } from '@troupe/core';
import { MEDIA_JOB, rerenderSlot } from './jobs';
import { personaMedia, slotMedia } from './read';

/**
 * Agent tools for stream E's namespaces (`media.*`, `voice.*`). Reads are open to agents; re-rendering is for the
 * Owner, the system and the Video Producer; replacing a persona's voice is the Owner's call (it changes how the
 * persona sounds everywhere).
 */
type Raw = Record<string, unknown>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAKERS: readonly Caller[] = ['owner', 'system', 'video-producer', 'studio-manager'];

function obj(raw: unknown, allowed: readonly string[]): Raw {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('input must be an object');
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`unknown input fields: ${extra.join(', ')}`);
  return raw as Raw;
}
function uuid(r: Raw, k: string): string {
  const v = r[k];
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new Error(`${k} must be a uuid`);
  return v;
}
const schema = (properties: Record<string, object>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const PID = { type: 'string', description: 'Persona id (uuid).' } as const;
const SID = { type: 'string', description: 'Calendar slot id (uuid).' } as const;

async function ownedSlot(ctx: Parameters<ToolDef['run']>[0], slotId: string, personaId: string): Promise<void> {
  const ok = await ctx.services.db.maybeOne('SELECT 1 FROM calendar_slot WHERE id = $1 AND persona_id = $2', [slotId, personaId]);
  if (!ok) throw new Error('slot not found for this persona');
}

const statusTool: ToolDef<{ persona_id: string }, unknown> = {
  name: 'media.status',
  description: "A persona's media identity (Soul ID, face reference, voice, colour grade, look pack) and its latest renders with their stage and credits.",
  scope: 'persona',
  inputSchema: schema({ persona_id: PID }, ['persona_id']),
  parse: (raw) => ({ persona_id: uuid(obj(raw, ['persona_id']), 'persona_id') }),
  run: async (ctx, i) => personaMedia(ctx.services.db, i.persona_id, ctx.services.now()),
};

const slotTool: ToolDef<{ persona_id: string; slot_id: string }, unknown> = {
  name: 'media.slot',
  description: "One post's media: render step, fix loops used, final files, cover, voice track, generations and the Q2/Q3/Q4 reports.",
  scope: 'persona',
  inputSchema: schema({ persona_id: PID, slot_id: SID }, ['persona_id', 'slot_id']),
  parse: (raw) => {
    const r = obj(raw, ['persona_id', 'slot_id']);
    return { persona_id: uuid(r, 'persona_id'), slot_id: uuid(r, 'slot_id') };
  },
  async run(ctx, i) {
    await ownedSlot(ctx, i.slot_id, i.persona_id);
    return slotMedia(ctx.services.db, i.slot_id);
  },
};

const rerenderTool: ToolDef<{ persona_id: string; slot_id: string }, unknown> = {
  name: 'media.rerender',
  description: 'Re-run the media of one post: reopens a slot blocked by Q2/Q3/Q4 (fresh fix loops) and queues media.render. Spends Higgsfield credits through the governor.',
  scope: 'persona',
  mutates: true,
  callers: MAKERS,
  ownerIntent: /\b(?:re-?render|re-?run|redo|retry|regenerate)\b.*\b(?:post|slot|video|reel|media|render|carousel)\b/i,
  inputSchema: schema({ persona_id: PID, slot_id: SID }, ['persona_id', 'slot_id']),
  parse: (raw) => {
    const r = obj(raw, ['persona_id', 'slot_id']);
    return { persona_id: uuid(r, 'persona_id'), slot_id: uuid(r, 'slot_id') };
  },
  async run(ctx, i) {
    await ownedSlot(ctx, i.slot_id, i.persona_id);
    return rerenderSlot(ctx.services, i.slot_id);
  },
};

const probeTool: ToolDef<Record<string, never>, unknown> = {
  name: 'media.probe_costs',
  description: "Queue the Higgsfield cost probe (`higgsfield generate cost`) that refreshes the price table the governor's estimates use. Free.",
  scope: 'studio',
  mutates: true,
  callers: ['owner', 'system', 'studio-manager'],
  ownerIntent: /\b(?:probe|refresh|check|update)\b.*\b(?:costs?|prices?|credits?)\b/i,
  inputSchema: schema({}, []),
  parse: (raw) => (obj(raw ?? {}, []), {}),
  run: async (ctx) => ({ job_id: (await enqueue(ctx.services.db, { kind: MEDIA_JOB.costProbe, studioId: ctx.studioId, maxAttempts: 3 })).id }),
};

const voiceTool: ToolDef<{ persona_id: string }, unknown> = {
  name: 'voice.redesign',
  description: "Replace a persona's synthetic voice: the next render designs a new one from the bible (Owner only: it changes how the persona sounds everywhere).",
  scope: 'persona',
  ownerOnly: true,
  mutates: true,
  inputSchema: schema({ persona_id: PID }, ['persona_id']),
  parse: (raw) => ({ persona_id: uuid(obj(raw, ['persona_id']), 'persona_id') }),
  async run(ctx, i) {
    await ctx.services.db.query(`UPDATE media_profile SET voice_id = NULL, voice_provider = NULL, updated_at = now() WHERE persona_id = $1`, [i.persona_id]);
    return { ok: true };
  },
};

export const tools: ReadonlyArray<ToolDef<any, any>> = [statusTool, slotTool, rerenderTool, probeTool, voiceTool];
