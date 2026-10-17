import { decide, OWNER } from '@troupe/core';
import { MEDIA_RENDER_JOB, PUBLISH_PREPARE_JOB, type PublishPreparePayload } from '@troupe/agents';
import { pipelineBoard } from '@troupe/content';
import { DeferJob, type JobRow, type PostFormat } from '@troupe/core';
import { describe, expect, it, vi } from 'vitest';
import { FakeFaceMatcher, FakeToolkit, jobs, renderSlot, slotMedia } from '../src';
import { mediaFixture } from './helpers';

const FORMATS: PostFormat[] = ['talking', 'activity_text', 'voiceover', 'static', 'carousel'];

async function publishJobs(db: Parameters<typeof slotMedia>[0], slotId: string) {
  return db.query<{ id: string; payload: PublishPreparePayload & { dedupe: string } }>(`SELECT id, payload FROM job WHERE kind = $1 AND payload->>'slotId' = $2`, [PUBLISH_PREPARE_JOB, slotId]);
}

describe('media.render: one post per format on fakes', () => {
  it.each(FORMATS)('%s → stored assets at export size, QC passes, cover on the board, one publish.prepare', async (format) => {
    const f = await mediaFixture();
    const payload = await f.queued(format);
    const out = await renderSlot(f.services, payload);
    expect(out.status).toBe('final_gate');

    const slot = await f.db.one<{ status: string; thumbnail_url: string }>('SELECT status, thumbnail_url FROM calendar_slot WHERE id = $1', [payload.slotId]);
    expect(slot.status).toBe('final_gate');
    expect(slot.thumbnail_url).toMatch(new RegExp(`^/api/media/media/${f.personaId}/${payload.slotId}/cover-v\\d+\\.svg$`));

    const media = (await slotMedia(f.db, payload.slotId))!;
    const size = format === 'carousel' ? [1080, 1350] : [1080, 1920];
    expect(media.final.length).toBe(format === 'carousel' ? payload.carousel!.length : 1);
    for (const a of media.final) expect([a.width, a.height]).toEqual(size);
    for (const a of media.final) expect(await f.providers.storage.get(a.url.replace('/api/media/', ''))).not.toBeNull();

    // Every asset carries the AI marker; the stage reports exist.
    const assets = await f.db.query<{ render_meta: { ai: { generated: boolean } } }>('SELECT render_meta FROM asset WHERE slot_id = $1', [payload.slotId]);
    expect(assets.every((a) => a.render_meta.ai.generated === true)).toBe(true);
    const stages = media.reports.map((r) => `${r.stage}:${r.pass}`);
    expect(stages).toContain('Q4:true');
    if (format === 'talking' || format === 'voiceover') {
      expect(media.voice).not.toBeNull();
      const q2 = await f.db.one<{ pass: boolean }>(`SELECT pass FROM qc_report WHERE stage = 'Q2' AND subject_id = $1`, [media.voice!.id]);
      expect(q2.pass).toBe(true);
    } else expect(media.voice).toBeNull();
    if (format === 'talking') {
      expect(stages).toContain('Q3:true');
      // Seedance by default; ≤ 15 s per clip, so a 30 s reel is two clips.
      const talks = f.providers.imageVideo.callsTo('talkingWithAudio');
      expect(talks.length).toBeGreaterThanOrEqual(1);
      for (const c of talks) expect((c.args as { durationS: number; resolution: string }).durationS).toBeLessThanOrEqual(15);
      for (const c of talks) expect((c.args as { resolution: string }).resolution).toBe('720p');
      expect(f.providers.talking.callsTo('render')).toHaveLength(0);
    }

    // Exactly one hand-over to distribution, with the AI flag literal true.
    const pub = await publishJobs(f.db, payload.slotId);
    expect(pub).toHaveLength(1);
    const pp = pub[0]!.payload;
    expect(pp.aiGenerated).toBe(true);
    expect(pp.q4ReportId).toBe(out.q4ReportId);
    expect(pp.cover?.url).toBe(slot.thumbnail_url);
    expect(pp.media.length).toBe(media.final.length);
    expect(pp.media[0]!.kind).toBe(format === 'static' || format === 'carousel' ? 'image' : 'video');
    expect(pp.caption).toBe(payload.caption);
    // Stills also hand over a TikTok slideshow: the same stills as one vertical video (TikTok photo posts can't carry
    // the AI disclosure). Video formats don't.
    if (format === 'static' || format === 'carousel') {
      const ss = pp.tiktokSlideshow!;
      expect(ss).toMatchObject({ kind: 'video', contentType: 'video/mp4', width: 1080, height: 1920 });
      expect(ss.durationS).toBe(format === 'static' ? 6 : 3 * media.final.length);
      const row = await f.db.one<{ type: string; role: string; render_meta: { ai: { generated: boolean }; source_asset_ids: string[] } }>('SELECT type, role, render_meta FROM asset WHERE id = $1', [ss.assetId]);
      expect(row).toMatchObject({ type: 'video', role: 'slideshow' });
      expect(row.render_meta.ai.generated).toBe(true);
      expect(row.render_meta.source_asset_ids).toEqual(media.final.map((a) => a.id));
      expect(await f.providers.storage.get(ss.storageKey)).not.toBeNull();
      const sv = f.toolkit.calls.filter((c) => c.method === 'renderVideo').at(-1)!.args as { segments: number; texts: number };
      expect(sv).toMatchObject({ segments: media.final.length, texts: 0 });
    } else expect(pp.tiktokSlideshow).toBeUndefined();

    // Idempotent: a retried job changes nothing and spends nothing.
    const credits = await f.db.one<{ n: string }>(`SELECT COALESCE(sum(amount),0) AS n FROM credit_ledger WHERE ref_id = $1`, [payload.slotId]);
    const again = await renderSlot(f.services, payload);
    expect(again.status).toBe('unchanged');
    expect(await publishJobs(f.db, payload.slotId)).toHaveLength(1);
    expect((await f.db.one<{ n: string }>(`SELECT COALESCE(sum(amount),0) AS n FROM credit_ledger WHERE ref_id = $1`, [payload.slotId])).n).toBe(credits.n);
  });

  it('runs through the media.render job handler with heartbeats and shows the render on the Pipeline board', async () => {
    const f = await mediaFixture();
    const payload = await f.queued('voiceover');
    const job = await f.db.one<JobRow>(`SELECT * FROM job WHERE kind = $1 AND payload->>'slotId' = $2`, [MEDIA_RENDER_JOB, payload.slotId]);
    let beats = 0;
    const res = (await jobs[MEDIA_RENDER_JOB]!({ services: f.services, job, heartbeat: async () => (beats += 1) > 0 })) as { status: string; publishJobId: string };
    expect(res.status).toBe('final_gate');
    expect(res.publishJobId).toBeTruthy();
    expect(beats).toBeGreaterThan(3);
    const [item] = await pipelineBoard(f.db, f.studioId, { slotId: payload.slotId });
    expect(item!.stage).toBe('final_gate');
    expect(item!.thumbnailUrl).toMatch(/^\/api\/media\/.*cover/);
    expect(item!.mediaStep).toBe('done');
    expect(item!.mediaCredits).toBeGreaterThan(0);
  });

  it('stops without losing work when the lease is lost', async () => {
    const f = await mediaFixture();
    const payload = await f.queued('voiceover');
    let n = 0;
    const out = await renderSlot(f.services, payload, { heartbeat: async () => (n += 1) < 3 });
    expect(out.status).toBe('stopped');
    const done = await renderSlot(f.services, payload);
    expect(done.status).toBe('final_gate');
    // The voice track made before the stop was reused, not paid for again.
    expect(f.providers.voice.callsTo('tts')).toHaveLength(1);
  });
});

describe('media.render: auto-fix loops (≤ 2), then block', () => {
  it('a frozen activity clip is regenerated and the post passes on the next loop', async () => {
    let videos = 0;
    const toolkit = new FakeToolkit({ onFetch: (_url, hint) => (hint.kind === 'video' && ++videos === 1 ? { freezes: [{ start: 2, end: 4.5 }] } : undefined) });
    const f = await mediaFixture({ toolkit });
    const payload = await f.queued('activity_text');
    const out = await renderSlot(f.services, payload);
    expect(out.status).toBe('final_gate');
    expect(out.loops).toEqual({ q4: 1 });
    expect(f.providers.imageVideo.callsTo('imageToVideo')).toHaveLength(2);
    const reports = (await slotMedia(f.db, payload.slotId))!.reports.filter((r) => r.stage === 'Q4');
    expect(reports.map((r) => r.pass)).toEqual([false, true]);
    expect(reports[0]!.checks.find((c) => c.check === 'frozen_frames')!.pass).toBe(false);
  });

  it('wrong loudness is re-normalised (two-pass) without re-rendering', async () => {
    const toolkit = new FakeToolkit({ renders: [{ integrated: -19.5 }] });
    const f = await mediaFixture({ toolkit });
    const payload = await f.queued('voiceover');
    const out = await renderSlot(f.services, payload);
    expect(out.status).toBe('final_gate');
    expect(toolkit.calls.filter((c) => c.method === 'normalizeAudio')).toHaveLength(1);
    expect(toolkit.calls.filter((c) => c.method === 'renderVideo')).toHaveLength(1);
    const q4 = (await slotMedia(f.db, payload.slotId))!.reports.filter((r) => r.stage === 'Q4');
    expect(q4[0]!.checks.find((c) => c.check === 'loudness')!.message).toMatch(/-19\.5 LUFS/);
  });

  it('a caption mismatch that survives 2 fix loops blocks the slot with a report and an Owner notification', async () => {
    const bad = { ocrText: 'lorem ipsum dolor' };
    const toolkit = new FakeToolkit({ renders: [bad, bad, bad, bad] });
    const f = await mediaFixture({ toolkit });
    const payload = await f.queued('voiceover');
    const out = await renderSlot(f.services, payload);
    expect(out.status).toBe('blocked');
    expect(out.reason).toMatch(/^Q4 failed after 2 fix loops: .*caption ocr/);
    const slot = await f.db.one<{ status: string; block_reason: string }>('SELECT status, block_reason FROM calendar_slot WHERE id = $1', [payload.slotId]);
    expect(slot.status).toBe('blocked');
    expect(slot.block_reason).toMatch(/^Q4/);
    const q4 = (await slotMedia(f.db, payload.slotId))!.reports.filter((r) => r.stage === 'Q4');
    expect(q4).toHaveLength(3);
    expect(q4.every((r) => !r.pass)).toBe(true);
    const defects = await f.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM qc_defect WHERE type = 'caption_ocr' AND persona_id = $1`, [f.personaId]);
    expect(defects.n).toBe(3);
    const note = await f.db.one<{ title: string; link: string }>(`SELECT title, link FROM notification WHERE persona_id = $1 ORDER BY created_at DESC LIMIT 1`, [f.personaId]);
    expect(note.title).toMatch(/QC blocked a render/);
    expect(note.link).toBe(`/pipeline/${payload.slotId}`);
    expect(await publishJobs(f.db, payload.slotId)).toHaveLength(0);
    // Captions were re-sized on each loop (the maker's fix), never edited by QC.
    expect(toolkit.calls.filter((c) => c.method === 'renderVideo')).toHaveLength(3);
    // Majors only: an Owner-only "publish anyway" card with the report, the failing checks and the payload.
    expect(out.reason).toMatch(/publish anyway/);
    const card = await f.db.one<{ id: string; mode: string; payload: { report_id: string; failing: Array<{ severity: string }>; prepare: { slotId: string; media: unknown[] } } }>(`SELECT id, mode, payload FROM approval WHERE kind = 'qc_override'`);
    expect(card.mode).toBe('explicit');
    expect(card.payload.failing.every((x) => x.severity === 'major')).toBe(true);
    expect(card.payload.prepare.slotId).toBe(payload.slotId);
    expect(card.payload.prepare.media).toHaveLength(1);
    await decide(f.db, { approvalId: card.id, decision: 'approve', actor: OWNER, note: 'captions are fine on a manual check' });
    expect((await f.db.one<{ status: string }>('SELECT status FROM calendar_slot WHERE id = $1', [payload.slotId])).status).toBe('final_gate');
    expect(await publishJobs(f.db, payload.slotId)).toHaveLength(1);
  });

  it('Q3: a talking clip whose face drifted is regenerated, then passes', async () => {
    let talks = 0;
    const toolkit = new FakeToolkit({ onFetch: (url) => (/\/talking\//.test(url) && ++talks === 1 ? { face: { identity: 'other', similarity: 0.31 } } : undefined) });
    const f = await mediaFixture({ toolkit, face: new FakeFaceMatcher() });
    const payload = await f.queued('talking');
    const out = await renderSlot(f.services, payload);
    expect(out.status).toBe('final_gate');
    expect(out.loops).toMatchObject({ q3: 1 });
    const q3 = (await slotMedia(f.db, payload.slotId))!.reports.filter((r) => r.stage === 'Q3');
    expect(q3.map((r) => r.pass)).toEqual([false, true]);
    expect(q3[0]!.checks.find((c) => c.check === 'face_similarity' && !c.pass)!.message).toMatch(/0\.31/);
  });

  it('Q3 also checks the persona on activity and static posts: a drifted Soul still is regenerated with its clip', async () => {
    let soul = 0;
    // Soul still #1 is the persona's face reference (prepared first); #2 is the post's still.
    const toolkit = new FakeToolkit({ onFetch: (url) => (/\/stills\/soul\//.test(url) && ++soul === 2 ? { face: { identity: 'other', similarity: 0.3 } } : undefined) });
    const f = await mediaFixture({ toolkit, face: new FakeFaceMatcher() });
    const payload = await f.queued('activity_text');
    const out = await renderSlot(f.services, payload);
    expect(out.status).toBe('final_gate');
    expect(out.loops).toMatchObject({ q3: 1 });
    const q3 = (await slotMedia(f.db, payload.slotId))!.reports.filter((r) => r.stage === 'Q3');
    expect(q3.map((r) => r.pass)).toEqual([false, true]);
    // The still and the clip made from it were both bought again (plus the one-off face reference still).
    expect(f.providers.imageVideo.callsTo('generateStill').filter((c) => (c.args as { soulId?: string }).soulId)).toHaveLength(3);
    expect(f.providers.imageVideo.callsTo('imageToVideo')).toHaveLength(2);

    const st = await f.queued('static');
    expect((await renderSlot(f.services, st)).status).toBe('final_gate');
    expect((await slotMedia(f.db, st.slotId))!.reports.some((r) => r.stage === 'Q3' && r.pass)).toBe(true);
  });

  it('Q2: a voice track that keeps being misheard is re-voiced twice, then blocked before any Higgsfield spend', async () => {
    const f = await mediaFixture({ mishear: (t) => t.replace(/Comment \w+/i, 'Comment plain') });
    const payload = await f.queued('talking');
    const out = await renderSlot(f.services, payload);
    expect(out.status).toBe('blocked');
    expect(out.reason).toMatch(/^Q2 voice failed after 2 re-voices/);
    expect(f.providers.voice.callsTo('tts')).toHaveLength(3);
    expect(f.providers.imageVideo.calls).toHaveLength(0);
    const hf = await f.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM credit_ledger WHERE unit = 'hf_credits'`);
    expect(hf.n).toBe(0);
  });
});

describe('media.render: credits through the governor', () => {
  it('debits Higgsfield credits at the actual cost, attributed to the slot', async () => {
    const f = await mediaFixture();
    const payload = await f.queued('voiceover');
    await renderSlot(f.services, payload);
    const ledger = await f.db.one<{ credits: string }>(
      `SELECT COALESCE(sum(amount),0) AS credits FROM credit_ledger WHERE unit = 'hf_credits' AND entry_type = 'debit' AND ref_type = 'calendar_slot' AND ref_id = $1`,
      [payload.slotId],
    );
    const gens = await f.db.one<{ credits: string }>(`SELECT COALESCE(sum(credits),0) AS credits FROM media_generation WHERE slot_id = $1`, [payload.slotId]);
    expect(Number(ledger.credits)).toBe(Number(gens.credits));
    expect(Number(ledger.credits)).toBeGreaterThan(0);
    const holds = await f.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM credit_ledger WHERE entry_type = 'hold'`);
    expect(holds.n).toBe(0);
    const usd = await f.db.one<{ n: string }>(`SELECT COALESCE(sum(amount),0) AS n FROM credit_ledger WHERE unit = 'media_usd' AND ref_id = $1 AND entry_type = 'debit'`, [payload.slotId]);
    expect(Number(usd.n)).toBeGreaterThan(0); // ElevenLabs TTS (+ STT for Q2)
  });

  it('a capped persona defers the job (6 h) instead of failing, and the board says why', async () => {
    const f = await mediaFixture({ budget: { hf_credits_month: 10 } });
    const payload = await f.queued('voiceover');
    const err = await renderSlot(f.services, payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeferJob);
    expect((err as DeferJob).delayMs).toBe(6 * 3_600_000);
    const mr = await f.db.one<{ waiting: string }>('SELECT waiting FROM media_render WHERE slot_id = $1', [payload.slotId]);
    expect(mr.waiting).toMatch(/budget cap/);
    const [item] = await pipelineBoard(f.db, f.studioId, { slotId: payload.slotId });
    expect(item!.waiting).toMatch(/budget cap/);
    expect(item!.stage).not.toBe('blocked');
  });
});

describe('media.render: live and fake never mix on a spoken post', () => {
  it('a live voice with fake generations waits for the Higgsfield key and spends nothing', async () => {
    const f = await mediaFixture();
    const payload = await f.queued('talking');
    const live = Object.assign(Object.create(Object.getPrototypeOf(f.providers.voice)), f.providers.voice, { name: 'elevenlabs' });
    const services = { ...f.services, providers: { ...f.services.providers, voice: live } };
    const err = await renderSlot(services, payload, { deps: f.deps }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeferJob);
    expect((err as DeferJob).message).toBe('pending key: higgsfield.api_key + higgsfield.api_secret');
    expect(f.providers.voice.callsTo('tts')).toHaveLength(0);
    const [item] = await pipelineBoard(f.db, f.studioId, { slotId: payload.slotId });
    expect(item!.waiting).toMatch(/pending key/);
  });
});

describe('media.render: pluggable talking provider', () => {
  it('TROUPE_TALKING_PROVIDER=fal renders talking clips through providers.talking, billed in USD', async () => {
    vi.stubEnv('TROUPE_TALKING_PROVIDER', 'fal');
    try {
      const f = await mediaFixture();
      const payload = await f.queued('talking');
      const out = await renderSlot(f.services, payload);
      expect(out.status).toBe('final_gate');
      expect(f.providers.talking.callsTo('render').length).toBeGreaterThanOrEqual(1);
      expect(f.providers.imageVideo.callsTo('talkingWithAudio')).toHaveLength(0);
      const gen = await f.db.one<{ usd: string }>(`SELECT sum(usd_cost) AS usd FROM media_generation WHERE slot_id = $1 AND operation = 'talking'`, [payload.slotId]);
      expect(Number(gen.usd)).toBeGreaterThan(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
