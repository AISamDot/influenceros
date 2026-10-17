import { CAMERA_STYLES, type Grounding, NO_CAPTIONS, nullWorld, PUBLISH_PREPARE_JOB, type PublishPreparePayload, type WorldService } from '@ios/agents';
import type { JobRow, PostFormat } from '@ios/core';
import { CAMERA_SPEC, createPromptCompiler, ensureLocations, lockLocation, placeKey, PRODUCTION_JOB, slotProduction } from '@ios/production';
import { describe, expect, it } from 'vitest';
import { FakeFaceMatcher, FakeToolkit, gradeQ4, jobs, NEUTRAL_GRADE, PIP_BOX, placeText, renderSlot, slotMedia, videoArgs } from '../src';
import { cardChrome, textSvg } from '../src/ffmpeg';
import { mediaFixture } from './helpers';

/**
 * IOS-5 stream K: the render templates for the format library (photo_dump, text_note, facecam_screen, reply_comment,
 * news_greenscreen, meme), the compiler in every generation, the camera record, the location lock and the chain.
 */

const NEW_FORMATS: PostFormat[] = ['photo_dump', 'text_note', 'facecam_screen', 'reply_comment', 'news_greenscreen', 'meme'];
const SIZE: Record<string, [number, number]> = { photo_dump: [1080, 1350] };

const G: Grounding = {
  personaId: 'x',
  timezone: 'Europe/London',
  localDate: '2026-10-19',
  localTime: '09:00',
  weekday: 'Monday',
  season: 'autumn',
  timeOfDay: 'morning',
  place: { city: 'Halifax', region: null, country: 'United Kingdom', lat: null, lon: null },
  weather: { summary: 'Overcast', tempC: 9, precipitation: false, isDay: true, source: 'fake' },
  sunrise: '07:31',
  sunset: '18:02',
  holidays: [],
  block: 'Grounding: Halifax, Monday morning in autumn, overcast, 9°C.',
};
const PIN_URL = 'https://i.pinimg.example/a-real-face.jpg';
const world: WorldService = {
  ...nullWorld(),
  grounding: async () => G,
  moodBoard: async () => ({ pins: [{ id: 'p1', url: 'https://pinterest.example/1', imageUrl: PIN_URL, title: 'cosy', description: '', board: null, source: 'apify' }], descriptors: ['muted sage', 'chunky knits'] }),
};
const compiled = { services: { prompts: createPromptCompiler, world: () => world } };

async function publishJobs(db: Parameters<typeof slotMedia>[0], slotId: string) {
  return db.query<{ id: string; payload: PublishPreparePayload }>(`SELECT id, payload FROM job WHERE kind = $1 AND payload->>'slotId' = $2`, [PUBLISH_PREPARE_JOB, slotId]);
}

describe('media.render: one post per format-library template on fakes', () => {
  it.each(NEW_FORMATS)('%s → stored assets at the export size, Q4 passes, exactly one publish.prepare with the AI flag', async (format) => {
    const f = await mediaFixture(compiled);
    if (format === 'reply_comment') {
      await f.db.query(`INSERT INTO comment (persona_id, platform, author_ref, text, classification) VALUES ($1, 'instagram', 'jane_doe99', $2, 'question')`, [
        f.personaId,
        '@jane_doe99 how do I start saving when there is nothing left? see www.spam-link.com',
      ]);
    }
    const payload = await f.queuedAs(format, format === 'news_greenscreen' ? { meta: { news: { headline: 'Interest rates cut for the third time - BBC News' } } } : {});
    expect(payload.format).toBe(format);
    const out = await renderSlot(f.services, payload);
    expect(out.status).toBe('final_gate');

    const media = (await slotMedia(f.db, payload.slotId))!;
    const [w, h] = SIZE[format] ?? [1080, 1920];
    for (const a of media.final) expect([a.width, a.height]).toEqual([w, h]);
    if (format === 'photo_dump') {
      expect(media.final.length).toBeGreaterThanOrEqual(5);
      expect(media.final.length).toBeLessThanOrEqual(10);
    } else expect(media.final).toHaveLength(1);
    const assets = await f.db.query<{ render_meta: { ai: { generated: boolean } } }>('SELECT render_meta FROM asset WHERE slot_id = $1', [payload.slotId]);
    expect(assets.every((a) => a.render_meta.ai.generated === true)).toBe(true);
    const q4 = media.reports.filter((r) => r.stage === 'Q4');
    expect(q4.at(-1)!.pass).toBe(true);
    const checks = Object.fromEntries(q4.at(-1)!.checks.map((c) => [c.check, c.pass]));

    const pub = await publishJobs(f.db, payload.slotId);
    expect(pub).toHaveLength(1);
    expect(pub[0]!.payload.aiGenerated).toBe(true);
    expect(pub[0]!.payload.format).toBe(format);
    expect(pub[0]!.payload.media).toHaveLength(media.final.length);
    expect(pub[0]!.payload.media[0]!.kind).toBe(['photo_dump', 'text_note', 'meme'].includes(format) ? 'image' : 'video');

    const prod = await slotProduction(f.db, payload.slotId);
    const cards = f.toolkit.calls.filter((c) => c.method === 'renderCard').map((c) => c.args as { layout: string; banner: string | null; background: boolean });
    const videos = f.toolkit.calls.filter((c) => c.method === 'renderVideo').map((c) => c.args as { pip: number; texts: number });
    const texts = q4.at(-1)!.checks.length ? ((await f.db.one<{ details: { ocr: Array<{ expected: string }> } }>('SELECT details FROM qc_report WHERE id = $1', [out.q4ReportId])).details.ocr.map((o) => o.expected)) : [];
    switch (format) {
      case 'photo_dump': {
        expect(checks.slide_count).toBe(true);
        // The persona stills were face-checked (Q3), joined the chain (approved) and later ones were chained from the first.
        expect(media.reports.some((r) => r.stage === 'Q3' && r.pass)).toBe(true);
        const frames = await f.db.query<{ status: string; chained_from: string | null }>('SELECT status, chained_from FROM production_frame WHERE slot_id = $1', [payload.slotId]);
        expect(frames.length).toBeGreaterThanOrEqual(3);
        expect(frames.every((x) => x.status === 'approved')).toBe(true);
        expect(frames.filter((x) => x.chained_from).length).toBeGreaterThanOrEqual(1);
        const stills = f.providers.imageVideo.callsTo('generateStill').map((c) => c.args as { aspect: string; prompt: string });
        expect(stills.filter((s) => s.aspect === '4:5').length).toBe(media.final.length);
        expect(cards.every((c) => c.layout === 'photo')).toBe(true);
        break;
      }
      case 'text_note': {
        // Typeset: nothing generated, nothing spent on Higgsfield.
        const hf = await f.db.one<{ n: string }>(`SELECT COALESCE(sum(amount),0) AS n FROM credit_ledger WHERE unit = 'hf_credits' AND ref_id = $1`, [payload.slotId]);
        expect(Number(hf.n)).toBe(0);
        expect(cards).toEqual([expect.objectContaining({ layout: 'note', background: false })]);
        expect(checks.text_length).toBe(true);
        break;
      }
      case 'meme':
        expect(cards).toEqual([expect.objectContaining({ layout: 'meme', background: true })]);
        expect(checks.text_length).toBe(true);
        break;
      case 'facecam_screen':
        expect(videos[0]!.pip).toBeGreaterThan(0);
        expect(checks.pip_safe_zone).toBe(true);
        expect(cards).toEqual([expect.objectContaining({ layout: 'screen' })]);
        expect(media.reports.some((r) => r.stage === 'Q3' && r.pass)).toBe(true);
        expect(media.voice).not.toBeNull();
        break;
      case 'reply_comment': {
        expect(checks.comment_overlay).toBe(true);
        expect(checks.handle_anonymised).toBe(true);
        const sticker = texts.find((t) => t.includes('asked:'))!;
        expect(sticker).toContain('how do I start saving when there is nothing left?');
        expect(sticker).toContain('@••••••');
        expect(sticker).not.toMatch(/jane_doe99|www|spam-link/);
        expect(media.voice).not.toBeNull();
        break;
      }
      case 'news_greenscreen': {
        expect(checks.no_outlet_logo).toBe(true);
        expect(cards).toEqual([expect.objectContaining({ layout: 'news', banner: 'NEWS DESK' })]);
        expect(videos[0]!.pip).toBeGreaterThan(0);
        expect(texts.join(' ')).toMatch(/Interest rates cut for the third time/);
        expect(texts.join(' ')).not.toMatch(/BBC/);
        break;
      }
    }
    if (format !== 'text_note') {
      expect(CAMERA_STYLES).toContain(prod!.camera);
      if (['facecam_screen', 'reply_comment', 'news_greenscreen'].includes(format)) expect(CAMERA_SPEC[prod!.camera!].talking).toBe(true);
    }

    // Idempotent: a retried job changes nothing.
    expect((await renderSlot(f.services, payload)).status).toBe('unchanged');
    expect(await publishJobs(f.db, payload.slotId)).toHaveLength(1);
  });
});

describe('the compiler in every generation', () => {
  it('talking reel: grounding in every still, no captions + accent in every clip, ≤ 10 s clips, camera recorded, pins never referenced', async () => {
    const f = await mediaFixture(compiled);
    await f.db.query(`UPDATE persona_bible SET content = jsonb_set(content, '{voice,accent}', '"Yorkshire"'::jsonb) WHERE persona_id = $1`, [f.personaId]);
    const payload = await f.queued('talking');
    expect((await renderSlot(f.services, payload)).status).toBe('final_gate');
    const stills = f.providers.imageVideo.callsTo('generateStill').map((c) => c.args as { prompt: string; referenceImageUrls?: string[] });
    const postStills = stills.slice(1); // #1 is the persona's one-off face reference
    expect(postStills.length).toBeGreaterThan(0);
    for (const s of postStills) {
      expect(s.prompt).toContain(G.block);
      expect(s.prompt).toMatch(/muted sage/); // mood as text
      expect(s.referenceImageUrls ?? []).not.toContain(PIN_URL);
    }
    const talks = f.providers.imageVideo.callsTo('talkingWithAudio').map((c) => c.args as { prompt: string; durationS: number });
    expect(talks.length).toBeGreaterThanOrEqual(2);
    for (const t of talks) {
      expect(t.prompt).toContain(NO_CAPTIONS);
      expect(t.prompt).toMatch(/fluent Yorkshire accent/);
      expect(t.prompt).toContain(G.block);
      expect(t.durationS).toBeLessThanOrEqual(10);
    }
    for (const c of f.providers.imageVideo.callsTo('imageToVideo').map((x) => x.args as { prompt: string; durationS: number })) {
      expect(c.prompt).toContain(NO_CAPTIONS);
      expect(c.durationS).toBeLessThanOrEqual(10);
    }
    const prod = (await slotProduction(f.db, payload.slotId))!;
    expect(CAMERA_SPEC[prod.camera!].talking).toBe(true);
    expect(prod.location).toBeTruthy();
    const gen = await f.db.one<{ render_meta: { prompt: { camera: string }; prompt_checks: string[] } }>(`SELECT render_meta FROM asset WHERE slot_id = $1 AND render_meta->>'gen_key' = 'talk:0'`, [payload.slotId]);
    expect(gen.render_meta.prompt_checks).toEqual([]);
  });

  it('location lock + consistency chain: stills reference the lock and the last approved frame, never a rejected one', async () => {
    let soul = 0;
    // Soul still #1 is the face reference; #2 is slot A's first still: it drifts and is rejected by Q3.
    const toolkit = new FakeToolkit({ onFetch: (url) => (/\/stills\/soul\//.test(url) && ++soul === 2 ? { face: { identity: 'other', similarity: 0.3 } } : undefined) });
    const f = await mediaFixture({ ...compiled, toolkit, face: new FakeFaceMatcher() });
    await ensureLocations(f.db, f.personaId, [{ place: 'Home office', description: 'a small home office, oak desk, window left' }]);
    await lockLocation(f.db, f.personaId, placeKey('Home office'), { refs: [{ url: 'https://hf.example/office-lock.png', assetKey: null, angle: 'wide' }], candidates: [], chosen: 0, at: new Date() });

    const a = await f.queued('static');
    expect((await renderSlot(f.services, a)).status).toBe('final_gate');
    const framesA = await f.db.query<{ url: string; status: string }>('SELECT url, status FROM production_frame WHERE slot_id = $1 ORDER BY created_at', [a.slotId]);
    expect(framesA.map((x) => x.status)).toEqual(['rejected', 'approved']);

    const b = await f.queuedAs('static');
    expect((await renderSlot(f.services, b)).status).toBe('final_gate');
    const calls = f.providers.imageVideo.callsTo('generateStill').map((c) => c.args as { referenceImageUrls?: string[] });
    const last = calls.at(-1)!.referenceImageUrls ?? [];
    expect(last).toContain('https://hf.example/office-lock.png');
    expect(last).toContain(framesA[1]!.url);
    expect(last).not.toContain(framesA[0]!.url);
    const prod = (await slotProduction(f.db, b.slotId))!;
    expect(prod.location).toBe('Home office');
    expect(prod.chain).toEqual({ from: [framesA[1]!.url], locked: true });
  });
});

describe('Q4 expectations for the format library', () => {
  const base = { voiced: true, info: { width: 1080, height: 1920, fps: 30, durationS: 20, hasAudio: true, hasVideo: true }, analysis: { info: { width: 1080, height: 1920, fps: 30, durationS: 20, hasAudio: true, hasVideo: true }, loudness: { integrated: -14, truePeak: -2, lra: 4 }, silences: [], blacks: [], freezes: [] }, ocr: [], coverOk: true, aiFlag: true, ctaKeyword: 'SAVE', caption: 'Comment SAVE', hashtags: ['#a', '#b', '#c'] };
  const sticker = (text: string) => ({ text, startS: 0, endS: 20, style: 'sticker' as const, fontSize: 46, box: { x: 100, y: 300, w: 800, h: 120 } });

  it('a visible @handle on a reply blocks; an outlet on the News Desk blocks; a persona box outside the safe zone fails', () => {
    const reply = gradeQ4({ ...base, format: 'reply_comment', texts: [sticker('@jane_doe99 asked: "how?"')] });
    expect(reply.checks.find((c) => c.check === 'handle_anonymised')).toMatchObject({ pass: false, severity: 'blocker' });
    expect(gradeQ4({ ...base, format: 'reply_comment', texts: [sticker('@•••••• asked: "how?"')] }).checks.find((c) => c.check === 'handle_anonymised')!.pass).toBe(true);
    const news = gradeQ4({ ...base, format: 'news_greenscreen', texts: [], chromeText: ['CNN'], pip: PIP_BOX.news_greenscreen });
    expect(news.checks.find((c) => c.check === 'no_outlet_logo')).toMatchObject({ pass: false, severity: 'blocker' });
    const off = gradeQ4({ ...base, format: 'facecam_screen', texts: [], pip: { x: 900, y: 1500, w: 300, h: 400 } });
    expect(off.checks.find((c) => c.check === 'pip_safe_zone')!.pass).toBe(false);
    const dump = gradeQ4({ ...base, voiced: false, analysis: null, format: 'photo_dump', info: { ...base.info, height: 1350, durationS: 0 }, slides: Array.from({ length: 4 }, () => ({ ...base.info, height: 1350, durationS: 0 })), texts: [] });
    expect(dump.checks.find((c) => c.check === 'slide_count')!.pass).toBe(false);
  });
});

describe('production identity and location lock jobs (fakes)', () => {
  it('look.build makes the sheet, detail strip, identity stack, 4 core refs and the BOPA pack once; renders then carry the stack', async () => {
    const f = await mediaFixture(compiled);
    const job = { payload: { personaId: f.personaId }, persona_id: f.personaId } as unknown as JobRow;
    const r = (await jobs[PRODUCTION_JOB.lookBuild]!({ services: f.services, job, heartbeat: async () => true })) as { made: number; total: number };
    expect(r.made).toBe(r.total);
    const kinds = await f.db.query<{ kind: string; n: number }>(`SELECT kind, count(*)::int AS n FROM production_identity WHERE persona_id = $1 AND status = 'active' GROUP BY kind ORDER BY kind`, [f.personaId]);
    expect(Object.fromEntries(kinds.map((k) => [k.kind, k.n]))).toEqual({
      bopa_angle: 3,
      bopa_background: 1,
      bopa_background_grid: 1,
      bopa_outfit: 2,
      bopa_pose: 1,
      bopa_pose_grid: 1,
      core: 4,
      detail_strip: 1,
      face: 1,
      full_body: 2,
      sheet: 1,
    });
    const before = f.providers.imageVideo.callsTo('generateStill').length;
    const again = (await jobs[PRODUCTION_JOB.lookBuild]!({ services: f.services, job, heartbeat: async () => true })) as { made: number };
    expect(again.made).toBe(0);
    expect(f.providers.imageVideo.callsTo('generateStill').length).toBe(before);
    const ledger = await f.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM credit_ledger WHERE ref_type = 'persona' AND ref_id = $1 AND entry_type = 'debit'`, [f.personaId]);
    expect(ledger.n).toBeGreaterThan(15);

    const payload = await f.queued('static');
    expect((await renderSlot(f.services, payload)).status).toBe('final_gate');
    const refs = (f.providers.imageVideo.callsTo('generateStill').at(-1)!.args as { referenceImageUrls?: string[] }).referenceImageUrls ?? [];
    const stack = await f.db.query<{ url: string }>(`SELECT url FROM production_identity WHERE persona_id = $1 AND kind IN ('face','full_body') AND status = 'active'`, [f.personaId]);
    for (const s of stack) expect(refs).toContain(s.url);
  });

  it('production.lock_locations locks each place from 5 candidates plus an anchor angle; a re-pick reuses the candidates', async () => {
    const f = await mediaFixture();
    const job = (payload: Record<string, unknown>) => ({ payload: { personaId: f.personaId, ...payload }, persona_id: f.personaId }) as unknown as JobRow;
    const r = (await jobs[PRODUCTION_JOB.lockLocations]!({ services: f.services, job: job({}), heartbeat: async () => true })) as { locked: number; pending: number };
    expect(r).toEqual({ locked: 2, pending: 0 });
    const locks = await f.db.query<{ place: string; status: string; refs: Array<{ url: string }>; candidates: unknown[]; chosen: number }>(`SELECT place, status, refs, candidates, chosen FROM location_lock WHERE persona_id = $1 ORDER BY place`, [f.personaId]);
    expect(locks.map((l) => [l.place, l.status, l.refs.length, l.candidates.length])).toEqual([
      ['Corner café', 'locked', 2, 5],
      ['Home office', 'locked', 2, 5],
    ]);
    const stills = f.providers.imageVideo.callsTo('generateStill').map((c) => c.args as { soulId?: string; prompt: string });
    expect(stills).toHaveLength(12);
    expect(stills.every((s) => !s.soulId && /No people in frame/.test(s.prompt))).toBe(true);
    await jobs[PRODUCTION_JOB.lockLocations]!({ services: f.services, job: job({ place: 'home office', pick: 3 }), heartbeat: async () => true });
    expect(f.providers.imageVideo.callsTo('generateStill')).toHaveLength(13);
    const office = await f.db.one<{ chosen: number }>(`SELECT chosen FROM location_lock WHERE persona_id = $1 AND place = 'Home office'`, [f.personaId]);
    expect(office.chosen).toBe(3);
  });
});

describe('FFmpeg graph for the format library (pure)', () => {
  it('letterboxes a 4:5 slide into the 9:16 slideshow (contain + pad in the persona colour), never crops it', () => {
    const base = { width: 1080, height: 1920, fps: 30, durationS: 6, pip: null, audio: null, texts: [], grade: NEUTRAL_GRADE, sharpen: false, loudnorm: 'none' as const, metadata: {} };
    const graph = (seg: Record<string, unknown>) => {
      const args = videoArgs({ ...base, segments: [{ file: 's1.jpg', kind: 'image', startS: 0, durationS: 3, ...seg }, { file: 's2.jpg', kind: 'image', startS: 3, durationS: 3 }] }, [], 'out.mp4');
      return args[args.indexOf('-filter_complex') + 1]!;
    };
    const g = graph({ fit: 'contain', padColor: '#F4EFE6' });
    expect(g).toContain('[0:v]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0xF4EFE6');
    expect(g).toContain('[1:v]scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920'); // default stays cover
    // A colour that isn't #RRGGBB never reaches the filter graph.
    expect(graph({ fit: 'contain', padColor: 'red;drawtext' })).toContain('color=black');
  });


  it('overlays the persona box at its place, after the main track and before the text layers; stickers are dark on white', () => {
    const box = PIP_BOX.facecam_screen;
    const args = videoArgs(
      {
        width: 1080,
        height: 1920,
        fps: 30,
        durationS: 12,
        segments: [{ file: 'backdrop.jpg', kind: 'image', startS: 0, durationS: 12, motion: 'none' }],
        pip: { segments: [{ file: 't0.mp4', kind: 'video', startS: 0, durationS: 6, offsetS: 0 }, { file: 't1.mp4', kind: 'video', startS: 6, durationS: 6, offsetS: 0 }], box },
        audio: { file: 'voice.mp3' },
        texts: [placeText('Step one', 'headline', 0, 12)],
        grade: NEUTRAL_GRADE,
        sharpen: true,
        loudnorm: 'single',
        metadata: {},
      },
      ['t0.png'],
      'out.mp4',
    );
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain(`[1:v]scale=${box.w}:${box.h}`);
    expect(graph).toContain('[p0][p1]concat=n=2');
    expect(graph).toContain(`[base][pip]overlay=${box.x}:${box.y}`);
    expect(graph).toContain('[g0][3:v]overlay'); // the text layer comes after 1 main + 2 box inputs
    expect(graph).toContain('[4:a]aresample'); // the voice track is the last input
    const svg = textSvg(placeText('@•••••• asked: "how?"', 'sticker', 0, 5), { width: 1080, height: 1920 });
    expect(svg).toContain('fill="#FFFFFF"');
    expect(svg).toContain('fill="#16151A"');
    expect(cardChrome({ width: 1080, height: 1920, layout: 'news', banner: 'NEWS DESK', colors: { bg: '#000', ink: '#fff', accent: '#f00' } })).toContain('NEWS DESK');
  });
});
