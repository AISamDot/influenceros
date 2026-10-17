import { join } from 'node:path';
import { loadPersonaKit, type StudioServices } from '@troupe/agents';
import { loadPersonaContext, type PersonaContext } from '@troupe/content';
import { BudgetExceededError, notify } from '@troupe/core';
import { json } from '@troupe/db';
import { readPersonaDoc } from '@troupe/core/seed';
import { ELEVENLABS_DESIGN_USD, GEN_RESOLUTION, mediaModels } from './config';
import type { MediaDeps } from './deps';
import { extFor, materialize, storeAsset } from './files';
import { estimateCredits, hfSpend, type SpendScope, usdSpend } from './spend';
import { type ColorGrade, gradeFromKit } from './toolkit';
import { Q3_TARGETS } from './config';
import {
  bopaPlan,
  type CharacterBrief,
  characterSheetPrompt,
  coreRefPrompts,
  defaultPick,
  detailStripPrompt,
  ensureLocations,
  type IdentityKind,
  type IdentityRef,
  identityRefs,
  identityStackPrompts,
  locationAnchorPrompt,
  locationCandidatePrompts,
  locationLocks,
  lockLocation,
  personaPlaces,
  placeKey,
  saveIdentityRef,
  upscaleCellPrompt,
} from '@troupe/production';

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

// ───────────────────────────── IOS-5 stream K: production identity and location lock ─────────────────────────────

const asRec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []);

/** The character brief the production prompts are written from (the bible's look; mood descriptors as text only). */
export async function characterBrief(services: StudioServices, personaId: string): Promise<CharacterBrief> {
  const c = await loadPersonaContext(services.db, personaId);
  const look = asRec(c.bible.look);
  const identity = asRec(c.bible.identity);
  const palette = (Array.isArray(look.palette) ? look.palette : []).map((p) => (typeof p === 'string' ? p : String(asRec(p).name ?? ''))).filter(Boolean);
  const mood = await services.world.moodBoard({ personaId }).catch(() => ({ descriptors: [] as string[] }));
  return {
    name: c.persona.name,
    age: typeof identity.age === 'number' || typeof identity.age === 'string' ? (identity.age as number | string) : null,
    anchors: [...strs(look.anchors), ...strs(look.features)].slice(0, 4),
    wardrobe: c.look.outfits,
    settings: c.look.settings,
    palette,
    stylisation: c.look.stylisation,
    mood: mood.descriptors.slice(0, 6),
  };
}

/**
 * The production identity (PRD §3.15.2, §3.12 BOPA), each piece made once and stored in `production_identity`:
 * the 5-view character sheet, the detail strip, the identity stack (face close-up + 2 full-body), 4 core references in
 * varied settings, and the BOPA look pack (a 3×3 background grid with the pick upscaled, keep-identity outfit edits, a
 * 2×2 pose grid with the pick upscaled, and angles in degrees). Grids are picked automatically (the Owner can re-pick
 * with `look.pick`). Identity shots that drift from the face reference stay candidates, never in the stack.
 * Paid stills go through the governor (persona overhead); a cap refusal propagates so the job defers.
 */
export async function buildProductionIdentity(services: StudioServices, deps: MediaDeps, scope: SpendScope, profile: MediaProfile): Promise<{ made: number; total: number }> {
  if (!profile.soulId) return { made: 0, total: 0 };
  const { db } = services;
  const personaId = scope.personaId;
  scope = { ...scope, slotId: null, ref: { type: 'persona', id: personaId } };
  const brief = await characterBrief(services, personaId);
  const models = mediaModels();
  const hf = services.providers.imageVideo;
  const fake = deps.toolkit.name === 'fake-toolkit';
  const refPath = profile.referenceKey ? await services.providers.storage.localPath(profile.referenceKey).catch(() => null) : null;
  let made = 0;
  let total = 0;
  const have = async (kind: IdentityKind, label: string) =>
    (await identityRefs(db, personaId, [kind])).find((r) => r.label === label.slice(0, 200)) ?? null;

  const make = async (kind: IdentityKind, label: string, prompt: string, o: { aspect: '9:16' | '1:1' | '4:5'; refs?: readonly string[]; check?: boolean; meta?: Record<string, unknown> }): Promise<IdentityRef> => {
    total += 1;
    const existing = await have(kind, label);
    if (existing) return existing;
    const refs = [...new Set((o.refs ?? []).filter(Boolean))];
    const still = await hfSpend(services, scope, { operation: 'still', model: models.soul }, () =>
      hf.generateStill({ soulId: profile.soulId!, prompt, aspect: o.aspect, model: models.soul, resolution: GEN_RESOLUTION, ...(refs.length ? { referenceImageUrls: refs } : {}) }),
    );
    const safe = `${kind}-${label}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
    const file = await materialize(services, deps.toolkit, still.url, join(deps.workRoot, 'profiles', personaId, `${safe}.png`), { kind: 'image' });
    const asset = await storeAsset(services, {
      personaId,
      key: `media/${personaId}/production/${safe}.png`,
      file,
      contentType: 'image/png',
      type: 'image',
      role: 'identity',
      provider: hf.name,
      credits: still.credits,
      tools: [hf.name],
      meta: { kind, label, ...(fake ? { fake: true } : {}) },
    });
    // QC: an identity shot whose face drifted from the reference never joins the stack (it stays a candidate).
    let status: 'active' | 'candidate' = 'active';
    let similarity: number | null = null;
    if (o.check && refPath) {
      const r = await deps.face.compare(refPath, file);
      similarity = r.similarity;
      if (r.faces !== 1 || r.similarity === null || r.similarity < Q3_TARGETS.faceMin) status = 'candidate';
    }
    made += 1;
    return saveIdentityRef(db, { personaId, kind, label, prompt, url: still.url, assetKey: asset.key, status, meta: { ...(o.meta ?? {}), similarity, asset_url: asset.url, ...(fake ? { fake: true } : {}) } });
  };

  const sheet = await make('sheet', '5-view sheet', characterSheetPrompt(brief), { aspect: '1:1' });
  await make('detail_strip', 'detail strip', detailStripPrompt(brief), { aspect: '1:1', refs: [sheet.url] });
  const stack: IdentityRef[] = [];
  for (const s of identityStackPrompts(brief)) stack.push(await make(s.kind, s.label, s.prompt, { aspect: s.kind === 'face' ? '4:5' : '9:16', refs: [sheet.url], check: true }));
  const stackUrls = stack.filter((r) => r.status === 'active').map((r) => r.url);
  const core: IdentityRef[] = [];
  for (const c of coreRefPrompts(brief)) core.push(await make('core', c.label, c.prompt, { aspect: '9:16', refs: stackUrls, check: true }));

  // BOPA.
  const plan = bopaPlan(brief);
  const bgGrid = await make('bopa_background_grid', 'backgrounds 3x3', plan.backgrounds.gridPrompt, { aspect: '1:1', refs: stackUrls, meta: { cells: plan.backgrounds.cells } });
  const bgPick = typeof bgGrid.meta.pick === 'number' ? (bgGrid.meta.pick as number) : defaultPick(`${personaId}:bg`, 3);
  await make('bopa_background', `background ${bgPick + 1}`, upscaleCellPrompt(plan.backgrounds.cells[bgPick] ?? plan.backgrounds.cells[0]!, bgPick, 3, 'background'), {
    aspect: '9:16',
    refs: [bgGrid.url, ...stackUrls.slice(0, 1)],
    check: true,
    meta: { cell: bgPick, grid: bgGrid.id },
  });
  const base = core.find((c) => c.status === 'active') ?? stack[0];
  for (const o of plan.outfits) await make('bopa_outfit', o.label, o.prompt, { aspect: '9:16', refs: [...(base ? [base.url] : []), ...stackUrls.slice(0, 1)], check: true });
  const poseGrid = await make('bopa_pose_grid', 'poses 2x2', plan.poses.gridPrompt, { aspect: '1:1', refs: stackUrls, meta: { cells: plan.poses.cells } });
  const posePick = typeof poseGrid.meta.pick === 'number' ? (poseGrid.meta.pick as number) : defaultPick(`${personaId}:pose`, 2);
  await make('bopa_pose', `pose ${posePick + 1}`, upscaleCellPrompt(plan.poses.cells[posePick] ?? plan.poses.cells[0]!, posePick, 2, 'pose'), { aspect: '9:16', refs: [poseGrid.url, ...stackUrls.slice(0, 1)], check: true, meta: { cell: posePick, grid: poseGrid.id } });
  for (const a of plan.angles) await make('bopa_angle', a.label, a.prompt, { aspect: '9:16', refs: stackUrls, check: true, meta: { degrees: a.degrees } });

  // The look pack the dashboard shows: the BOPA picks and outfits (real renders only; fakes keep the placeholder).
  if (!fake) {
    const pack = (await identityRefs(db, personaId, ['bopa_background', 'bopa_outfit', 'bopa_pose', 'bopa_angle']))
      .filter((r) => r.status === 'active')
      .map((r) => ({ label: r.label, url: String(r.meta.asset_url ?? r.url) }));
    if (pack.length) await db.query(`UPDATE persona SET look_pack = $2::jsonb, updated_at = now() WHERE id = $1`, [personaId, json(pack)]);
  }
  await db.query(`UPDATE media_profile SET meta = meta || '{"identity_done": true}'::jsonb WHERE persona_id = $1`, [personaId]);
  return { made, total };
}

/**
 * The location lock (PRD §3.15.3): each recurring place (World Bible places, then the bible's settings; at most 5)
 * gets 5 candidates from one prompt, a pick (automatic, or the Owner's `location.lock` re-pick) and a second anchor
 * angle referencing the pick; the pick and the angle become the place's locked reference set. No people in anchor
 * frames. Stills go through the governor.
 */
export async function lockPersonaLocations(
  services: StudioServices,
  deps: MediaDeps,
  scope: SpendScope,
  opts: { place?: string | null; pick?: number | null } = {},
): Promise<{ locked: number; pending: number }> {
  const { db } = services;
  const personaId = scope.personaId;
  scope = { ...scope, slotId: null, ref: { type: 'persona', id: personaId } };
  const c = await loadPersonaContext(db, personaId);
  await ensureLocations(db, personaId, await personaPlaces(db, personaId, c.look.settings));
  const models = mediaModels();
  const hf = services.providers.imageVideo;
  const fake = deps.toolkit.name === 'fake-toolkit';
  const still = async (prompt: string, name: string, refs: readonly string[] = []) => {
    const r = await hfSpend(services, scope, { operation: 'still', model: models.still }, () =>
      hf.generateStill({ prompt, aspect: '9:16', model: models.still, resolution: GEN_RESOLUTION, ...(refs.length ? { referenceImageUrls: [...refs] } : {}) }),
    );
    const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 70);
    const file = await materialize(services, deps.toolkit, r.url, join(deps.workRoot, 'profiles', personaId, 'locations', `${safe}.png`), { kind: 'image' });
    const a = await storeAsset(services, { personaId, key: `media/${personaId}/locations/${safe}.png`, file, contentType: 'image/png', type: 'image', role: 'location', provider: hf.name, credits: r.credits, tools: [hf.name], meta: { place: name, ...(fake ? { fake: true } : {}) } });
    return { url: r.url, assetKey: a.key };
  };
  const wanted = opts.place ? placeKey(opts.place) : null;
  let lockedNow = 0;
  for (const l of await locationLocks(db, personaId)) {
    if (wanted ? l.placeKey !== wanted : l.status === 'locked') continue;
    // One prompt across 5 variations (made once; a re-pick reuses them).
    const candidates: Array<{ label: string; prompt: string; url: string; assetKey: string | null }> = [...l.candidates];
    for (const [i, cand] of locationCandidatePrompts(l.place, l.description, c.look.stylisation).entries()) {
      if (i < candidates.length) continue;
      candidates.push({ ...cand, ...(await still(cand.prompt, `${l.placeKey}-candidate-${i + 1}`)) });
      // Stored as they come, so a deferred job never buys the same candidate twice.
      await db.query(`UPDATE location_lock SET candidates = $3::jsonb, updated_at = now() WHERE persona_id = $1 AND place_key = $2`, [personaId, l.placeKey, json(candidates)]);
    }
    const pick = Math.max(0, Math.min(candidates.length - 1, opts.pick ?? defaultPick(`${personaId}:${l.placeKey}`, 2) % candidates.length));
    const chosen = candidates[pick]!;
    const anchor = await still(locationAnchorPrompt(l.place, l.description), `${l.placeKey}-anchor-${pick + 1}`, [chosen.url]);
    await lockLocation(db, personaId, l.placeKey, {
      refs: [
        { url: chosen.url, assetKey: chosen.assetKey, angle: 'doorway wide' },
        { url: anchor.url, assetKey: anchor.assetKey, angle: 'opposite corner' },
      ],
      candidates,
      chosen: pick,
      at: services.now(),
    });
    lockedNow += 1;
  }
  const all = await locationLocks(db, personaId);
  return { locked: lockedNow, pending: all.filter((x) => x.status === 'pending').length };
}
