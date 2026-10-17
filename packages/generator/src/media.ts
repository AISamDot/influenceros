import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StudioServices } from '@troupe/agents';
import { metered, meteredProviders } from '@troupe/core';
import { ELEVENLABS_DESIGN_USD, type FaceMatcher, mediaDeps } from '@troupe/media';
import { bopaPlan, type BopaPlan, type CharacterBrief, coreRefPrompts, detailStripPrompt, identityStackPrompts } from '@troupe/production';
import type { InspirationPin } from '@troupe/providers';
import { placeholderLook, sampleLine, type Steer, sheetPrompt, type VoiceBrief, voiceBriefs } from './fake';
import type { CharacterProfile, ConceptOption, LookCheck, LookProfile, LookStep, VoicePreview } from './types';

/**
 * Look and voice for the generator. With a live Higgsfield adapter the character-sheet variants are real stills
 * (metered against the studio's credit cap) and picking one runs a face-drift check (a second generation of the
 * same sheet compared with Apple Vision feature prints) plus a face check against existing personas' reference
 * images. Without it, the variants are placeholder portraits and the checks say so. Voice previews always go through
 * `providers.voice` (ElevenLabs Voice Design / Higgsfield TTS, or the fake with no key).
 */

const FACE_SAME = 0.6;
/** A sheet whose face is this close to a picked inspiration pin is blocked (PRD §3.13: pins are never a face). */
export const PIN_FACE_MAX = 0.55;

export const higgsfieldLive = (services: StudioServices): boolean => !services.providers.imageVideo.name.startsWith('fake');

/**
 * (IOS-5 stream K) The production identity plan the look step shows next to the sheets: the detail strip, the
 * identity stack (face close-up + 2 full-body), the 4 core references and the BOPA look pack, as prompts. They are
 * generated after launch by `look.build` (Higgsfield, governor); the sheets here are the 5-view production sheet.
 */
export interface LookProduction {
  readonly sheetViews: readonly string[];
  readonly detailStrip: string;
  readonly identity: ReadonlyArray<{ kind: 'face' | 'full_body'; label: string; prompt: string }>;
  readonly core: ReadonlyArray<{ label: string; prompt: string }>;
  readonly bopa: BopaPlan;
  /** Mood descriptors from the draft's inspiration board (text only). */
  readonly mood: readonly string[];
  /** How many picked pins the face check runs against (never used as references). */
  readonly pins: number;
  /** The draft the look was made for (the pin face check reads its mood board). */
  readonly draftId?: string | null;
}

/**
 * The generator draft a look step belongs to. The frozen step code passes no draft id to the look functions, so it is
 * found by the draft's title (the concept's or the character's name, set when they are picked); a plain column, never
 * a scan of the draft state. null when there is none.
 */
export async function lookDraftId(services: StudioServices, studioId: string, names: readonly string[]): Promise<string | null> {
  const wanted = names.filter(Boolean);
  if (!wanted.length) return null;
  const row = await services.db
    .maybeOne<{ id: string }>(`SELECT id FROM persona_draft WHERE studio_id = $1 AND status = 'active' AND title = ANY($2::text[]) ORDER BY updated_at DESC LIMIT 1`, [studioId, wanted])
    .catch(() => null);
  return row?.id ?? null;
}

async function moodFor(services: StudioServices, draftId: string | null): Promise<{ pins: InspirationPin[]; descriptors: string[] }> {
  if (!draftId) return { pins: [], descriptors: [] };
  return services.world.moodBoard({ draftId }).catch(() => ({ pins: [], descriptors: [] }));
}

export function lookProduction(brief: CharacterBrief, pins: number): LookProduction {
  return {
    sheetViews: ['front', 'side', 'back', 'front close-up', 'top-down'],
    detailStrip: detailStripPrompt(brief),
    identity: identityStackPrompts(brief),
    core: coreRefPrompts(brief),
    bopa: bopaPlan(brief),
    mood: brief.mood ?? [],
    pins,
  };
}

/**
 * The face check against the draft's picked pins (PRD §3.13): the sheet's face is compared with the face in each pin;
 * any pin at or above PIN_FACE_MAX blocks the sheet. Pins only ever come in here, never into a generation.
 */
export async function pinFaceCheck(
  face: Pick<FaceMatcher, 'compare' | 'name'>,
  sheetPath: string,
  pins: ReadonlyArray<{ id: string; title: string; path: string | null }>,
): Promise<{ checked: number; nearest: { id: string; title: string; similarity: number } | null; verdict: 'clear' | 'too_similar' | 'not_checked' }> {
  let checked = 0;
  let nearest: { id: string; title: string; similarity: number } | null = null;
  for (const p of pins) {
    if (!p.path) continue;
    const r = await face.compare(p.path, sheetPath).catch(() => ({ faces: 0, similarity: null }));
    if (r.similarity === null) continue;
    checked += 1;
    if (!nearest || r.similarity > nearest.similarity) nearest = { id: p.id, title: p.title, similarity: r.similarity };
  }
  return { checked, nearest, verdict: !checked ? 'not_checked' : nearest && nearest.similarity >= PIN_FACE_MAX ? 'too_similar' : 'clear' };
}

export async function lookVariants(
  services: StudioServices,
  input: { studioId: string; concept: ConceptOption; character: CharacterProfile | null; steer?: Steer; profile?: LookProfile },
): Promise<LookStep> {
  const draftId = await lookDraftId(services, input.studioId, [input.character?.name ?? '', input.concept.name]);
  const board = await moodFor(services, draftId);
  const mood = board.descriptors.slice(0, 6);
  const looked = placeholderLook(input.concept, input.character, input.steer ?? {}, input.profile, mood);
  const brief: CharacterBrief = {
    name: input.character?.name ?? input.concept.name,
    age: input.character?.age ?? input.concept.age,
    anchors: looked.profile.anchors,
    wardrobe: looked.profile.wardrobe,
    settings: looked.profile.settings,
    palette: looked.profile.palette.map((p) => p.name),
    stylisation: looked.profile.stylisation,
    mood,
  };
  const base: LookStep & { production: LookProduction } = { ...looked, production: { ...lookProduction(brief, board.pins.filter((p) => p.imageUrl).length), draftId } };
  if (!higgsfieldLive(services)) return base;
  const hf = meteredProviders(services.db, services.providers, { studioId: input.studioId, agent: 'studio-manager', ref: { type: 'studio', id: input.studioId } }).imageVideo;
  const name = input.character?.name ?? input.concept.name;
  const age = input.character?.age ?? input.concept.age;
  const variants = [];
  for (const [i, v] of base.variants.entries()) {
    const prompt = sheetPrompt(name, age, base.profile, i, mood);
    const still = await hf.generateStill({ prompt, aspect: '1:1', model: 'nano-banana', resolution: '720p' });
    variants.push({ ...v, prompt, url: still.url, provider: 'higgsfield' as const });
  }
  return { ...base, variants };
}

async function fetchTo(url: string, file: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > 15_000_000) return null;
    writeFileSync(file, buf);
    return file;
  } catch {
    return null;
  }
}

/** The drift and face-distinctness check for the picked sheet (live), or a clear "not checked" (placeholders). */
export async function checkLook(
  services: StudioServices,
  input: { studioId: string; look: LookStep; variantId: string; textDistinct: { score: number; nearest: string | null } },
): Promise<LookCheck> {
  const v = input.look.variants.find((x) => x.id === input.variantId);
  const textNote = input.textDistinct.nearest ? `closest look: ${input.textDistinct.nearest}` : 'no close look in the studio or the archive';
  if (!v || v.provider !== 'higgsfield' || !higgsfieldLive(services)) {
    return {
      mode: 'placeholder',
      drift: { similarity: null, verdict: 'not_checked', note: 'Placeholder portraits: the face-drift and inspiration-pin face checks run once Higgsfield is connected.' },
      distinct: { score: input.textDistinct.score, nearest: input.textDistinct.nearest, note: `Anchors, wardrobe and palette compared (${textNote}).` },
    };
  }
  const hf = meteredProviders(services.db, services.providers, { studioId: input.studioId, agent: 'studio-manager', ref: { type: 'studio', id: input.studioId } }).imageVideo;
  const dir = join(tmpdir(), 'troupe-generator', `${Date.now()}-${Math.round(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  const again = await hf.generateStill({ prompt: `${v.prompt} Same character, new angle.`, aspect: '1:1', model: 'nano-banana', resolution: '720p' });
  const a = await fetchTo(v.url, join(dir, 'a.png'));
  const b = await fetchTo(again.url, join(dir, 'b.png'));
  const face = mediaDeps(services).face;
  let drift: LookCheck['drift'] = { similarity: null, verdict: 'not_checked', note: 'Could not download both generations to compare.' };
  if (a && b) {
    const r = await face.compare(a, b);
    drift =
      r.similarity === null
        ? { similarity: null, verdict: 'not_checked', note: `Face comparison unavailable (${face.name}).` }
        : { similarity: r.similarity, verdict: r.similarity >= FACE_SAME ? 'stable' : 'drifting', note: r.similarity >= FACE_SAME ? 'The face holds across generations.' : 'The face drifts between generations: pick another sheet or tighten the anchors.' };
  }
  // Face distinctness: the picked sheet against each persona's stored reference image.
  let nearestFace: { name: string; similarity: number } | null = null;
  if (a) {
    const refs = await services.db.query<{ name: string; reference_key: string }>(
      `SELECT p.name, m.reference_key FROM media_profile m JOIN persona p ON p.id = m.persona_id
        WHERE p.studio_id = $1 AND m.reference_key IS NOT NULL AND p.state NOT IN ('KILLED','RETIRED')`,
      [input.studioId],
    ).catch(() => []);
    for (const ref of refs) {
      const path = await services.providers.storage.localPath(ref.reference_key).catch(() => null);
      if (!path) continue;
      const r = await face.compare(path, a);
      if (r.similarity !== null && (!nearestFace || r.similarity > nearestFace.similarity)) nearestFace = { name: ref.name, similarity: r.similarity };
    }
  }
  const faceClash = nearestFace && nearestFace.similarity >= FACE_SAME;
  // (IOS-5) The face check against the draft's picked inspiration pins: too close to a pin blocks the sheet.
  const board = await moodFor(services, (input.look as LookStep & { production?: LookProduction }).production?.draftId ?? null);
  const pinPaths: Array<{ id: string; title: string; path: string | null }> = [];
  for (const [k, p] of board.pins.filter((x) => x.imageUrl && /^https:\/\//.test(x.imageUrl)).slice(0, 12).entries()) pinPaths.push({ id: p.id, title: p.title, path: await fetchTo(p.imageUrl!, join(dir, `pin-${k}.img`)) });
  const pins = a ? await pinFaceCheck(face, a, pinPaths) : { checked: 0, nearest: null, verdict: 'not_checked' as const };
  const pinClash = pins.verdict === 'too_similar';
  const out: LookCheck & { pins: typeof pins } = {
    mode: 'live',
    drift,
    distinct: {
      score: faceClash || pinClash ? Math.min(input.textDistinct.score, pinClash ? 10 : 20) : input.textDistinct.score,
      nearest: faceClash ? nearestFace!.name : pinClash ? `pin: ${pins.nearest!.title}` : input.textDistinct.nearest,
      note: pinClash
        ? `The face is too close to a picked inspiration pin ("${pins.nearest!.title}", ${pins.nearest!.similarity.toFixed(2)}): pins are mood only, pick another sheet.`
        : faceClash
          ? `The face looks like ${nearestFace!.name} (${nearestFace!.similarity.toFixed(2)}): pick another sheet.`
          : `No face match with existing personas${pins.checked ? ` or the ${pins.checked} picked pin(s)` : ''}; ${textNote}.`,
    },
    pins,
  };
  return out;
}

/**
 * Three voice previews. Each is a Voice Design call plus a TTS sample; with ElevenLabs both are paid, so both go
 * through the governor (design at the ElevenLabs estimate, like media/profile.ts; TTS through meteredProviders).
 */
export async function voicePreviews(services: StudioServices, input: { studioId: string; concept: ConceptOption; steer?: Steer; briefs?: VoiceBrief[] }): Promise<VoicePreview[]> {
  const ctx = { studioId: input.studioId, personaId: null, agent: 'studio-manager', ref: { type: 'studio' as const, id: input.studioId } };
  const raw = services.providers.voice;
  const voice = meteredProviders(services.db, services.providers, ctx).voice;
  const text = sampleLine(input.concept).slice(0, 280);
  const fake = voice.name.startsWith('fake');
  const design = (description: string) =>
    raw.name === 'elevenlabs'
      ? metered(services.db, ctx, { unit: 'media_usd', estimate: ELEVENLABS_DESIGN_USD, provider: raw.name, operation: 'voice_design' }, () => raw.designVoice({ description }), () => ELEVENLABS_DESIGN_USD)
      : raw.designVoice({ description });
  const out: VoicePreview[] = [];
  for (const b of input.briefs ?? voiceBriefs(input.concept, input.steer ?? {})) {
    const designed = await design(b.description);
    const tts = await voice.tts({ voiceId: designed.voiceId, text });
    out.push({ id: b.id, label: b.label, description: b.description, voiceId: designed.voiceId, sampleText: text, url: tts.url, durationS: tts.durationS, provider: voice.name, fake });
  }
  return out;
}
