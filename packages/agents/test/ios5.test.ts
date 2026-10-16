import { CORE_FORMATS, FORMAT_SHAPE, OPTIONAL_FORMATS, POST_FORMATS, releaseHold, reserve, scriptShape } from '@ios/core';
import { FakeApify } from '@ios/providers';
import { describe, expect, it } from 'vitest';
import {
  APIFY_PROVIDER,
  ApifyWeeklyCapError,
  apifyWeekSpendUsd,
  basicPromptCompiler,
  CAMERA_STYLES,
  DEFAULT_CADENCE,
  fingerprintOf,
  type Grounding,
  meteredApify,
  NO_CAPTIONS,
  nullFormatPlans,
  nullRadar,
  nullWorld,
  speechSeconds,
  STORY_FRAME_KINDS,
  WINNER_CADENCE,
} from '../src';
import { createTestStudio, makeTestPersona } from '../src/testing';

const grounding: Grounding = {
  personaId: 'p',
  timezone: 'Europe/London',
  localDate: '2026-11-05',
  localTime: '18:10',
  weekday: 'Thursday',
  season: 'autumn',
  timeOfDay: 'evening',
  place: { city: 'Leeds', region: 'West Yorkshire', country: 'United Kingdom', lat: 53.8, lon: -1.55 },
  weather: { summary: 'light rain', tempC: 7, precipitation: true, isDay: false, source: 'fake' },
  sunrise: '07:05',
  sunset: '16:30',
  holidays: ['Bonfire Night (Thu)'],
  block: 'Leeds, Thursday 5 Nov 2026, 18:10, dark outside, 7 °C light rain, Bonfire Night.',
};

describe('IOS-5 shared contracts', () => {
  it('knows every format and gives each a script shape', () => {
    expect(POST_FORMATS).toEqual([...CORE_FORMATS, ...OPTIONAL_FORMATS]);
    for (const f of ['photo_dump', 'text_note', 'facecam_screen', 'reply_comment', 'news_greenscreen', 'meme'] as const) expect(OPTIONAL_FORMATS).toContain(f);
    for (const f of POST_FORMATS) expect(CORE_FORMATS).toContain(FORMAT_SHAPE[f]);
    expect(scriptShape('photo_dump')).toBe('carousel');
    expect(scriptShape('facecam_screen')).toBe('talking');
    expect(scriptShape('meme')).toBe('static');
  });

  it('keeps the core-format invariant in the default cadences', () => {
    for (const t of [DEFAULT_CADENCE, WINNER_CADENCE]) {
      for (const f of CORE_FORMATS) expect(t.formatMix[f]).toBeGreaterThanOrEqual(1);
      expect(Object.values(t.formatMix).reduce((a, b) => a + (b ?? 0), 0)).toBe(t.postsPerWeek);
      expect(Object.values(t.purposeMix).reduce((a, b) => a + b, 0)).toBe(t.postsPerWeek);
    }
    // FR-4.3c (Owner, 16 Oct): the still-heavier studio default, and the winner default scaled to ~17.
    expect(DEFAULT_CADENCE.formatMix).toEqual({ talking: 2, activity_text: 2, voiceover: 1, static: 2, carousel: 2, photo_dump: 1 });
    expect(WINNER_CADENCE.postsPerWeek).toBe(17);
    expect(WINNER_CADENCE.formatMix).toEqual({ talking: 4, activity_text: 3, voiceover: 2, static: 3, carousel: 3, photo_dump: 2 });
    const stills = (t: typeof DEFAULT_CADENCE) => (t.formatMix.static ?? 0) + (t.formatMix.carousel ?? 0) + (t.formatMix.photo_dump ?? 0);
    expect(stills(DEFAULT_CADENCE) / DEFAULT_CADENCE.postsPerWeek).toBe(0.5);
    expect(stills(WINNER_CADENCE) / WINNER_CADENCE.postsPerWeek).toBeCloseTo(0.47, 2);
  });

  it('composes the null services into createServices', async () => {
    const t = await createTestStudio();
    expect(await t.services.radar.formatBenchmarks({ studioId: t.studioId, niche: 'x' })).toBeNull();
    expect(await t.services.world.grounding('p', new Date())).toBeNull();
    expect(await t.services.world.beatsForWeek({ personaId: 'p', weekStart: new Date(), slots: [] })).toEqual([]);
    expect((await t.services.world.checkConcept({ studioId: t.studioId, personaId: null, fingerprint: fingerprintOf({ title: 'a', niche: 'n', format: 'meme', hook: 'h' }) })).ok).toBe(true);
    expect(await t.services.formatPlans.planFor('p')).toBeNull();
    const img = await t.services.prompts.image({ personaId: 'p', scene: 'At the kitchen table', grounding });
    expect(img.text).toContain(grounding.block);
    await t.db.close();
  });

  it('a stream factory receives the finished services lazily', async () => {
    let seen: unknown = null;
    const t = await createTestStudio({
      radar: (base, services) => ({
        ...nullRadar(base),
        formatBenchmarks: async () => {
          seen = services().runtime.mode;
          return null;
        },
      }),
      world: (base) => nullWorld(base),
      formatPlans: (base) => nullFormatPlans(base),
    });
    await t.services.radar.formatBenchmarks({ studioId: t.studioId, niche: 'x' });
    expect(seen).toBe('fake');
    await t.db.close();
  });

  it('the basic compiler keeps the grounding block and "no captions" in every video prompt', async () => {
    const c = basicPromptCompiler();
    const v = await c.video({ personaId: 'p', startFrame: 'Kitchen, kettle on', action: 'pours tea', line: 'Right then.', accent: 'fluent Yorkshire accent', durationS: 4, grounding, camera: 'propped_phone' });
    expect(v.text).toContain(NO_CAPTIONS);
    expect(v.text).toContain(grounding.block);
    expect(v.text).toContain('fluent Yorkshire accent');
    expect(CAMERA_STYLES).toContain('propped_phone');
    expect(speechSeconds(25)).toBe(10);
    expect(STORY_FRAME_KINDS).toEqual(['world', 'storyline', 'reshare', 'engagement', 'sell']);
  });

  it('migration 0016 accepts the new formats', async () => {
    const t = await createTestStudio();
    const p = await makeTestPersona(t);
    for (const f of ['photo_dump', 'text_note', 'facecam_screen', 'reply_comment', 'news_greenscreen', 'meme']) {
      await t.db.query(`INSERT INTO idea (persona_id, title, format, purpose) VALUES ($1, $2, $3, 'reach')`, [p.id, `t ${f}`, f]);
    }
    await expect(t.db.query(`INSERT INTO idea (persona_id, title, format) VALUES ($1, 'x', 'hologram')`, [p.id])).rejects.toThrow();
    // Story frames get QC reports and Gate results like posts.
    await t.db.query(`INSERT INTO qc_report (persona_id, subject_type, subject_id, stage, pass) VALUES ($1, 'story_frame', gen_random_uuid(), 'Q1', true)`, [p.id]);
    await t.db.query(`INSERT INTO gate_result (persona_id, subject_type, subject_id, stage, verdict) VALUES ($1, 'story_frame', gen_random_uuid(), 'pre_publish', 'green')`, [p.id]);
    await t.db.close();
  });

  it('FakeApify serves registered fixtures, caps items and reports a pay-per-result cost', async () => {
    const a = new FakeApify().fixture('apify/instagram-profile-scraper', (input) => [{ username: input.username }, { username: 'b' }, { username: 'c' }]);
    const r = await a.runActor({ actor: 'apify/instagram-profile-scraper', input: { username: 'a' }, maxItems: 2 });
    expect(r.items).toEqual([{ username: 'a' }, { username: 'b' }]);
    expect(r.costUsd).toBeCloseTo(2 * FakeApify.USD_PER_ITEM);
  });
});

describe('meteredApify', () => {
  it('debits every run through the governor and refuses past the weekly cap', async () => {
    const t = await createTestStudio({ settings: { apify_weekly_cap_usd: 0.05 } });
    t.providers.research.fixture('apify/instagram-hashtag-scraper', Array.from({ length: 10 }, (_, i) => ({ id: i })));
    const run = (maxItems: number) =>
      meteredApify(t.services, { studioId: t.studioId, agent: 'radar', actor: 'apify/instagram-hashtag-scraper', input: { hashtags: ['x'] }, maxItems, estimateUsd: maxItems * FakeApify.USD_PER_ITEM });
    const r = await run(10);
    expect(r.items).toHaveLength(10);
    const spent = await apifyWeekSpendUsd(t.db, t.studioId, new Date());
    expect(spent).toBeCloseTo(10 * FakeApify.USD_PER_ITEM);
    await expect(run(20)).rejects.toBeInstanceOf(ApifyWeeklyCapError);
    await t.db.close();
  });

  it('counts runs in flight (governor holds), so concurrent scans cannot overshoot the weekly cap', async () => {
    const t = await createTestStudio({ settings: { apify_weekly_cap_usd: 0.05 } });
    t.providers.research.fixture('apify/instagram-hashtag-scraper', Array.from({ length: 10 }, (_, i) => ({ id: i })));
    // Another scan is running: its estimate is held on the ledger until it settles.
    const hold = await reserve(t.db, { studioId: t.studioId, unit: 'media_usd', amount: 0.04, provider: APIFY_PROVIDER, operation: 'apify/instagram-hashtag-scraper' });
    expect(await apifyWeekSpendUsd(t.db, t.studioId, new Date())).toBeCloseTo(0.04);
    await expect(
      meteredApify(t.services, { studioId: t.studioId, agent: 'radar', actor: 'apify/instagram-hashtag-scraper', input: { hashtags: ['x'] }, maxItems: 10, estimateUsd: 10 * FakeApify.USD_PER_ITEM }),
    ).rejects.toBeInstanceOf(ApifyWeeklyCapError);
    await releaseHold(t.db, hold);
    expect(await apifyWeekSpendUsd(t.db, t.studioId, new Date())).toBe(0);
    await t.db.close();
  });
});
