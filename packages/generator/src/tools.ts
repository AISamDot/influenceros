import { type ToolContext, type ToolDef, ToolInputError } from '@troupe/agents';
import { type Actor, proposeArchive } from '@troupe/core';
import { launchDraft } from './launch';
import { computeReview } from './review';
import { type ConceptPart, CONCEPT_PARTS, chooseOption, mixConcepts, regenerateStep, reviseStep } from './steps';
import { getDraft, listDrafts } from './store';
import { type DraftRow, STEPS } from './types';

/**
 * generator.* tools (PRD §3.12). The Studio Manager reads drafts freely; every tool that changes a draft is
 * `mutates` with an `ownerIntent`, and generator chat runs are untrusted (drafts carry outside research), so the
 * registry lets a change through only when the Owner asked for it in this turn. Launching is Owner-only: no agent can
 * call generator.launch, and launchDraft refuses any actor but the Owner.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Spec = Record<string, { type: 'string' | 'integer' | 'object'; optional?: boolean; enum?: readonly string[]; uuid?: boolean; min?: number; max?: number; maxLength?: number; description?: string }>;

function schemaOf(spec: Spec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(spec)) {
    properties[k] = {
      type: f.type,
      ...(f.description ? { description: f.description } : {}),
      ...(f.enum ? { enum: f.enum } : {}),
      ...(f.uuid ? { format: 'uuid' } : {}),
      ...(f.min !== undefined ? { minimum: f.min } : {}),
      ...(f.max !== undefined ? { maximum: f.max } : {}),
      ...(f.type === 'object' ? { additionalProperties: { type: 'string' } } : {}),
    };
  }
  return { type: 'object', properties, required: Object.entries(spec).filter(([, f]) => !f.optional).map(([k]) => k), additionalProperties: false };
}

function parserOf<T>(spec: Spec): (raw: unknown) => T {
  return (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolInputError('input must be an object');
    const r = raw as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!(k in spec)) throw new ToolInputError(`unknown field: ${k}`);
    const out: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(spec)) {
      const v = r[k];
      if (v === undefined || v === null || v === '') {
        if (!f.optional) throw new ToolInputError(`${k} is required`);
        continue;
      }
      if (f.type === 'string') {
        if (typeof v !== 'string') throw new ToolInputError(`${k} must be a string`);
        if (f.uuid && !UUID_RE.test(v)) throw new ToolInputError(`${k} must be a uuid`);
        if (f.enum && !f.enum.includes(v)) throw new ToolInputError(`${k} must be one of ${f.enum.join(', ')}`);
        if (f.maxLength && v.length > f.maxLength) throw new ToolInputError(`${k} is too long`);
        out[k] = v.trim();
      } else if (f.type === 'integer') {
        const n = Number(v);
        if (!Number.isInteger(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) throw new ToolInputError(`${k} must be an integer${f.min !== undefined ? ` from ${f.min}` : ''}${f.max !== undefined ? ` to ${f.max}` : ''}`);
        out[k] = n;
      } else {
        if (typeof v !== 'object' || Array.isArray(v)) throw new ToolInputError(`${k} must be an object`);
        out[k] = v;
      }
    }
    return out as T;
  };
}

function tool<I, O>(d: Omit<ToolDef<I, O>, 'inputSchema' | 'parse'> & { spec: Spec }): ToolDef<I, O> {
  const { spec, ...rest } = d;
  return { ...rest, inputSchema: schemaOf(spec), parse: parserOf<I>(spec) };
}

const actorOf = (ctx: ToolContext): Actor => ctx.actor;

// ── Owner intents (registry gate for untrusted runs): a verb plus a draft object, never a bare common verb. ──
// Option letters are capitals only (no `i` flag), so "use a warmer tone" or "take a look" never reads as a pick.

/** "Word" → "[Ww]ord": case-insensitive first letter without making the whole pattern (and its letters) insensitive. */
const ci = (w: string) => w.replace(/[a-z]/i, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`).replace(/ /g, '\\s+');
const any = (ws: readonly string[]) => `(?:${ws.map(ci).join('|')})`;
const PARTS = 'look|mechanic|hooks?|premise|contrast|name|voice|product|first\\s+product|sign-?off';

/** "pick B", "go with option C", "use sheet A". */
export const PICK_INTENT = new RegExp(`\\b${any(['pick', 'choose', 'go with', 'select', 'use', 'take'])}\\s+(?:${any(['option', 'concept', 'sheet', 'voice', 'preview'])}\\s+)?[A-E]\\b(?!['’]s)`);
/** "combine A's look with B's mechanic", "take C's hooks". */
export const MIX_INTENT = new RegExp(`\\b${any(['combine', 'mix', 'merge', 'blend', 'swap', 'take', 'use'])}\\b.*\\b[A-E]['’]s\\s+(?:${PARTS})\\b`);
/** "regenerate", "new options", "try again". */
export const REGENERATE_INTENT = new RegExp(`\\b${any(['regenerate', 'redo', 'new options', 'try again', 'more options', 'fresh options', 'fresh ideas', 'fresh concepts', 'different options', 'three more', 'new sheets'])}\\b`);
const REVISE_VERBS = ['make', 'change', 'rename', 'call', 'name', 'revise', 'edit', 'set', 'swap', 'replace', 'drop', 'remove', 'add', 'give', 'turn', 'switch', 'shorten', 'raise', 'lower', 'price', 'use', 'try'];
const DRAFT_OBJECTS = [
  'her', 'him', 'them', 'name', 'age', 'older', 'younger', 'look', 'wardrobe', 'palette', 'anchors?', 'mechanic', 'premise', 'contrast', 'hooks?', 'voice', 'tone',
  'price', 'product', 'option', 'concept', 'character', 'persona', 'catchphrases?', 'sign-?off', 'lore', 'personality', 'worldview', 'positions?', 'pillars?', 'series', 'ladder', 'handle',
  'drier', 'warmer', 'funnier', 'sharper', 'softer', 'calmer', 'bolder', 'sassier',
];
/** "make her older", "call him Otto", "change the mechanic", "set the price to $19". */
export const EDIT_INTENT = new RegExp(`\\b${any(REVISE_VERBS)}\\b.*\\b${any(DRAFT_OBJECTS)}\\b`);
/** Everything generator.revise_step does: an edit, a pick, a mix or a regenerate. */
export const REVISE_INTENT = new RegExp([EDIT_INTENT, PICK_INTENT, MIX_INTENT, REGENERATE_INTENT].map((r) => `(?:${r.source})`).join('|'));

async function draftInStudio(ctx: ToolContext, id: string): Promise<DraftRow> {
  const d = await getDraft(ctx.services.db, id);
  if (!d || d.studio_id !== ctx.studioId) throw new ToolInputError(`draft ${id} is not in this studio`);
  return d;
}

/** A compact view of a draft for the model: chosen values, option ids and the latest scores. */
export function draftSummary(d: DraftRow): Record<string, unknown> {
  const s = d.state;
  return {
    id: d.id,
    title: d.title,
    status: d.status,
    version: d.version,
    current_step: `${d.current_step} ${STEPS[d.current_step - 1]?.title ?? ''}`,
    opportunity: { options: s.opportunity.options.map((o) => `${o.id}: ${o.niche} (${o.scores.total}) ${o.angle.slice(0, 100)}`), chosen: s.opportunity.chosen?.id ?? null },
    concept: {
      options: s.concept.options.map((c) => ({ id: c.id, name: c.name, archetype: c.archetype, mechanic: c.mechanic, hooks: c.hooks, score: c.scorecard?.total })),
      chosen: s.concept.chosen ? { from: s.concept.chosenFrom, name: s.concept.chosen.name, age: s.concept.chosen.age, premise: s.concept.chosen.premise, mechanic: s.concept.chosen.mechanic, look: s.concept.chosen.lookLine, score: s.concept.chosen.scorecard?.total } : null,
    },
    character: s.character.chosen ? { name: s.character.chosen.name, age: s.character.chosen.age, personality: s.character.chosen.personality, catchphrases: s.character.chosen.catchphrases, status: s.character.status } : null,
    look: s.look.chosen ? { anchors: s.look.chosen.profile.anchors, sheets: s.look.chosen.variants.map((v) => `${v.id} (${v.provider})`), picked: s.look.chosen.chosenVariant, status: s.look.status } : null,
    voice: { options: s.voice.options.map((v) => `${v.id}: ${v.label}`), chosen: s.voice.chosen?.id ?? null },
    content: s.content.chosen ? { pillars: s.content.chosen.pillars.map((p) => p.name), entry: s.content.chosen.firstProductBrief.name, price: s.content.chosen.firstProductBrief.priceCents / 100, status: s.content.status } : null,
    review: s.review.chosen ? { scorecard: s.review.chosen.scorecard, distinctness: s.review.chosen.distinctness, ready: s.review.chosen.ready, missing: s.review.chosen.missing } : null,
  };
}

const DRAFT_ID = { type: 'string' as const, uuid: true };
const STEP = { type: 'integer' as const, min: 1, max: 7, description: '1 opportunity · 2 concept · 3 character · 4 look · 5 voice · 6 content and money · 7 review' };

export const listDraftsTool = tool<Record<string, never>, unknown>({
  name: 'generator.list_drafts',
  description: 'Persona Generator drafts in this studio (id, title, step, status, scorecard).',
  scope: 'studio',
  callers: ['studio-manager'],
  spec: {},
  run: async (ctx) => (await listDrafts(ctx.services.db, ctx.studioId)).map((d) => ({ id: d.id, title: d.title, status: d.status, step: d.current_step, score: d.scores.total ?? null })),
});

export const readDraftTool = tool<{ draft_id: string }, unknown>({
  name: 'generator.read_draft',
  description: 'One draft: every step\'s options and what the Owner chose, plus the latest scorecard and distinctness.',
  scope: 'studio',
  callers: ['studio-manager'],
  spec: { draft_id: DRAFT_ID },
  run: async (ctx, i) => draftSummary(await draftInStudio(ctx, i.draft_id)),
});

export const scoreDraftTool = tool<{ draft_id: string }, unknown>({
  name: 'generator.score_draft',
  description: 'Recomputes the win scorecard (captivation 30, demand 20, ladder 15, gap 10, producibility 15, line safety 10), distinctness against the studio and the archive, and the launch risks. Read-only.',
  scope: 'studio',
  callers: ['studio-manager'],
  spec: { draft_id: DRAFT_ID },
  run: async (ctx, i) => {
    const d = await draftInStudio(ctx, i.draft_id);
    return computeReview(ctx.services, d, d.state);
  },
});

export const reviseStepTool = tool<{ draft_id: string; step: number; instruction: string }, unknown>({
  name: 'generator.revise_step',
  description:
    'Applies the Owner\'s instruction to a draft step, e.g. "make her older and drier", "call him Otto Larkspur", "combine A\'s look with B\'s mechanic", "pick B", "regenerate". Only when the Owner asked for the change in this turn.',
  scope: 'studio',
  callers: ['studio-manager'],
  mutates: true,
  ownerIntent: REVISE_INTENT,
  spec: { draft_id: DRAFT_ID, step: STEP, instruction: { type: 'string', maxLength: 1000 } },
  run: async (ctx, i) => {
    await draftInStudio(ctx, i.draft_id);
    // In a run that carries the Owner's own message, that message is the instruction: the model picks the step, but it
    // can't put words in the Owner's mouth.
    const owner = ctx.trust?.ownerText?.trim();
    const instruction = owner ? owner.slice(0, 1000) : i.instruction;
    const r = await reviseStep(ctx.services, i.draft_id, i.step, instruction, { actor: actorOf(ctx) });
    return { changed: r.changed, summary: r.summary, version: r.draft.version, score: r.draft.scores.total ?? null };
  },
});

export const pickOptionTool = tool<{ draft_id: string; step: number; option: string }, unknown>({
  name: 'generator.pick_option',
  description: 'Picks an option on a step (A–E; a sheet on Look, a preview on Voice) and drafts the next step. Only when the Owner asked for that pick in this turn.',
  scope: 'studio',
  callers: ['studio-manager'],
  mutates: true,
  ownerIntent: PICK_INTENT,
  spec: { draft_id: DRAFT_ID, step: STEP, option: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E'] } },
  run: async (ctx, i) => {
    await draftInStudio(ctx, i.draft_id);
    const d = await chooseOption(ctx.services, i.draft_id, i.step, i.option, { actor: actorOf(ctx) });
    return { version: d.version, current_step: d.current_step };
  },
});

export const regenerateStepTool = tool<{ draft_id: string; step: number; instruction?: string }, unknown>({
  name: 'generator.regenerate_step',
  description: 'Drafts new options for a step, optionally steered by the Owner\'s instruction. Only when the Owner asked for new options in this turn.',
  scope: 'studio',
  callers: ['studio-manager'],
  mutates: true,
  ownerIntent: REGENERATE_INTENT,
  spec: { draft_id: DRAFT_ID, step: STEP, instruction: { type: 'string', optional: true, maxLength: 1000 } },
  run: async (ctx, i) => {
    await draftInStudio(ctx, i.draft_id);
    const d = await regenerateStep(ctx.services, i.draft_id, i.step, { actor: actorOf(ctx), instruction: i.instruction ?? null });
    return { version: d.version, generation: (d.state[STEPS[i.step - 1]!.key] as { generation: number }).generation };
  },
});

export const mixConceptsTool = tool<{ draft_id: string; parts: Record<string, string>; base?: string }, unknown>({
  name: 'generator.mix_concepts',
  description: `Builds a mixed concept from parts of the options, e.g. {"look": "A", "mechanic": "B"}. Parts: ${CONCEPT_PARTS.join(', ')}. Only when the Owner asked for the mix in this turn.`,
  scope: 'studio',
  callers: ['studio-manager'],
  mutates: true,
  ownerIntent: MIX_INTENT,
  spec: { draft_id: DRAFT_ID, parts: { type: 'object' }, base: { type: 'string', optional: true, enum: ['A', 'B', 'C', 'D', 'E'] } },
  run: async (ctx, i) => {
    await draftInStudio(ctx, i.draft_id);
    const parts: Partial<Record<ConceptPart, string>> = {};
    for (const [k, v] of Object.entries(i.parts)) {
      if (!(CONCEPT_PARTS as readonly string[]).includes(k) || typeof v !== 'string' || !/^[A-E]$/.test(v)) throw new ToolInputError(`bad part ${k}: ${String(v)}`);
      parts[k as ConceptPart] = v;
    }
    const d = await mixConcepts(ctx.services, i.draft_id, parts, { actor: actorOf(ctx), base: i.base });
    return { version: d.version, name: d.state.concept.chosen?.name, score: d.state.concept.chosen?.scorecard?.total ?? null };
  },
});

export const proposeArchiveTool = tool<{ persona_id: string; rationale: string }, unknown>({
  name: 'generator.propose_archive',
  description:
    'Archives a persona that never launched (PROPOSED or SETUP), or opens an Owner-only persona_archive card for one that launched (it keeps running until the Owner approves). Everything is kept and can be restored. Only when the Owner asked for it in this turn.',
  scope: 'persona',
  callers: ['studio-manager'],
  mutates: true,
  ownerIntent: /\b(?:archive|park|shelve)\b/i,
  spec: { persona_id: { type: 'string', uuid: true }, rationale: { type: 'string', maxLength: 1000 } },
  run: async (ctx, i) => {
    const r = await proposeArchive(ctx.services.db, { personaId: i.persona_id, rationale: i.rationale, proposedBy: actorOf(ctx) });
    return r.archived ? { archived: true, state: r.persona.state } : { archived: false, approval_id: r.approval.id, link: '/approvals' };
  },
});

export const launchTool = tool<{ draft_id: string }, unknown>({
  name: 'generator.launch',
  description: 'Approves a draft\'s launch (creates the persona and moves it to SETUP). Owner-only: agents can never call it.',
  scope: 'studio',
  ownerOnly: true,
  mutates: true,
  spec: { draft_id: DRAFT_ID },
  run: async (ctx, i) => {
    await draftInStudio(ctx, i.draft_id);
    const r = await launchDraft(ctx.services, i.draft_id, { actor: actorOf(ctx) });
    return { persona: r.persona, approval_id: r.approval.id };
  },
});

export const GENERATOR_TOOLS: ReadonlyArray<ToolDef<any, any>> = [
  listDraftsTool,
  readDraftTool,
  scoreDraftTool,
  reviseStepTool,
  pickOptionTool,
  regenerateStepTool,
  mixConceptsTool,
  proposeArchiveTool,
  launchTool,
];

export const CHAT_TOOLS = ['generator.read_draft', 'generator.score_draft', 'generator.revise_step', 'generator.pick_option', 'generator.regenerate_step', 'generator.mix_concepts'] as const;
