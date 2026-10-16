import type { FormatPlan, OpportunityEvidence, WorldDraft } from '@ios/agents';

/**
 * The Persona Generator's draft model (PRD §3.12). A draft holds seven steps; each step keeps the options the
 * Studio Manager drafted (`options`, regenerated as `generation` goes up) and what the Owner picked or edited
 * (`chosen`). Changing an earlier step marks later finished steps `stale` (kept, flagged for a regenerate).
 */

export const STEPS = [
  { n: 1, key: 'opportunity', title: 'Opportunity', blurb: 'Ranked niches and angles with evidence, or your own idea' },
  { n: 2, key: 'concept', title: 'Concept', blurb: 'Three distinct concepts: premise, contrast, mechanic, hooks, first product' },
  { n: 3, key: 'character', title: 'Character', blurb: 'Identity, personality, worldview, lore, positions, catchphrases' },
  { n: 4, key: 'look', title: 'Look', blurb: 'Anchors, wardrobe, palette, settings and the character sheet' },
  { n: 5, key: 'voice', title: 'Voice', blurb: 'Three voice previews to pick from' },
  { n: 6, key: 'content', title: 'Content and money', blurb: 'Pillars, series, hook bank, product ladder, first product brief' },
  { n: 7, key: 'review', title: 'Review and launch', blurb: 'Full scorecard, distinctness, risks; you approve the launch' },
] as const;

export type StepKey = (typeof STEPS)[number]['key'];
export type StepNumber = (typeof STEPS)[number]['n'];
export const stepKey = (n: number): StepKey => {
  const s = STEPS.find((x) => x.n === n);
  if (!s) throw new Error(`no step ${n}`);
  return s.key;
};
export const stepNumber = (k: StepKey): StepNumber => STEPS.find((x) => x.key === k)!.n;

export type StepStatus = 'empty' | 'ready' | 'done' | 'stale';

export interface StepState<O, C = O> {
  status: StepStatus;
  /** Bumped on every (re)generation of the options. */
  generation: number;
  options: O[];
  chosen: C | null;
  /** Which option the chosen value started from ('M' for a mix, 'owner' for the Owner's own edit). */
  chosenFrom: string | null;
  /** The Studio Manager's one-line recommendation for this step. */
  advice: string | null;
  /** The instruction behind the latest generation or revision, if any. */
  instruction?: string | null;
}

export interface Evidence {
  signal: 'demand' | 'intent' | 'competition' | 'seasonality' | 'gap' | 'trend';
  detail: string;
  /** [V] several reputable sources · [L] credible secondary · [U] single/vendor · [S] the studio's own data. */
  flag: 'V' | 'L' | 'U' | 'S';
  source?: string;
}

export interface OpportunityOption {
  id: string;
  niche: string;
  subNiche: string;
  angle: string;
  audience: string;
  evidence: Evidence[];
  buyingMoments: string[];
  risks: string[];
  /** 0–10 each, plus a 0–100 total. */
  scores: { demand: number; intent: number; competition: number; seasonality: number; gap: number; total: number };
  ownerIdea?: boolean;
}

export interface ProductIdea {
  name: string;
  priceCents: number;
  format: string;
}

export interface Scorecard {
  captivation: number; // /30
  demand: number; // /20
  ladder: number; // /15
  gap: number; // /10
  producibility: number; // /15
  lineSafety: number; // /10
  total: number; // /100
  notes: Partial<Record<Exclude<keyof Scorecard, 'total' | 'notes'>, string>>;
}

export const SCORECARD_WEIGHTS = { captivation: 30, demand: 20, ladder: 15, gap: 10, producibility: 15, lineSafety: 10 } as const;
export type ScoreDimension = keyof typeof SCORECARD_WEIGHTS;

export interface ConceptOption {
  id: string;
  name: string;
  pronoun: 'she' | 'he';
  age: number;
  /** One line: "79, school dinner lady for 41 years". */
  archetype: string;
  premise: string;
  /** The contrast / USP. */
  contrast: string;
  /** The signature mechanic (the recurring bit). */
  mechanic: string;
  hooks: string[];
  firstProduct: ProductIdea;
  lookLine: string;
  voiceLine: string;
  signOff: string;
  /** Internal: which archetype the fake library built it from (keeps regenerations and mixes coherent). */
  archetypeKey?: string;
  /** Internal: the archetype the look came from, when mixed from another concept. */
  lookKey?: string;
  scorecard?: Scorecard;
}

export interface CharacterProfile {
  name: string;
  age: number;
  ageRange: string;
  homeBase: string;
  handle: string;
  identity: string;
  personality: string[];
  worldview: string[];
  lore: string;
  positions: Array<{ debate: string; stance: string }>;
  catchphrases: string[];
}

export type CharacterField = 'name' | 'homeBase' | 'identity' | 'personality' | 'worldview' | 'lore' | 'positions' | 'catchphrases';
export const CHARACTER_FIELDS: readonly CharacterField[] = ['name', 'homeBase', 'identity', 'personality', 'worldview', 'lore', 'positions', 'catchphrases'];

export interface CharacterStep {
  profile: CharacterProfile;
  /** Two or more alternatives per field, ready to swap in. */
  alternatives: Partial<Record<CharacterField, unknown[]>>;
}

export interface LookVariant {
  id: string;
  label: string;
  prompt: string;
  /** Image URL (live Higgsfield) or a placeholder data: URI. */
  url: string;
  provider: 'higgsfield' | 'placeholder';
}

export interface LookProfile {
  anchors: string[];
  wardrobe: string[];
  palette: Array<{ name: string; hex: string }>;
  settings: string[];
  stylisation: string;
  framing: string;
  hue: number;
}

export interface LookCheck {
  mode: 'live' | 'placeholder';
  /** Face similarity between two generations of the picked sheet (live), null without Higgsfield. */
  drift: { similarity: number | null; verdict: 'stable' | 'drifting' | 'not_checked'; note: string };
  /** Visual overlap with existing and archived personas (anchors, wardrobe, palette; faces when live). */
  distinct: { score: number; nearest: string | null; note: string };
}

export interface LookStep {
  profile: LookProfile;
  variants: LookVariant[];
  chosenVariant: string | null;
  check: LookCheck | null;
}

export interface VoicePreview {
  id: string;
  label: string;
  description: string;
  voiceId: string;
  sampleText: string;
  url: string;
  durationS: number;
  provider: string;
  fake: boolean;
}

export interface ContentPlanDraft {
  pillars: Array<{ name: string; why: string }>;
  series: Array<{ name: string; format: string; cadence: string; pillar: string }>;
  hookBank: string[];
  ladder: Array<{ rung: 'lead_magnet' | 'entry' | 'addon' | 'core_bundle' | 'upsell' | 'membership'; name: string; priceCents: number; when: string }>;
  firstProductBrief: { name: string; promise: string; format: string; priceCents: number; keyword: string; sections: string[] };
  ctaKeywords: string[];
}

export interface Distinctness {
  /** 0–100: 100 = nothing like it in the studio or the archive. */
  score: number;
  verdict: 'distinct' | 'close' | 'clone';
  nearest: Array<{ slug: string; name: string; source: 'studio' | 'archive' | 'draft'; similarity: number; shared: string[] }>;
}

export interface ReviewState {
  scorecard: Scorecard;
  distinctness: Distinctness;
  risks: string[];
  missing: string[];
  launchDate: string;
  timezone: string;
  ready: boolean;
}

export interface DraftSeed {
  mode: 'recommend' | 'owner_idea' | 'archive';
  idea?: string | null;
  /** Restored drafts keep their documents' launch plan: first post date (YYYY-MM-DD) and timezone. */
  launchDate?: string | null;
  timezone?: string | null;
}

export interface DraftState {
  seed: DraftSeed;
  opportunity: StepState<OpportunityOption>;
  concept: StepState<ConceptOption>;
  character: StepState<CharacterStep, CharacterProfile>;
  look: StepState<LookStep, LookStep>;
  voice: StepState<VoicePreview>;
  content: StepState<ContentPlanDraft>;
  review: StepState<ReviewState>;
  // IOS-5 extensions (docs/IOS-5-CONTRACTS.md §5.5). Optional: older drafts don't have them. Each is filled through
  // its stream's service (StudioServices) and edited with `setDraftExtension`; the stream's own panel renders it.
  /** Stream I: Growth Radar evidence attached to step 1 (also merged into each option's evidence with flag 'S'). */
  radar?: { evidence: OpportunityEvidence[]; at: string } | null;
  /** Stream J: the World Bible and ~12-week storyline drafted in step 6, adopted at launch. */
  world?: WorldDraft | null;
  /** Stream L: the Format Plan the Studio Manager recommends in step 6, approved with the launch. */
  formatPlan?: FormatPlan | null;
}

/** The IOS-5 draft extensions the Owner (or the owning stream's chat tool) can replace. */
export type DraftExtensionKey = 'world' | 'formatPlan';

export interface DraftRow {
  id: string;
  studio_id: string;
  title: string;
  status: 'active' | 'launched' | 'archived';
  source: 'generator' | 'owner_idea' | 'archive';
  current_step: number;
  version: number;
  state: DraftState;
  scores: Partial<Scorecard> & { distinctness?: number };
  persona_id: string | null;
  archive_ref: { label: string; slug: string } | null;
  created_by: string;
  launched_by: string | null;
  launched_at: Date | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface DraftMessage {
  id: string;
  draft_id: string;
  step: number;
  role: 'owner' | 'agent' | 'system';
  author: string;
  body: string;
  meta: Record<string, unknown>;
  created_at: Date;
}

export const emptyStep = <O, C = O>(): StepState<O, C> => ({ status: 'empty', generation: 0, options: [], chosen: null, chosenFrom: null, advice: null });

export function emptyState(seed: DraftSeed): DraftState {
  return {
    seed,
    opportunity: emptyStep(),
    concept: emptyStep(),
    character: emptyStep(),
    look: emptyStep(),
    voice: emptyStep(),
    content: emptyStep(),
    review: emptyStep(),
  };
}
