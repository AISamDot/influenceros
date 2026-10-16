import { AsyncLocalStorage } from 'node:async_hooks';
import { runAgent, STUDIO_RULES_BLOCK, type StudioServices } from '@ios/agents';
import { type Actor, BudgetExceededError } from '@ios/core';
import { listArchivedPersonas } from '@ios/core/seed';
import type { Db } from '@ios/db';
import { buildConcept, fakeCharacter, fakeConcepts, fakeContent, fakeLookProfile, fakeOpportunities, opportunityFor, sheetPrompt, type StudioMix, type VoiceBrief, voiceBriefs } from './fake';
import { ARCHETYPES, archetypeByKey, type NicheDef, nicheByKey, nicheForText, rng } from './library';
import { archiveStudioPersona, restoreStudioPersona } from './archive';
import { checkLook, lookVariants, voicePreviews } from './media';
import { computeReview } from './review';
import { archiveSignatures, distinctness, draftSignature, scoreConcept, studioSignatures } from './score';
import { commit, DraftError, getDraftVersion, insertDraft, requireDraft } from './store';
import {
  CHARACTER_FIELDS,
  type CharacterField,
  type CharacterProfile,
  type CharacterStep,
  type ConceptOption,
  type ContentPlanDraft,
  type DraftRow,
  type DraftState,
  emptyState,
  type LookProfile,
  type LookStep,
  type OpportunityOption,
  type ReviewState,
  STEPS,
  type StepKey,
  stepKey,
  type StepState,
  type VoicePreview,
} from './types';

/**
 * The generator's steps (PRD §3.12). The Studio Manager drafts options for a step (a model run in live mode, the
 * deterministic library without a key), the Owner picks, edits or mixes them, and every change is a new draft
 * version. Picking a step's option drafts the next step, so the wizard always has something to show.
 */

export interface Ctx {
  actor: Actor;
  /** The version the Owner's form was rendered from; refused if the draft has moved on. */
  expectVersion?: number;
}

// ───────────────────────────── Guards ─────────────────────────────

const held = new AsyncLocalStorage<ReadonlySet<string>>();
const queues = new Map<string, Promise<void>>();

/**
 * Runs `fn` with this process's lock on the draft: a second paid generation for the same draft (a double submit, a
 * chat turn racing a button) waits for the first and then sees its version, instead of spending and being refused.
 * Re-entrant: a step that drafts the next one inside the same call doesn't wait for itself.
 */
export async function withDraftLock<T>(draftId: string, fn: () => Promise<T>): Promise<T> {
  const mine = held.getStore();
  if (mine?.has(draftId)) return fn();
  const prev = queues.get(draftId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => gate);
  queues.set(draftId, tail);
  await prev;
  try {
    return await held.run(new Set([...(mine ?? []), draftId]), fn);
  } finally {
    release();
    if (queues.get(draftId) === tail) queues.delete(draftId);
  }
}

/** The Owner's form was rendered from an older version: refuse before any paid generation starts. */
function checkVersion(d: DraftRow, expectVersion: number | undefined): void {
  if (expectVersion !== undefined && expectVersion !== d.version) throw new DraftError('this draft changed since you opened it: reload and try again');
}

export const RESTORED_READ_ONLY = 'restored exactly from the archive: this draft is read-only (only the review runs here); edit the bible after launch';

/** A draft restored from the archive mirrors the persona's documents exactly: nothing in it changes before launch. */
export const isRestoredDraft = (d: Pick<DraftRow, 'persona_id'>): boolean => !!d.persona_id;

function assertEditable(d: DraftRow): void {
  assertActive(d);
  if (isRestoredDraft(d)) throw new DraftError(RESTORED_READ_ONLY);
}

export const GENERATOR_SYSTEM = `You are the Studio Manager co-creating a new AI influencer persona with the Owner in the Persona Generator. You recommend, score and draft; the Owner decides.
Rules: personas are openly AI characters (platform AI labels) with clearly fictional lore; never claim a degree, licence or credential; no real person's name or likeness; no fabricated results used to sell; legal and platform lines only (no cure claims, no buy/sell calls, no income guarantees). The win scorecard: captivation 30 (the premise raises a question in one second; one-line look; ownable voice, catchphrase and lore; quotable), demand and intent 20, ladder fit 15 (a $15 tool, a $35 system, a monthly reason to stay), gap 10, producibility 15 (one front-facing speaker, four sets or fewer, little motion), line safety 10. "Elder + contrast" in an unexpected niche is the strongest reach pattern; photoreal with deliberate imperfection.
Answer with one JSON object in the shape asked for. English only.`;

const GENERATOR_BLOCK = { key: 'generator:v1', text: GENERATOR_SYSTEM };

// ───────────────────────────── Context ─────────────────────────────

export async function studioMix(db: Db, studioId: string): Promise<StudioMix> {
  const rows = await db.query<{ niche: string; state: string; n: number }>(
    `SELECT lower(niche) AS niche, state, count(*)::int AS n FROM persona WHERE studio_id = $1 AND state NOT IN ('KILLED','RETIRED') GROUP BY 1, 2`,
    [studioId],
  );
  const active: Record<string, number> = {};
  const archived: Record<string, number> = {};
  for (const r of rows) {
    const bucket = r.state === 'ARCHIVED' ? archived : active;
    bucket[r.niche] = (bucket[r.niche] ?? 0) + r.n;
  }
  try {
    for (const p of listArchivedPersonas()) archived[p.niche] = (archived[p.niche] ?? 0) + 1;
  } catch {
    /* no archive on disk */
  }
  return { active, archived };
}

/** Names already used in the studio or the archive (a new concept never reuses one). */
async function takenNames(db: Db, studioId: string): Promise<string[]> {
  const rows = await db.query<{ name: string }>('SELECT name FROM persona WHERE studio_id = $1', [studioId]);
  let archived: string[] = [];
  try {
    archived = listArchivedPersonas().map((p) => p.name);
  } catch {
    archived = [];
  }
  return [...rows.map((r) => r.name), ...archived];
}

export function nicheOf(state: DraftState): NicheDef {
  const o = state.opportunity.chosen;
  return (o && nicheByKey(o.niche)) ?? nicheForText(`${o?.niche ?? ''} ${o?.angle ?? ''} ${state.seed.idea ?? ''}`);
}

const clone = <T>(v: T): T => structuredClone(v);

// ───────────────────────────── Model or library ─────────────────────────────

interface Drafted<T> {
  value: T;
  mode: 'live' | 'fake';
  note?: string;
}

/** One structured run of the Studio Manager; in fake mode (or if a live answer is unusable) the library's draft. */
async function drafted<T>(services: StudioServices, d: DraftRow, key: StepKey, prompt: string, fake: () => T, merge: (raw: unknown, fallback: T) => T): Promise<Drafted<T>> {
  try {
    const res = await runAgent(services, {
      agent: 'studio-manager',
      scope: { studioId: d.studio_id, personaId: null },
      label: `generator: ${key}`,
      tier: key === 'opportunity' || key === 'concept' ? 'strong' : 'standard',
      system: GENERATOR_SYSTEM,
      cached: [STUDIO_RULES_BLOCK, GENERATOR_BLOCK],
      prompt,
      parse: (v) => merge(v, fake()),
      jsonSchema: { type: 'object', properties: { options: { type: 'array', items: { type: 'object' } }, advice: { type: 'string' } } },
      fake: () => fake(),
      maxTokens: 4000,
      costRef: { type: 'studio', id: d.studio_id },
    });
    return { value: res.output, mode: res.mode };
  } catch (err) {
    if (err instanceof BudgetExceededError || services.runtime.mode === 'fake') throw err;
    return { value: fake(), mode: 'fake', note: `The model's draft was unusable (${err instanceof Error ? err.message.slice(0, 120) : String(err)}); drafted from the studio library instead.` };
  }
}

const str = (v: unknown, fb: string, max = 600): string => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fb);
const strs = (v: unknown, fb: string[], n = 12): string[] => (Array.isArray(v) && v.length ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, n) : fb);
const num = (v: unknown, fb: number, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : fb);
const optionsOf = (raw: unknown): Array<Record<string, unknown>> => {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).options : null;
  return Array.isArray(o) ? o.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
};

function mergeOpportunities(raw: unknown, fb: OpportunityOption[]): OpportunityOption[] {
  const got = optionsOf(raw);
  if (!got.length) return fb;
  return got.slice(0, 5).map((g, i) => {
    const base = fb[i] ?? fb[0]!;
    const s = (g.scores ?? {}) as Record<string, unknown>;
    const scores = {
      demand: num(s.demand, base.scores.demand, 0, 10),
      intent: num(s.intent, base.scores.intent, 0, 10),
      competition: num(s.competition, base.scores.competition, 0, 10),
      seasonality: num(s.seasonality, base.scores.seasonality, 0, 10),
      gap: base.scores.gap, // the studio's own data decides the gap
      total: 0,
    };
    scores.total = Math.round(scores.demand * 3 + scores.intent * 3 + scores.competition * 1.5 + scores.seasonality + scores.gap * 1.5);
    const evidence = Array.isArray(g.evidence)
      ? (g.evidence as Array<Record<string, unknown>>).slice(0, 6).map((e) => ({
          signal: (['demand', 'intent', 'competition', 'seasonality', 'gap', 'trend'].includes(String(e.signal)) ? e.signal : 'demand') as OpportunityOption['evidence'][number]['signal'],
          detail: str(e.detail, '', 300),
          flag: (['V', 'L', 'U', 'S'].includes(String(e.flag)) ? e.flag : 'U') as 'V' | 'L' | 'U' | 'S',
          ...(typeof e.source === 'string' ? { source: e.source.slice(0, 200) } : {}),
        }))
      : base.evidence;
    return {
      ...base,
      niche: str(g.niche, base.niche, 40).toLowerCase(),
      subNiche: str(g.subNiche ?? g.sub_niche, base.subNiche, 120),
      angle: str(g.angle, base.angle, 300),
      audience: str(g.audience, base.audience, 300),
      evidence: [...evidence.filter((e) => e.detail), ...base.evidence.filter((e) => e.signal === 'gap')],
      buyingMoments: strs(g.buyingMoments ?? g.buying_moments, base.buyingMoments, 6),
      risks: strs(g.risks, base.risks, 6),
      scores,
    };
  })
    .sort((a, b) => (b.ownerIdea ? 1 : 0) - (a.ownerIdea ? 1 : 0) || b.scores.total - a.scores.total)
    .map((o, i) => ({ ...o, id: 'ABCDE'[i]! }));
}

function mergeConcepts(raw: unknown, fb: ConceptOption[]): ConceptOption[] {
  const got = optionsOf(raw);
  if (!got.length) return fb;
  return fb.map((base, i) => {
    const g = got[i] ?? {};
    const fp = (g.firstProduct ?? g.first_product ?? {}) as Record<string, unknown>;
    return {
      ...base,
      name: str(g.name, base.name, 60),
      pronoun: g.pronoun === 'he' || g.pronoun === 'she' ? g.pronoun : base.pronoun,
      age: num(g.age, base.age, 18, 99),
      archetype: str(g.archetype, base.archetype, 120),
      premise: str(g.premise, base.premise),
      contrast: str(g.contrast, base.contrast),
      mechanic: str(g.mechanic, base.mechanic),
      hooks: strs(g.hooks, base.hooks, 5),
      firstProduct: { name: str(fp.name, base.firstProduct.name, 80), priceCents: num(fp.priceCents ?? fp.price_cents, base.firstProduct.priceCents, 0, 99_900), format: str(fp.format, base.firstProduct.format, 80) },
      lookLine: str(g.lookLine ?? g.look_line, base.lookLine, 160),
      voiceLine: str(g.voiceLine ?? g.voice_line, base.voiceLine, 160),
      signOff: str(g.signOff ?? g.sign_off, base.signOff, 80),
    };
  });
}

function mergeCharacter(raw: unknown, fb: CharacterStep): CharacterStep {
  const g = (optionsOf(raw)[0] ?? (raw as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  const p = (g.profile ?? g) as Record<string, unknown>;
  const b = fb.profile;
  const positions = Array.isArray(p.positions)
    ? (p.positions as Array<Record<string, unknown>>).map((x) => ({ debate: str(x.debate, '', 120), stance: str(x.stance, '', 240) })).filter((x) => x.debate && x.stance)
    : [];
  return {
    profile: {
      ...b,
      identity: str(p.identity, b.identity, 800),
      personality: strs(p.personality, b.personality, 6),
      worldview: strs(p.worldview, b.worldview, 8),
      lore: str(p.lore, b.lore, 1500),
      positions: positions.length ? positions : b.positions,
      catchphrases: strs(p.catchphrases, b.catchphrases, 3),
    },
    alternatives: fb.alternatives,
  };
}

function mergeLook(raw: unknown, fb: LookProfile): LookProfile {
  const g = (optionsOf(raw)[0] ?? (raw as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  const palette = Array.isArray(g.palette)
    ? (g.palette as Array<Record<string, unknown>>)
        .map((p) => ({ name: str(p?.name, '', 40), hex: typeof p?.hex === 'string' && /^#[0-9a-f]{6}$/i.test(p.hex) ? p.hex : '' }))
        .filter((p) => p.name && p.hex)
        .slice(0, 6)
    : [];
  return {
    ...fb,
    anchors: strs(g.anchors, fb.anchors, 4),
    wardrobe: strs(g.wardrobe, fb.wardrobe, 4),
    settings: strs(g.settings, fb.settings, 4),
    palette: palette.length >= 2 ? palette : fb.palette,
  };
}

function mergeVoiceBriefs(raw: unknown, fb: VoiceBrief[]): VoiceBrief[] {
  const got = optionsOf(raw);
  if (!got.length) return fb;
  const tail = 'Synthetic voice, never a clone of a real person.';
  return fb.map((b, i) => {
    const g = got[i] ?? {};
    const description = str(g.description, b.description, 600);
    return { id: b.id, label: str(g.label, b.label, 30), description: description.includes('never a clone') ? description : `${description.replace(/\.?$/, '.')} ${tail}` };
  });
}

function mergeContent(raw: unknown, fb: ContentPlanDraft): ContentPlanDraft {
  const g = (optionsOf(raw)[0] ?? {}) as Record<string, unknown>;
  return { ...fb, hookBank: strs(g.hookBank ?? g.hook_bank, fb.hookBank, 15) };
}

// ───────────────────────────── Generation ─────────────────────────────

function requireChosen<T>(s: StepState<any, T>, what: string): T {
  if (!s.chosen) throw new DraftError(`pick ${what} first`);
  return s.chosen;
}

/** Concept scorecards with each concept's distinctness against the studio and the archive. */
export async function scoreConcepts(services: StudioServices, d: DraftRow, concepts: ConceptOption[], opp: OpportunityOption | null): Promise<ConceptOption[]> {
  const others = [...(await studioSignatures(services.db, d.studio_id, d.persona_id)), ...archiveSignatures(d.archive_ref)];
  return concepts.map((c) => {
    const tmp = { ...emptyState(d.state.seed), opportunity: { ...d.state.opportunity, chosen: opp }, concept: { ...d.state.concept, chosen: c } } as DraftState;
    const dist = distinctness(draftSignature(tmp, d.title), others);
    // Options drafted together are scored against each other (a near-twin loses points); a lone mix or edit isn't.
    const siblings = concepts.length > 1 ? concepts.filter((x) => x !== c) : [];
    return { ...c, scorecard: scoreConcept({ concept: c, opportunity: opp, distinct: dist.score, siblings }) };
  });
}

function advise(key: StepKey, state: DraftState): string | null {
  switch (key) {
    case 'opportunity': {
      const [a, b] = [...state.opportunity.options].sort((x, y) => y.scores.total - x.scores.total);
      if (!a) return null;
      const why = (a.evidence[0]?.detail ?? '').replace(/\.?$/, '.');
      return `I'd take ${a.id}: ${a.niche} (${a.scores.total}/100). ${why}${b ? ` Runner-up: ${b.id}, ${b.niche} (${b.scores.total}).` : ''}`;
    }
    case 'concept': {
      const ranked = [...state.concept.options].sort((x, y) => (y.scorecard?.total ?? 0) - (x.scorecard?.total ?? 0));
      const top = ranked[0];
      if (!top) return null;
      const bestHook = [...state.concept.options].flatMap((c) => c.hooks.map((h) => ({ c, h }))).sort((x, y) => x.h.length - y.h.length)[0];
      const other = ranked.find((x) => x.id !== top.id);
      const tied = ranked.filter((x) => (x.scorecard?.total ?? 0) === (top.scorecard?.total ?? 0)).map((x) => x.id);
      const lead =
        tied.length > 1
          ? `${tied.join(' and ')} tie at ${top.scorecard?.total ?? '?'}/100: the scorecard can't split them, so pick on the premise you like best.`
          : `${top.id} leads at ${top.scorecard?.total ?? '?'}/100 (captivation ${top.scorecard?.captivation ?? '?'}/30${other?.scorecard ? `; next ${other.id} at ${other.scorecard.total}` : ''}).`;
      return `${lead}${bestHook ? ` Most quotable hook: ${bestHook.c.id}'s "${bestHook.h.replace(/[.!?]$/, '')}".` : ''}${other ? ` Mix them if you like, e.g. "combine ${other.id}'s look with ${top.id}'s mechanic".` : ''}`;
    }
    case 'character':
      return 'Swap any field for an alternative, or tell me what to change ("make her older and drier").';
    case 'look':
      return state.look.options[0]?.variants[0]?.provider === 'higgsfield'
        ? 'Pick the sheet whose face you want to keep; I run a drift check on it.'
        : 'Placeholder sheets (no Higgsfield key): pick the wardrobe direction; the real character sheet is generated once Higgsfield is connected.';
    case 'voice':
      return `A matches the concept's voice line; B and C are variations (${state.voice.options.slice(1).map((v) => v.label.toLowerCase()).join(', ')}).${state.voice.options[0]?.fake ? ' Previews are fake audio until ElevenLabs is connected.' : ''}`;
    case 'content': {
      const c = state.content.options[0];
      return c ? `Entry product at $${(c.firstProductBrief.priceCents / 100).toFixed(0)} sits in the $9–19 band; the ladder climbs to a $${((c.ladder.find((x) => x.rung === 'core_bundle')?.priceCents ?? 0) / 100).toFixed(0)} system and a membership.` : null;
    }
    case 'review':
      return null;
  }
}

/** (Re)drafts the options of one step from the steps before it. Returns the new state. */
async function generate(services: StudioServices, d: DraftRow, key: StepKey, instruction?: string | null): Promise<{ state: DraftState; note?: string }> {
  const state = clone(d.state);
  const note = (n?: string) => (n ? { note: n } : {});
  const ask = instruction ? `\nThe Owner asks: ${instruction.slice(0, 500)}` : '';
  switch (key) {
    case 'opportunity': {
      const gen = state.opportunity.generation + 1;
      const mix = await studioMix(services.db, d.studio_id);
      const r = await drafted(
        services,
        d,
        key,
        `Rank 4 niche-and-angle opportunities for the next persona${state.seed.idea ? `, the first being the Owner's own idea: "${state.seed.idea}"` : ''}. Studio personas per niche: ${JSON.stringify(mix.active)}; archived: ${JSON.stringify(mix.archived)}. Each option: niche, subNiche, angle, audience, evidence [{signal, detail, flag V|L|U, source}], buyingMoments, risks, scores {demand, intent, competition (10 = open), seasonality} 0–10.${ask}\nReturn {"options": [...], "advice": "..."}.`,
        () => fakeOpportunities({ draftId: d.id, generation: gen, idea: state.seed.idea, mix }),
        mergeOpportunities,
      );
      state.opportunity = { ...state.opportunity, status: 'ready', generation: gen, options: r.value, instruction: instruction ?? null };
      state.opportunity.advice = advise(key, state);
      return { state, ...note(r.note) };
    }
    case 'concept': {
      const opp = requireChosen(state.opportunity, 'an opportunity');
      const gen = state.concept.generation + 1;
      const avoid = await takenNames(services.db, d.studio_id);
      const r = await drafted(
        services,
        d,
        key,
        `Opportunity: ${JSON.stringify(opp)}. Draft 3 distinct concepts (different archetypes, names and mechanics). Avoid these names: ${avoid.join(', ') || 'none'}. Each: name, pronoun, age, archetype (one line), premise, contrast, mechanic ("Name: what it does"), hooks (5, under 10 words), firstProduct {name, priceCents, format}, lookLine, voiceLine, signOff.${ask}\nReturn {"options": [...], "advice": "..."}.`,
        () => fakeConcepts({ draftId: d.id, generation: gen, opportunity: opp, avoidNames: avoid }),
        mergeConcepts,
      );
      state.concept = { ...state.concept, status: 'ready', generation: gen, options: await scoreConcepts(services, d, r.value, opp), instruction: instruction ?? null };
      state.concept.advice = advise(key, state);
      return { state, ...note(r.note) };
    }
    case 'character': {
      const concept = requireChosen(state.concept, 'a concept');
      const gen = state.character.generation + 1;
      const niche = nicheOf(state);
      const r = await drafted(
        services,
        d,
        key,
        `Concept: ${JSON.stringify(concept)}. Niche: ${niche.key} (${niche.subNiche}). Draft the character: identity (an openly AI, clearly fictional character; no credentials), personality (4 traits), worldview (5 principles), lore (backstory + a running storyline), positions [{debate, stance}] on the field's key debates, catchphrases (2).${ask}\nReturn {"options": [{"profile": {...}}]}.`,
        () => fakeCharacter({ draftId: d.id, generation: gen, concept, niche }),
        mergeCharacter,
      );
      state.character = { ...state.character, status: 'ready', generation: gen, options: [r.value], chosen: clone(r.value.profile), chosenFrom: 'A', instruction: instruction ?? null };
      state.character.advice = advise(key, state);
      return { state, ...note(r.note) };
    }
    case 'look': {
      const concept = requireChosen(state.concept, 'a concept');
      const gen = state.look.generation + 1;
      const steer = { instruction: instruction ?? null, generation: gen };
      let profile: LookProfile | undefined;
      let n: string | undefined;
      if (instruction) {
        // The Owner's steer rewrites the look profile (the model with a key; the library folds it in without one).
        const fb = fakeLookProfile(concept, state.character.chosen, steer);
        const r = await drafted(
          services,
          d,
          key,
          `Look profile: ${JSON.stringify({ anchors: fb.anchors, wardrobe: fb.wardrobe, palette: fb.palette, settings: fb.settings })}. Concept: ${concept.name}, ${concept.archetype}.${ask}\nRewrite the anchors (3), wardrobe (3), palette (4, each {name, hex}) and settings (3 or fewer) to follow the Owner's ask. Photoreal, one person, no real person's likeness.\nReturn {"options": [{"anchors": [...], "wardrobe": [...], "palette": [...], "settings": [...]}]}.`,
          () => fb,
          mergeLook,
        );
        profile = r.value;
        n = r.note;
      }
      const look = await lookVariants(services, { studioId: d.studio_id, concept, character: state.character.chosen, steer, profile });
      state.look = { ...state.look, status: 'ready', generation: gen, options: [look], chosen: clone(look), chosenFrom: 'A', instruction: instruction ?? null };
      state.look.advice = advise(key, state);
      return { state, ...note(n) };
    }
    case 'voice': {
      const concept = requireChosen(state.concept, 'a concept');
      const gen = state.voice.generation + 1;
      const steer = { instruction: instruction ?? null, generation: gen };
      let briefs: VoiceBrief[] | undefined;
      let n: string | undefined;
      if (instruction) {
        const fb = voiceBriefs(concept, steer);
        const r = await drafted(
          services,
          d,
          key,
          `Voice briefs for ${concept.name} (${concept.archetype}; voice line: ${concept.voiceLine}): ${JSON.stringify(fb)}.${ask}\nRewrite the three voice-design descriptions (A follows the ask most closely; B and C are variations on it). Synthetic voices only: never a real person's voice.\nReturn {"options": [{"label": "...", "description": "..."}, ...]}.`,
          () => fb,
          mergeVoiceBriefs,
        );
        briefs = r.value;
        n = r.note;
      }
      const previews = await voicePreviews(services, { studioId: d.studio_id, concept, steer, briefs });
      state.voice = { ...state.voice, status: 'ready', generation: gen, options: previews, chosen: null, chosenFrom: null, instruction: instruction ?? null };
      state.voice.advice = advise(key, state);
      return { state, ...note(n) };
    }
    case 'content': {
      const concept = requireChosen(state.concept, 'a concept');
      const gen = state.content.generation + 1;
      const niche = nicheOf(state);
      const r = await drafted(
        services,
        d,
        key,
        `Concept: ${JSON.stringify(concept)}. Character: ${JSON.stringify(state.character.chosen)}. Draft a hook bank of 12 hooks (under 10 words each, no results claims, no credentials).${ask}\nReturn {"options": [{"hookBank": [...]}]}.`,
        () => fakeContent({ draftId: d.id, generation: gen, concept, character: state.character.chosen, niche }),
        mergeContent,
      );
      state.content = { ...state.content, status: 'ready', generation: gen, options: [r.value], chosen: clone(r.value), chosenFrom: 'A', instruction: instruction ?? null };
      state.content.advice = advise(key, state);
      return { state, ...note(r.note) };
    }
    case 'review': {
      const review = await computeReview(services, d, state);
      state.review = { ...state.review, status: 'ready', generation: state.review.generation + 1, options: [review], chosen: review, chosenFrom: 'A' };
      return { state };
    }
  }
}

const ORDER: StepKey[] = STEPS.map((s) => s.key);

/** Later steps that were done become stale (kept, flagged); the review is always recomputed. */
function markDownstream(state: DraftState, key: StepKey): void {
  for (const k of ORDER.slice(ORDER.indexOf(key) + 1)) {
    const s = state[k] as StepState<unknown, unknown>;
    if (k === 'review') continue;
    if (s.status === 'done' || s.status === 'ready') s.status = s.chosen || s.options.length ? 'stale' : s.status;
  }
}

async function withReview(services: StudioServices, d: DraftRow, state: DraftState): Promise<{ state: DraftState; scores: DraftRow['scores'] }> {
  if (!state.concept.chosen) return { state, scores: d.scores };
  const review = await computeReview(services, d, state);
  state.review = { ...state.review, status: state.review.status === 'empty' ? 'empty' : 'ready', options: [review], chosen: review, chosenFrom: 'A', generation: state.review.generation };
  return { state, scores: { ...review.scorecard, distinctness: review.distinctness.score } };
}

// ───────────────────────────── Public operations ─────────────────────────────

export async function createDraft(services: StudioServices, input: { studioId: string; idea?: string | null; actor: Actor }): Promise<DraftRow> {
  const idea = input.idea?.trim() ? input.idea.trim().slice(0, 600) : null;
  const d = await insertDraft(services.db, {
    studioId: input.studioId,
    title: idea ? `Idea: ${idea.slice(0, 60)}` : 'New persona',
    seed: { mode: idea ? 'owner_idea' : 'recommend', idea },
    source: idea ? 'owner_idea' : 'generator',
    actor: input.actor,
  });
  return regenerateStep(services, d.id, 1, { actor: input.actor });
}

export async function regenerateStep(services: StudioServices, draftId: string, step: number, ctx: Ctx & { instruction?: string | null }): Promise<DraftRow> {
  return withDraftLock(draftId, async () => {
    const key = stepKey(step);
    const d = await requireDraft(services.db, draftId);
    if (key === 'review') assertActive(d);
    else assertEditable(d);
    checkVersion(d, ctx.expectVersion);
    const { state, note } = await generate(services, d, key, ctx.instruction);
    if (note) state[key].advice = `${state[key].advice ?? ''} ${note}`.trim();
    if (key !== 'review') markDownstream(state, key);
    const reviewed = await withReview(services, d, state);
    return commit(services.db, draftId, { step, change: `${key}: ${state[key].generation > 1 ? 'regenerated' : 'drafted'}${ctx.instruction ? ` ("${ctx.instruction.slice(0, 80)}")` : ''}`, actor: ctx.actor, expectVersion: ctx.expectVersion ?? d.version }, async () => ({
      ...reviewed,
      currentStep: step,
    }));
  });
}

function assertActive(d: DraftRow): void {
  if (d.status !== 'active') throw new DraftError(`this draft is ${d.status}`);
}

/** Picks an option of a step (or confirms the drafted one on single-option steps), then drafts the next step. */
export async function chooseOption(services: StudioServices, draftId: string, step: number, optionId: string, ctx: Ctx): Promise<DraftRow> {
  return withDraftLock(draftId, async () => {
    const key = stepKey(step);
    if (key === 'review') throw new DraftError('the review has nothing to pick: approve the launch instead');
    let d = await requireDraft(services.db, draftId);
    assertEditable(d);
    checkVersion(d, ctx.expectVersion);
    const state = clone(d.state);
    const s = state[key] as StepState<any, any>;
    if (key === 'look') {
      const look = (s.chosen ?? s.options[0]) as LookStep | undefined;
      if (!look) throw new DraftError('no character sheets yet');
      if (!look.variants.some((v) => v.id === optionId)) throw new DraftError(`no sheet ${optionId}`);
      const review = await computeReview(services, d, state);
      const check = await checkLook(services, { studioId: d.studio_id, look, variantId: optionId, textDistinct: { score: review.distinctness.score, nearest: review.distinctness.nearest[0]?.name ?? null } });
      s.chosen = { ...clone(look), chosenVariant: optionId, check };
      s.chosenFrom = optionId;
    } else if (key === 'character' || key === 'content') {
      if (!s.chosen) s.chosen = clone(key === 'character' ? (s.options[0] as CharacterStep).profile : s.options[0]);
      s.chosenFrom = s.chosenFrom ?? 'A';
    } else if (optionId === 'current') {
      // Confirms what is already chosen (a mix or the Owner's edit): nothing to replace.
      if (!s.chosen) throw new DraftError(`nothing chosen on ${key} yet`);
    } else {
      const opt = (s.options as Array<{ id: string }>).find((o) => o.id === optionId);
      if (!opt) throw new DraftError(`no option ${optionId} on ${key}`);
      const changed = s.chosenFrom !== optionId;
      s.chosen = clone(opt);
      s.chosenFrom = optionId;
      if (changed) markDownstream(state, key);
    }
    s.status = 'done';
    const nextKey = ORDER[ORDER.indexOf(key) + 1]!;
    const reviewed = await withReview(services, d, state);
    d = await commit(services.db, draftId, { step, change: `${key}: ${optionId === 'current' ? `confirmed ${s.chosenFrom ?? ''}`.trim() : `picked ${optionId}`}`, actor: ctx.actor, expectVersion: ctx.expectVersion ?? d.version }, async () => ({
      ...reviewed,
      currentStep: Math.max(step + 1, 1),
      title: key === 'concept' ? (s.chosen as ConceptOption).name : key === 'character' ? (s.chosen as CharacterProfile).name : undefined,
    }));
    // Draft the next step when it is empty or out of date.
    const next = d.state[nextKey] as StepState<unknown, unknown>;
    if (nextKey === 'review' || next.status === 'empty' || next.status === 'stale') return regenerateStep(services, draftId, step + 1, { actor: ctx.actor });
    return d;
  });
}

/**
 * "Keep as is" on a stale step: the Owner confirms that what was drafted before an earlier change still holds. The
 * review blocks the launch until every stale step is regenerated or kept.
 */
export async function keepStep(services: StudioServices, draftId: string, step: number, ctx: Ctx): Promise<DraftRow> {
  const key = stepKey(step);
  if (!(['character', 'look', 'voice', 'content'] as StepKey[]).includes(key)) throw new DraftError(`nothing to keep on ${key}`);
  const d = await requireDraft(services.db, draftId);
  assertEditable(d);
  checkVersion(d, ctx.expectVersion);
  const state = clone(d.state);
  const s = state[key] as StepState<unknown, unknown>;
  if (s.status !== 'stale') throw new DraftError(`${key} is not out of date`);
  if (!s.chosen) throw new DraftError(key === 'voice' ? 'pick a voice first (or draft three more)' : `nothing chosen on ${key} to keep`);
  s.status = 'done';
  const reviewed = await withReview(services, d, state);
  return commit(services.db, draftId, { step, change: `${key}: kept as is`, actor: ctx.actor, expectVersion: ctx.expectVersion ?? d.version }, async () => reviewed);
}

/** The Owner's own idea as an option on step 1 (replacing an earlier one), ranked with the evidence like the others. */
export async function addOwnerIdea(services: StudioServices, draftId: string, idea: string, ctx: Ctx): Promise<DraftRow> {
  const text = idea.trim().slice(0, 600);
  if (text.length < 4) throw new DraftError('describe your idea in a few words');
  const d = await requireDraft(services.db, draftId);
  assertEditable(d);
  checkVersion(d, ctx.expectVersion);
  const state = clone(d.state);
  const mix = await studioMix(services.db, d.studio_id);
  const opt = opportunityFor(nicheForText(text), mix, rng(`${d.id}:idea:${text}`), text.slice(0, 240), true);
  let options = state.opportunity.options.filter((o) => !o.ownerIdea);
  const used = new Set(options.map((o) => o.id));
  let letter = ['A', 'B', 'C', 'D', 'E'].find((l) => !used.has(l));
  if (!letter) {
    // Five options already: the idea takes the place of the lowest-scored one that isn't picked.
    const drop = [...options].filter((o) => o.id !== state.opportunity.chosen?.id).sort((a, b) => a.scores.total - b.scores.total)[0]!;
    options = options.filter((o) => o !== drop);
    letter = drop.id;
  }
  state.opportunity.options = [{ ...opt, id: letter }, ...options];
  state.opportunity.status = state.opportunity.chosen ? state.opportunity.status : 'ready';
  state.opportunity.advice = advise('opportunity', state);
  state.seed = { ...state.seed, mode: 'owner_idea', idea: text };
  return commit(services.db, draftId, { step: 1, change: `opportunity: added your idea as ${letter}`, actor: ctx.actor, expectVersion: ctx.expectVersion ?? d.version }, async () => ({ state, currentStep: 1 }));
}

/** The launch date (first posts) and timezone shown on step 7. */
export async function setLaunchPlan(services: StudioServices, draftId: string, plan: { launchDate: string; timezone: string }, ctx: Ctx): Promise<DraftRow> {
  const d = await requireDraft(services.db, draftId);
  assertEditable(d);
  checkVersion(d, ctx.expectVersion);
  const date = plan.launchDate.trim();
  const tz = plan.timezone.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new DraftError('the launch date must look like 2026-11-02');
  const today = services.now().toISOString().slice(0, 10);
  if (date <= today) throw new DraftError('the launch date must be after today');
  if (Date.parse(`${date}T00:00:00Z`) - services.now().getTime() > 366 * 86_400_000) throw new DraftError('the launch date must be within a year');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
  } catch {
    throw new DraftError(`unknown timezone ${tz} (use one like America/New_York or Europe/London)`);
  }
  const state = clone(d.state);
  const base: ReviewState = state.review.chosen ?? (await computeReview(services, d, state));
  state.review = { ...state.review, chosen: { ...base, launchDate: date, timezone: tz } };
  state.seed = { ...state.seed, launchDate: date, timezone: tz };
  const reviewed = await withReview(services, d, state);
  return commit(services.db, draftId, { step: 7, change: `launch plan: first posts ${date} (${tz})`, actor: ctx.actor, expectVersion: ctx.expectVersion ?? d.version }, async () => reviewed);
}

/** Makes an earlier version the current one again (a new version, so nothing is lost). */
export async function restoreVersion(services: StudioServices, draftId: string, version: number, ctx: Ctx): Promise<DraftRow> {
  const d = await requireDraft(services.db, draftId);
  assertEditable(d);
  checkVersion(d, ctx.expectVersion);
  if (!Number.isInteger(version) || version < 1 || version >= d.version) throw new DraftError(`no earlier version ${version}`);
  const v = await getDraftVersion(services.db, draftId, version);
  if (!v) throw new DraftError(`no version ${version}`);
  const state = clone(v.state);
  const reviewed = await withReview(services, d, state);
  const title = state.character.chosen?.name ?? state.concept.chosen?.name ?? d.title;
  return commit(services.db, draftId, { step: v.step, change: `restored v${version} (${v.change.slice(0, 80)})`, actor: ctx.actor, expectVersion: ctx.expectVersion ?? d.version }, async () => ({ ...reviewed, title }));
}

/** The Owner's own edit to a step's chosen value (form fields). */
export async function editChosen(services: StudioServices, draftId: string, step: number, patch: Record<string, unknown>, ctx: Ctx): Promise<DraftRow> {
  const key = stepKey(step);
  const d = await requireDraft(services.db, draftId);
  assertEditable(d);
  checkVersion(d, ctx.expectVersion);
  const state = clone(d.state);
  const s = state[key] as StepState<any, any>;
  if (!s.chosen && key !== 'concept' && key !== 'opportunity') throw new DraftError(`nothing to edit on ${key} yet`);
  const base = (key === 'opportunity' && patch.id ? (s.options as Array<{ id: string }>).find((o) => o.id === patch.id) : null) ?? s.chosen ?? (s.options as Array<{ id: string }>).find((o) => o.id === patch.id) ?? s.options[0];
  if (!base) throw new DraftError(`nothing to edit on ${key} yet`);
  const clean = sanitizePatch(key, patch);
  if (!Object.keys(clean).length) throw new DraftError('nothing to change');
  const next = applyPatch(key, clone(base), clean, state);
  if (key === 'concept') (next as ConceptOption).scorecard = scoreConcept({ concept: next as ConceptOption, opportunity: state.opportunity.chosen });
  s.chosen = next;
  s.chosenFrom = 'owner';
  s.status = 'done';
  markDownstream(state, key);
  const reviewed = await withReview(services, d, state);
  const title = key === 'concept' || key === 'character' ? ((next as { name?: string }).name ?? d.title) : undefined;
  return commit(services.db, draftId, { step, change: `${key}: edited (${Object.keys(clean).join(', ')})`, actor: ctx.actor, expectVersion: ctx.expectVersion ?? d.version }, async () => ({ ...reviewed, ...(title ? { title } : {}) }));
}

type PatchKind = 'string' | 'number' | 'list' | 'price' | 'positions' | 'pairs' | 'palette' | 'series';

const RUNGS = ['lead_magnet', 'entry', 'addon', 'core_bundle', 'upsell', 'membership'] as const;

export const PATCHABLE: Partial<Record<StepKey, Record<string, PatchKind>>> = {
  opportunity: { angle: 'string', audience: 'string', subNiche: 'string' },
  concept: {
    name: 'string',
    age: 'number',
    archetype: 'string',
    premise: 'string',
    contrast: 'string',
    mechanic: 'string',
    hooks: 'list',
    lookLine: 'string',
    voiceLine: 'string',
    signOff: 'string',
    firstProductName: 'string',
    firstProductPrice: 'price',
    firstProductFormat: 'string',
  },
  character: { name: 'string', age: 'number', homeBase: 'string', handle: 'string', identity: 'string', lore: 'string', personality: 'list', worldview: 'list', catchphrases: 'list', positions: 'positions' },
  look: { anchors: 'list', wardrobe: 'list', settings: 'list', palette: 'palette' },
  content: {
    hookBank: 'list',
    ctaKeywords: 'list',
    pillars: 'pairs',
    series: 'series',
    briefName: 'string',
    briefPromise: 'string',
    briefFormat: 'string',
    briefPrice: 'price',
    briefKeyword: 'string',
    briefSections: 'list',
    ...Object.fromEntries(RUNGS.flatMap((r) => [[`ladder_${r}_name`, 'string'], [`ladder_${r}_price`, 'price']])),
  },
};

const lines = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : String(v).split('\n')).map((x) => x.trim()).filter(Boolean);

function sanitizePatch(key: StepKey, patch: Record<string, unknown>): Record<string, unknown> {
  const allowed = PATCHABLE[key] ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, kind] of Object.entries(allowed)) {
    const v = patch[k];
    if (v === undefined) continue;
    switch (kind) {
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 18 || n > 99) throw new DraftError(`${k} must be a number between 18 and 99`);
        out[k] = Math.round(n);
        break;
      }
      case 'price': {
        const n = Number(String(v).replace(/[$,\s]/g, ''));
        if (!Number.isFinite(n) || n < 0 || n > 999) throw new DraftError(`${k} must be a price in dollars, 0 to 999`);
        out[k] = Math.round(n * 100);
        break;
      }
      case 'list':
        out[k] = lines(v).slice(0, 20).map((x) => x.slice(0, 240));
        break;
      case 'positions':
      case 'pairs': {
        const rows = lines(v).slice(0, 12).map((x) => {
          const i = x.search(/[:—–]/);
          return i > 0 ? [x.slice(0, i).trim(), x.slice(i + 1).trim()] : [x, ''];
        });
        if (kind === 'positions') {
          if (rows.some(([, b]) => !b)) throw new DraftError('write each position as "debate: stance"');
          out[k] = rows.map(([debate, stance]) => ({ debate: debate!.slice(0, 120), stance: stance!.slice(0, 240) }));
        } else out[k] = rows.map(([name, why]) => ({ name: name!.slice(0, 80), why: why!.slice(0, 240) }));
        break;
      }
      case 'palette': {
        const rows = lines(v).slice(0, 6).map((x) => {
          const m = /^(.*?)\s*(#[0-9a-f]{6})\s*$/i.exec(x);
          if (!m) throw new DraftError(`write each colour as "Name #RRGGBB" (got "${x.slice(0, 40)}")`);
          return { name: (m[1] || m[2]!).trim().slice(0, 40), hex: m[2]!.toUpperCase() };
        });
        if (rows.length < 2) throw new DraftError('a palette needs at least two colours');
        out[k] = rows;
        break;
      }
      case 'series': {
        out[k] = lines(v)
          .slice(0, 6)
          .map((x) => {
            const [name = '', format = 'talking', cadence = '1 a week', pillar = ''] = x.split('|').map((y) => y.trim());
            if (!name) throw new DraftError('write each series as "name | format | cadence | pillar"');
            return { name: name.slice(0, 80), format: format.slice(0, 40), cadence: cadence.slice(0, 40), pillar: pillar.slice(0, 80) };
          });
        break;
      }
      default: {
        const t = String(v).trim();
        if (!t) throw new DraftError(`${k} can't be empty`);
        out[k] = t.slice(0, 1500);
      }
    }
  }
  if (key === 'character' && typeof out.age === 'number') out.ageRange = `${(out.age as number) - 3}–${(out.age as number) + 3}`;
  return out;
}

/** Applies a sanitised patch to a step's value (the fields that live in nested objects are mapped here). */
function applyPatch(key: StepKey, base: any, p: Record<string, unknown>, state: DraftState): any {
  const take = (k: string) => {
    const v = p[k];
    delete p[k];
    return v;
  };
  if (key === 'concept') {
    const name = take('firstProductName') as string | undefined;
    const price = take('firstProductPrice') as number | undefined;
    const format = take('firstProductFormat') as string | undefined;
    const next = { ...base, ...p } as ConceptOption;
    if (name !== undefined || price !== undefined || format !== undefined) next.firstProduct = { ...base.firstProduct, ...(name !== undefined ? { name } : {}), ...(price !== undefined ? { priceCents: price } : {}), ...(format !== undefined ? { format } : {}) };
    return next;
  }
  if (key === 'look') {
    const look = base as LookStep;
    const profile = { ...look.profile, ...p } as LookProfile;
    const name = state.character.chosen?.name ?? state.concept.chosen?.name ?? '';
    const age = state.character.chosen?.age ?? state.concept.chosen?.age ?? 60;
    // The sheet prompts follow the edited profile (placeholders now; the real sheets on the next generation).
    return { ...look, profile, variants: look.variants.map((v, i) => ({ ...v, prompt: sheetPrompt(name, age, profile, i) })) };
  }
  if (key === 'content') {
    const c = base as ContentPlanDraft;
    const brief = { ...c.firstProductBrief };
    const got: Record<string, unknown> = {};
    for (const [k, f] of [['briefName', 'name'], ['briefPromise', 'promise'], ['briefFormat', 'format'], ['briefPrice', 'priceCents'], ['briefKeyword', 'keyword'], ['briefSections', 'sections']] as const) {
      const v = take(k);
      if (v !== undefined) (brief as Record<string, unknown>)[f] = got[f] = v;
    }
    let ladder = c.ladder.map((r) => ({ ...r }));
    const rung: Record<string, { name?: string; price?: number }> = {};
    for (const r of RUNGS) {
      const nm = take(`ladder_${r}_name`) as string | undefined;
      const pr = take(`ladder_${r}_price`) as number | undefined;
      if (nm === undefined && pr === undefined) continue;
      rung[r] = { name: nm, price: pr };
      const row = ladder.find((x) => x.rung === r);
      if (row) {
        if (nm !== undefined) row.name = nm;
        if (pr !== undefined) row.priceCents = pr;
      } else if (nm) ladder = [...ladder, { rung: r, name: nm, priceCents: pr ?? 0, when: 'Later' }];
    }
    // The first product brief is the entry rung: an edit to either one moves both (the brief wins if both changed).
    const entry = ladder.find((x) => x.rung === 'entry');
    if (entry) {
      if (got.name !== undefined) entry.name = brief.name;
      else if (rung.entry?.name !== undefined) brief.name = entry.name;
      if (got.priceCents !== undefined) entry.priceCents = brief.priceCents;
      else if (rung.entry?.price !== undefined) brief.priceCents = entry.priceCents;
    }
    const kw = (x: string) => x.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
    const keywords = (p.ctaKeywords as string[] | undefined)?.map(kw).filter(Boolean);
    return { ...c, ...p, ...(keywords ? { ctaKeywords: keywords } : {}), ladder, firstProductBrief: { ...brief, keyword: kw(brief.keyword) || c.firstProductBrief.keyword } };
  }
  return { ...base, ...p };
}

/** Swaps one character field for one of its alternatives. */
export async function pickAlternative(services: StudioServices, draftId: string, field: CharacterField, index: number, ctx: Ctx): Promise<DraftRow> {
  if (!CHARACTER_FIELDS.includes(field)) throw new DraftError(`unknown field ${field}`);
  const d = await requireDraft(services.db, draftId);
  assertEditable(d);
  checkVersion(d, ctx.expectVersion);
  const state = clone(d.state);
  const opt = state.character.options[0];
  const alt = opt?.alternatives[field]?.[index];
  if (!opt || alt === undefined) throw new DraftError(`no alternative ${index + 1} for ${field}`);
  const profile = clone(state.character.chosen ?? opt.profile);
  const prev = profile[field];
  // Keep the swapped-out value as an alternative, so a swap can be undone.
  opt.alternatives[field] = [...(opt.alternatives[field] ?? []).filter((_, i) => i !== index), prev];
  if (field === 'name') {
    state.character.chosen = profile;
    renameEverywhere(state, String(prev), String(alt));
  } else {
    (profile as unknown as Record<string, unknown>)[field] = clone(alt);
    state.character.chosen = profile;
  }
  state.character.chosenFrom = 'owner';
  markDownstream(state, 'character');
  const reviewed = await withReview(services, d, state);
  return commit(services.db, draftId, { step: 3, change: `character: ${field} swapped`, actor: ctx.actor, expectVersion: ctx.expectVersion ?? d.version }, async () => ({
    ...reviewed,
    ...(field === 'name' ? { title: state.character.chosen?.name ?? d.title } : {}),
  }));
}

export const CONCEPT_PARTS = ['name', 'premise', 'contrast', 'mechanic', 'hooks', 'look', 'voice', 'product', 'signOff'] as const;
export type ConceptPart = (typeof CONCEPT_PARTS)[number];

/** Mixes concept parts from different options ("A's look with B's mechanic") into a chosen concept 'M'. */
export async function mixConcepts(services: StudioServices, draftId: string, parts: Partial<Record<ConceptPart, string>>, ctx: Ctx & { base?: string }): Promise<DraftRow> {
  const d = await requireDraft(services.db, draftId);
  assertEditable(d);
  checkVersion(d, ctx.expectVersion);
  const state = clone(d.state);
  const opts = state.concept.options;
  const find = (id: string) => {
    const o = opts.find((x) => x.id === id.toUpperCase());
    if (!o) throw new DraftError(`no concept ${id}`);
    return o;
  };
  const entries = Object.entries(parts).filter(([k, v]) => v && (CONCEPT_PARTS as readonly string[]).includes(k)) as Array<[ConceptPart, string]>;
  if (!entries.length) throw new DraftError('say which parts to take from which concept');
  const baseId = ctx.base ?? parts.premise ?? (state.concept.chosen && state.concept.chosenFrom !== 'M' ? state.concept.chosenFrom : null) ?? parts.mechanic ?? entries[0]![1];
  const base = state.concept.chosen && ctx.base === undefined && !parts.premise && state.concept.chosenFrom === 'M' ? clone(state.concept.chosen) : clone(find(baseId!));
  for (const [part, id] of entries) {
    const src = find(id);
    switch (part) {
      case 'name': {
        const old = base.name;
        base.name = src.name;
        base.pronoun = src.pronoun;
        base.premise = base.premise.split(old).join(src.name);
        break;
      }
      case 'premise':
        base.premise = src.premise;
        base.archetype = src.archetype;
        base.age = src.age;
        base.archetypeKey = src.archetypeKey;
        break;
      case 'contrast':
        base.contrast = src.contrast;
        break;
      case 'mechanic':
        base.mechanic = src.mechanic;
        break;
      case 'hooks':
        base.hooks = [...src.hooks];
        break;
      case 'look':
        base.lookLine = src.lookLine;
        base.lookKey = src.lookKey ?? src.archetypeKey;
        break;
      case 'voice':
        base.voiceLine = src.voiceLine;
        break;
      case 'product':
        base.firstProduct = { ...src.firstProduct };
        break;
      case 'signOff':
        base.signOff = src.signOff;
        break;
    }
  }
  base.id = 'M';
  const [scored] = await scoreConcepts(services, d, [base], state.opportunity.chosen);
  state.concept.chosen = scored!;
  state.concept.chosenFrom = 'M';
  state.concept.status = 'done';
  markDownstream(state, 'concept');
  const label = entries.map(([p, id]) => `${id}'s ${p}`).join(' + ');
  const reviewed = await withReview(services, d, state);
  const row = await commit(services.db, draftId, { step: 2, change: `concept: mixed ${label} (base ${baseId})`, actor: ctx.actor, expectVersion: ctx.expectVersion ?? d.version }, async () => ({
    ...reviewed,
    title: scored!.name,
    currentStep: Math.max(d.current_step, 2),
  }));
  return row;
}

export async function goToStep(services: StudioServices, draftId: string, step: number, ctx: Ctx): Promise<DraftRow> {
  const key = stepKey(step);
  const d = await requireDraft(services.db, draftId);
  // Steps open in order: a step needs the one before it to have something chosen.
  const prev = ORDER[ORDER.indexOf(key) - 1];
  if (prev && !(d.state[prev] as StepState<unknown, unknown>).chosen && !(prev === 'voice' && d.state.voice.options.length)) {
    throw new DraftError(`finish ${prev} first`);
  }
  if (d.current_step === step && (d.state[key] as StepState<unknown, unknown>).status !== 'empty') return d;
  if ((d.state[key] as StepState<unknown, unknown>).status === 'empty' && d.status === 'active') return regenerateStep(services, draftId, step, ctx);
  return commit(services.db, draftId, { step, change: `opened ${key}`, actor: ctx.actor }, async (cur) => ({ state: cur.state, currentStep: step }));
}

/**
 * Archives a draft. A review draft of a persona that is still PROPOSED (restored from the archive, never launched) is
 * archived together with its persona, so the persona never sits on the wall with no way back to its review.
 */
export async function archiveDraft(services: StudioServices, draftId: string, ctx: Ctx): Promise<DraftRow> {
  const d = await requireDraft(services.db, draftId);
  if (d.status !== 'active') throw new DraftError(`this draft is ${d.status}`);
  if (d.persona_id) {
    const p = await services.db.maybeOne<{ state: string }>('SELECT state FROM persona WHERE id = $1', [d.persona_id]);
    if (p?.state === 'PROPOSED') {
      await archiveStudioPersona(services, { personaId: d.persona_id, actor: ctx.actor, reason: 'archived with its review draft' });
      return requireDraft(services.db, draftId);
    }
  }
  return commit(services.db, draftId, { step: 0, change: 'archived', actor: ctx.actor }, async (cur) => {
    if (cur.status !== 'active') throw new DraftError(`this draft is ${cur.status}`);
    return { state: cur.state, status: 'archived' };
  });
}

/** Restores an archived draft; one archived with its persona brings the persona back to its review with it. */
export async function restoreDraft(services: StudioServices, draftId: string, ctx: Ctx): Promise<DraftRow> {
  const d = await requireDraft(services.db, draftId);
  if (d.status !== 'archived') throw new DraftError(`this draft is ${d.status}, not archived`);
  if (d.persona_id) {
    const p = await services.db.maybeOne<{ state: string }>('SELECT state FROM persona WHERE id = $1', [d.persona_id]);
    if (p?.state === 'ARCHIVED') {
      await restoreStudioPersona(services, { personaId: d.persona_id, actor: ctx.actor });
      return requireDraft(services.db, draftId);
    }
  }
  return commit(services.db, draftId, { step: 0, change: 'restored', actor: ctx.actor }, async (cur) => {
    if (cur.status !== 'archived') throw new DraftError(`this draft is ${cur.status}, not archived`);
    return { state: cur.state, status: 'active' };
  });
}

// ───────────────────────────── Natural-language revisions ─────────────────────────────

export interface Revision {
  changed: boolean;
  summary: string;
  draft: DraftRow;
}

function renameEverywhere(state: DraftState, from: string, to: string): void {
  if (!from || !to || from === to) return;
  const firstFrom = from.split(/\s+/)[0]!;
  const firstTo = to.split(/\s+/)[0]!;
  const swap = (s: string) => s.split(from).join(to).split(firstFrom).join(firstTo);
  const c = state.concept.chosen;
  if (c) {
    c.name = to;
    c.premise = swap(c.premise);
    c.hooks = c.hooks.map(swap);
  }
  const ch = state.character.chosen;
  if (ch) {
    ch.name = to;
    ch.identity = swap(ch.identity);
    ch.lore = swap(ch.lore);
  }
}

function reAge(state: DraftState, age: number): void {
  const c = state.concept.chosen;
  if (c) {
    const old = c.age;
    c.age = age;
    c.archetype = c.archetype.replace(new RegExp(`\\b${old}\\b`), String(age));
    c.premise = c.premise.replace(new RegExp(`\\b${old}\\b`), String(age));
  }
  const ch = state.character.chosen;
  if (ch) {
    const old = ch.age;
    ch.age = age;
    ch.ageRange = `${age - 3}–${age + 3}`;
    ch.identity = ch.identity.replace(new RegExp(`\\b${old}\\b`), String(age));
  }
}

const TONES: Record<string, { trait: string; voice: string }> = {
  drier: { trait: 'bone-dry', voice: 'drier, more deadpan' },
  warmer: { trait: 'warm', voice: 'warmer, more encouraging' },
  funnier: { trait: 'funny', voice: 'funnier, quicker to laugh' },
  sharper: { trait: 'sharp', voice: 'sharper, shorter sentences' },
  softer: { trait: 'gentle', voice: 'softer, slower' },
  calmer: { trait: 'calm', voice: 'calmer, lower' },
  bolder: { trait: 'bold', voice: 'bolder, more emphatic' },
  sassier: { trait: 'sassy', voice: 'sassier, more swagger' },
};

/** The option letter an instruction picks ("go with B", "pick option c"), or null ("use a warmer tone", "take a look"). */
export function pickedLetter(text: string): string | null {
  for (const m of text.matchAll(/\b(?:pick|choose|go with|select|use|take)\s+(?:(option|concept|sheet|voice|preview)\s+)?([A-Za-z])\b(?!['’]s)/gi)) {
    const l = m[2]!;
    if (/^[A-E]$/.test(l) || (m[1] && /^[a-e]$/.test(l))) return l.toUpperCase();
  }
  return null;
}

/** The age change an instruction asks for: +8/-8 (or "by N") after make her/him/them or she/he should be; else null. */
export function ageShift(text: string): number | null {
  const m =
    /\b(?:make\s+(?:her|him|them|it)|(?:she|he|they)\s+(?:should\s+be|is|are|'s|'re))\s+(?:a\s+(?:bit|little|lot)\s+|much\s+|slightly\s+|even\s+|way\s+)?(older|younger)\b(?:\s+by\s+(\d{1,2}))?/i.exec(text) ??
    /(?:^|[.!;]\s*)(?:a\s+(?:bit|little|lot)\s+|much\s+|slightly\s+)?(older|younger)\b(?:\s+by\s+(\d{1,2}))?/i.exec(text.trim());
  if (!m) return null;
  return (m[1]!.toLowerCase() === 'older' ? 1 : -1) * Number(m[2] ?? 8);
}

/**
 * The library's interpretation of an Owner instruction (no model): pick, mix, regenerate, rename, age, tone and
 * price. Returns null when it doesn't recognise the instruction.
 */
async function fakeRevise(services: StudioServices, d: DraftRow, step: number, text: string, ctx: Ctx): Promise<Revision | null> {
  const t = text.trim();
  // Mixes: "combine A's look with B's mechanic", "take C's hooks".
  const mixParts: Partial<Record<ConceptPart, string>> = {};
  const PART_RE = /\b([A-E])['’]s\s+(look|mechanic|hooks?|premise|contrast|name|voice|product|first product|sign-?off)\b/gi;
  for (const m of t.matchAll(PART_RE)) {
    const raw = m[2]!.toLowerCase();
    const part = (raw.startsWith('hook') ? 'hooks' : raw === 'first product' ? 'product' : raw.startsWith('sign') ? 'signOff' : raw) as ConceptPart;
    mixParts[part] = m[1]!.toUpperCase();
  }
  if (Object.keys(mixParts).length && d.state.concept.options.length) {
    const row = await mixConcepts(services, d.id, mixParts, ctx);
    const c = row.state.concept.chosen!;
    return { changed: true, draft: row, summary: `Mixed ${Object.entries(mixParts).map(([p, id]) => `${id}'s ${p}`).join(' with ')}: ${c.name}, scorecard ${c.scorecard?.total ?? '?'}/100.` };
  }
  // Regenerate.
  if (/\b(?:regenerate|new options|try again|more options|redo|fresh (?:options|ideas|concepts)|different options)\b/i.test(t)) {
    const row = await regenerateStep(services, d.id, step, { ...ctx, instruction: t });
    return { changed: true, draft: row, summary: `New ${stepKey(step)} options drafted (round ${row.state[stepKey(step)].generation}).` };
  }
  // Pick: "go with B", "pick option C". The letter must be a capital A–E (or follow "option"), so the article in
  // "use a warmer tone" or "take a look" is never read as a pick.
  const letter = pickedLetter(t);
  if (letter && stepKey(step) !== 'review') {
    const row = await chooseOption(services, d.id, step, letter, ctx);
    return { changed: true, draft: row, summary: `Picked ${letter} on ${stepKey(step)}; ${STEPS[Math.min(step, 6)]!.title.toLowerCase()} is drafted.` };
  }
  const state = clone(d.state);
  const did: string[] = [];
  // Rename: "call her Vera Lin", "rename him to Otto".
  const nameM = /\b(?:call|name|rename)\s+(?:her|him|them|it|the persona)?\s*(?:to\s+)?["“]?([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)/.exec(t);
  if (nameM && state.concept.chosen) {
    const from = state.character.chosen?.name ?? state.concept.chosen.name;
    renameEverywhere(state, from, nameM[1]!);
    did.push(`renamed to ${nameM[1]}`);
  }
  // Age: "make her older", "she should be younger by 5", "make him 80". "Older"/"younger" alone ("an older sister in
  // the lore") is not an age change.
  const exact = /\b(?:make\s+(?:her|him|them)\s+|age\s+(?:to\s+)?|she(?:'s| is| should be)\s+|he(?:'s| is| should be)\s+)(\d{2})\b/i.exec(t);
  const rel = ageShift(t);
  const cur = state.character.chosen?.age ?? state.concept.chosen?.age;
  if (cur !== undefined && (exact || rel)) {
    const age = exact ? Number(exact[1]) : cur + rel!;
    const clamped = Math.max(25, Math.min(95, age));
    reAge(state, clamped);
    did.push(`age ${cur} → ${clamped}`);
  }
  // Tone: "drier", "warmer", "funnier"…
  for (const [word, tone] of Object.entries(TONES)) {
    if (!new RegExp(`\\b${word}\\b`, 'i').test(t)) continue;
    if (state.concept.chosen) state.concept.chosen.voiceLine = `${state.concept.chosen.voiceLine.replace(/;\s*now .*$/, '')}; now ${tone.voice}`;
    if (state.character.chosen) state.character.chosen.personality = [tone.trait, ...state.character.chosen.personality.filter((x) => x !== tone.trait)].slice(0, 5);
    did.push(word);
  }
  // Price: "make the first product $19".
  const price = /\$(\d{1,3})\b/.exec(t);
  if (price && /\b(?:price|product|charge|sell)\b/i.test(t)) {
    const cents = Number(price[1]) * 100;
    if (state.concept.chosen) state.concept.chosen.firstProduct = { ...state.concept.chosen.firstProduct, priceCents: cents };
    if (state.content.chosen) {
      state.content.chosen.firstProductBrief.priceCents = cents;
      state.content.chosen.ladder = state.content.chosen.ladder.map((r) => (r.rung === 'entry' ? { ...r, priceCents: cents } : r));
    }
    did.push(`first product $${price[1]}`);
  }
  if (!did.length) return null;
  if (state.concept.chosen) state.concept.chosen.scorecard = scoreConcept({ concept: state.concept.chosen, opportunity: state.opportunity.chosen });
  if (state.concept.chosen) state.concept.chosenFrom = state.concept.chosenFrom === 'M' ? 'M' : 'owner';
  const key = stepKey(step);
  if (key !== 'review') markDownstream(state, key === 'opportunity' ? 'concept' : key);
  const reviewed = await withReview(services, d, state);
  const row = await commit(services.db, d.id, { step, change: `revised: ${did.join(', ')}`, actor: ctx.actor, expectVersion: ctx.expectVersion ?? d.version }, async () => ({
    ...reviewed,
    title: state.character.chosen?.name ?? state.concept.chosen?.name ?? d.title,
  }));
  return { changed: true, draft: row, summary: `Done: ${did.join(', ')}.` };
}

/** The live interpretation: the model rewrites the step's chosen value as JSON, merged over the current one. */
async function liveRevise(services: StudioServices, d: DraftRow, step: number, text: string, ctx: Ctx): Promise<Revision | null> {
  const key = stepKey(step);
  const target = key === 'opportunity' || key === 'review' || key === 'look' || key === 'voice' ? 'concept' : key;
  const s = d.state[target] as StepState<any, any>;
  if (!s.chosen) return null;
  type Out = { changed?: boolean; summary?: string; value?: Record<string, unknown> };
  const res = await runAgent<Out>(services, {
    agent: 'studio-manager',
    scope: { studioId: d.studio_id, personaId: null },
    label: `generator: revise ${target}`,
    tier: 'standard',
    system: GENERATOR_SYSTEM,
    cached: [STUDIO_RULES_BLOCK, GENERATOR_BLOCK],
    prompt: `Current ${target}: ${JSON.stringify(s.chosen)}.\nThe Owner asks: ${text.slice(0, 600)}\nReturn {"changed": true|false, "summary": "one line", "value": {the full revised ${target}, same fields}}.`,
    parse: (v) => (v && typeof v === 'object' ? (v as Out) : {}),
    jsonSchema: { type: 'object', properties: { changed: { type: 'boolean' }, summary: { type: 'string' }, value: { type: 'object' } } },
    fake: (): Out => ({ changed: false }),
    maxTokens: 3000,
    costRef: { type: 'studio', id: d.studio_id },
  });
  const out = res.output;
  if (!out.changed || !out.value) return null;
  const patch = sanitizePatch(target, out.value);
  if (!Object.keys(patch).length) return null;
  const row = await editChosen(services, d.id, STEPS.find((x) => x.key === target)!.n, patch, ctx);
  return { changed: true, draft: row, summary: str(out.summary, `Revised the ${target}.`, 300) };
}

/**
 * Applies an Owner instruction to the draft. With a key the model reads it first (it rewrites the step's value); the
 * library's parser is the no-key path, and the fallback for what the model can't map to a value (a pick, a mix, a
 * regenerate). `changed: false` when nothing applied (the reply then suggests how).
 */
export async function reviseStep(services: StudioServices, draftId: string, step: number, instruction: string, ctx: Ctx): Promise<Revision> {
  const d = await requireDraft(services.db, draftId);
  assertEditable(d);
  checkVersion(d, ctx.expectVersion);
  if (services.runtime.mode === 'live') {
    try {
      const live = await liveRevise(services, d, step, instruction, ctx);
      if (live) return live;
    } catch (err) {
      if (err instanceof BudgetExceededError || err instanceof DraftError) throw err;
      // An unusable model answer: the library's parser below.
    }
  }
  const fake = await fakeRevise(services, await requireDraft(services.db, draftId), step, instruction, ctx);
  if (fake) return fake;
  return { changed: false, draft: d, summary: 'I could not map that to a change. Try "pick B", "combine A\'s look with B\'s mechanic", "make her older", "call her …", "make it drier" or "regenerate".' };
}

/** Helper for tests and the restore path: a concept built straight from the library. */
export function libraryConcept(nicheKey: string, archetypeKey: string, name: string): ConceptOption {
  const n = nicheByKey(nicheKey) ?? nicheForText(nicheKey);
  const a = archetypeByKey(archetypeKey) ?? ARCHETYPES[0]!;
  return buildConcept(n, a, name, 'A', rng(`${nicheKey}:${archetypeKey}:${name}`));
}

export type { VoicePreview };
