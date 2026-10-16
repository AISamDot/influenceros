import {
  type CameraStyle,
  CLIP_MAX_S,
  type CompiledPrompt,
  type Grounding,
  IMAGE_PROMPT_BLOCKS,
  type ImagePromptSpec,
  NO_CAPTIONS,
  type PromptCompiler,
  type QcCheck,
  type ServiceFactory,
  SPEECH_WPS,
  speechSeconds,
  VIDEO_PROMPT_BLOCKS,
  type VideoPromptSpec,
} from '@ios/agents';
import { asksBakedText, hasTimecodes, loadPersonaContext } from '@ios/content';
import type { Db } from '@ios/db';
import { cameraLine, cameraMotionLine, cameraStylesFor, pickCamera } from './camera';
import { identityStackUrls, lockedLocation } from './store';

/**
 * The prompt compiler (PRD §3.15.4, docs/IOS-5-CONTRACTS.md §5): deterministic blocks filled from the bible, the
 * world and the scene. Five image blocks (subject/identity, wardrobe, setting/location lock, camera/lens/realism,
 * lighting/grounding) and five video blocks (start frame, action, camera motion, audio/speech, constraints).
 *
 * Owner rules every compiled prompt keeps: the grounding block (when the persona has a World Bible); "no captions or
 * subtitles" in every video prompt; the accent in every talking prompt; speech at 2.5–3 words a second with no
 * timecodes; clips ≤ 10 s; 720p generation (exported 1080×1920). References are only the persona's own identity
 * stack and the locked location frames: never a pin or a scraped creator's image (ImagePromptSpec takes mood as text).
 */

export interface CompileContext {
  readonly personaId: string;
  readonly name: string;
  /** Hair and 2–3 distinctive features. */
  readonly identity: string;
  readonly outfits: readonly string[];
  readonly settings: readonly string[];
  readonly stylisation: string;
  readonly framing: string;
  /** The bible's accent ("Yorkshire", "soft Scottish accent"), when set. */
  readonly accent: string | null;
  readonly cameraStyles: readonly CameraStyle[];
  /** Identity stack: face close-up + 2 full-body (provider URLs). */
  readonly identityRefs: readonly string[];
  /** The spec's place when it is locked: its anchor frames. */
  readonly location: { readonly place: string; readonly description: string; readonly refs: readonly string[] } | null;
}

/** Constant generation settings (PRD §3.15.4; §1 owner rule: 720p generation, 1080×1920 export). */
export const GENERATION_SETTINGS = { resolution: '720p', guidance: 0.8, export: '1080x1920' } as const;

const ACCENT_BY_COUNTRY: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:united kingdom|uk|england|britain|great britain|wales)\b/i, 'British English'],
  [/\bscotland\b/i, 'Scottish English'],
  [/\b(?:ireland|eire)\b/i, 'Irish English'],
  [/\b(?:united states|usa|us|america)\b/i, 'American English'],
  [/\bcanada\b/i, 'Canadian English'],
  [/\baustralia\b/i, 'Australian English'],
  [/\bnew zealand\b/i, 'New Zealand English'],
  [/\bsouth africa\b/i, 'South African English'],
  [/\bindia\b/i, 'Indian English'],
  [/\bnigeria\b/i, 'Nigerian English'],
];

/** "Yorkshire" → "fluent Yorkshire accent"; "a soft Scottish accent" → "fluent, soft Scottish accent". */
export function accentPhrase(raw: string): string {
  const a = raw
    .replace(/^\s*(?:a|an)\s+/i, '')
    .replace(/^fluent,?\s*/i, '')
    .trim()
    .replace(/[.]+$/, '');
  if (!a) return 'fluent neutral English accent';
  return /\baccent\b/i.test(a) ? `fluent ${a}` : `fluent ${a} accent`;
}

/** The accent for a talking prompt: the spec's, the bible's, the World Bible country's, else neutral English. */
export function resolveAccent(spec: { accent?: string | null }, ctx: Pick<CompileContext, 'accent'>, g: Grounding | null | undefined): string {
  if (spec.accent?.trim()) return accentPhrase(spec.accent);
  if (ctx.accent?.trim()) return accentPhrase(ctx.accent);
  const country = g?.place.country ?? '';
  const hit = ACCENT_BY_COUNTRY.find(([re]) => re.test(country));
  return accentPhrase(hit ? hit[1] : 'neutral English');
}

const TOD_LIGHT: Readonly<Record<Grounding['timeOfDay'], string>> = {
  night: 'night: lamp-lit interior, dark outside any window',
  dawn: 'pale dawn light, the sky just brightening',
  morning: 'soft morning daylight',
  midday: 'bright midday daylight',
  afternoon: 'warm afternoon light',
  evening: 'low evening light',
};

/** The lighting sentence from the persona's real local moment (season, time of day, weather). */
export function lightingLine(g: Grounding | null | undefined): string {
  if (!g) return 'Soft, natural window light';
  const dark = g.weather ? !g.weather.isDay : g.timeOfDay === 'night';
  const light = dark && g.timeOfDay !== 'night' ? `${g.timeOfDay}, after dark: warm indoor lamps, dark outside the window` : TOD_LIGHT[g.timeOfDay];
  const weather = g.weather ? `, ${g.weather.summary.toLowerCase()} outside (${Math.round(g.weather.tempC)}°C)` : '';
  return `Light: ${light}${weather}, ${g.season}`;
}

/** Strips anything that reads like a timecode from free text (actions bind to the words, never to times). */
export function stripTimecodes(text: string): string {
  return text
    .replace(/\[\s*\d+(?:\.\d+)?\s*s?\s*\]/gi, '')
    .replace(/\b\d+(?:\.\d+)?\s?(?:s|secs?)?\s?[-–]\s?\d+(?:\.\d+)?\s?(?:s|secs?|seconds)\s*[:)]\s*/gi, '')
    .replace(/(?<![\d:.])(?!9:16\b)0?\d:[0-5]\d(?::[0-5]\d)?(?!\d|\s?(?:am|pm)\b)\s*[-–:]?\s*/gi, '')
    .replace(/\b(?:at|from|until)\s+\d+(?:\.\d+)?\s?(?:s|secs?|seconds)\b,?\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
const pickOf = <T>(list: readonly T[], seed: string): T | undefined => (list.length ? list[hash(seed) % list.length] : undefined);
const sentence = (s: string) => {
  const t = s.trim().replace(/\s+/g, ' ');
  const u = t ? t[0]!.toUpperCase() + t.slice(1) : t;
  return !u ? '' : /[.!?]$/.test(u) ? u : `${u}.`;
};
const noPeople = (scene: string) => /\bno (?:people|person|one)\b|\bwithout (?:people|anyone)\b/i.test(scene);
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

function settingBlock(spec: { location?: string | null }, ctx: CompileContext, seed: string, mood?: readonly string[]): string {
  const moodLine = mood?.length ? ` Mood and styling (descriptors only): ${mood.slice(0, 6).join(', ')}.` : '';
  if (ctx.location) return `Setting: ${ctx.location.place}, ${ctx.location.description}, exactly as in the locked reference frames (same layout, furniture, window and light direction).${moodLine}`;
  const place = spec.location?.trim() || pickOf(ctx.settings, `${seed}:set`) || 'a bright, lived-in room';
  return `Setting: ${place}, with real depth behind (never a flat backdrop).${moodLine}`;
}

/** Five image blocks, pure (the factory loads the context). */
export function compileImage(spec: ImagePromptSpec, ctx: CompileContext): CompiledPrompt {
  const seed = `${spec.personaId}:${spec.scene}`;
  const camera = spec.camera ?? pickCamera(ctx.cameraStyles, { seed });
  const empty = noPeople(spec.scene);
  const g = spec.grounding ?? null;
  const scene = stripTimecodes(spec.scene);
  const wardrobe = spec.wardrobe?.trim() || pickOf(ctx.outfits, `${seed}:fit`) || 'simple everyday clothes';
  const blocks: Record<(typeof IMAGE_PROMPT_BLOCKS)[number], string> = {
    subject: empty
      ? `Photoreal phone photo, no people in frame: ${sentence(scene)}`
      : `Photoreal phone photo of ${ctx.name}, ${ctx.identity}, the same face, hair and build as the reference images. ${sentence(scene)} One person only; not a lookalike of anyone real.`,
    wardrobe: empty ? 'No people, so no wardrobe in frame.' : `Wearing ${wardrobe}${g ? `, dressed for ${g.season} at ${Math.round(g.weather?.tempC ?? 0)}°C` : ''}.`.replace(/ at 0°C/, ''),
    setting: settingBlock(spec, ctx, seed, spec.mood),
    camera: `${cameraLine(camera)}. ${ctx.stylisation ? sentence(ctx.stylisation) : ''}`.trim(),
    lighting: `${lightingLine(g)}.${g ? ` ${g.block}` : ''} No readable text, logos or watermarks in the image.`,
  };
  const references = [...(empty ? [] : ctx.identityRefs), ...(ctx.location?.refs ?? [])];
  const notes: string[] = [];
  if (!empty && !ctx.identityRefs.length) notes.push('no identity stack yet (character sheet not generated): Soul ID only');
  if (spec.location && !ctx.location) notes.push(`location "${spec.location}" is not locked yet`);
  if (!g) notes.push('no grounding (no World Bible yet)');
  return {
    text: IMAGE_PROMPT_BLOCKS.map((k) => blocks[k]).join(' '),
    blocks,
    references: [...new Set(references)],
    camera,
    settings: { aspect: spec.aspect ?? '9:16', ...GENERATION_SETTINGS },
    notes,
  };
}

/** Five video blocks, pure. Clips are ≤ 10 s; a line that needs longer is flagged to be split (`settings.split`). */
export function compileVideo(spec: VideoPromptSpec, ctx: CompileContext): CompiledPrompt {
  const seed = `${spec.personaId}:${spec.startFrame}:${spec.action}`;
  const camera = spec.camera ?? pickCamera(ctx.cameraStyles, { seed, format: spec.line ? 'talking' : null });
  const g = spec.grounding ?? null;
  const line = spec.line?.trim() ? spec.line.replace(/\s+/g, ' ').trim() : null;
  const accent = line ? resolveAccent(spec, ctx, g) : null;
  const need = line ? speechSeconds(words(line)) : 0;
  const durationS = Math.round(Math.min(CLIP_MAX_S, Math.max(1, spec.durationS, need)) * 10) / 10;
  const split = line && need > CLIP_MAX_S ? Math.ceil(need / CLIP_MAX_S - 1e-9) : 1;
  const where = ctx.location ? `${ctx.location.place}` : spec.location?.trim() || 'the room';
  const blocks: Record<(typeof VIDEO_PROMPT_BLOCKS)[number], string> = {
    start_frame: `Photoreal, natural phone video. Start exactly from the reference still: ${sentence(stripTimecodes(spec.startFrame))} Keep ${ctx.name}'s face, hair, outfit, the setting and the light exactly as in the start frame.`,
    action: line
      ? `${sentence(stripTimecodes(spec.action))} ${ctx.name} says, in a ${accent}, at an easy conversational pace of ${SPEECH_WPS.min}–${SPEECH_WPS.max} words a second: "${line}" Gestures land on the words they go with; natural blinks and small head movements.`
      : `${sentence(stripTimecodes(spec.action))} Subtle, natural motion; small ambient movement in ${where}.`,
    camera_motion: `${cameraMotionLine(camera)}.`,
    audio: line ? `Audio: only ${ctx.name}'s voice in a ${accent}, close and clear, natural room acoustics, no music.` : `Audio: no speech; quiet natural ambience of ${where}, no music.`,
    constraints: `${NO_CAPTIONS} One continuous shot of about ${durationS} s (≤ ${CLIP_MAX_S} s). One person only; hands stay simple and natural.${g ? ` ${lightingLine(g)}. ${g.block}` : ''}`,
  };
  const notes: string[] = [];
  if (split > 1) notes.push(`the line needs ${need} s at ${SPEECH_WPS.min} words a second: split it into ${split} clips of ≤ ${CLIP_MAX_S} s`);
  if (!g) notes.push('no grounding (no World Bible yet)');
  return {
    text: VIDEO_PROMPT_BLOCKS.map((k) => blocks[k]).join(' '),
    blocks,
    // The start frame is the persona's own frame; the face reference is never dropped.
    references: [...new Set([...(spec.startFrameUrl ? [spec.startFrameUrl] : []), ...ctx.identityRefs.slice(0, 1), ...(ctx.location?.refs.slice(0, 1) ?? [])])],
    camera,
    settings: { aspect: '9:16', duration_s: durationS, ...GENERATION_SETTINGS, ...(split > 1 ? { split } : {}) },
    notes,
  };
}

/**
 * The Owner's prompt rules as checks (used by the renderers before paying for a clip, and by tests): no captions
 * line, no timecodes, the accent in talking prompts, ≤ 10 s, speech that fits 2.5–3 words a second.
 */
export function checkVideoPrompt(p: CompiledPrompt, o: { line?: string | null } = {}): QcCheck[] {
  const checks: QcCheck[] = [];
  const add = (check: string, pass: boolean, severity: QcCheck['severity'], message: string) => checks.push({ check, pass, severity, message });
  add('no_captions', p.text.includes(NO_CAPTIONS), 'blocker', p.text.includes(NO_CAPTIONS) ? 'Carries "no captions or subtitles".' : 'Missing the "no captions or subtitles" line.');
  // The writer-facing blocks (the grounding block in `constraints` carries real clock times, never timecodes).
  const scrubbed = ['start_frame', 'action', 'camera_motion', 'audio']
    .map((k) => p.blocks[k] ?? '')
    .join(' ')
    .replace(/"[^"]*"/g, '');
  add('no_timecodes', !hasTimecodes(scrubbed), 'major', hasTimecodes(scrubbed) ? 'Carries a timecode.' : 'No timecodes.');
  add('no_baked_text', !asksBakedText(scrubbed), 'major', asksBakedText(scrubbed) ? 'Asks for text in the generation.' : 'No text baked in.');
  const d = Number(p.settings.duration_s ?? 0);
  add('clip_length', d > 0 && d <= CLIP_MAX_S, 'blocker', `${d} s (max ${CLIP_MAX_S} s).`);
  if (o.line?.trim()) {
    const accent = /\bfluent\b[^.]*\baccent\b/i.test(p.blocks.action ?? '') && /\baccent\b/i.test(p.blocks.audio ?? '');
    add('accent', accent, 'major', accent ? 'Accent stated in the action and audio blocks.' : 'Talking prompt without the accent.');
    const wps = words(o.line) / Math.max(0.1, d);
    const fits = wps <= SPEECH_WPS.max + 0.05;
    add('speech_pace', fits, 'major', `${wps.toFixed(2)} words a second over ${d} s (2.5–3).`);
  }
  return checks;
}

// ───────────────────────────── Context + the StudioServices factory ─────────────────────────────

const asRec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asStrs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []);

/** Everything the compiler needs about a persona (bible look and voice, identity stack, the place's lock). */
export async function loadCompileContext(db: Db, personaId: string, location?: string | null): Promise<CompileContext> {
  const ctx = await loadPersonaContext(db, personaId);
  const look = asRec(ctx.bible.look);
  const voice = asRec(ctx.bible.voice);
  const anchors = [...asStrs(look.anchors), ...asStrs(look.features)].slice(0, 4);
  const identity = anchors.length ? anchors.join(', ') : asStr(look.description) || asStr(look.summary) || `an AI creator for ${ctx.persona.niche}`;
  const lock = await lockedLocation(db, personaId, location);
  return {
    personaId,
    name: ctx.persona.name,
    identity: identity.slice(0, 400),
    outfits: ctx.look.outfits,
    settings: ctx.look.settings,
    stylisation: ctx.look.stylisation,
    framing: ctx.look.framing,
    accent: asStr(voice.accent).trim() || null,
    cameraStyles: cameraStylesFor(ctx.bible, personaId),
    identityRefs: await identityStackUrls(db, personaId),
    location: lock ? { place: lock.place, description: lock.description, refs: lock.refs.map((r) => r.url) } : null,
  };
}

/** The PromptCompiler on StudioServices (`services.prompts`): K's renderers and L's story-frame stills use it. */
export const createPromptCompiler: ServiceFactory<PromptCompiler> = (base, services) => {
  const grounding = async (personaId: string, given: Grounding | null | undefined): Promise<Grounding | null> => {
    if (given !== undefined) return given;
    try {
      return await services().world.grounding(personaId, base.now());
    } catch {
      return null;
    }
  };
  return {
    async image(spec) {
      const ctx = await loadCompileContext(base.db, spec.personaId, spec.location);
      return compileImage({ ...spec, grounding: await grounding(spec.personaId, spec.grounding) }, ctx);
    },
    async video(spec) {
      const ctx = await loadCompileContext(base.db, spec.personaId, spec.location);
      return compileVideo({ ...spec, grounding: await grounding(spec.personaId, spec.grounding) }, ctx);
    },
  };
};
