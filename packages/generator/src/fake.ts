import { portraitUri } from '@troupe/core';
import { characterSheetPrompt } from '@troupe/production';
import {
  type Archetype,
  type ArchetypeFamily,
  ARCHETYPES,
  archetypeByKey,
  familyOf,
  fill,
  firstName,
  namePool,
  type NicheDef,
  NICHES,
  nicheByKey,
  nicheForText,
  pick,
  rng,
  slugify,
  withArticle,
} from './library';
import { scoreConcept } from './score';
import type {
  CharacterProfile,
  CharacterStep,
  ConceptOption,
  ContentPlanDraft,
  LookProfile,
  LookStep,
  OpportunityOption,
} from './types';

/**
 * The no-key Studio Manager: deterministic drafts for every step, built from the library. Seeded by the draft id
 * and the step's generation, so a regenerate gives new options and a test gets the same ones every time.
 */

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export interface StudioMix {
  /** Live personas per niche (not archived, killed or retired). */
  active: Record<string, number>;
  /** Archived personas per niche (files and parked personas). */
  archived: Record<string, number>;
}

export function opportunityFor(n: NicheDef, mix: StudioMix, r: () => number, angle?: string, ownerIdea = false): OpportunityOption {
  const jitter = () => Math.round((r() - 0.5) * 2);
  const demand = clamp(n.base.demand + jitter(), 1, 10);
  const intent = clamp(n.base.intent + jitter(), 1, 10);
  const competition = clamp(n.base.competition, 1, 10);
  const seasonality = clamp(n.base.seasonality, 1, 10);
  const active = mix.active[n.key] ?? 0;
  const gap = clamp(10 - 3 * active, 0, 10);
  const total = Math.round(demand * 3 + intent * 3 + competition * 1.5 + seasonality + gap * 1.5);
  const evidence = [...n.evidence];
  evidence.push({
    signal: 'gap',
    detail: active
      ? `The studio already runs ${active} ${n.key} persona${active > 1 ? 's' : ''}: a new one has to take a different audience`
      : `No live ${n.key} persona in the studio${mix.archived[n.key] ? ` (${mix.archived[n.key]} archived)` : ''}`,
    flag: 'S',
  });
  return {
    id: '',
    niche: n.key,
    subNiche: n.subNiche,
    angle: angle ?? n.angle,
    audience: n.audience,
    evidence,
    buyingMoments: n.buyingMoments,
    risks: n.risks,
    scores: { demand, intent, competition, seasonality, gap, total },
    ...(ownerIdea ? { ownerIdea: true } : {}),
  };
}

/** Step 1: four ranked niche/angle recommendations (or the Owner's idea first, then three more). */
export function fakeOpportunities(input: { draftId: string; generation: number; idea?: string | null; mix: StudioMix }): OpportunityOption[] {
  const r = rng(`${input.draftId}:opportunity:${input.generation}`);
  const out: OpportunityOption[] = [];
  let pool = [...NICHES];
  if (input.idea?.trim()) {
    const n = nicheForText(input.idea);
    out.push(opportunityFor(n, input.mix, r, input.idea.trim().slice(0, 240), true));
    pool = pool.filter((x) => x.key !== n.key);
  }
  const ranked = pool
    .map((n) => opportunityFor(n, input.mix, r))
    .sort((a, b) => b.scores.total - a.scores.total);
  // A regenerate rotates further down the ranking, so the Owner sees new niches, still in score order.
  const offset = ((input.generation - 1) * 2) % Math.max(1, ranked.length);
  const rotated = [...ranked.slice(offset), ...ranked.slice(0, offset)].slice(0, 4 - out.length).sort((a, b) => b.scores.total - a.scores.total);
  out.push(...rotated);
  return out.map((o, i) => ({ ...o, id: LETTERS[i]! }));
}

// ───────────────────────────── Concepts ─────────────────────────────

/** The shape of the signature mechanic: a verdict, a repeated ritual, an episodic series, or a dated challenge. */
export type ConceptShape = 'rating' | 'ritual' | 'series' | 'challenge';
export const CONCEPT_SHAPES: readonly ConceptShape[] = ['rating', 'ritual', 'series', 'challenge'];

const SHAPE_VERB: Record<ConceptShape, string> = { rating: 'rating', ritual: 'fixing', series: 'telling stories about', challenge: 'coaching' };

const SHAPE_HOOKS: Record<ConceptShape, string[]> = {
  rating: ['Rating your {object}: {verdictA} or {verdictB}?', '{first} rates the comments. Brace yourself.', 'Verdict: {verdictB}. Here is the one fix.'],
  ritual: ['{ritual}, week one. Do it with me.', 'Same time, same rules. Your turn.', '{first} does {pos} own {object} first.'],
  series: ['{ritual}, episode one.', 'Your {object}, told as a story.', 'Part two: what happened next.'],
  challenge: ['Day 1 of 30. One small task.', '30 days, one {object}, no excuses.', 'Sunday check-in: who made it?'],
};

const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function premiseFor(a: Archetype, n: NicheDef, name: string, age: number): string {
  const pron = a.pronoun === 'she' ? 'She' : 'He';
  const pos = a.pronoun === 'she' ? 'her' : 'his';
  switch (familyOf(a)) {
    case 'peer':
      return `${name}, ${age}, ${withArticle(a.role)} for ${a.years} years. ${pron} learned more about ${n.subNiche} from ${a.unit} than from any course, and ${a.pronoun} says so.`;
    case 'era':
      return `${name}, ${withArticle(a.role)}, somehow posting from 2026 (a clearly fictional time-slip). ${pron} holds modern ${n.subNiche} up against ${pos} ${a.unit} and says what changed.`;
    default:
      return `${name}, ${age}, ${withArticle(a.role)} for ${a.years} years. ${n.trigger} Unretired. Now ${a.pronoun} brings the ${a.role}'s rules to ${n.subNiche}.`;
  }
}

function mechanicFor(shape: ConceptShape, a: Archetype, n: NicheDef): string {
  const pos = a.pronoun === 'she' ? 'her' : 'his';
  switch (shape) {
    case 'rating':
      return `${a.ritual}: ${a.pronoun} rates a viewer's ${n.object}, "${a.verdicts[0]}" or "${a.verdicts[1]}", with the one fix that changes the call.`;
    case 'ritual':
      return `${a.ritual}: the same short ritual every week; ${a.pronoun} works through ${pos} own ${n.object} on camera, one rule at a time, and viewers do theirs alongside.`;
    case 'series':
      return `${a.ritual}: a numbered story series; each episode retells one viewer's ${n.object} as a tale from ${pos} ${a.unit}, ending on the rule ${a.pronoun} would use.`;
    case 'challenge':
      return `${a.ritual}: a 30-day challenge run live; one small task a day for the viewer's ${n.object}, a check-in every Sunday, and "${a.verdicts[0]}" for everyone who finishes.`;
  }
}

function productFor(shape: ConceptShape, a: Archetype, n: NicheDef): ConceptOption['firstProduct'] {
  const P = n.products;
  switch (shape) {
    case 'challenge':
      return { name: P.entry[0], priceCents: P.entry[1], format: 'PDF 30-day tracker (A4 + US Letter)' };
    case 'rating':
      return { name: `The ${a.ritual} Scorecard`, priceCents: 900, format: 'PDF scorecard and checklist' };
    case 'ritual':
      return { name: `The ${a.ritual} Workbook`, priceCents: 1200, format: 'PDF workbook (A4 + US Letter)' };
    case 'series':
      return { name: P.upsell[0], priceCents: P.upsell[1], format: 'PDF workbook (A4 + US Letter)' };
  }
}

/**
 * One concept from a niche and an archetype. `shape` sets the mechanic, the hooks and the first product; `slot` (0–2)
 * takes a different share of the niche's own hooks, so three concepts never share a hook.
 */
export function buildConcept(n: NicheDef, a: Archetype, name: string, id: string, r: () => number, opp?: OpportunityOption | null, shape: ConceptShape = 'rating', slot = 0): ConceptOption {
  const age = a.age + Math.round((r() - 0.5) * 6);
  const vars = {
    retort: a.retort,
    verdictA: a.verdicts[0],
    verdictB: a.verdicts[1],
    years: a.years,
    unit: a.unit,
    object: n.object,
    first: firstName(name),
    ritual: a.ritual,
    pos: a.pronoun === 'she' ? 'her' : 'his',
  };
  // The niche's hooks, minus the rating template (the rating shape has its own), split three ways.
  const nicheHooks = n.hooks.filter((h) => !h.includes('{verdictA}'));
  const mine = [nicheHooks[slot % 3], nicheHooks[(slot % 3) + 3]].filter((h): h is string => !!h);
  const myth = n.myths[slot % n.myths.length]!;
  const tpls = [...SHAPE_HOOKS[shape], ...mine];
  if (tpls.length < 5) tpls.push(`"${myth}"? {retort}`);
  const hooks = [...new Set(tpls.slice(0, 5).map((t) => fill(t, { ...vars, myth })))];
  const role = a.role;
  const concept: ConceptOption = {
    id,
    name,
    pronoun: a.pronoun,
    age,
    archetype: `${age}, ${role} for ${a.years} years`,
    premise: premiseFor(a, n, name, age),
    contrast: `${cap1(a.authority)}, in a niche full of ${n.noise}. The premise is the hook: why is ${withArticle(role)} ${SHAPE_VERB[shape]} my ${n.object}?`,
    mechanic: mechanicFor(shape, a, n),
    hooks,
    firstProduct: productFor(shape, a, n),
    lookLine: `${a.anchors[0]}, ${a.wardrobe[0]}, ${a.anchors[1]}`,
    voiceLine: a.voice,
    signOff: a.signOff,
    archetypeKey: a.key,
  };
  concept.scorecard = scoreConcept({ concept, opportunity: opp ?? null });
  return concept;
}

/** Whether the audience line reads as mostly women or mostly men ("Women 22–38 …"). */
function audienceLean(audience: string): 'she' | 'he' | null {
  const t = audience.toLowerCase();
  const women = /\bwomen\b/.test(t);
  const men = /\bmen\b/.test(t);
  if (women && !men) return 'she';
  if (men && !women) return 'he';
  return null;
}

/**
 * Step 2: three distinct concepts for the chosen opportunity: one archetype from each family (an elder, a peer, a
 * character from another era), three different mechanic shapes, first products and price points, no shared hooks,
 * and both pronouns unless the audience leans one way (then two of the three match it).
 */
export function fakeConcepts(input: { draftId: string; generation: number; opportunity: OpportunityOption; avoidNames?: readonly string[] }): ConceptOption[] {
  const n = nicheByKey(input.opportunity.niche) ?? nicheForText(`${input.opportunity.niche} ${input.opportunity.angle}`);
  const r = rng(`${input.draftId}:concept:${input.generation}:${n.key}`);
  const families: ArchetypeFamily[] = pick(['elder', 'peer', 'era'] as const, 3, r);
  const byFamily = (f: ArchetypeFamily) => ARCHETYPES.filter((a) => familyOf(a) === f);
  const archetypes = families.map((f) => pick(byFamily(f), 1, r)[0]!);
  const lean = audienceLean(`${input.opportunity.audience} ${n.audience}`);
  const want = lean ?? null;
  const swapTo = (i: number, pronoun: 'she' | 'he') => {
    const alt = byFamily(families[i]!).filter((a) => a.pronoun === pronoun);
    if (alt.length) archetypes[i] = pick(alt, 1, r)[0]!;
  };
  if (want) {
    for (let i = 0; i < 3 && archetypes.filter((a) => a.pronoun === want).length < 2; i++) if (archetypes[i]!.pronoun !== want) swapTo(i, want);
  } else if (new Set(archetypes.map((a) => a.pronoun)).size === 1) {
    swapTo(2, archetypes[0]!.pronoun === 'she' ? 'he' : 'she');
  }
  const shapes = pick(CONCEPT_SHAPES, 3, r);
  const used = new Set((input.avoidNames ?? []).map((x) => x.toLowerCase()));
  const concepts = archetypes.map((a, i) => {
    const all = namePool(familyOf(a), a.pronoun);
    const pool = all.filter((x) => !used.has(x.toLowerCase()) && !used.has(firstName(x).toLowerCase()));
    const name = pool[Math.floor(r() * pool.length)] ?? all[0]!;
    used.add(name.toLowerCase());
    used.add(firstName(name).toLowerCase());
    return buildConcept(n, a, name, LETTERS[i]!, r, input.opportunity, shapes[i]!, i);
  });
  // Scored against each other, so near-identical options lose points and the ranking means something.
  return concepts.map((c) => ({ ...c, scorecard: scoreConcept({ concept: c, opportunity: input.opportunity, siblings: concepts.filter((x) => x.id !== c.id) }) }));
}

/**
 * The concept's archetype, with the concept's own text winning: its ritual and verdicts (from the mechanic), sign-off
 * and voice line; the look (anchors, wardrobe, settings, palette) from `lookKey` when the look was mixed in from
 * another concept. An edited concept with no library archetype gets one built from its own lines.
 */
export function archetypeFor(c: ConceptOption): Archetype {
  const base = ARCHETYPES[0]!;
  const known = archetypeByKey(c.archetypeKey);
  const role = /,\s*([^,]+?) for \d+ years/.exec(c.archetype ?? '')?.[1] ?? 'veteran';
  const years = Number(/for (\d+) years/.exec(c.archetype ?? '')?.[1] ?? 30);
  const a: Archetype = known ? { ...known } : { ...base, key: 'custom', role, years, retort: c.signOff || base.retort };
  const look = archetypeByKey(c.lookKey) ?? (known ? a : null);
  const ritual = /^([^:]{3,40}):/.exec(c.mechanic ?? '')?.[1]?.trim();
  const verdicts = [...(c.mechanic ?? '').matchAll(/"([^"]{2,40})"/g)].map((m) => m[1]!);
  const anchors = (c.lookLine ?? '').split(/,\s*/).filter(Boolean);
  return {
    ...a,
    pronoun: c.pronoun ?? a.pronoun,
    age: c.age ?? a.age,
    ritual: ritual ?? a.ritual,
    verdicts: verdicts.length >= 2 ? [verdicts[0]!, verdicts[1]!] : a.verdicts,
    signOff: c.signOff || a.signOff,
    voice: c.voiceLine || a.voice,
    anchors: look ? look.anchors : anchors.length >= 3 ? anchors.slice(0, 3) : [...anchors, ...base.anchors].slice(0, 3),
    wardrobe: (look ?? a).wardrobe,
    settings: (look ?? a).settings,
    palette: (look ?? a).palette,
    hue: (look ?? a).hue,
  };
}

// ───────────────────────────── Character ─────────────────────────────

export function fakeCharacter(input: { draftId: string; generation: number; concept: ConceptOption; niche: NicheDef }): CharacterStep {
  const c = input.concept;
  const a = archetypeFor(c);
  const n = input.niche;
  const r = rng(`${input.draftId}:character:${input.generation}`);
  const first = firstName(c.name);
  const ritualWord = slugify(a.ritual).replace(/-/g, '').slice(0, 14);
  const profile: CharacterProfile = {
    name: c.name,
    age: c.age,
    ageRange: `${c.age - 3}–${c.age + 3}`,
    homeBase: a.homeBases[0] ?? 'a small town',
    handle: `${slugify(first).replace(/-/g, '')}${ritualWord}`.slice(0, 24),
    identity: `${c.name}, ${c.age}, ${withArticle(a.role)} for ${a.years} years: a clearly fictional AI character, labelled as AI on every platform. ${a.pronoun === 'she' ? 'She' : 'He'} talks ${n.subNiche} the way ${a.pronoun} ran ${a.unit}. Never claims a degree, licence or credential.`,
    personality: [...a.personality],
    worldview: n.worldview.slice(0, 5),
    lore: `${a.lore} ${n.trigger} That is why ${a.pronoun} came online.`,
    positions: n.positions.map((p) => ({ ...p })),
    catchphrases: [a.signOff, a.retort].slice(0, 2),
  };
  const altNames = pick(namePool(familyOf(a), c.pronoun).filter((x) => x !== c.name), 2, r);
  const alternatives: CharacterStep['alternatives'] = {
    name: altNames,
    homeBase: [a.homeBases[1] ?? 'a seaside town', 'a city flat above a shop'],
    identity: [
      `${c.name}, ${c.age}: ${a.authority}. Openly an AI character. Brings the ${a.role}'s habits to ${n.subNiche}; never claims credentials.`,
      `${first}, ${c.age}, ${familyOf(a) === 'elder' ? 'retired' : familyOf(a) === 'era' ? 'time-slipped' : 'off-duty'} ${a.role}, now the internet's ${n.object} inspector (AI character, labelled).`,
    ],
    personality: [a.personalityAlt, [...a.personality.slice(0, 2), ...a.personalityAlt.slice(0, 2)]],
    worldview: [pick(n.worldview, 5, r), [...n.worldview.slice(1, 5), 'Kindness is not the same as agreeing']],
    lore: [`${a.loreAlt} ${n.trigger}`, `${a.lore}`],
    positions: [n.softPositions.map((p) => ({ ...p }))],
    catchphrases: [
      [a.signOff, a.retorts[0] ?? a.retort],
      [a.retorts[1] ?? a.retort, a.retorts[2] ?? a.signOff],
    ],
  };
  return { profile, alternatives };
}

// ───────────────────────────── Look ─────────────────────────────

/** The Owner's steer for a (re)generation: the instruction typed in "Steer it" and the step's generation number. */
export interface Steer {
  instruction?: string | null;
  generation?: number;
}

const COLOURS: Record<string, string> = {
  red: '#B3262E', crimson: '#9D0208', burgundy: '#6D1A36', pink: '#E56B9F', orange: '#E8590C', yellow: '#E9C46A', gold: '#C9A227',
  green: '#2D6A4F', teal: '#2A9D8F', blue: '#1F4E99', navy: '#1F3A5F', purple: '#6B2D5C', lilac: '#B8A1D9', brown: '#6F4E37',
  cream: '#F2E8D5', white: '#F4F1EA', grey: '#8D99AE', gray: '#8D99AE', black: '#14141A',
};

const rotate = <T>(xs: readonly T[], k: number): T[] => (xs.length ? [...xs.slice(k % xs.length), ...xs.slice(0, k % xs.length)] : []);

/** The look profile; a regenerate rotates the wardrobe and settings and shifts the hue, and the Owner's steer is folded in. */
export function fakeLookProfile(concept: ConceptOption, character: CharacterProfile | null, steer: Steer = {}): LookProfile {
  const a = archetypeFor(concept);
  const g = Math.max(0, (steer.generation ?? 1) - 1);
  const ask = steer.instruction?.trim().slice(0, 200) ?? '';
  const profile: LookProfile = {
    anchors: a.anchors.slice(0, 3),
    wardrobe: rotate(a.wardrobe, g),
    palette: a.palette.map((p) => ({ ...p })),
    settings: rotate(a.settings, g).slice(0, 3),
    stylisation: 'Photoreal with deliberate imperfection (soft skin texture, real wrinkles, natural light); never glossy',
    framing: `Chest-up, front-facing, eye level; one speaker; ${character?.age ?? concept.age} years old, looks it`,
    hue: (a.hue + g * 17) % 360,
  };
  if (ask) {
    const colour = Object.keys(COLOURS).find((c) => new RegExp(`\\b${c}\\b`, 'i').test(ask));
    if (colour) {
      profile.palette = [{ name: `Owner ${colour}`, hex: COLOURS[colour]! }, ...profile.palette.filter((p) => p.hex !== COLOURS[colour]).slice(0, 3)];
      if (/\b(?:wardrobe|clothes|outfits?|wear(?:s|ing)?|dress(?:es|ed)?|suits?|jackets?)\b/i.test(ask)) profile.wardrobe = profile.wardrobe.map((w) => `${w}, all in ${colour}`);
    }
    profile.stylisation = `${profile.stylisation}. Owner's steer: ${ask}`;
  }
  return profile;
}

/**
 * The prompt for one character-sheet variant (never asks to pass as a real person): the production sheet (IOS-5
 * stream K, PRD §3.15.2): five views (front, side, back, front close-up, top-down) on neutral grey, in the method's
 * order. `mood` is text from the inspiration board (descriptors only; a pin is never an identity reference).
 */
export function sheetPrompt(name: string, age: number, look: LookProfile, i: number, mood: readonly string[] = []): string {
  const wardrobe = look.wardrobe[i % look.wardrobe.length] ?? look.wardrobe[0] ?? '';
  const setting = look.settings[i % look.settings.length] ?? '';
  return characterSheetPrompt({
    name,
    age,
    anchors: look.anchors,
    wardrobe: [wardrobe],
    settings: setting ? [setting] : [],
    palette: look.palette.map((p) => p.name),
    stylisation: look.stylisation,
    mood,
  });
}

export function placeholderLook(concept: ConceptOption, character: CharacterProfile | null, steer: Steer = {}, profileIn?: LookProfile, mood: readonly string[] = []): LookStep {
  const profile = profileIn ?? fakeLookProfile(concept, character, steer);
  const name = character?.name ?? concept.name;
  const age = character?.age ?? concept.age;
  const g = Math.max(0, (steer.generation ?? 1) - 1);
  const variants = [0, 1, 2].map((i) => ({
    id: LETTERS[i]!,
    label: `Sheet ${LETTERS[i]}: ${profile.wardrobe[i % profile.wardrobe.length]}`,
    prompt: sheetPrompt(name, age, profile, i, mood),
    url: portraitUri(name, (profile.hue + i * 24) % 360, { variant: i + g * 3, label: profile.wardrobe[i % profile.wardrobe.length] }),
    provider: 'placeholder' as const,
  }));
  return { profile, variants, chosenVariant: null, check: null };
}

// ───────────────────────────── Voice ─────────────────────────────

const labelOf = (alt: string) => {
  const w = alt.split(/[ ,]/)[0] ?? 'Variation';
  return w.charAt(0).toUpperCase() + w.slice(1);
};

const VOICE_TWISTS = ['', 'a touch slower', 'a little brighter', 'closer to the mic', 'a shade lower', 'more breath between lines'];

export interface VoiceBrief {
  id: string;
  label: string;
  description: string;
}

/** Three voice briefs: the concept's voice line and two variations; a regenerate varies them, the Owner's steer is folded in. */
export function voiceBriefs(concept: ConceptOption, steer: Steer = {}): VoiceBrief[] {
  const a = archetypeFor(concept);
  const g = Math.max(0, (steer.generation ?? 1) - 1);
  const ask = steer.instruction?.trim().slice(0, 200) ?? '';
  const who = `${concept.pronoun === 'she' ? 'woman' : 'man'} in ${concept.pronoun === 'she' ? 'her' : 'his'} ${Math.floor(concept.age / 10) * 10}s`;
  const alts = g % 2 ? [a.voiceAlts[1], a.voiceAlts[0]] : [a.voiceAlts[0], a.voiceAlts[1]];
  const twist = (i: number) => VOICE_TWISTS[(g * 3 + i) % VOICE_TWISTS.length]!;
  const line = (base: string, i: number) => [base, twist(i), ask ? `steered: ${ask}` : ''].filter(Boolean).join('; ');
  const tail = 'Synthetic voice, never a clone of a real person.';
  return [
    { id: 'A', label: ask ? 'Steered' : 'Signature', description: `A ${who}: ${line(concept.voiceLine || a.voice, 0)}. ${tail}` },
    { id: 'B', label: labelOf(alts[0]), description: `A ${who}: ${line(alts[0], 1)}. ${tail}` },
    { id: 'C', label: labelOf(alts[1]), description: `A ${who}: ${line(alts[1], 2)}. ${tail}` },
  ];
}

export const sampleLine = (concept: ConceptOption): string => `${concept.hooks[0] ?? ''} ${concept.signOff}`.trim();

// ───────────────────────────── Content and money ─────────────────────────────

export function fakeContent(input: { draftId: string; generation: number; concept: ConceptOption; character: CharacterProfile | null; niche: NicheDef }): ContentPlanDraft {
  const c = input.concept;
  const n = input.niche;
  const a = archetypeFor(c);
  const r = rng(`${input.draftId}:content:${input.generation}`);
  const first = firstName(input.character?.name ?? c.name);
  const vars = { retort: a.retort, verdictA: a.verdicts[0], verdictB: a.verdicts[1], years: a.years, unit: a.unit, object: n.object, first, ritual: a.ritual };
  const extra = n.hooks.map((t, i) => fill(t, { ...vars, myth: n.myths[i % n.myths.length]! }));
  const mythHooks = n.myths.map((m) => `"${m}"? ${a.retorts[0] ?? a.retort}`);
  const bank = [
    ...new Set([
      ...c.hooks,
      ...extra,
      ...mythHooks,
      `${first}'s rule for ${n.subNiche.split(' and ')[0]}.`,
      `Why ${withArticle(a.role)} has opinions about your ${n.object}.`,
      `${a.ritual}, episode one.`,
      `Send me your ${n.object}. I'll rate it.`,
    ]),
  ];
  const P = n.products;
  return {
    pillars: n.pillars.map((p) => ({ ...p })),
    series: [
      { name: a.ritual, format: 'talking', cadence: '3 a week', pillar: n.pillars[1]?.name ?? '' },
      { name: n.seriesB.name, format: n.seriesB.format, cadence: '2 a week', pillar: n.pillars[0]?.name ?? '' },
      { name: `${first}'s Rules`, format: 'carousel', cadence: '1 a week', pillar: n.pillars[2]?.name ?? '' },
    ],
    hookBank: pick(bank, Math.min(12, bank.length), r),
    ladder: [
      { rung: 'lead_magnet', name: P.lead, priceCents: 0, when: 'Launch' },
      { rung: 'entry', name: c.firstProduct.name || P.entry[0], priceCents: c.firstProduct.priceCents || P.entry[1], when: 'Launch' },
      { rung: 'addon', name: P.addon[0], priceCents: P.addon[1], when: 'Month 2' },
      { rung: 'core_bundle', name: P.core[0], priceCents: P.core[1], when: 'Month 2' },
      { rung: 'upsell', name: P.upsell[0], priceCents: P.upsell[1], when: 'Month 2–3' },
      { rung: 'membership', name: P.membership[0], priceCents: P.membership[1], when: 'Month 3+ (winners only)' },
    ],
    firstProductBrief: {
      name: c.firstProduct.name || P.entry[0],
      promise: `${n.angle.split(':')[0]}, in ${first}'s rules: a finite, tick-box tool, not a reading list.`,
      format: c.firstProduct.format || 'PDF workbook (A4 + US Letter)',
      priceCents: c.firstProduct.priceCents || P.entry[1],
      keyword: n.keywords[0]!,
      sections: [...n.briefSections],
    },
    ctaKeywords: [...n.keywords],
  };
}
