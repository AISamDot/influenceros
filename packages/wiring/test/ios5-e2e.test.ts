import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CADENCE, MEDIA_RENDER_JOB, PUBLISH_PREPARE_JOB, type StudioServices } from '@ios/agents';
import { createTestStudio, type TestStudio } from '@ios/agents/testing';
import { processSlot, planWeek } from '@ios/content';
import { type JobRow, OWNER, runOnce } from '@ios/core';
import * as formats from '@ios/formats';
import { chooseOption, createDraft, launchDraft, launchFormats, regenerateStep } from '@ios/generator';
import { isVideoFormat, mediaKind } from '@ios/distribution';
import { FakeFaceMatcher, FakeOcr, FakeToolkit, setMediaDeps, slotMedia } from '@ios/media';
import { createPromptCompiler } from '@ios/production';
import { createCadencePolicy, createRoutingPolicy, createWorker } from '@ios/profit';
import { createFakeProviders } from '@ios/providers';
import * as radar from '@ios/radar';
import { createWorldService } from '@ios/world';
import { afterEach, describe, expect, it } from 'vitest';
import { allJobs, allTools } from '../src';

/**
 * IOS-5 integrator E2E on fakes (docs/IOS-5-CONTRACTS.md §7): a draft with Radar evidence (I) → step 6 with a Format
 * Plan (L) and a World Bible (J) → the Owner's launch → a week planned from the plan with storyline beats → a script
 * grounded and checked (J) → a photo_dump slot rendered with compiled prompts (K) → a day of story frames published
 * to Instagram (L) → story metrics feeding the Stories lever (a lever version of the Format Plan).
 */

const DAY = 86_400_000;
const clock = { now: new Date('2026-10-16T09:00:00Z') };

let t: TestStudio | null = null;
afterEach(async () => {
  await t?.db.close();
  t = null;
});

/** Runs every due job (inline, the worker's handlers) until the queue is empty or only future-deferred jobs remain. */
async function drain(services: StudioServices, kinds: (k: string) => boolean, max = 300): Promise<Array<{ kind: string; outcome: string }>> {
  const handlers = Object.fromEntries(
    Object.entries(allJobs())
      .filter(([k]) => kinds(k))
      .map(([k, h]) => [k, (job: JobRow) => h({ services, job, heartbeat: async () => true })]),
  );
  const log: Array<{ kind: string; outcome: string }> = [];
  for (let i = 0; i < max; i += 1) {
    const r = await runOnce(services.db, handlers, { workerId: 'e2e', now: new Date(Math.max(Date.now(), services.now().getTime()) + 60 * 60_000), policy: { baseMs: 1, capMs: 1 } });
    if (!r) break;
    log.push({ kind: r.job.kind, outcome: r.outcome });
    if (r.outcome === 'deferred' && log.filter((l) => l.kind === r.job.kind && l.outcome === 'deferred').length > 5) break;
  }
  return log;
}

describe('IOS-5 end to end (fakes)', () => {
  it('Radar evidence → Format Plan + World Bible → launch → planned week with beats → grounded script → photo_dump render → Stories → Stories lever', async () => {
    const providers = createFakeProviders();
    t = await createTestStudio({
      now: () => clock.now,
      providers,
      tools: allTools(),
      cadence: createCadencePolicy,
      routing: createRoutingPolicy,
      radar: radar.createRadarService,
      world: createWorldService,
      prompts: createPromptCompiler,
      formatPlans: formats.createFormatPlanService,
    });
    const { db, studioId, services } = t;
    setMediaDeps(services, { toolkit: new FakeToolkit(), ocr: new FakeOcr(), face: new FakeFaceMatcher(), workRoot: mkdtempSync(join(tmpdir(), 'ios5-e2e-')) });
    const ctx = { actor: OWNER };

    // 1. I → generator step 1: the weekly Radar run scans the draft's niches; redrafting step 1 carries its evidence.
    // The Owner's idea keeps option A's niche through a redraft (the fake rotates the other options).
    let d = await createDraft(services, { studioId, idea: 'A retired dinner lady who runs her pension like a canteen: budgeting for over-60s', actor: OWNER });
    expect(d.state.opportunity.options[0]!.niche).toBe('wealth');
    expect(await radar.enqueueWeekly(services, studioId)).toBeTruthy();
    const radarLog = await drain(services, (k) => k.startsWith('radar.') || k.startsWith('remix.'));
    expect(radarLog.filter((l) => l.outcome !== 'succeeded' && l.outcome !== 'deferred')).toEqual([]);
    expect((await db.one<{ n: number }>('SELECT count(*)::int AS n FROM tracked_account WHERE studio_id = $1', [studioId])).n).toBeGreaterThan(0);
    d = await regenerateStep(services, d.id, 1, ctx);
    expect(d.state.radar?.evidence.length).toBeGreaterThan(0);
    const chosenNiche = d.state.opportunity.options.find((o) => o.id === 'A')!.niche;
    expect(chosenNiche).toBe('wealth');
    expect(d.state.opportunity.options[0]!.evidence.some((e) => e.flag === 'S' && /Growth Radar/.test(e.source ?? ''))).toBe(true);

    // 2. Steps 2–6: step 6 carries the Studio Manager's Format Plan and the World Bible draft.
    for (const step of [1, 2, 3, 4, 5, 6]) d = await chooseOption(services, d.id, step, 'A', ctx);
    expect(d.state.opportunity.chosen?.niche).toBe(chosenNiche);
    const plan = d.state.formatPlan!;
    expect(plan).toBeTruthy();
    expect(plan.lines.every((l) => l.reason.length > 0 && l.costPerWeekUsd >= 0)).toBe(true);
    const planned = new Map(plan.lines.filter((l) => l.enabled && l.perWeek > 0).map((l) => [l.format, l.perWeek]));
    for (const f of ['static', 'carousel'] as const) expect(planned.get(f) ?? 0).toBeGreaterThan(0);
    expect(plan.stories.perDay).toBeGreaterThanOrEqual(3);
    expect(plan.stories.perDay).toBeLessThanOrEqual(5);
    expect(d.state.world).toBeTruthy();

    // 3. The Owner's launch adopts both; the launch fortnight follows the plan.
    const r = await launchDraft(services, d.id, ctx);
    const pid = r.persona.id;
    const adopted = await services.formatPlans.planFor(pid);
    expect(adopted?.lines.map((l) => [l.format, l.perWeek])).toEqual(plan.lines.map((l) => [l.format, l.perWeek]));
    expect(await db.maybeOne('SELECT 1 FROM world_bible WHERE persona_id = $1', [pid])).toBeTruthy();
    const launchSlots = await db.query<{ format: string }>('SELECT format FROM calendar_slot WHERE persona_id = $1', [pid]);
    expect(launchSlots).toHaveLength(20);
    const launchFormats = new Set(launchSlots.map((s) => s.format));
    for (const f of planned.keys()) expect(launchFormats.has(f), f).toBe(true);

    // The persona goes live on Instagram and TikTok (accounts connected, TESTING).
    await db.query(`UPDATE persona SET state = 'TESTING', autonomy = 'L1', launched_at = $2 WHERE id = $1`, [pid, clock.now]);
    await db.query(`UPDATE account SET status = 'active', ai_label_ok = true, handle = platform || '_e2e', token_ref = 'zr_' || platform WHERE persona_id = $1`, [pid]);

    // 4. A week planned from the plan, tagged with storyline beats.
    const weekStart = new Date('2026-11-16T00:00:00Z');
    clock.now = new Date('2026-11-13T09:00:00Z');
    const week = await planWeek(services, pid, weekStart);
    expect(week.created).toBeGreaterThan(0);
    const slots = await db.query<{ id: string; format: string; purpose: string; story: { beat?: string } | null }>(
      `SELECT id, format, purpose, meta->'story' AS story FROM calendar_slot WHERE id = ANY($1::uuid[]) ORDER BY slot_at`,
      [week.slotIds],
    );
    const weekFormats = new Set(slots.map((s) => s.format));
    for (const f of planned.keys()) expect(weekFormats.has(f), f).toBe(true);
    const beats = slots.filter((s) => s.story?.beat);
    expect(beats.length).toBeGreaterThan(0);
    expect(beats.every((s) => s.purpose !== 'sell')).toBe(true);

    // 5. A beat slot's script is grounded and checked (world checks in Q1; facts to the continuity ledger).
    const beatSlot = beats[0]!;
    const out = await processSlot(services, beatSlot.id);
    expect(out.status).toBe('media_queued');
    const q1 = await db.one<{ details: { checks: Array<{ check: string }> } }>(`SELECT details FROM qc_report WHERE subject_id = $1 AND stage = 'Q1' ORDER BY created_at DESC LIMIT 1`, [out.scriptId]);
    expect(q1.details.checks.map((c) => c.check)).toEqual(expect.arrayContaining(['continuity', 'no_repeat', 'near_duplicate_wording']));
    expect(await db.maybeOne(`SELECT 1 FROM continuity_record WHERE subject_type = 'script' AND subject_id = $1`, [out.scriptId])).toBeTruthy();
    await db.query(`DELETE FROM job WHERE kind = $1`, [MEDIA_RENDER_JOB]);

    // 6. A photo_dump slot rendered with compiled prompts: 5–10 slides at 1080×1350, one publish.prepare, an Instagram post.
    let dump = slots.find((s) => s.format === 'photo_dump');
    if (!dump) {
      await db.query(`UPDATE calendar_slot SET format = 'photo_dump' WHERE id = $1`, [slots.find((s) => s.id !== beatSlot.id && s.purpose !== 'sell')!.id]);
      dump = slots.find((s) => s.id !== beatSlot.id && s.purpose !== 'sell')!;
    }
    expect((await processSlot(services, dump.id)).status).toBe('media_queued');
    const worker = createWorker({ services, handlers: allJobs(), workerId: 'e2e' });
    await worker.drain();
    const jobs = await db.query<{ kind: string; status: string; last_error: string | null }>(`SELECT kind, status, last_error FROM job WHERE kind IN ($1, $2) ORDER BY kind DESC`, [MEDIA_RENDER_JOB, PUBLISH_PREPARE_JOB]);
    expect(jobs.map((j) => [j.kind, j.status, j.last_error])).toEqual([
      [PUBLISH_PREPARE_JOB, 'succeeded', null],
      [MEDIA_RENDER_JOB, 'succeeded', null],
    ]);
    const media = (await slotMedia(db, dump.id))!;
    expect(media.final.length).toBeGreaterThanOrEqual(5);
    expect(media.final.length).toBeLessThanOrEqual(10);
    for (const a of media.final) expect([a.width, a.height]).toEqual([1080, 1350]);
    const grounding = await services.world.grounding(pid, clock.now);
    expect(grounding?.place.city).toBeTruthy();
    // Every still of the dump was compiled (K) with the persona's grounding block (J) for the slot's local moment.
    const stills = providers.imageVideo.calls
      .filter((c) => c.method === 'generateStill')
      .map((c) => String((c.args as { prompt: string }).prompt))
      .filter((p) => /Photo dump/.test(p));
    expect(stills.length).toBeGreaterThanOrEqual(3);
    expect(stills.every((p) => p.includes(`Local moment for ${r.persona.name}`) && p.includes(grounding?.place.city ?? '?'))).toBe(true);
    const posts = await db.query<{ platform: string; format: string; status: string; ai_flag: boolean; meta: Record<string, unknown> }>(
      `SELECT platform, format, status, ai_flag, meta FROM post WHERE calendar_slot_id = $1 ORDER BY platform`,
      [dump.id],
    );
    // Instagram gets the photos; TikTok gets the same stills as a slideshow video (its photo posts can't carry the AI
    // disclosure), AI flag on.
    expect(posts.map((p) => [p.platform, p.format, p.ai_flag])).toEqual([
      ['instagram', 'photo_dump', true],
      ['tiktok', 'photo_dump', true],
    ]);
    expect(posts[1]!.meta).toMatchObject({ kind: 'video', slideshow: true });
    for (const p of posts) expect(['scheduled', 'awaiting_approval']).toContain(p.status);

    // 7. A day of story frames, produced and published as Stories on Instagram only (TikTok has no Stories).
    const days = ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'];
    const first = await formats.planStoryDay(services, pid, days.at(-1));
    expect(first.length).toBe(adopted!.stories.perDay);
    for (const f of first) expect((await formats.produceStoryFrame(services, f.id)).status).toBe('approved');
    for (const f of first) {
      const res = await formats.publishStoryFrame(services, f.id);
      expect(res.results.find((x) => x.platform === 'instagram')).toMatchObject({ status: 'published' });
      expect(res.results.find((x) => x.platform === 'tiktok')?.status ?? 'unsupported').toBe('unsupported');
    }
    const sent = providers.publish.calls.filter((c) => c.method === 'publish').map((c) => c.args as { kind: string; aiLabel: boolean; platform: string });
    expect(sent.filter((s) => s.kind === 'story')).toHaveLength(first.length);
    expect(sent.filter((s) => s.kind === 'story').every((s) => s.platform === 'instagram' && s.aiLabel === true)).toBe(true);

    // 8. Three more days, then story metrics feed the weekly Stories lever (a lever version of the Format Plan).
    for (const date of days.slice(0, -1)) {
      for (const f of await formats.planStoryDay(services, pid, date)) {
        await formats.produceStoryFrame(services, f.id);
        await formats.publishStoryFrame(services, f.id);
      }
    }
    const storyPosts = await db.query<{ external_id: string; kind: string }>(`SELECT sp.external_id, f.kind FROM story_post sp JOIN story_frame f ON f.id = sp.story_frame_id WHERE sp.persona_id = $1 AND sp.status = 'published'`, [pid]);
    expect(storyPosts.length).toBeGreaterThanOrEqual(formats.STORY_TUNE.minFrames);
    const from = adopted!.stories.perDay;
    // Viewers leave (55% tap away or exit): the lever drops a frame a day, unless the plan is already at 3, where
    // viewers who stay and reply add one.
    const leaving = from > 3;
    for (const s of storyPosts) {
      providers.publish.storyMetrics.set(s.external_id, leaving ? { reach: 500, replies: 1, tapsForward: 200, exits: 75, tapsBack: 5 } : { reach: 500, replies: 12, tapsForward: 40, exits: 20, tapsBack: 5 });
    }
    expect((await formats.ingestStoryMetrics(services)).captured).toBe(storyPosts.length);
    const tune = await allJobs()[formats.STORY_JOB.tune]!({ services, job: { payload: { personaId: pid } } as unknown as JobRow, heartbeat: async () => true });
    expect(tune).toMatchObject({ personas: 1, moved: [{ personaId: pid, from, to: leaving ? from - 1 : from + 1 }] });
    const tuned = await services.formatPlans.planFor(pid);
    // A new plan version from the lever; only Stories moved, so the feed lines keep their source (and winner scaling).
    expect(tuned).toMatchObject({ source: adopted!.source, stories: { perDay: leaving ? from - 1 : from + 1 } });
    expect(tuned!.reason).toMatch(/^Stories lever:/);
    expect(tuned!.lines.map((l) => [l.format, l.perWeek])).toEqual(adopted!.lines.map((l) => [l.format, l.perWeek]));
    expect(clock.now.getTime() - new Date('2026-11-10T00:00:00Z').getTime()).toBeLessThan(5 * DAY);
  }, 240_000);

  it('the launch fortnight follows the Format Plan (or the studio default), and distribution knows what each format exports', () => {
    const count = (fs: readonly string[]) => fs.reduce<Record<string, number>>((a, f) => ({ ...a, [f]: (a[f] ?? 0) + 1 }), {});
    const def = launchFormats(null);
    expect(def).toHaveLength(10);
    expect(count(def)).toEqual(DEFAULT_CADENCE.formatMix);
    // No format runs back to back when the mix allows it.
    expect(def.every((f, i) => i === 0 || f !== def[i - 1])).toBe(true);
    const plan = formats.editPlan(formats.defaultPlan(), { counts: { meme: 2, text_note: 1 } });
    const withMemes = count(launchFormats(plan));
    expect(Object.values(withMemes).reduce((a, b) => a + b, 0)).toBe(10);
    for (const f of ['talking', 'activity_text', 'voiceover', 'static', 'carousel']) expect(withMemes[f], f).toBeGreaterThanOrEqual(1);

    expect((['photo_dump', 'carousel'] as const).map((f) => mediaKind(f))).toEqual(['carousel', 'carousel']);
    expect((['static', 'text_note', 'meme'] as const).map((f) => mediaKind(f))).toEqual(['image', 'image', 'image']);
    expect(['talking', 'activity_text', 'voiceover', 'facecam_screen', 'reply_comment', 'news_greenscreen', 'product_in_hand', 'trend_reenactment'].every((f) => isVideoFormat(f as never))).toBe(true);
  });
});
