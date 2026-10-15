import type { PostFormat } from '@ios/core';
import type { HiggsfieldOperation, MediaResolution } from '@ios/providers';

/**
 * Stream E constants: export sizes, generation settings, platform safe zones and the QC targets (PRD §3.6, owner
 * rules in docs/IOS-34-CONTRACTS.md §1). One place to tune; every check reads from here.
 */

/** Generation resolution for the pilot: Higgsfield renders at 720p; exports upscale with a sharpening pass. */
export const GEN_RESOLUTION: MediaResolution = '720p';

export const EXPORT = {
  video: { width: 1080, height: 1920, fps: 30 },
  /** Carousel slides are 4:5. */
  carousel: { width: 1080, height: 1350 },
} as const;

/**
 * Higgsfield model ids. The CLI's ids change with releases: verify with `higgsfield model list --json` and override
 * any of them with HIGGSFIELD_MODELS='{"talking":"…"}' (JSON) without a code change.
 */
export const DEFAULT_MODELS = {
  /** Soul character stills (character sheet, look pack, in-set stills). */
  soul: 'text2image_soul_v2',
  /** Nano Banana stills (static posts, carousel covers, b-roll start frames). */
  still: 'nano_banana_pro',
  /** Image-to-video activity clips from a start image, in preference order. */
  activity: 'kling3_0_turbo',
  activityFallback: ['kling3_0', 'wan2_5'],
  /** Talking clips with the uploaded voice track (--audio). */
  talking: 'seedance2_0',
  /** Higgsfield TTS (the optional voice provider). */
  tts: 'higgsfield_tts',
} as const;
export type ModelKey = 'soul' | 'still' | 'activity' | 'talking' | 'tts';
export interface MediaModels {
  readonly soul: string;
  readonly still: string;
  readonly activity: string;
  readonly activityFallback: readonly string[];
  readonly talking: string;
  readonly tts: string;
}

export function mediaModels(env: Readonly<Record<string, string | undefined>> = process.env): MediaModels {
  let over: Record<string, unknown> = {};
  try {
    over = env.HIGGSFIELD_MODELS ? (JSON.parse(env.HIGGSFIELD_MODELS) as Record<string, unknown>) : {};
  } catch {
    over = {};
  }
  const pick = (k: ModelKey): string => (typeof over[k] === 'string' && /^[\w.-]{1,80}$/.test(over[k] as string) ? (over[k] as string) : (DEFAULT_MODELS[k] as string));
  const fallback = Array.isArray(over.activityFallback) ? (over.activityFallback as unknown[]).filter((m): m is string => typeof m === 'string') : [...DEFAULT_MODELS.activityFallback];
  return { soul: pick('soul'), still: pick('still'), activity: pick('activity'), activityFallback: fallback, talking: pick('talking'), tts: pick('tts') };
}

/** One Seedance talking clip is at most 15 s, so a 30 s reel is two clips. */
export const TALK_CLIP_MAX_S = 15;
/** Activity clip lengths the image-to-video models take. */
export const CLIP_SECONDS = 5;

/** Per-format timeline targets (seconds). */
export const FORMAT_SPEC: Readonly<Record<PostFormat, { minS: number; maxS: number; kind: 'video' | 'image' | 'carousel' }>> = {
  talking: { minS: 12, maxS: 60, kind: 'video' },
  activity_text: { minS: 6, maxS: 10, kind: 'video' },
  voiceover: { minS: 12, maxS: 60, kind: 'video' },
  static: { minS: 0, maxS: 0, kind: 'image' },
  carousel: { minS: 0, maxS: 0, kind: 'carousel' },
};
export const ACTIVITY_LOOP_S = 8;
export const CAROUSEL_SLIDES = { min: 6, max: 8 } as const;

/**
 * Platform safe zones on a 1080×1920 frame (the union of TikTok, Reels and Shorts UI): nothing important above
 * `top`, below `height - bottom`, or right of `width - right` (the action rail).
 */
export const SAFE_ZONE = { top: 260, bottom: 440, left: 80, right: 160 } as const;

/** QC targets (PRD §3.6). */
export const Q4_TARGETS = {
  lufs: -14,
  lufsTolerance: 1,
  truePeakMax: -1,
  silenceMaxS: 0.7,
  blackMaxS: 0.25,
  freezeMaxS: 0.9,
  fps: 30,
  /** Caption OCR: share of expected words that must be read back. */
  ocrMinMatch: 0.8,
} as const;

export const Q3_TARGETS = {
  /** Face similarity vs the persona reference (Apple Vision feature print; calibrate on the first real renders). */
  faceMin: 0.6,
  freezeMaxS: 0.9,
} as const;

/** Auto-fix loops per stage before the slot is blocked with a report (PRD FR-21.5). */
export const MAX_MEDIA_FIX_LOOPS = 2;

/** Defer a job capped by the governor for 6 h (docs/IOS-34-CONTRACTS.md §5.2). */
export const BUDGET_DEFER_MS = 6 * 3_600_000;

/** ElevenLabs Creator plan: ~$22 for 100k characters (USD per character, list price Oct 2026). */
export const ELEVENLABS_USD_PER_CHAR = 0.00022;
export const ELEVENLABS_MODEL = 'eleven_multilingual_v2';

/** fal Kling AI Avatar v2 (standard) list price, USD per second of output. */
export const FAL_AVATAR_USD_PER_S = 0.0562;

/** Cost-probe grid: the operations and durations the price table holds. */
export const PROBE_GRID: ReadonlyArray<{ operation: HiggsfieldOperation; model: ModelKey; durations: readonly number[] }> = [
  { operation: 'soul_id', model: 'soul', durations: [0] },
  { operation: 'still', model: 'soul', durations: [0] },
  { operation: 'still', model: 'still', durations: [0] },
  { operation: 'image_to_video', model: 'activity', durations: [5, 10] },
  { operation: 'talking_with_audio', model: 'talking', durations: [5, 10, 15] },
];
