/**
 * IOS-5 shared contracts (docs/IOS-5-CONTRACTS.md §5): the types and service interfaces the four IOS-5 streams build
 * against in parallel. Integrator-only: a stream that needs a change asks for it (§8); nothing here changes on a
 * stream branch.
 *
 *   RadarService ........ stream I (@ios/radar)       → read by L (Format Plan benchmarks), the generator (step 1),
 *                                                       the Studio Manager and the Monetization Agent
 *   WorldService ........ stream J (@ios/world)       → read by K (grounding block in every prompt), L (story frames,
 *                                                       continuity), I (no-repeat check on remix briefs), the content
 *                                                       pipeline (Q1 world checks, ledger) and the generator (step 6)
 *   PromptCompiler ...... stream K (@ios/production)  → read by L (story-frame stills), K's own renderers
 *   FormatPlanService ... stream L (@ios/formats)     → read by the generator (step 6, launch), the CadencePolicy
 *                                                       (L owns it in @ios/profit) and K (which formats are on)
 *
 * Each service has a null / basic default in `defaults.ts`, so every stream compiles and tests without the others.
 */
import { type Actor, type CostRef, getSettings, metered, type PersonaState, type Platform, type PostFormat, type PostPurpose } from '@ios/core';
import type { Db } from '@ios/db';
import type { InspirationPin } from '@ios/providers';
import type { QcCheck, ServiceBase } from './contracts';

// ───────────────────────────── Formats and Stories (stream L owns the meaning; K renders) ─────────────────────────────

/** FR-4.3d: the daily Stories mix. `sell` runs only on sell days. */
export const STORY_FRAME_KINDS = ['world', 'storyline', 'reshare', 'engagement', 'sell'] as const;
export type StoryFrameKind = (typeof STORY_FRAME_KINDS)[number];
/** Stories per persona per day (FR-4.3d). */
export const STORIES_PER_DAY = { min: 3, max: 5 } as const;
/** Highlight sets the Persona Manager curates (FR-4.3d). */
export const HIGHLIGHT_SETS = ['Start here', 'Free guide', 'Shop', 'Lore'] as const;
export type HighlightSet = (typeof HIGHLIGHT_SETS)[number];

/** One line of a Format Plan: a format, its weekly count, whether it is on, why, and what it costs. */
export interface FormatPlanLine {
  readonly format: PostFormat;
  readonly perWeek: number;
  /** Optional formats can be off (perWeek 0); core formats are always on. */
  readonly enabled: boolean;
  readonly reason: string;
  readonly costPerPostUsd: number;
  readonly costPerWeekUsd: number;
}

export interface StoriesPlan {
  /** Frames per day, within STORIES_PER_DAY. */
  readonly perDay: number;
  readonly mix: ReadonlyArray<{ readonly kind: StoryFrameKind; readonly perDay: number; readonly reason: string }>;
  readonly costPerWeekUsd: number;
}

/**
 * A persona's Format Plan (FR-4.3c): recommended by the Studio Manager in Persona Generator step 6, approved with the
 * launch, editable on the persona page and in chat, re-tuned weekly within bounds by the Profit Engine's format lever.
 * `lines` sum to `postsPerWeek`.
 */
export interface FormatPlan {
  readonly postsPerWeek: number;
  readonly lines: readonly FormatPlanLine[];
  readonly stories: StoriesPlan;
  readonly source: 'default' | 'recommended' | 'owner' | 'lever';
  readonly reason: string;
  readonly costPerWeekUsd: number;
  /** The niche benchmark it used (from RadarService), null when the Radar had nothing yet. */
  readonly benchmark: { readonly niche: string; readonly confidence: FormatBenchmark['confidence']; readonly updatedAt: string } | null;
}

export interface FormatPlanRecommendRequest {
  readonly studioId: string;
  readonly niche: string;
  /** One line, e.g. "79, school dinner lady for 41 years" (the concept's archetype). */
  readonly archetype: string;
  readonly ladder: ReadonlyArray<{ readonly rung: string; readonly priceCents: number }>;
  /** The persona's monthly media budget, when known (persona budget cap). */
  readonly budgetUsdPerMonth?: number | null;
  readonly state?: PersonaState;
}

export interface FormatPlanService {
  /** Studio Manager recommendation (Persona Generator step 6). null = no recommendation available. */
  recommend(q: FormatPlanRecommendRequest): Promise<FormatPlan | null>;
  /** The persona's plan in force, or null (the calendar then uses the cadence default). */
  planFor(personaId: string): Promise<FormatPlan | null>;
  /** Writes the approved plan for a newly launched persona. Runs inside the launch transaction (`db` is the tx). */
  adoptPlan(db: Db, q: { readonly personaId: string; readonly studioId: string; readonly plan: FormatPlan; readonly actor: Actor }): Promise<void>;
}

// ───────────────────────────── Growth Radar + Winner Finder (stream I) ─────────────────────────────

/** What breaks out for fast-growing accounts in a niche (FR-4.3c "niche benchmarks"). */
export interface FormatBenchmark {
  readonly niche: string;
  readonly sample: { readonly accounts: number; readonly posts: number };
  /** Share of the niche's outlier posts per format (0–1; the formats seen sum to ~1). Classified into our PostFormat values. */
  readonly formatShare: Readonly<Partial<Record<PostFormat, number>>>;
  /** Median outlier score per format (views ÷ the creator's median over the last 20 posts). */
  readonly formatLift: Readonly<Partial<Record<PostFormat, number>>>;
  /** Median feed posts a week of the accelerating accounts; null = unknown. */
  readonly postsPerWeek: number | null;
  /** Median story frames a day, when observable; null = unknown. */
  readonly storiesPerDay: number | null;
  readonly confidence: 'low' | 'medium' | 'high';
  readonly updatedAt: Date;
}

/** One piece of Radar evidence for Persona Generator step 1 (shown with flag 'S', the studio's own data). */
export interface OpportunityEvidence {
  readonly niche: string;
  readonly signal: 'trend' | 'gap' | 'demand' | 'competition';
  readonly detail: string;
  /** e.g. 'Growth Radar: 6 accelerating accounts, 14 d'. Never a scraped caption verbatim. */
  readonly source: string;
  /** 0–1 strength. */
  readonly score: number;
  readonly at: Date;
}

export interface MonetisationPattern {
  readonly niche: string;
  readonly kind: 'bio_link' | 'digital_product' | 'membership' | 'fanvue' | 'brand_deal' | 'affiliate' | 'other';
  /** Share of the reviewed high-growth accounts showing it (0–1). */
  readonly share: number;
  /** Short descriptions written by our analysis (never copied captions). */
  readonly notes: readonly string[];
}

export interface RadarService {
  formatBenchmarks(q: { readonly studioId: string; readonly niche: string }): Promise<FormatBenchmark | null>;
  opportunityEvidence(q: { readonly studioId: string; readonly niches?: readonly string[]; readonly limit?: number }): Promise<OpportunityEvidence[]>;
  monetisationPatterns(q: { readonly studioId: string; readonly niche: string }): Promise<MonetisationPattern[]>;
}

/** Outlier thresholds (PRD §3.15.9): views ÷ the creator's median views over the last 20 posts. */
export const OUTLIER = { window: 20, outlier: 5, strong: 10, recencyDays: 14 } as const;
/** Internal winners: our post beats the persona's median by this factor on views and saves/shares at 24 h. */
export const INTERNAL_WINNER_LIFT = 2;

// ───────────────────────────── World, grounding, storyline, continuity, no-repeat (stream J) ─────────────────────────────

export type Season = 'winter' | 'spring' | 'summer' | 'autumn' | 'wet' | 'dry';
export type TimeOfDay = 'night' | 'dawn' | 'morning' | 'midday' | 'afternoon' | 'evening';

/**
 * Real-time grounding for one persona at one moment (PRD §3.14.2): local date, season, time of day, real local weather
 * (Open-Meteo, no key; fake in tests) and nearby local holidays. `block` is the ready-made grounding text every script
 * and visual prompt carries (stream K's compiler puts it in the lighting/grounding block).
 */
export interface Grounding {
  readonly personaId: string;
  readonly timezone: string;
  /** YYYY-MM-DD, persona-local. */
  readonly localDate: string;
  /** HH:MM, persona-local. */
  readonly localTime: string;
  readonly weekday: string;
  readonly season: Season;
  readonly timeOfDay: TimeOfDay;
  readonly place: { readonly city: string; readonly region: string | null; readonly country: string; readonly lat: number | null; readonly lon: number | null };
  readonly weather: {
    readonly summary: string;
    readonly tempC: number;
    readonly precipitation: boolean;
    readonly isDay: boolean;
    readonly source: 'open-meteo' | 'fake' | 'climate';
  } | null;
  /** HH:MM local, when known. */
  readonly sunrise: string | null;
  readonly sunset: string | null;
  /** Local holidays and events within a few days, e.g. ['Bonfire Night (Wed)']. */
  readonly holidays: readonly string[];
  readonly block: string;
}

/** A storyline beat assigned to one of the week's planned slots (PRD §3.14.3). */
export interface SlotBeat {
  /** Index into the `slots` passed to `beatsForWeek`. */
  readonly slotIndex: number;
  readonly arcId: string;
  readonly chapterId: string;
  readonly beatId: string;
  readonly chapter: string;
  readonly beat: string;
  readonly tension?: string;
  readonly payoff?: string;
}

/** The concept fingerprint the no-repeat engine embeds per persona (PRD §3.14.5). */
export interface ConceptFingerprint {
  readonly premise: string;
  readonly hookType: string | null;
  readonly topic: string;
  readonly format: PostFormat;
  readonly keyLine: string;
  /** Series episodes must add a new beat: the series name, when the concept is an episode. */
  readonly series?: string | null;
}

export interface NoRepeatResult {
  readonly ok: boolean;
  /** Cosine similarity to the nearest concept (0–1). */
  readonly similarity: number;
  readonly nearest: { readonly id: string; readonly title: string; readonly scope: 'persona' | 'studio'; readonly similarity: number } | null;
  readonly reason?: string;
}

/** The subject of a world check or ledger entry. */
export interface WorldSubject {
  readonly type: 'script' | 'story_frame' | 'reply' | 'remix_brief';
  /** Row id; null for a check before anything is stored. */
  readonly id: string | null;
}

export interface WorldCheckRequest {
  readonly studioId: string;
  readonly personaId: string;
  readonly subject: WorldSubject;
  /** All the text the audience will see or hear (hook, body, caption, on-screen lines, slides). */
  readonly text: string;
  readonly format?: PostFormat;
  /** When it goes out (grounding is checked against this moment). */
  readonly at: Date;
  readonly fingerprint?: ConceptFingerprint;
  /** The visual brief, so wardrobe and light can be checked against the grounding. */
  readonly visualBrief?: string | null;
}

export interface WorldRecordRequest {
  readonly studioId: string;
  readonly personaId: string;
  readonly subject: WorldSubject & { readonly id: string };
  readonly text: string;
  readonly at: Date;
  readonly fingerprint?: ConceptFingerprint;
}

/** A World Bible + storyline drafted in Persona Generator step 6 (stream J owns the shape of `bible` / `storyline`). */
export interface WorldDraft {
  /** One paragraph the Owner reads in the review step. */
  readonly summary: string;
  readonly place: { readonly city: string; readonly region: string | null; readonly country: string; readonly timezone: string };
  readonly bible: Readonly<Record<string, unknown>>;
  readonly storyline: Readonly<Record<string, unknown>>;
}

export interface WorldDraftRequest {
  readonly studioId: string;
  readonly draftId: string;
  readonly niche: string;
  readonly concept: { readonly name: string; readonly archetype: string; readonly premise: string; readonly mechanic: string };
  readonly character: { readonly homeBase: string; readonly lore: string; readonly identity: string } | null;
  readonly timezone?: string | null;
}

export interface WorldService {
  /** Grounding for the persona at `at`; null when it has no World Bible yet. */
  grounding(personaId: string, at: Date): Promise<Grounding | null>;
  /** Storyline beats for a week's planned slots ([] = no storyline). The calendar calls it once per planned week. */
  beatsForWeek(q: {
    readonly personaId: string;
    readonly weekStart: Date;
    readonly slots: ReadonlyArray<{ readonly index: number; readonly at: Date; readonly format: PostFormat; readonly purpose: PostPurpose }>;
  }): Promise<SlotBeat[]>;
  /** World QC (grounding fit, continuity contradictions, no-repeat). Failing blocker/major checks block like Q1 defects. */
  checkContent(q: WorldCheckRequest): Promise<QcCheck[]>;
  /** Logs an approved script / story frame / reply: facts into the continuity ledger, the fingerprint into history. Idempotent per subject. */
  recordApproved(q: WorldRecordRequest): Promise<void>;
  /** The no-repeat check alone (Viral Remix briefs, ideas). */
  checkConcept(q: { readonly studioId: string; readonly personaId: string | null; readonly fingerprint: ConceptFingerprint }): Promise<NoRepeatResult>;
  /** Persona Generator step 6: the World Bible and a ~12-week storyline; null = not available. */
  draftWorld(q: WorldDraftRequest): Promise<WorldDraft | null>;
  /** Writes the approved draft's world for a newly launched persona. Runs inside the launch transaction (`db` is the tx). */
  adoptWorld(db: Db, q: { readonly personaId: string; readonly studioId: string; readonly draft: WorldDraft; readonly actor: Actor }): Promise<void>;
  /**
   * The picked inspiration pins (Pinterest API or the Apify fallback) for a generator draft or a persona, and the
   * descriptors (palette, wardrobe, setting, vibe, age range, styling) the Studio Manager wrote from them. Mood and
   * format only: K passes `descriptors` as ImagePromptSpec.mood and uses `pins` only for the face check that blocks a
   * look too similar to any picked pin (PRD §3.13). Never a face or identity reference.
   */
  moodBoard(q: { readonly draftId?: string | null; readonly personaId?: string | null }): Promise<{ pins: InspirationPin[]; descriptors: string[] }>;
}

/** The fingerprint of a scripted slot (the pipeline and Viral Remix build it the same way). */
export function fingerprintOf(x: { title: string; hookType?: string | null; pillar?: string | null; niche: string; format: PostFormat; hook: string; series?: string | null }): ConceptFingerprint {
  return { premise: x.title, hookType: x.hookType ?? null, topic: x.pillar || x.niche, format: x.format, keyLine: x.hook, series: x.series ?? null };
}

// ───────────────────────────── Production prompt compiler (stream K) ─────────────────────────────

/** Realism camera styles (PRD §3.15.8). Never a locked-off studio camera. */
export const CAMERA_STYLES = [
  'handheld',
  'selfie',
  'mirror',
  'propped_phone',
  'over_shoulder',
  'dashcam',
  'walk_and_talk',
  'doorway_peek',
] as const;
export type CameraStyle = (typeof CAMERA_STYLES)[number];

/** The five image blocks and five video blocks, in order. */
export const IMAGE_PROMPT_BLOCKS = ['subject', 'wardrobe', 'setting', 'camera', 'lighting'] as const;
export const VIDEO_PROMPT_BLOCKS = ['start_frame', 'action', 'camera_motion', 'audio', 'constraints'] as const;
export type ImagePromptBlock = (typeof IMAGE_PROMPT_BLOCKS)[number];
export type VideoPromptBlock = (typeof VIDEO_PROMPT_BLOCKS)[number];

/** Dialogue pace (PRD §3.15.5): 2.5–3 words a second sets the clip length. */
export const SPEECH_WPS = { min: 2.5, max: 3 } as const;
/** Clips are generated at ≤ 10 s each and stitched (Owner, 16 Oct). */
export const CLIP_MAX_S = 10;
/** Seconds of speech for `words` at the slow end of the pace (so a line never gets cut off). */
export const speechSeconds = (words: number): number => Math.ceil((Math.max(0, words) / SPEECH_WPS.min) * 10) / 10;
/** In every video prompt (Owner rule; captions are added in the edit). */
export const NO_CAPTIONS = 'No captions or subtitles, no on-screen text.';

export interface ImagePromptSpec {
  readonly personaId: string;
  /** What happens in the frame, in plain words. */
  readonly scene: string;
  readonly wardrobe?: string | null;
  /** A World Bible place name; K locks it to that place's reference set. */
  readonly location?: string | null;
  readonly camera?: CameraStyle | null;
  readonly grounding?: Grounding | null;
  readonly aspect?: '9:16' | '4:5' | '1:1';
  /**
   * Mood / format descriptors (palette, styling, vibe) from inspiration boards. Text only: pins and scraped creators'
   * images are NEVER a face or identity reference, so they can't be passed here as images.
   */
  readonly mood?: readonly string[];
}

export interface VideoPromptSpec {
  readonly personaId: string;
  /** The still the clip starts from (its asset URL), when chained. */
  readonly startFrameUrl?: string | null;
  readonly startFrame: string;
  readonly action: string;
  /** The verbatim spoken line, for talking clips; null = no speech. */
  readonly line?: string | null;
  /** e.g. 'fluent Yorkshire accent' (required for talking prompts; K falls back to the bible's accent). */
  readonly accent?: string | null;
  readonly camera?: CameraStyle | null;
  /** ≤ CLIP_MAX_S. */
  readonly durationS: number;
  readonly grounding?: Grounding | null;
  readonly location?: string | null;
}

export interface CompiledPrompt {
  readonly text: string;
  readonly blocks: Readonly<Record<string, string>>;
  /** Reference image URLs: the persona's own identity refs and location lock only (never pins or scraped images). */
  readonly references: readonly string[];
  readonly camera: CameraStyle | null;
  /** Guidance for the generator call (e.g. 9:16, guidance 0.8). */
  readonly settings: Readonly<Record<string, string | number>>;
  readonly notes: readonly string[];
}

export interface PromptCompiler {
  image(spec: ImagePromptSpec): Promise<CompiledPrompt>;
  video(spec: VideoPromptSpec): Promise<CompiledPrompt>;
}

// ───────────────────────────── Scraping rules (streams I and J) ─────────────────────────────

/** Ledger provider name for every Apify run (the weekly cap sums these). */
export const APIFY_PROVIDER = 'apify';

export class ApifyWeeklyCapError extends Error {
  override readonly name = 'ApifyWeeklyCapError';
  constructor(readonly details: { usedUsd: number; capUsd: number; requestedUsd: number }) {
    super(`Apify weekly cap reached: $${details.usedUsd.toFixed(2)} of $${details.capUsd.toFixed(2)} used in the last 7 days (this run needs ~$${details.requestedUsd.toFixed(2)})`);
  }
}

/** Apify spend in the trailing 7 days: credit_ledger debits with provider 'apify', plus the holds of runs in flight. */
export async function apifyWeekSpendUsd(db: Db, studioId: string, now: Date): Promise<number> {
  const row = await db.one<{ usd: number | null }>(
    `SELECT COALESCE(sum(amount), 0)::float8 AS usd FROM credit_ledger
      WHERE studio_id = $1 AND provider = $2 AND entry_type IN ('debit','hold') AND created_at > $3`,
    [studioId, APIFY_PROVIDER, new Date(now.getTime() - 7 * 86_400_000)],
  );
  return Number(row.usd ?? 0);
}

/**
 * The only way to run an Apify actor (streams I and J; also the Monetization Agent's market scan). Public data only,
 * low volume (`maxItems` required), no proxies or ban evasion. It refuses past the studio's weekly cap
 * (`settings.apify_weekly_cap_usd`, Owner-only) with ApifyWeeklyCapError (defer the job; never raise the cap), then
 * runs under the governor (`metered`, unit media_usd, provider 'apify') and settles at the run's reported cost
 * (the estimate when the vendor reports none). Items are untrusted: fence them before any agent sees them.
 */
export async function meteredApify(
  services: Pick<ServiceBase, 'db' | 'providers' | 'now'>,
  q: {
    readonly studioId: string;
    readonly personaId?: string | null;
    /** Who is spending (ledger meta.agent), e.g. 'trend-scout', 'radar', 'world'. */
    readonly agent: string;
    readonly ref?: CostRef;
    readonly actor: string;
    readonly input: Record<string, unknown>;
    readonly maxItems: number;
    /** Expected cost: maxItems × the actor's pay-per-result price. */
    readonly estimateUsd: number;
    readonly operation?: string;
  },
): Promise<{ runId: string; items: unknown[]; costUsd: number }> {
  const now = services.now();
  const capUsd = (await getSettings(services.db, q.studioId)).apify_weekly_cap_usd;
  const usedUsd = await apifyWeekSpendUsd(services.db, q.studioId, now);
  if (usedUsd + q.estimateUsd > capUsd) throw new ApifyWeeklyCapError({ usedUsd, capUsd, requestedUsd: q.estimateUsd });
  const res = await metered(
    services.db,
    { studioId: q.studioId, personaId: q.personaId ?? null, agent: q.agent, ref: q.ref },
    { unit: 'media_usd', estimate: q.estimateUsd, provider: APIFY_PROVIDER, operation: q.operation ?? q.actor },
    () => services.providers.research.runActor({ actor: q.actor, input: q.input, maxItems: q.maxItems }),
    (r) => (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) && r.costUsd > 0 ? r.costUsd : q.estimateUsd),
  );
  return { runId: res.runId, items: res.items, costUsd: typeof res.costUsd === 'number' ? res.costUsd : q.estimateUsd };
}

/** Default weekly Apify cap (also DEFAULT_SETTINGS.apify_weekly_cap_usd). */
export const APIFY_DEFAULT_WEEKLY_CAP_USD = 10;

/** Where a platform supports Stories through the publishing API (a capability flag per platform; stream L confirms at runtime). */
export const STORY_PLATFORMS_DEFAULT: Readonly<Record<Platform, boolean>> = { instagram: true, tiktok: false, youtube: false, pinterest: false };
