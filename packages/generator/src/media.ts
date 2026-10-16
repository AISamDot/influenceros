import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StudioServices } from '@ios/agents';
import { meteredProviders } from '@ios/core';
import { mediaDeps } from '@ios/media';
import { placeholderLook, sampleLine, sheetPrompt, voiceBriefs } from './fake';
import type { CharacterProfile, ConceptOption, LookCheck, LookStep, VoicePreview } from './types';

/**
 * Look and voice for the generator. With a live Higgsfield adapter the character-sheet variants are real stills
 * (metered against the studio's credit cap) and picking one runs a face-drift check (a second generation of the
 * same sheet compared with Apple Vision feature prints) plus a face check against existing personas' reference
 * images. Without it, the variants are placeholder portraits and the checks say so. Voice previews always go through
 * `providers.voice` (ElevenLabs Voice Design / Higgsfield TTS, or the fake with no key).
 */

const FACE_SAME = 0.6;

export const higgsfieldLive = (services: StudioServices): boolean => !services.providers.imageVideo.name.startsWith('fake');

export async function lookVariants(services: StudioServices, input: { studioId: string; concept: ConceptOption; character: CharacterProfile | null }): Promise<LookStep> {
  const base = placeholderLook(input.concept, input.character);
  if (!higgsfieldLive(services)) return base;
  const hf = meteredProviders(services.db, services.providers, { studioId: input.studioId, agent: 'studio-manager', ref: { type: 'studio', id: input.studioId } }).imageVideo;
  const name = input.character?.name ?? input.concept.name;
  const age = input.character?.age ?? input.concept.age;
  const variants = [];
  for (const [i, v] of base.variants.entries()) {
    const prompt = sheetPrompt(name, age, base.profile, i);
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
      drift: { similarity: null, verdict: 'not_checked', note: 'Placeholder portraits: the face-drift check runs once Higgsfield is connected.' },
      distinct: { score: input.textDistinct.score, nearest: input.textDistinct.nearest, note: `Anchors, wardrobe and palette compared (${textNote}).` },
    };
  }
  const hf = meteredProviders(services.db, services.providers, { studioId: input.studioId, agent: 'studio-manager', ref: { type: 'studio', id: input.studioId } }).imageVideo;
  const dir = join(tmpdir(), 'ios-generator', `${Date.now()}-${Math.round(Math.random() * 1e6)}`);
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
  return {
    mode: 'live',
    drift,
    distinct: {
      score: faceClash ? Math.min(input.textDistinct.score, 20) : input.textDistinct.score,
      nearest: faceClash ? nearestFace!.name : input.textDistinct.nearest,
      note: faceClash ? `The face looks like ${nearestFace!.name} (${nearestFace!.similarity.toFixed(2)}): pick another sheet.` : `No face match with existing personas; ${textNote}.`,
    },
  };
}

export async function voicePreviews(services: StudioServices, input: { studioId: string; concept: ConceptOption }): Promise<VoicePreview[]> {
  const voice = meteredProviders(services.db, services.providers, { studioId: input.studioId, agent: 'studio-manager', ref: { type: 'studio', id: input.studioId } }).voice;
  const text = sampleLine(input.concept).slice(0, 280);
  const fake = voice.name.startsWith('fake');
  const out: VoicePreview[] = [];
  for (const b of voiceBriefs(input.concept)) {
    const designed = await voice.designVoice({ description: b.description });
    const tts = await voice.tts({ voiceId: designed.voiceId, text });
    out.push({ id: b.id, label: b.label, description: b.description, voiceId: designed.voiceId, sampleText: text, url: tts.url, durationS: tts.durationS, provider: voice.name, fake });
  }
  return out;
}
