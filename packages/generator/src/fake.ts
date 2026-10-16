import { portraitUri } from '@ios/core';
import {
  type Archetype,
  ARCHETYPES,
  archetypeByKey,
  fill,
  firstName,
  NAMES,
  type NicheDef,
  NICHES,
  nicheByKey,
  nicheForText,
  pick,
  rng,
  slugify,
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

export function buildConcept(n: NicheDef, a: Archetype, name: string, id: string, r: () => number, opp?: OpportunityOption | null): ConceptOption {
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
  };
  const myths = pick(n.myths, n.myths.length, r);
  const hookTpls = pick(n.hooks, 5, r);
  const hooks = hookTpls.map((t, i) => fill(t, { ...vars, myth: myths[i % myths.length]! }));
  const concept: ConceptOption = {
    id,
    name,
    pronoun: a.pronoun,
    age,
    archetype: `${age}, ${a.role} for ${a.years} years`,
    premise: `${name}, ${age}, ${a.role} for ${a.years} years. ${n.trigger} Unretired. Now ${a.pronoun} brings the ${a.role}'s rules to ${n.subNiche}.`,
    contrast: `${a.authority.charAt(0).toUpperCase()}${a.authority.slice(1)}, in a niche full of ${n.noise}. The premise is the hook: why is a ${a.role} rating my ${n.object}?`,
    mechanic: `${a.ritual}: ${a.pronoun} rates a viewer's ${n.object}, "${a.verdicts[0]}" or "${a.verdicts[1]}", with the one fix that changes the call.`,
    hooks,
    firstProduct: { name: n.products.entry[0], priceCents: n.products.entry[1], format: 'PDF workbook (A4 + US Letter)' },
    lookLine: `${a.anchors[0]}, ${a.wardrobe[0]}, ${a.anchors[1]}`,
    voiceLine: a.voice,
    signOff: a.signOff,
    archetypeKey: a.key,
  };
  concept.scorecard = scoreConcept({ concept, opportunity: opp ?? null });
  return concept;
}

/** Step 2: three distinct concepts (different archetypes, names and mechanics) for the chosen opportunity. */
export function fakeConcepts(input: { draftId: string; generation: number; opportunity: OpportunityOption; avoidNames?: readonly string[] }): ConceptOption[] {
  const n = nicheByKey(input.opportunity.niche) ?? nicheForText(`${input.opportunity.niche} ${input.opportunity.angle}`);
  const r = rng(`${input.draftId}:concept:${input.generation}:${n.key}`);
  const archetypes = pick(ARCHETYPES, 3, r);
  const used = new Set((input.avoidNames ?? []).map((x) => x.toLowerCase()));
  return archetypes.map((a, i) => {
    const pool = NAMES[a.pronoun].filter((x) => !used.has(x.toLowerCase()));
    const name = pool[Math.floor(r() * pool.length)] ?? NAMES[a.pronoun][0]!;
    used.add(name.toLowerCase());
    return buildConcept(n, a, name, LETTERS[i]!, r, input.opportunity);
  });
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
    identity: `${c.name}, ${c.age}, a ${a.role} for ${a.years} years: a clearly fictional AI character, labelled as AI on every platform. ${a.pronoun === 'she' ? 'She' : 'He'} talks ${n.subNiche} the way ${a.pronoun} ran ${a.unit}. Never claims a degree, licence or credential.`,
    personality: [...a.personality],
    worldview: n.worldview.slice(0, 5),
    lore: `${a.lore} ${n.trigger} That is why ${a.pronoun} came online.`,
    positions: n.positions.map((p) => ({ ...p })),
    catchphrases: [a.signOff, a.retort].slice(0, 2),
  };
  const altNames = pick(NAMES[c.pronoun].filter((x) => x !== c.name), 2, r);
  const alternatives: CharacterStep['alternatives'] = {
    name: altNames,
    homeBase: [a.homeBases[1] ?? 'a seaside town', 'a city flat above a shop'],
    identity: [
      `${c.name}, ${c.age}: ${a.authority}. Openly an AI character. Brings the ${a.role}'s habits to ${n.subNiche}; never claims credentials.`,
      `${first}, ${c.age}, retired ${a.role}, now the internet's ${n.object} inspector (AI character, labelled).`,
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

export function fakeLookProfile(concept: ConceptOption, character: CharacterProfile | null): LookProfile {
  const a = archetypeFor(concept);
  return {
    anchors: a.anchors.slice(0, 3),
    wardrobe: [...a.wardrobe],
    palette: a.palette.map((p) => ({ ...p })),
    settings: a.settings.slice(0, 3),
    stylisation: 'Photoreal with deliberate imperfection (soft skin texture, real wrinkles, natural light); never glossy',
    framing: `Chest-up, front-facing, eye level; one speaker; ${character?.age ?? concept.age} years old, looks it`,
    hue: a.hue,
  };
}

/** The prompt for one character-sheet variant (never asks to pass as a real person). */
export function sheetPrompt(name: string, age: number, look: LookProfile, i: number): string {
  const wardrobe = look.wardrobe[i % look.wardrobe.length] ?? look.wardrobe[0] ?? '';
  const setting = look.settings[i % look.settings.length] ?? '';
  return `Character sheet of ${name}, a fictional ${age}-year-old AI character: front, three-quarter and profile views plus two expressions. ${look.anchors.join(', ')}. Wearing ${wardrobe}. Background: ${setting}. ${look.stylisation}. Palette ${look.palette.map((p) => p.name).join(', ')}. One person only, no text, no logos, no celebrity likeness.`;
}

export function placeholderLook(concept: ConceptOption, character: CharacterProfile | null): LookStep {
  const profile = fakeLookProfile(concept, character);
  const name = character?.name ?? concept.name;
  const age = character?.age ?? concept.age;
  const variants = [0, 1, 2].map((i) => ({
    id: LETTERS[i]!,
    label: `Sheet ${LETTERS[i]}: ${profile.wardrobe[i % profile.wardrobe.length]}`,
    prompt: sheetPrompt(name, age, profile, i),
    url: portraitUri(name, (profile.hue + i * 24) % 360, { variant: i, label: profile.wardrobe[i % profile.wardrobe.length] }),
    provider: 'placeholder' as const,
  }));
  return { profile, variants, chosenVariant: null, check: null };
}

// ───────────────────────────── Voice ─────────────────────────────

const labelOf = (alt: string) => {
  const w = alt.split(/[ ,]/)[0] ?? 'Variation';
  return w.charAt(0).toUpperCase() + w.slice(1);
};

export function voiceBriefs(concept: ConceptOption): Array<{ id: string; label: string; description: string }> {
  const a = archetypeFor(concept);
  const who = `${concept.pronoun === 'she' ? 'woman' : 'man'} in ${concept.pronoun === 'she' ? 'her' : 'his'} ${Math.floor(concept.age / 10) * 10}s`;
  return [
    { id: 'A', label: 'Signature', description: `A ${who}: ${concept.voiceLine || a.voice}. Synthetic voice, never a clone of a real person.` },
    { id: 'B', label: labelOf(a.voiceAlts[0]), description: `A ${who}: ${a.voiceAlts[0]}. Synthetic voice, never a clone of a real person.` },
    { id: 'C', label: labelOf(a.voiceAlts[1]), description: `A ${who}: ${a.voiceAlts[1]}. Synthetic voice, never a clone of a real person.` },
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
      `Why a ${a.role} has opinions about your ${n.object}.`,
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
