import { join } from 'node:path';
import { loadPersonaKit, type StudioServices } from '@ios/agents';
import { loadPersonaContext, type PersonaContext } from '@ios/content';
import { BudgetExceededError, notify } from '@ios/core';
import { json } from '@ios/db';
import { readPersonaDoc } from '@ios/core/seed';
import { ELEVENLABS_DESIGN_USD, GEN_RESOLUTION, mediaModels } from './config';
import type { MediaDeps } from './deps';
import { extFor, materialize, storeAsset } from './files';
import { estimateCredits, hfSpend, type SpendScope, usdSpend } from './spend';
import { type ColorGrade, gradeFromKit } from './toolkit';

/**
 * A persona's media identity (FR-5.1): the Soul ID trained from its look prompts, the face reference every talking
 * clip is checked against (Q3), the designed voice, the colour grade from its bible palette, and the look pack.
 * Created automatically the first time a persona needs media; each piece is created once and reused.
 */
export interface MediaProfile {
  personaId: string;
  soulId: string | null;
  soulStatus: 'none' | 'ready' | 'failed';
  referenceKey: string | null;
  voiceProvider: string | null;
  voiceId: string | null;
  grade: ColorGrade;
  lookPrompts: string[];
  meta: Record<string, unknown>;
}

interface Row {
  persona_id: string;
  soul_id: string | null;
  soul_status: MediaProfile['soulStatus'];
  reference_key: string | null;
  voice_provider: string | null;
  voice_id: string | null;
  grade: ColorGrade | Record<string, never>;
  look_prompts: string[];
  meta: Record<string, unknown>;
}

const toProfile = (r: Row): MediaProfile => ({
  personaId: r.persona_id,
  soulId: r.soul_id,
  soulStatus: r.soul_status,
  referenceKey: r.reference_key,
  voiceProvider: r.voice_provider,
  voiceId: r.voice_id,
  grade: r.grade as ColorGrade,
  lookPrompts: r.look_prompts ?? [],
  meta: r.meta ?? {},
});

export async function getProfile(services: StudioServices, personaId: string): Promise<MediaProfile | null> {
  const r = await services.db.maybeOne<Row>('SELECT * FROM media_profile WHERE persona_id = $1', [personaId]);
  return r ? toProfile(r) : null;
}

/** Fenced prompt blocks from the persona's look-prompts doc (launch personas), most important first. */
export function parseLookPrompts(doc: string): string[] {
  const out: string[] = [];
  for (const m of doc.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    const p = m[1]!.trim();
    if (p.length >= 40) out.push(p.slice(0, 3500));
  }
  return out;
}

/** Whether a bible was written by the Persona Generator (no source documents on disk). */
export const fromGenerator = (bible: Record<string, unknown> | null | undefined): boolean =>
  String((bible?.source_document as { file?: unknown } | undefined)?.file ?? '').startsWith('generator/');

/**
 * Look prompts for Soul ID training: the launch doc's prompts; else the Persona Generator's character-sheet prompt
 * (the sheet the Owner picked) plus a portrait; else a character sheet built from the bible's look.
 */
export function lookPromptsFor(ctx: PersonaContext, doc: string): string[] {
  const fromDoc = parseLookPrompts(doc);
  if (fromDoc.length) return fromDoc.slice(0, 3);
  const { look, persona } = ctx;
  const sheet = ((ctx.bible?.look as Record<string, unknown> | undefined)?.character_sheet as { prompt?: unknown } | null | undefined)?.prompt;
  if (typeof sheet === 'string' && sheet.trim().length >= 40) {
    return [
      sheet.trim().slice(0, 3500),
      `Photorealistic portrait of ${persona.name}, ${look.framing || 'chest-up'}, in ${look.settings[0] ?? 'a bright home office'}, wearing ${look.outfits[0] ?? 'smart casual clothes'}, looking at the camera, natural expression, ${look.stylisation || 'soft natural light'}. One person only, no text, no logos.`,
    ];
  }
  const outfit = look.outfits[0] ?? 'smart casual clothes';
  return [
    `Photorealistic character reference sheet, three panels on a seamless white studio background, the same person in all three panels: front view, three-quarter view, head-and-shoulders close-up. ${persona.name}, an AI creator for ${persona.niche}. ${look.stylisation || 'Photoreal, soft natural light'}. Wearing ${outfit}. One person only, fully clothed, no logos, no readable text.`,
    `Photorealistic portrait of ${persona.name}, ${look.framing || 'chest-up'}, in ${look.settings[0] ?? 'a bright home office'}, wearing ${outfit}, looking at the camera, natural expression, ${look.stylisation || 'soft natural light'}. One person only, no text, no logos.`,
  ];
}

export function voiceDescription(ctx: PersonaContext): string {
  const v = (ctx.bible.voice ?? {}) as Record<string, unknown>;
  const timbre = [v.timbre, v.accent, v.description].filter((x): x is string => typeof x === 'string').join('; ');
  return `${ctx.persona.name}, an English-speaking ${ctx.persona.niche} creator. ${timbre ? `${timbre}. ` : ''}Delivery: ${ctx.voice.energy || 'warm and clear'}, about ${ctx.voice.wpm} words per minute. Natural, close-mic, no music.`.slice(0, 900);
}

/** Soul ID training failures before the daily prepare stops retrying (the Owner retries by hand). */
export const SOUL_ID_MAX_FAILURES = 3;

/**
 * Ensures the profile has a grade, a voice and (with `soul`) a Soul ID plus a face reference. Idempotent: each step
 * runs once and is stored before the next; paid steps go through the governor (a cap defers the caller's job).
 */
export async function ensureProfile(
  services: StudioServices,
  deps: MediaDeps,
  scope: SpendScope,
  opts: { soul: boolean; voice: boolean; retrySoul?: boolean },
): Promise<MediaProfile> {
  const { db } = services;
  const personaId = scope.personaId;
  // A persona's identity is persona overhead, not the cost of the post that happened to need it first.
  scope = { ...scope, slotId: null, ref: { type: 'persona', id: personaId } };
  let row = await db.maybeOne<Row>('SELECT * FROM media_profile WHERE persona_id = $1', [personaId]);
  if (!row || !row.grade || !('contrast' in row.grade)) {
    const kit = await loadPersonaKit(db, personaId);
    row = await db.one<Row>(
      `INSERT INTO media_profile (persona_id, grade) VALUES ($1, $2::jsonb)
       ON CONFLICT (persona_id) DO UPDATE SET grade = EXCLUDED.grade, updated_at = now() RETURNING *`,
      [personaId, json(gradeFromKit(kit))],
    );
  }
  let ctx: PersonaContext | null = null;
  const context = async () => (ctx ??= await loadPersonaContext(db, personaId));

  if (opts.voice && !row.voice_id) {
    const voice = services.providers.voice;
    const description = voiceDescription(await context());
    // ElevenLabs voice design generates paid previews: metered with an estimate. Higgsfield presets are free.
    const { voiceId } =
      voice.name === 'elevenlabs'
        ? await usdSpend(services, scope, { operation: 'voice_design', provider: voice.name, estimate: ELEVENLABS_DESIGN_USD }, async () => ({ ...(await voice.designVoice({ description })), costUsd: ELEVENLABS_DESIGN_USD }))
        : await voice.designVoice({ description });
    row = await db.one<Row>(`UPDATE media_profile SET voice_id = $2, voice_provider = $3, updated_at = now() WHERE persona_id = $1 RETURNING *`, [personaId, voiceId, services.providers.voice.name]);
  }

  if (opts.soul && row.soul_status === 'failed' && !opts.retrySoul) {
    throw new Error(`Soul ID training failed ${SOUL_ID_MAX_FAILURES} times for this persona; it waits for the Owner to retry (each try buys new stills)`);
  }
  if (opts.soul && row.soul_status !== 'ready') {
    const c = await context();
    // The look prompts doc wherever it lives (seed folder, else the archive a restored persona came from); a
    // Persona Generator persona has none and uses its character-sheet prompt.
    const prompts = lookPromptsFor(c, readPersonaDoc(c.persona.slug, 'lookPrompts', undefined, { archive: !fromGenerator(c.bible) }));
    const models = mediaModels();
    const hf = services.providers.imageVideo;
    let soul: { soulId: string };
    try {
      soul = await hfSpend(
        services,
        scope,
        { operation: 'soul_id', model: models.soul, extraEstimate: prompts.length * (await estimateCredits(db, { operation: 'still', model: models.soul })) },
        () => hf.createSoulId({ name: c.persona.name, referenceImageUrls: [], prompts }),
      );
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      // Every failed try buys new character-sheet stills: after SOUL_ID_MAX_FAILURES the daily prepare stops retrying
      // and the Owner is told.
      const failures = (Number((row.meta as Record<string, unknown> | null)?.soul_failures) || 0) + 1;
      const failed = failures >= SOUL_ID_MAX_FAILURES;
      await db.query(
        `UPDATE media_profile SET meta = meta || $2::jsonb, soul_status = CASE WHEN $3 THEN 'failed' ELSE soul_status END, updated_at = now() WHERE persona_id = $1`,
        [personaId, json({ soul_failures: failures, soul_error: (err instanceof Error ? err.message : String(err)).slice(0, 300) }), failed],
      );
      if (failed) {
        await notify(db, {
          studioId: scope.studioId,
          personaId,
          kind: 'system',
          severity: 'warn',
          title: `Soul ID training failed ${failures} times: ${c.persona.name}`.slice(0, 160),
          body: `The daily media prepare stopped retrying (each try buys new stills). Last error: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`,
          link: `/personas/${c.persona.slug}`,
        });
      }
      throw err;
    }
    row = await db.one<Row>(
      `UPDATE media_profile SET soul_id = $2, soul_status = 'ready', look_prompts = $3::jsonb, meta = meta - 'soul_failures' - 'soul_error', updated_at = now() WHERE persona_id = $1 RETURNING *`,
      [personaId, soul.soulId, json(prompts)],
    );
  }

  if (opts.soul && row.soul_id && !row.reference_key) {
    const c = await context();
    const models = mediaModels();
    const prompt = `Photorealistic head-and-shoulders portrait of ${c.persona.name} facing the camera, even soft light, plain light background, sharp focus on the face. One person only, no text.`;
    const still = await hfSpend(services, scope, { operation: 'still', model: models.soul }, () =>
      services.providers.imageVideo.generateStill({ soulId: row!.soul_id!, prompt, aspect: '9:16', model: models.soul, resolution: GEN_RESOLUTION }),
    );
    const file = await materialize(services, deps.toolkit, still.url, join(deps.workRoot, 'profiles', personaId, 'reference.png'), { kind: 'image' });
    const key = `media/${personaId}/profile/reference${extFor('image/png')}`;
    const asset = await storeAsset(services, { personaId, key, file, contentType: 'image/png', type: 'image', role: 'reference', provider: services.providers.imageVideo.name, credits: still.credits, tools: [services.providers.imageVideo.name], meta: deps.toolkit.name === 'fake-toolkit' ? { fake: true } : {} });
    row = await db.one<Row>(`UPDATE media_profile SET reference_key = $2, updated_at = now() WHERE persona_id = $1 RETURNING *`, [personaId, key]);
    // The real face replaces the generated placeholder portrait (a data: URI from the seed), never an Owner-set one.
    // Fake renders (no keys) keep the placeholder: their files are stand-ins, not images.
    if (deps.toolkit.name !== 'fake-toolkit')
      await db.query(`UPDATE persona SET portrait_url = $2, updated_at = now() WHERE id = $1 AND (portrait_url IS NULL OR portrait_url LIKE 'data:%')`, [personaId, asset.url]);
  }
  return toProfile(row);
}

/**
 * The look pack: one in-set still per setting and outfit (Soul ID), stored as `persona.look_pack` when that is still
 * the seed's placeholder. Talking reels start from these looks.
 */
export async function buildLookPack(services: StudioServices, deps: MediaDeps, scope: SpendScope, profile: MediaProfile, max = 3): Promise<Array<{ label: string; url: string }>> {
  if (!profile.soulId) return [];
  const c = await loadPersonaContext(services.db, scope.personaId);
  const models = mediaModels();
  const pack: Array<{ label: string; url: string }> = [];
  const settings = c.look.settings.length ? c.look.settings : ['a bright home office'];
  for (let i = 0; i < Math.min(max, Math.max(settings.length, c.look.outfits.length, 1)); i++) {
    const setting = settings[i % settings.length]!;
    const outfit = c.look.outfits[i % Math.max(1, c.look.outfits.length)] ?? 'smart casual clothes';
    const still = await hfSpend(services, scope, { operation: 'still', model: models.soul }, () =>
      services.providers.imageVideo.generateStill({
        soulId: profile.soulId!,
        prompt: `${c.persona.name} in ${setting}, wearing ${outfit}, ${c.look.framing || 'chest-up'}, ${c.look.stylisation || 'photoreal, soft natural light'}. One person only, no text, no logos.`,
        aspect: '9:16',
        model: models.soul,
        resolution: GEN_RESOLUTION,
      }),
    );
    const file = await materialize(services, deps.toolkit, still.url, join(deps.workRoot, 'profiles', scope.personaId, `look-${i}.png`), { kind: 'image' });
    const a = await storeAsset(services, { personaId: scope.personaId, key: `media/${scope.personaId}/profile/look-${i + 1}.png`, file, contentType: 'image/png', type: 'image', role: 'look', provider: services.providers.imageVideo.name, credits: still.credits, tools: [services.providers.imageVideo.name], meta: { setting, outfit, ...(deps.toolkit.name === 'fake-toolkit' ? { fake: true } : {}) } });
    pack.push({ label: `${setting} · ${outfit}`, url: a.url });
  }
  if (deps.toolkit.name !== 'fake-toolkit')
    await services.db.query(
    `UPDATE persona SET look_pack = $2::jsonb, updated_at = now() WHERE id = $1 AND (look_pack = '[]'::jsonb OR look_pack::text LIKE '%data:%')`,
    [scope.personaId, json(pack)],
  );
  return pack;
}
