import { join } from 'node:path';
import { enqueueOnceFor, loadPersonaKit, type MediaRenderPayload, PUBLISH_PREPARE_JOB, type PublishPreparePayload, type QcCheck, type RenderedMedia, type StudioServices } from '@ios/agents';
import { loadPersonaContext, type PersonaContext, saveQcReport, voiceCheck } from '@ios/content';
import { BudgetExceededError, DeferJob, notify, type PostFormat, propose } from '@ios/core';
import { json } from '@ios/db';
import {
  ACTIVITY_LOOP_S,
  BUDGET_DEFER_MS,
  CAROUSEL_SLIDES,
  CLIP_SECONDS,
  ELEVENLABS_USD_PER_CHAR,
  EXPORT,
  FAL_AVATAR_USD_PER_S,
  GEN_RESOLUTION,
  higgsfieldTtsCredits,
  MAX_MEDIA_FIX_LOOPS,
  mediaModels,
  TALK_CLIP_MAX_S,
} from './config';
import { type MediaDeps, mediaDeps, talkingProvider } from './deps';
import { extFor, localOf, materialize, storeAsset, workDir } from './files';
import { ensureProfile, type MediaProfile } from './profile';
import { gradeQ3, gradeQ4, type OcrSample, type Q3Clip, type Q4Fix } from './qc';
import { hfSpend, type SpendScope, usdSpend } from './spend';
import { captionCues, type CardSpec, placeText, round2, type Segment, splitSpeech, type TextBox, type VideoComposition } from './toolkit';

/**
 * The media.render job (docs/IOS-34-CONTRACTS.md §5.1): voice → Q2 → generate (Higgsfield, governor) → Q3 (talking)
 * → render (FFmpeg/sharp) → Q4, with at most 2 maker fix loops per stage, then either blocked (report + Owner
 * notification) or `final_gate` with the cover on the board and exactly one `publish.prepare` handed to distribution.
 *
 * Every step stores its result in `media_render.state` before the next starts, so a retried or resumed job never
 * pays for the same generation twice. A governor refusal defers the job 6 h; the slot shows what it waits for.
 */

export const SPOKEN_FORMATS: readonly PostFormat[] = ['talking', 'voiceover'];
const MEDIA_STATUSES = ['media_queued', 'voice', 'q2', 'rendering', 'render', 'q3', 'q4', 'qc'];
const DONE_STATUSES = ['final_gate', 'scheduled', 'live'];

interface GenItem {
  key: string;
  url: string;
  kind: 'image' | 'video';
  durationS: number | null;
  assetId: string;
  credits: number;
  usd: number;
}

interface RenderState {
  voice?: { assetId: string; key: string; providerUrl: string; durationS: number; voiceId: string; q2ReportId?: string };
  gen?: Record<string, GenItem>;
  talk?: Array<{ ref: string; text: string; startS: number; endS: number }>;
  q3ReportId?: string;
  final?: { kind: 'video' | 'image' | 'carousel'; assetIds: string[]; keys: string[]; texts: TextBox[]; slideTexts?: TextBox[][]; durationS: number | null; segments: Array<{ ref?: string; startS: number; durationS: number }> };
  textScale?: number;
  version?: number;
}

interface RenderRow {
  slot_id: string;
  persona_id: string;
  script_id: string | null;
  format: PostFormat;
  step: string;
  state: RenderState;
  loops: Record<string, number>;
}

export interface RenderOutcome {
  readonly slotId: string;
  readonly status: 'final_gate' | 'blocked' | 'skipped' | 'unchanged' | 'stopped';
  readonly reason?: string;
  readonly q4ReportId?: string;
  readonly publishJobId?: string | null;
  readonly media?: readonly RenderedMedia[];
  readonly loops?: Record<string, number>;
}

class Blocked extends Error {
  constructor(
    readonly reason: string,
    readonly reportId: string | null,
  ) {
    super(reason);
  }
}
class Stopped extends Error {}

const failing = (checks: readonly QcCheck[]) =>
  checks
    .filter((c) => !c.pass && c.severity !== 'minor')
    .map((c) => `${c.check.replace(/_/g, ' ')}: ${c.message}${c.location ? ` @${c.location}` : ''}`)
    .join('; ');

/** Runs or resumes the render of one slot. */
export async function renderSlot(services: StudioServices, payload: MediaRenderPayload, opts: { heartbeat?: () => Promise<boolean>; deps?: MediaDeps } = {}): Promise<RenderOutcome> {
  const { db } = services;
  const slotId = payload.slotId;
  const slot = await db.maybeOne<{ id: string; persona_id: string; status: string; title: string; script_id: string | null; block_reason: string | null }>(
    'SELECT id, persona_id, status, title, script_id, block_reason FROM calendar_slot WHERE id = $1',
    [slotId],
  );
  if (!slot) return { slotId, status: 'unchanged', reason: 'slot not found' };
  if (DONE_STATUSES.includes(slot.status)) return { slotId, status: 'unchanged', reason: `already ${slot.status}` };
  if (slot.script_id && slot.script_id !== payload.scriptId) return { slotId, status: 'unchanged', reason: 'superseded by a newer script' };
  if (!MEDIA_STATUSES.includes(slot.status)) return { slotId, status: 'unchanged', reason: `slot is ${slot.status}` };

  const persona = await db.one<{ studio_id: string; state: string; name: string; slug: string }>('SELECT studio_id, state, name, slug FROM persona WHERE id = $1', [slot.persona_id]);
  if (['KILLED', 'RETIRED'].includes(persona.state)) {
    await setSlot(services, slotId, 'skipped', { blockReason: `persona is ${persona.state}` });
    return { slotId, status: 'skipped' };
  }

  // Never mix a live voice with fake generations (or the reverse) on a spoken post: real money would buy a track the
  // rest of the pipeline can't use. Wait for the missing key instead (the slot shows which).
  const spokenFormat = SPOKEN_FORMATS.includes(payload.format) && !!payload.voiceover;
  const fakeHf = services.providers.imageVideo.name.startsWith('fake');
  if (spokenFormat && fakeHf !== services.providers.voice.name.startsWith('fake')) {
    const waiting = `pending key: ${fakeHf ? 'higgsfield.api_key + higgsfield.api_secret' : 'elevenlabs.api_key'}`;
    await db.query(
      `INSERT INTO media_render (slot_id, persona_id, script_id, format, waiting) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (slot_id) DO UPDATE SET waiting = EXCLUDED.waiting, updated_at = now()`,
      [slotId, slot.persona_id, payload.scriptId, payload.format, waiting],
    );
    throw new DeferJob(BUDGET_DEFER_MS, waiting);
  }
  const deps = opts.deps ?? mediaDeps(services);
  const scope: SpendScope = { studioId: persona.studio_id, personaId: slot.persona_id, slotId, ref: { type: 'calendar_slot', id: slotId } };
  let mr = await db.one<RenderRow>(
    `INSERT INTO media_render (slot_id, persona_id, script_id, format) VALUES ($1, $2, $3, $4)
     ON CONFLICT (slot_id) DO UPDATE SET updated_at = now() RETURNING *`,
    [slotId, slot.persona_id, payload.scriptId, payload.format],
  );
  if (mr.script_id !== payload.scriptId || mr.format !== payload.format) {
    mr = await db.one<RenderRow>(
      `UPDATE media_render SET script_id = $2, format = $3, step = 'voice', state = '{}'::jsonb, loops = '{}'::jsonb, final_asset_id = NULL, cover_asset_id = NULL, q4_report_id = NULL, updated_at = now() WHERE slot_id = $1 RETURNING *`,
      [slotId, payload.scriptId, payload.format],
    );
  }
  const r = new Render(services, deps, payload, scope, mr, slot.title, opts.heartbeat);
  try {
    const out = await r.run();
    await db.query('UPDATE media_render SET waiting = NULL WHERE slot_id = $1', [slotId]);
    return out;
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      await db.query('UPDATE media_render SET waiting = $2, updated_at = now() WHERE slot_id = $1', [slotId, `budget cap: ${err.message}`.slice(0, 200)]);
      throw new DeferJob(BUDGET_DEFER_MS, `budget cap: ${err.message}`);
    }
    if (err instanceof Blocked) {
      await r.save('blocked');
      await setSlot(services, slotId, 'blocked', { blockReason: err.reason.slice(0, 500) });
      await notify(db, {
        studioId: persona.studio_id,
        personaId: slot.persona_id,
        kind: 'system',
        severity: 'warn',
        title: `QC blocked a render: ${slot.title}`.slice(0, 160),
        body: err.reason.slice(0, 1000),
        link: `/pipeline/${slotId}`,
      });
      return { slotId, status: 'blocked', reason: err.reason, loops: r.row.loops };
    }
    if (err instanceof Stopped) return { slotId, status: 'stopped', reason: 'lease lost' };
    throw err;
  }
}

/**
 * The Owner-only "publish anyway" card for a render whose Q4 failed on majors only after the fix loops (FR-21.5/21.6):
 * the Q4 report, the failing checks with timestamps, and the publish.prepare payload. One open card per slot.
 */
async function proposeMediaOverride(
  services: StudioServices,
  c: { studioId: string; personaId: string; title: string; reportId: string; failing: Array<{ check: string; severity: string; message: string; location: string | null }>; prepare: PublishPreparePayload; thumbnailUrl: string },
): Promise<string> {
  const open = await services.db.maybeOne<{ id: string }>(`SELECT id FROM approval WHERE kind = 'qc_override' AND status = 'pending' AND payload->'prepare'->>'slotId' = $1`, [c.prepare.slotId]);
  if (open) return open.id;
  const a = await propose(services.db, {
    studioId: c.studioId,
    personaId: c.personaId,
    kind: 'qc_override',
    title: c.title.slice(0, 200),
    summary: `Q4 failed on majors only after ${MAX_MEDIA_FIX_LOOPS} fix loops: ${c.failing.map((f) => `${f.message}${f.location ? ` (${f.location})` : ''}`).join('; ')}`.slice(0, 900),
    payload: { stage: 'Q4', report_id: c.reportId, failing: c.failing.slice(0, 20), prepare: c.prepare, thumbnail_url: c.thumbnailUrl },
    subjectType: 'calendar_slot',
    subjectId: c.prepare.slotId,
    proposedBy: { type: 'agent', id: 'video-producer' },
  });
  return a.id;
}

async function setSlot(services: StudioServices, slotId: string, status: string, extra: { blockReason?: string | null; thumbnailUrl?: string } = {}) {
  await services.db.query(
    `UPDATE calendar_slot SET status = $2, block_reason = $3, thumbnail_url = COALESCE($4, thumbnail_url), stage_changed_at = $5 WHERE id = $1`,
    [slotId, status, extra.blockReason ?? null, extra.thumbnailUrl ?? null, services.now()],
  );
}

class Render {
  readonly state: RenderState;
  private profile: MediaProfile | null = null;
  private ctx: PersonaContext | null = null;
  private readonly spoken: boolean;
  private readonly dir: string;

  constructor(
    readonly services: StudioServices,
    readonly deps: MediaDeps,
    readonly p: MediaRenderPayload,
    readonly scope: SpendScope,
    readonly row: RenderRow,
    readonly title: string,
    readonly heartbeat?: () => Promise<boolean>,
  ) {
    this.state = row.state ?? {};
    this.row.loops = row.loops ?? {};
    this.spoken = SPOKEN_FORMATS.includes(p.format) && !!p.voiceover;
    this.dir = workDir(deps.workRoot, p.slotId);
  }

  async save(step?: string, extra: { finalAssetId?: string; coverAssetId?: string; q4ReportId?: string } = {}) {
    if (step) this.row.step = step;
    await this.services.db.query(
      `UPDATE media_render SET step = $2, state = $3::jsonb, loops = $4::jsonb, final_asset_id = COALESCE($5, final_asset_id), cover_asset_id = COALESCE($6, cover_asset_id),
              q4_report_id = COALESCE($7, q4_report_id), updated_at = now() WHERE slot_id = $1`,
      [this.p.slotId, this.row.step, json(this.state), json(this.row.loops), extra.finalAssetId ?? null, extra.coverAssetId ?? null, extra.q4ReportId ?? null],
    );
  }

  private async beat() {
    if (this.heartbeat && !(await this.heartbeat())) throw new Stopped();
  }

  private loop(stage: string): number {
    return this.row.loops[stage] ?? 0;
  }

  private async context(): Promise<PersonaContext> {
    return (this.ctx ??= await loadPersonaContext(this.services.db, this.p.personaId));
  }

  /** Fake renders (no keys) are marked so the dashboard doesn't try to play a stand-in file. */
  private get fakeMeta(): { fake?: true } {
    return this.deps.toolkit.name === 'fake-toolkit' ? { fake: true } : {};
  }

  private get key() {
    return `media/${this.p.personaId}/${this.p.slotId}`;
  }

  async run(): Promise<RenderOutcome> {
    // Voice first; the Soul ID (paid once per persona) only when generation starts, after Q2 passed.
    this.profile = await ensureProfile(this.services, this.deps, this.scope, { soul: false, voice: this.spoken });
    for (let guard = 0; guard < 20; guard++) {
      await this.beat();
      if (this.spoken && !this.state.voice) {
        await this.voice();
        continue;
      }
      if (this.spoken && !this.state.voice!.q2ReportId) {
        await this.q2();
        continue;
      }
      if (!this.generated()) {
        await this.generate();
        continue;
      }
      if (this.q3Targets().length && !this.state.q3ReportId) {
        await this.q3();
        continue;
      }
      if (!this.state.final) {
        await this.render();
        continue;
      }
      return await this.q4();
    }
    throw new Error('media.render: too many steps (fix loop did not converge)');
  }

  // ───────────────────────────── voice + Q2 ─────────────────────────────

  private async voice() {
    await setSlot(this.services, this.p.slotId, 'voice');
    await this.save('voice');
    const profile = this.profile!;
    const text = this.p.voiceover!;
    const voice = this.services.providers.voice;
    // Higgsfield TTS bills credits (hf_credits); ElevenLabs bills USD (media_usd).
    const tts =
      voice.name === 'higgsfield-tts'
        ? await hfSpend(this.services, this.scope, { operation: 'tts', model: mediaModels().tts, provider: voice.name, estimate: higgsfieldTtsCredits(text.length) }, () => voice.tts({ voiceId: profile.voiceId!, text }))
        : await usdSpend(this.services, this.scope, { operation: 'tts', provider: voice.name, estimate: Math.max(0.001, text.length * ELEVENLABS_USD_PER_CHAR * 1.2) }, () => voice.tts({ voiceId: profile.voiceId!, text }));
    const v = (this.state.version = (this.state.version ?? 0) + 1);
    const file = await materialize(this.services, this.deps.toolkit, tts.url, join(this.dir, `voice-${v}.mp3`), { kind: 'audio', durationS: tts.durationS });
    const a = await storeAsset(this.services, {
      personaId: this.p.personaId,
      scriptId: this.p.scriptId,
      slotId: this.p.slotId,
      key: `${this.key}/voice-v${v}.mp3`,
      file,
      contentType: 'audio/mpeg',
      type: 'audio',
      role: 'voice',
      provider: voice.name,
      usd: tts.costUsd,
      tools: [voice.name],
      meta: { duration_s: tts.durationS, voice_id: profile.voiceId, ...this.fakeMeta },
    });
    this.state.voice = { assetId: a.id, key: a.key, providerUrl: tts.url, durationS: tts.durationS, voiceId: profile.voiceId! };
    // A new voice track means new talking clips and a new render.
    for (const k of Object.keys(this.state.gen ?? {})) if (k.startsWith('talk')) delete this.state.gen![k];
    delete this.state.talk;
    delete this.state.q3ReportId;
    delete this.state.final;
    await this.save();
  }

  private async q2() {
    await setSlot(this.services, this.p.slotId, 'q2');
    const v = this.state.voice!;
    const res = await voiceCheck(this.services, {
      studioId: this.scope.studioId,
      personaId: this.p.personaId,
      scriptId: this.p.scriptId,
      audioUrl: v.providerUrl,
      expectedText: this.p.voiceover!,
      assetId: v.assetId,
      voiceId: v.voiceId,
      expectedVoiceId: this.profile!.voiceId,
      keyTerms: [this.p.ctaKeyword],
      costRef: this.scope.ref,
    });
    if (res.pass) {
      v.q2ReportId = res.reportId;
      await this.save();
      return;
    }
    if (this.loop('q2') >= MAX_MEDIA_FIX_LOOPS) throw new Blocked(`Q2 voice failed after ${MAX_MEDIA_FIX_LOOPS} re-voices: ${failing(res.checks)}`, res.reportId);
    this.row.loops.q2 = this.loop('q2') + 1;
    delete this.state.voice; // the maker regenerates the voice track
    await this.save();
  }

  // ───────────────────────────── generations ─────────────────────────────

  /** What this format needs from Higgsfield (keys in state.gen). */
  private plan(): Array<{ key: string; op: 'still' | 'clip' | 'talk'; from?: string; durationS?: number; aspect?: '9:16' | '4:5'; shot?: string; talkIndex?: number; useSoul?: boolean }> {
    const f = this.p.format;
    if (f === 'talking') {
      const parts = this.talkParts();
      return [
        { key: 'still:look', op: 'still', useSoul: true, shot: 'talking' },
        ...parts.map((_, i) => ({ key: `talk:${i}`, op: 'talk' as const, from: 'still:look', talkIndex: i })),
        { key: 'still:broll', op: 'still', useSoul: false, shot: 'cutaway detail' },
        { key: 'clip:broll', op: 'clip', from: 'still:broll', durationS: CLIP_SECONDS },
      ];
    }
    if (f === 'activity_text') return [{ key: 'still:0', op: 'still', useSoul: true, shot: 'activity' }, { key: 'clip:0', op: 'clip', from: 'still:0', durationS: 10 }];
    if (f === 'voiceover') {
      const each = this.state.voice!.durationS / 3;
      const d = each <= CLIP_SECONDS ? CLIP_SECONDS : 10;
      const shots = ['wide establishing shot', 'close-up of hands and objects', 'medium shot'];
      return shots.flatMap((shot, i) => [
        { key: `still:${i}`, op: 'still' as const, useSoul: i !== 1, shot },
        { key: `clip:${i}`, op: 'clip' as const, from: `still:${i}`, durationS: d },
      ]);
    }
    if (f === 'static') return [{ key: 'still:0', op: 'still', useSoul: true, shot: 'hero' }];
    return [{ key: 'still:cover', op: 'still', useSoul: false, aspect: '4:5', shot: 'cover' }];
  }

  private talkParts() {
    if (!this.state.talk) {
      const d = this.state.voice!.durationS;
      this.state.talk = splitSpeech(this.p.voiceover!, d, TALK_CLIP_MAX_S).map((x, i) => ({ ref: `talk:${i}`, ...x }));
    }
    return this.state.talk;
  }

  private generated(): boolean {
    return this.plan().every((i) => this.state.gen?.[i.key]);
  }

  private prompt(shot: string, useSoul: boolean, ctx: PersonaContext): string {
    const brief = this.p.visualBrief
      .replace(/[^.]*\bAI label\b[^.]*\.?/gi, '')
      .trim()
      .slice(0, 600);
    const setting = ctx.look.settings[(this.p.slotId.charCodeAt(0) + shot.length) % Math.max(1, ctx.look.settings.length)] ?? 'a bright, tidy room';
    const outfit = ctx.look.outfits[this.p.slotId.charCodeAt(1) % Math.max(1, ctx.look.outfits.length)] ?? 'smart casual clothes';
    const style = ctx.look.stylisation || 'photoreal, soft natural light';
    if (shot === 'talking') return `${ctx.persona.name} in ${setting}, wearing ${outfit}, ${ctx.look.framing || 'chest-up'}, looking at the camera, relaxed and about to speak. ${style}. One person only, no text, no logos.`;
    if (shot === 'cover') return `${brief}. Clean editorial flat-lay or scene for a ${ctx.persona.niche} carousel cover, generous empty space at the top for a headline, ${style}. No text, no logos.`;
    const who = useSoul ? `${ctx.persona.name} in ${setting}, wearing ${outfit}` : `${setting}, no people`;
    return `${shot}: ${brief}. ${who}. ${style}. Props in the scene from the first frame. No readable text, no logos, no watermarks.`;
  }

  private async generate() {
    await setSlot(this.services, this.p.slotId, 'rendering');
    await this.save('generate');
    this.profile = await ensureProfile(this.services, this.deps, this.scope, { soul: this.p.format !== 'carousel', voice: this.spoken });
    const ctx = await this.context();
    const models = mediaModels();
    const hf = this.services.providers.imageVideo;
    const gen = (this.state.gen ??= {});
    for (const item of this.plan()) {
      if (gen[item.key]) continue;
      await this.beat();
      const n = (this.state.version = (this.state.version ?? 0) + 1);
      if (item.op === 'still') {
        const useSoul = !!item.useSoul && !!this.profile!.soulId;
        const model = useSoul ? models.soul : models.still;
        const r = await hfSpend(this.services, this.scope, { operation: 'still', model }, () =>
          hf.generateStill({ soulId: useSoul ? this.profile!.soulId! : undefined, prompt: this.prompt(item.shot!, useSoul, ctx), aspect: item.aspect ?? '9:16', model, resolution: GEN_RESOLUTION }),
        );
        gen[item.key] = await this.keep(item.key, r.url, 'image', null, r.credits, 0, hf.name, n);
      } else if (item.op === 'clip') {
        const src = gen[item.from!]!;
        const r = await hfSpend(this.services, this.scope, { operation: 'image_to_video', model: models.activity, durationS: item.durationS }, () =>
          hf.imageToVideo({
            imageUrl: src.url,
            prompt: `Subtle, natural motion: ${this.p.visualBrief.slice(0, 300)}. Slow camera push-in. Keep the face, outfit and light exactly as in the start frame.`,
            durationS: item.durationS!,
            model: models.activity,
            resolution: GEN_RESOLUTION,
            aspect: '9:16',
          }),
        );
        gen[item.key] = await this.keep(item.key, r.url, 'video', r.durationS ?? item.durationS!, r.credits, 0, hf.name, n);
      } else {
        const part = this.talkParts()[item.talkIndex!]!;
        const voiceFile = await localOf(this.services, this.state.voice!.key);
        const cut = join(this.dir, `talk-audio-${item.talkIndex}-${n}.mp3`);
        await this.deps.toolkit.cutAudio(voiceFile, part.startS, part.endS, cut);
        const { url: audioUrl } = await hf.upload({ filePath: cut, contentType: 'audio/mpeg' });
        const talking = talkingProvider(this.services);
        const durationS = round2(part.endS - part.startS);
        const req = { imageUrl: gen[item.from!]!.url, audioUrl, durationS, resolution: GEN_RESOLUTION, prompt: 'Talking to the camera, natural head movement and blinks, mouth matches the audio.' };
        const r =
          talking.name === 'higgsfield-seedance'
            ? await hfSpend(this.services, this.scope, { operation: 'talking_with_audio', model: models.talking, durationS }, () => talking.render(req))
            : await usdSpend(this.services, this.scope, { operation: 'talking', provider: talking.name, estimate: durationS * FAL_AVATAR_USD_PER_S * 1.2 }, () => talking.render(req));
        gen[item.key] = await this.keep(item.key, r.url, 'video', r.durationS, r.credits, r.costUsd, talking.name, n);
      }
      delete this.state.final;
      await this.save();
    }
  }

  private async keep(key: string, url: string, kind: 'image' | 'video', durationS: number | null, credits: number, usd: number, provider: string, n: number): Promise<GenItem> {
    const ext = kind === 'video' ? '.mp4' : '.png';
    const safe = key.replace(/[^a-z0-9]+/gi, '-');
    const file = await materialize(this.services, this.deps.toolkit, url, join(this.dir, `${safe}-${n}${ext}`), { kind, durationS: durationS ?? undefined });
    const a = await storeAsset(this.services, {
      personaId: this.p.personaId,
      scriptId: this.p.scriptId,
      slotId: this.p.slotId,
      key: `${this.key}/gen/${safe}-${n}${ext}`,
      file,
      type: kind,
      role: kind === 'video' ? 'clip' : 'still',
      provider,
      credits,
      usd,
      tools: [provider],
      meta: { gen_key: key, duration_s: durationS, ...this.fakeMeta },
    });
    return { key: a.key, url, kind, durationS, assetId: a.id, credits, usd };
  }

  // ───────────────────────────── Q3 ─────────────────────────────

  /**
   * What Q3 checks (FR-5.1, FR-21.3): talking clips, and on every other format each generation that shows the
   * persona (Soul ID stills and the clips made from them). No-people cutaways and carousel covers are skipped.
   */
  private q3Targets(): Array<{ ref: string; kind: 'image' | 'video'; freezes: boolean }> {
    if (this.p.format === 'talking') return this.talkParts().map((t) => ({ ref: t.ref, kind: 'video' as const, freezes: true }));
    if (!this.profile?.soulId) return [];
    const plan = this.plan();
    const soul = new Set(plan.filter((i) => i.op === 'still' && i.useSoul).map((i) => i.key));
    return plan
      .filter((i) => soul.has(i.key) || (i.op === 'clip' && soul.has(i.from!)))
      .map((i) => ({ ref: i.key, kind: i.op === 'still' ? ('image' as const) : ('video' as const), freezes: false }));
  }

  private async q3() {
    await setSlot(this.services, this.p.slotId, 'q3');
    await this.save('q3');
    this.profile = await ensureProfile(this.services, this.deps, this.scope, { soul: true, voice: this.spoken });
    const { toolkit, face } = this.deps;
    const refKey = this.profile!.referenceKey;
    const refPath = refKey ? await localOf(this.services, refKey) : null;
    const clips: Q3Clip[] = [];
    const targets = this.q3Targets();
    for (const t of targets) {
      const g = this.state.gen![t.ref]!;
      const file = await localOf(this.services, g.key);
      const samples: Array<{ atS: number; faces: number; similarity: number | null }> = [];
      if (t.kind === 'image') {
        samples.push({ atS: 0, ...(refPath ? await face.compare(refPath, file) : { faces: 1, similarity: null }) });
        clips.push({ ref: t.ref, samples, freezes: [] });
        continue;
      }
      const info = await toolkit.probe(file);
      const analysis = t.freezes ? await toolkit.analyze(file, { audio: false }) : null;
      for (const at of [0.5, Math.max(0.6, info.durationS / 2), Math.max(0.7, info.durationS - 0.6)]) {
        const { path: framePath } = await toolkit.frame(file, at, join(this.dir, `q3-${t.ref.replace(':', '-')}-${Math.round(at * 10)}`));
        samples.push({ atS: at, ...(refPath ? await face.compare(refPath, framePath) : { faces: 1, similarity: null }) });
      }
      // Activity clips move slowly by design: only talking clips are checked for frozen frames.
      clips.push({ ref: t.ref, samples, freezes: analysis?.freezes ?? [] });
    }
    const res = gradeQ3(clips, { hasReference: !!refPath });
    const reportId = await saveQcReport(this.services, {
      personaId: this.p.personaId,
      subjectType: 'asset',
      subjectId: this.state.gen![targets[0]!.ref]!.assetId,
      stage: 'Q3',
      pass: res.pass,
      score: res.score,
      checks: res.checks,
      extra: { loop: this.loop('q3'), clips, face_matcher: face.name, slot_id: this.p.slotId },
    });
    if (res.pass) {
      this.state.q3ReportId = reportId;
      await this.save();
      return;
    }
    if (this.loop('q3') >= MAX_MEDIA_FIX_LOOPS) throw new Blocked(`Q3 avatar failed after ${MAX_MEDIA_FIX_LOOPS} regenerations: ${failing(res.checks)}`, reportId);
    this.row.loops.q3 = this.loop('q3') + 1;
    // A redone still also redoes the clips made from it.
    const plan = this.plan();
    for (const ref of res.redo) {
      delete this.state.gen![ref];
      for (const i of plan) if (i.from === ref) delete this.state.gen![i.key];
    }
    await this.save();
  }

  // ───────────────────────────── render ─────────────────────────────

  private async render() {
    await setSlot(this.services, this.p.slotId, 'rendering');
    await this.save('render');
    const kit = await loadPersonaKit(this.services.db, this.p.personaId);
    const grade = this.profile!.grade;
    const n = (this.state.version = (this.state.version ?? 0) + 1);
    const scale = this.state.textScale ?? 1;
    const gen = this.state.gen!;
    const tools = [this.services.providers.imageVideo.name, this.deps.toolkit.name];
    const kw = this.p.ctaKeyword.toUpperCase();
    const f = this.p.format;

    if (f === 'static' || f === 'carousel') {
      const frame = f === 'carousel' ? EXPORT.carousel : EXPORT.video;
      const specs: CardSpec[] = [];
      if (f === 'static') {
        const title = (this.p.onScreenText[0] ?? this.p.caption.split(/[.!?\n]/)[0] ?? this.title).trim();
        const texts = [placeText(title, 'headline', 0, 0, frame, scale), placeText(`Comment ${kw}`, 'cta', 0, 0, frame, scale)];
        specs.push({ ...frame, background: await localOf(this.services, gen['still:0']!.key), colors: kit.colors, layout: 'static', title, footer: `Comment ${kw}`, grade, sharpen: true, texts });
      } else {
        const slides = (this.p.carousel ?? []).slice(0, CAROUSEL_SLIDES.max);
        const cover = await localOf(this.services, gen['still:cover']!.key);
        slides.forEach((s, i) => {
          const layout = i === 0 ? 'cover' : i === slides.length - 1 ? 'cta' : 'slide';
          const texts = [placeText(s.title, 'headline', 0, 0, frame, scale), ...(s.body ? [placeText(s.body, i === slides.length - 1 ? 'cta' : 'caption', 0, 0, frame, scale)] : [])];
          specs.push({ ...frame, background: i === 0 ? cover : null, colors: kit.colors, layout, title: s.title, body: s.body, index: i + 1, total: slides.length, grade, sharpen: true, texts });
        });
      }
      const assetIds: string[] = [];
      const keys: string[] = [];
      for (const [i, spec] of specs.entries()) {
        const out = join(this.dir, `final-${n}-${i + 1}.jpg`);
        const info = await this.deps.toolkit.renderCard(spec, out);
        const a = await storeAsset(this.services, {
          personaId: this.p.personaId,
          scriptId: this.p.scriptId,
          slotId: this.p.slotId,
          key: f === 'carousel' ? `${this.key}/final-v${n}/slide-${i + 1}.jpg` : `${this.key}/final-v${n}.jpg`,
          file: out,
          contentType: 'image/jpeg',
          type: f === 'carousel' ? 'carousel' : 'image',
          role: f === 'carousel' ? 'slide' : 'final',
          provider: this.deps.toolkit.name,
          credits: i === 0 ? Object.values(gen).reduce((s, g) => s + g.credits, 0) : 0,
          tools,
          meta: { width: info.width, height: info.height, index: i + 1, total: specs.length, format: f, layout: spec.layout, grade, version: n, ...this.fakeMeta },
        });
        assetIds.push(a.id);
        keys.push(a.key);
        await this.beat();
      }
      this.state.final = { kind: f === 'carousel' ? 'carousel' : 'image', assetIds, keys, texts: specs.flatMap((s) => [...s.texts]), slideTexts: specs.map((s) => [...s.texts]), durationS: null, segments: [] };
      await this.save(undefined, { finalAssetId: assetIds[0] });
      return;
    }

    // Reels.
    const segments: Segment[] = [];
    let durationS: number;
    let texts: TextBox[] = [];
    let audio: VideoComposition['audio'] = null;
    if (f === 'activity_text') {
      durationS = ACTIVITY_LOOP_S;
      segments.push({ file: await localOf(this.services, gen['clip:0']!.key), kind: 'video', startS: 0, durationS, ref: 'clip:0' });
      const lines = this.p.onScreenText.length ? this.p.onScreenText : [this.title];
      const each = durationS / lines.length;
      texts = lines.map((l, i) => placeText(l, i === lines.length - 1 && l.toUpperCase().includes(kw) ? 'cta' : 'headline', round2(i * each), round2(i === lines.length - 1 ? durationS : (i + 1) * each), EXPORT.video, scale));
    } else {
      const v = this.state.voice!;
      durationS = round2(v.durationS + 0.3);
      audio = { file: await localOf(this.services, v.key) };
      if (f === 'talking') {
        const parts = this.talkParts();
        const cut = { file: await localOf(this.services, gen['clip:broll']!.key), ref: 'clip:broll' };
        const boundary = parts.length > 1 ? parts[1]!.startS : round2(v.durationS * 0.45);
        const [a, b] = [Math.max(0.8, boundary - 1.2), Math.min(durationS - 0.8, boundary + 1.2)];
        // The clip whose audio covers time t (each talking clip starts where its audio chunk starts).
        const clipAt = (t: number) => {
          let i = 0;
          parts.forEach((x, k) => {
            if (x.startS <= t + 0.01) i = k;
          });
          return i;
        };
        // talking clip(s) before the cutaway, the cutaway, then the rest.
        const pushTalk = (from: number, to: number) => {
          let t = from;
          while (t < to - 0.01) {
            const i = clipAt(t);
            const part = parts[i]!;
            let end = i === parts.length - 1 ? to : Math.min(to, parts[i + 1]!.startS);
            if (end <= t + 0.005) end = to;
            segments.push({ file: '', kind: 'video', startS: round2(t), durationS: round2(end - t), offsetS: round2(t - part.startS), ref: part.ref });
            t = end;
          }
        };
        pushTalk(0, a);
        segments.push({ file: cut.file, kind: 'video', startS: round2(a), durationS: round2(b - a), offsetS: 0, ref: cut.ref });
        pushTalk(b, durationS);
        for (const [i, s] of segments.entries()) if (!s.file) segments[i] = { ...s, file: await localOf(this.services, gen[s.ref!]!.key) };
      } else {
        const each = round2(durationS / 3);
        for (let i = 0; i < 3; i++) segments.push({ file: await localOf(this.services, gen[`clip:${i}`]!.key), kind: 'video', startS: round2(i * each), durationS: i === 2 ? round2(durationS - 2 * each) : each, ref: `clip:${i}` });
      }
      texts = [...captionCues(this.p.voiceover!, v.durationS, { scale }), placeText(`Comment ${kw}`, 'cta', round2(Math.max(0, durationS - 3)), durationS, EXPORT.video, scale)];
    }
    const comp: VideoComposition = {
      ...EXPORT.video,
      durationS,
      segments,
      audio,
      texts,
      grade,
      sharpen: true,
      loudnorm: audio ? 'single' : 'none',
      metadata: { comment: 'AI-generated (Influencer OS). Platform AI flag: true.', title: this.title.slice(0, 120) },
    };
    const out = join(this.dir, `final-${n}.mp4`);
    const info = await this.deps.toolkit.renderVideo(comp, out);
    const a = await storeAsset(this.services, {
      personaId: this.p.personaId,
      scriptId: this.p.scriptId,
      slotId: this.p.slotId,
      key: `${this.key}/final-v${n}.mp4`,
      file: out,
      contentType: 'video/mp4',
      type: 'video',
      role: 'final',
      provider: this.deps.toolkit.name,
      credits: Object.values(gen).reduce((s, g) => s + g.credits, 0),
      usd: Object.values(gen).reduce((s, g) => s + g.usd, 0),
      tools: [...tools, ...(this.spoken ? [this.services.providers.voice.name] : [])],
      meta: { width: info.width, height: info.height, fps: info.fps, duration_s: info.durationS, format: f, grade, captions: texts.length, version: n, voice_asset_id: this.state.voice?.assetId ?? null, ...this.fakeMeta },
    });
    this.state.final = { kind: 'video', assetIds: [a.id], keys: [a.key], texts, durationS: info.durationS, segments: segments.map((s) => ({ ref: s.ref, startS: s.startS, durationS: s.durationS })) };
    await this.save(undefined, { finalAssetId: a.id });
  }

  // ───────────────────────────── Q4 ─────────────────────────────

  private frameOf(file: string, atS: number, name: string): Promise<{ path: string; contentType: string }> {
    return this.deps.toolkit.frame(file, atS, join(this.dir, name));
  }

  private async q4(): Promise<RenderOutcome> {
    await setSlot(this.services, this.p.slotId, 'q4');
    await this.save('q4');
    const { toolkit, ocr } = this.deps;
    const fin = this.state.final!;
    const files = await Promise.all(fin.keys.map((k) => localOf(this.services, k)));
    const main = files[0]!;
    const info = await toolkit.probe(main);
    const analysis = fin.kind === 'video' ? await toolkit.analyze(main, { audio: this.spoken }) : null;
    const samples: OcrSample[] = [];
    if (fin.kind === 'video') {
      // Up to 10 text blocks, evenly spread, each read at its midpoint.
      const step = Math.max(1, Math.ceil(fin.texts.length / 10));
      for (const [i, t] of fin.texts.entries()) {
        if (i % step !== 0 && t.style !== 'cta') continue;
        const at = round2((t.startS + t.endS) / 2);
        const { path } = await this.frameOf(main, at, `ocr-${i}`);
        samples.push({ atS: at, expected: t.text, read: (await ocr.read(path)).text });
      }
    } else {
      for (const [i, file] of files.entries()) {
        const { path } = await this.frameOf(file, 0, `ocr-slide-${i + 1}`);
        const expected = fin.slideTexts?.[i] ?? fin.texts;
        const read = (await ocr.read(path)).text;
        for (const t of expected) samples.push({ atS: 0, expected: t.text, read, ...(fin.kind === 'carousel' ? { slide: i + 1 } : {}) });
      }
    }
    const slides = fin.kind === 'carousel' ? await Promise.all(files.map((f) => toolkit.probe(f))) : undefined;
    const coverAt = fin.kind === 'video' ? Math.min(1.0, (fin.durationS ?? 1) / 3) : 0;
    const coverBlack = !!analysis?.blacks.some((b) => b.start <= coverAt && b.end >= coverAt);
    const cover = await this.frameOf(main, coverAt, `cover-${this.state.version ?? 0}`);
    const assets = await this.services.db.query<{ id: string; render_meta: { ai?: { generated?: boolean } } }>('SELECT id, render_meta FROM asset WHERE id = ANY($1::uuid[])', [fin.assetIds]);
    const aiFlag = assets.length === fin.assetIds.length && assets.every((a) => a.render_meta?.ai?.generated === true);
    const res = gradeQ4({
      format: this.p.format,
      voiced: this.spoken,
      info,
      analysis,
      slides,
      texts: fin.texts,
      ocr: samples,
      segments: fin.segments,
      coverOk: !coverBlack,
      aiFlag,
      ctaKeyword: this.p.ctaKeyword,
      caption: this.p.caption,
      hashtags: this.p.hashtags,
    });
    const reportId = await saveQcReport(this.services, {
      personaId: this.p.personaId,
      subjectType: 'asset',
      subjectId: fin.assetIds[0]!,
      stage: 'Q4',
      pass: res.pass,
      score: res.score,
      checks: res.checks,
      extra: {
        loop: this.loop('q4'),
        slot_id: this.p.slotId,
        format: this.p.format,
        info,
        loudness: analysis?.loudness ?? null,
        silences: analysis?.silences ?? [],
        blacks: analysis?.blacks ?? [],
        freezes: analysis?.freezes ?? [],
        ocr: samples.slice(0, 20).map((s) => ({ at: s.atS, slide: s.slide ?? null, expected: s.expected, read: s.read.slice(0, 200) })),
        fixes: res.fixes,
        toolkit: toolkit.name,
        ocr_provider: ocr.name,
      },
    });
    if (!res.pass) {
      if (this.loop('q4') >= MAX_MEDIA_FIX_LOOPS) {
        const reason = `Q4 failed after ${MAX_MEDIA_FIX_LOOPS} fix loops: ${failing(res.checks)}`;
        // Majors only (no blocker): the Owner may publish anyway with a reason (FR-21.5/21.6). Blockers never.
        const bad = res.checks.filter((c) => !c.pass && c.severity !== 'minor');
        if (bad.length && !bad.some((c) => c.severity === 'blocker')) {
          const h = await this.handover(fin, main, coverAt, cover, reportId);
          await proposeMediaOverride(this.services, {
            studioId: this.scope.studioId,
            personaId: this.p.personaId,
            title: `Publish "${this.title}" anyway?`,
            reportId,
            failing: bad.map((c) => ({ check: c.check, severity: c.severity, message: c.message, location: c.location ?? null })),
            prepare: h.payload,
            thumbnailUrl: h.coverUrl,
          });
          throw new Blocked(`${reason} (majors only: "publish anyway" is waiting in Approvals)`, reportId);
        }
        throw new Blocked(reason, reportId);
      }
      this.row.loops.q4 = this.loop('q4') + 1;
      await this.applyFixes(res.fixes);
      await this.save();
      return this.run();
    }

    // Passed: cover on the board, hand over to distribution once.
    const h = await this.handover(fin, main, coverAt, cover, reportId);
    // The slot moves to final_gate before publish.prepare exists: a fast prepare (another worker) sets 'scheduled', and
    // must never be overwritten back to final_gate.
    await this.save('done', { coverAssetId: h.coverAssetId, q4ReportId: reportId, finalAssetId: fin.assetIds[0] });
    await setSlot(this.services, this.p.slotId, 'final_gate', { thumbnailUrl: h.coverUrl });
    const job = await enqueueOnceFor(
      this.services.db,
      { kind: PUBLISH_PREPARE_JOB, key: `slot:${this.p.slotId}`, payload: h.payload as unknown as Record<string, unknown>, studioId: this.scope.studioId, personaId: this.p.personaId, runAt: this.services.now() },
      { ever: true },
    );
    return { slotId: this.p.slotId, status: 'final_gate', q4ReportId: reportId, publishJobId: job?.id ?? null, media: h.payload.media, loops: this.row.loops };
  }

  /** Stores the cover and builds the publish.prepare payload for the final media. */
  private async handover(
    fin: NonNullable<RenderState['final']>,
    _main: string,
    coverAt: number,
    cover: { path: string; contentType: string },
    reportId: string,
  ): Promise<{ payload: PublishPreparePayload; coverAssetId: string; coverUrl: string }> {
    const { toolkit } = this.deps;
    const coverAsset = await storeAsset(this.services, {
      personaId: this.p.personaId,
      scriptId: this.p.scriptId,
      slotId: this.p.slotId,
      key: `${this.key}/cover-v${this.state.version ?? 0}${extFor(cover.contentType)}`,
      file: cover.path,
      contentType: cover.contentType,
      type: 'thumbnail',
      role: 'cover',
      provider: toolkit.name,
      tools: [toolkit.name],
      meta: { at_s: coverAt },
    });
    const rendered = await this.renderedMedia(fin.assetIds, fin.kind === 'video' ? 'video' : 'image');
    const coverMedia = (await this.renderedMedia([coverAsset.id], 'image'))[0] ?? null;
    const payload: PublishPreparePayload = {
      slotId: this.p.slotId,
      personaId: this.p.personaId,
      scriptId: this.p.scriptId,
      format: this.p.format,
      media: rendered,
      cover: coverMedia,
      caption: this.p.caption,
      hashtags: this.p.hashtags,
      ctaKeyword: this.p.ctaKeyword,
      aiGenerated: true,
      q4ReportId: reportId,
    };
    return { payload, coverAssetId: coverAsset.id, coverUrl: coverAsset.url };
  }

  private async renderedMedia(ids: readonly string[], kind: 'video' | 'image'): Promise<RenderedMedia[]> {
    const rows = await this.services.db.query<{ id: string; url: string; render_meta: Record<string, unknown> }>('SELECT id, url, render_meta FROM asset WHERE id = ANY($1::uuid[])', [ids]);
    return ids.map((id) => {
      const r = rows.find((x) => x.id === id)!;
      const m = r.render_meta;
      const frame = this.p.format === 'carousel' && kind === 'image' && m.layout ? EXPORT.carousel : EXPORT.video;
      return {
        assetId: id,
        kind,
        storageKey: String(m.storage_key),
        url: r.url,
        contentType: String(m.content_type ?? (kind === 'video' ? 'video/mp4' : 'image/jpeg')),
        width: Number(m.width ?? frame.width),
        height: Number(m.height ?? frame.height),
        durationS: m.duration_s === undefined || m.duration_s === null ? null : Number(m.duration_s),
      };
    });
  }

  /** The maker's fixes for a failed Q4 (QC never fixes its own findings). */
  private async applyFixes(fixes: readonly Q4Fix[]) {
    const fin = this.state.final!;
    for (const fix of fixes) {
      if (fix.kind === 'normalize_audio' && fin.kind === 'video' && fixes.length === 1) {
        // Re-normalise in place: two-pass loudnorm, video copied, stored as a new version.
        const n = (this.state.version = (this.state.version ?? 0) + 1);
        const src = await localOf(this.services, fin.keys[0]!);
        const out = join(this.dir, `final-${n}-norm.mp4`);
        await this.deps.toolkit.normalizeAudio(src, out);
        const prev = await this.services.db.one<{ render_meta: Record<string, unknown>; credit_cost: number; usd_cost: string; provider: string | null }>('SELECT render_meta, credit_cost, usd_cost, provider FROM asset WHERE id = $1', [fin.assetIds[0]]);
        const a = await storeAsset(this.services, {
          personaId: this.p.personaId,
          scriptId: this.p.scriptId,
          slotId: this.p.slotId,
          key: `${this.key}/final-v${n}.mp4`,
          file: out,
          contentType: 'video/mp4',
          type: 'video',
          role: 'final',
          provider: prev.provider,
          credits: prev.credit_cost,
          usd: Number(prev.usd_cost),
          tools: [...(((prev.render_meta.ai as { tools?: string[] } | undefined)?.tools) ?? []), 'loudnorm'],
          meta: { ...prev.render_meta, version: n, storage_key: `${this.key}/final-v${n}.mp4`, normalized: true },
        });
        this.state.final = { ...fin, assetIds: [a.id], keys: [a.key] };
        continue;
      }
      if (fix.kind === 'captions') this.state.textScale = Math.min(1.3, (this.state.textScale ?? 1) + 0.12);
      if (fix.kind === 'regenerate') for (const ref of fix.refs) delete this.state.gen?.[ref];
      if (fix.kind === 'revoice') {
        delete this.state.voice;
        delete this.state.q3ReportId;
      }
      if (fix.kind === 'regenerate' && fix.refs.some((r) => r.startsWith('talk'))) delete this.state.q3ReportId;
      delete this.state.final;
    }
  }
}
