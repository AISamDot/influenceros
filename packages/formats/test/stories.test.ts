import { type Grounding, nullWorld, type WorldRecordRequest, type WorldService } from '@ios/agents';
import { createTestStudio, makeTestPersona, type TestStudio } from '@ios/agents/testing';
import { attachSampleBible } from '@ios/content';
import { type JobRow, OWNER, setKillSwitch } from '@ios/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Generator walks and full Story days are heavy under the parallel suite (PGlite per test).
vi.setConfig({ testTimeout: 120_000 });
import {
  approveStoryFrame,
  createFormatPlanService,
  curateHighlights,
  defaultPlan,
  editPlan,
  framesFor,
  highlightsFor,
  ingestStoryMetrics,
  jobs,
  planStoryDay,
  produceStoryFrame,
  publishStoryFrame,
  queueDueStories,
  savePlan,
  scheduleStoryDays,
  storyChecks,
  storyStats,
  tuneStories,
} from '../src';

// Tue 20 Oct 2026, 05:30 UTC = 06:30 in London (BST until 25 Oct).
const NOW = new Date('2026-10-20T05:30:00Z');
const DATE = '2026-10-20';

let t: TestStudio | null = null;
afterEach(async () => {
  await t?.db.close();
  t = null;
});

const recorded: WorldRecordRequest[] = [];
const grounding = (personaId: string, at: Date): Grounding => ({
  personaId,
  timezone: 'Europe/London',
  localDate: DATE,
  localTime: '09:15',
  weekday: 'Tuesday',
  season: 'autumn',
  timeOfDay: 'morning',
  place: { city: 'Leeds', region: 'West Yorkshire', country: 'UK', lat: 53.8, lon: -1.55 },
  weather: { summary: 'Light rain', tempC: 9, precipitation: true, isDay: true, source: 'fake' },
  sunrise: '07:30',
  sunset: '17:50',
  holidays: [],
  block: `Grounding: Tuesday ${DATE}, ${at.toISOString()}, Leeds, autumn, light rain, 9°C.`,
});
const world = (): WorldService => ({
  ...nullWorld(),
  grounding: async (personaId, at) => grounding(personaId, at),
  beatsForWeek: async ({ slots }) => slots.map((s) => ({ slotIndex: s.index, arcId: 'a1', chapterId: 'c2', beatId: 'b5', chapter: 'Chapter 2: The allotment', beat: 'The shed key is missing again and I know who took it' })),
  recordApproved: async (q) => {
    recorded.push(q);
  },
});

async function studio(opts: { world?: boolean } = {}) {
  recorded.length = 0;
  t = await createTestStudio({ now: () => NOW, formatPlans: createFormatPlanService, ...(opts.world === false ? {} : { world: world }) });
  const p = await makeTestPersona(t, { timezone: 'Europe/London', name: 'Dot Pickering' });
  await attachSampleBible(t.db, p.id);
  return p;
}

async function account(tt: TestStudio, personaId: string, platform: string, handle: string) {
  await tt.db.query(`INSERT INTO account (persona_id, platform, handle, token_ref, status, ai_label_ok) VALUES ($1, $2, $3, $4, 'active', true)`, [personaId, platform, handle, `acc_${platform}_${handle}`]);
}

async function livePost(tt: TestStudio, personaId: string, title: string, at: Date): Promise<string> {
  const slot = await tt.db.one<{ id: string }>(`INSERT INTO calendar_slot (persona_id, slot_at, format, purpose, title, status) VALUES ($1, $2, 'static', 'reach', $3, 'live') RETURNING id`, [personaId, at, title]);
  const post = await tt.db.one<{ id: string }>(
    `INSERT INTO post (persona_id, calendar_slot_id, platform, format, caption, status, scheduled_at, published_at, external_id) VALUES ($1, $2, 'instagram', 'static', 'caption', 'live', $3, $3, 'x1') RETURNING id`,
    [personaId, slot.id, at],
  );
  return post.id;
}

/** Runs every queued job of `kind` through the module's handler (the worker's job, inline). */
async function runQueued(tt: TestStudio, kind: string): Promise<unknown[]> {
  const rows = await tt.db.query<JobRow>(`SELECT * FROM job WHERE kind = $1 AND status = 'queued' ORDER BY run_at, created_at`, [kind]);
  const out: unknown[] = [];
  for (const job of rows) {
    out.push(await jobs[kind]!({ services: tt.services, job, heartbeat: async () => true }));
    await tt.db.query(`UPDATE job SET status = 'succeeded' WHERE id = $1`, [job.id]);
  }
  return out;
}

describe('Stories engine (FR-4.3d)', () => {
  it('plans 5 native frames on a sell day (world, storyline, reshare, engagement, sell) at local times, copy in the persona voice', async () => {
    const p = await studio();
    await livePost(t!, p.id, 'Five cheap dinners from one chicken', new Date(NOW.getTime() - 20 * 3_600_000));
    await t!.db.query(`INSERT INTO calendar_slot (persona_id, slot_at, format, purpose, title) VALUES ($1, $2, 'talking', 'sell', 'Walkthrough: the meal plan')`, [p.id, new Date('2026-10-20T18:00:00Z')]);
    const frames = await planStoryDay(t!.services, p.id);
    expect(frames.map((f) => f.kind)).toEqual(['world', 'storyline', 'reshare', 'engagement', 'sell']);
    expect(frames.every((f) => f.status === 'planned' && f.story_date.toString().length > 0)).toBe(true);
    // Local times (Europe/London, BST): 08:15 … 20:30.
    expect(new Date(frames[0]!.planned_at).toISOString()).toBe('2026-10-20T07:15:00.000Z');
    expect(new Date(frames[4]!.planned_at).toISOString()).toBe('2026-10-20T19:30:00.000Z');
    expect(frames[0]!.text).toMatch(/Tuesday in Leeds: light rain, 9°C/);
    expect(frames[1]!.text).toMatch(/The allotment/);
    expect(frames[2]!.reshare_post_id).toBeTruthy();
    expect(frames[2]!.text).toMatch(/Five cheap dinners/);
    expect(frames[3]!.text).toContain(frames[3]!.cta_keyword!);
    expect(frames[4]!.cta_keyword).toBeTruthy();
    expect(frames.every((f) => !/https?:/.test(f.text ?? ''))).toBe(true);
    // Idempotent per persona-day.
    expect((await planStoryDay(t!.services, p.id)).map((f) => f.id)).toEqual(frames.map((f) => f.id));
    expect((await t!.db.one<{ agent: string }>(`SELECT agent FROM agent_run ORDER BY started_at DESC LIMIT 1`)).agent).toBe('stories-producer');
  });

  it('drops the sell frame on other days, swaps the reshare for a beat when there is no new post, and follows the plan (3–5)', async () => {
    const p = await studio();
    await t!.db.query(`INSERT INTO calendar_slot (persona_id, slot_at, format, purpose, title) VALUES ($1, $2, 'talking', 'reach', 'A reach post')`, [p.id, new Date('2026-10-20T18:00:00Z')]);
    expect((await planStoryDay(t!.services, p.id)).map((f) => f.kind)).toEqual(['world', 'storyline', 'storyline', 'engagement']);
    await savePlan(t!.db, { studioId: t!.studioId, personaId: p.id, plan: editPlan(defaultPlan(), { storiesPerDay: 3 }), actor: OWNER, now: NOW });
    expect((await planStoryDay(t!.services, p.id, '2026-10-21')).map((f) => f.kind)).toEqual(['world', 'storyline', 'engagement']);
  });

  it('makes each frame a still + overlay at 1080×1920, passes QC + Gate as story_frame, records its facts, and publishes as a story on Instagram only', async () => {
    const p = await studio();
    await account(t!, p.id, 'instagram', 'dotpickering');
    await account(t!, p.id, 'tiktok', 'dotpickering');
    await livePost(t!, p.id, 'Five cheap dinners', new Date(NOW.getTime() - 3_600_000));
    const frames = await planStoryDay(t!.services, p.id);
    const done = [];
    for (const f of frames) done.push(await produceStoryFrame(t!.services, f.id));
    for (const f of done) {
      expect(f).toMatchObject({ status: 'approved', gate_verdict: 'green', width: 1080, height: 1920 });
      expect(f.media_key).toMatch(/^stories\//);
      expect(f.prompt).toMatchObject({ text: expect.stringContaining('Grounding') });
    }
    const qc = await t!.db.query<{ subject_type: string; stage: string; pass: boolean }>(`SELECT subject_type, stage, pass FROM qc_report`);
    expect(qc).toHaveLength(frames.length);
    expect(qc.every((r) => r.subject_type === 'story_frame' && r.stage === 'Q4' && r.pass)).toBe(true);
    const gates = await t!.db.query<{ subject_type: string; verdict: string }>(`SELECT subject_type, verdict FROM gate_result`);
    expect(gates.every((g) => g.subject_type === 'story_frame' && g.verdict === 'green')).toBe(true);
    expect(recorded.map((r) => r.subject.type)).toEqual(frames.map(() => 'story_frame'));
    // Stills are governed Higgsfield spend at 720p, 9:16.
    const stills = t!.providers.imageVideo.calls.filter((c) => c.method === 'generateStill');
    expect(stills).toHaveLength(frames.length);
    expect(stills.every((c) => (c.args as { aspect: string; resolution: string }).aspect === '9:16' && (c.args as { resolution: string }).resolution === '720p')).toBe(true);
    expect((await t!.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM credit_ledger WHERE persona_id = $1 AND entry_type = 'debit'`, [p.id])).n).toBeGreaterThanOrEqual(frames.length);
    // Publishes are queued once each frame's time comes (nothing ahead of time); a frame that missed its day is skipped.
    expect(await t!.db.query(`SELECT 1 FROM job WHERE kind = 'stories.publish'`)).toHaveLength(0);
    expect(await queueDueStories(t!.services, new Date('2026-10-20T12:00:00Z'))).toEqual({ queued: 2, skipped: 0 });
    expect(await queueDueStories(t!.services, new Date('2026-10-20T21:00:00Z'))).toEqual({ queued: frames.length - 2, skipped: 0 });

    const res = await publishStoryFrame(t!.services, frames[0]!.id);
    expect(res.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ platform: 'instagram', status: 'published' }), expect.objectContaining({ platform: 'tiktok', status: 'unsupported' })]),
    );
    const sent = t!.providers.publish.calls.filter((c) => c.method === 'publish').map((c) => c.args as { kind: string; aiLabel: boolean; platform: string; mediaUrls: string[]; idempotencyKey: string });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'story', aiLabel: true, platform: 'instagram', idempotencyKey: `story:${frames[0]!.id}:instagram` });
    expect(sent[0]!.mediaUrls).toEqual([done[0]!.media_url]);
    expect((await framesFor(t!.services, p.id, DATE))[0]!.status).toBe('published');
    // Idempotent: a retry sends nothing new.
    await publishStoryFrame(t!.services, frames[0]!.id);
    expect(t!.providers.publish.calls.filter((c) => c.method === 'publish')).toHaveLength(1);

    // Kill switch: nothing goes out, the frame says why.
    await setKillSwitch(t!.db, t!.studioId, { scope: 'persona', personaId: p.id }, OWNER, 'pause');
    const blocked = await publishStoryFrame(t!.services, frames[1]!.id);
    expect(blocked.results.find((r) => r.platform === 'instagram')).toMatchObject({ status: 'blocked' });
    expect(t!.providers.publish.calls.filter((c) => c.method === 'publish')).toHaveLength(1);
  });

  it('blocks a frame that uses a story as proof a product works (Gate red), holds amber / L0 frames for the Owner, and fails QC on a link', async () => {
    const p = await studio();
    const [f1, f2] = await planStoryDay(t!.services, p.id);
    await t!.db.query(`UPDATE story_frame SET text = 'This workbook got me over him in a week, and it will work for you too' WHERE id = $1`, [f1!.id]);
    const red = await produceStoryFrame(t!.services, f1!.id);
    expect(red).toMatchObject({ status: 'blocked', gate_verdict: 'red' });
    expect(red.block_reason).toMatch(/^Gate:/);
    await t!.db.query(`UPDATE story_frame SET text = 'Read more at https://example.com today' WHERE id = $1`, [f2!.id]);
    const link = await produceStoryFrame(t!.services, f2!.id);
    expect(link).toMatchObject({ status: 'blocked' });
    expect(link.block_reason).toMatch(/No links/);
    expect(recorded).toHaveLength(0); // nothing blocked reaches the continuity ledger
    expect(await t!.db.query(`SELECT 1 FROM job WHERE kind = 'stories.publish'`)).toHaveLength(0);

    const l0 = await makeTestPersona(t!, { autonomy: 'L0', timezone: 'Europe/London' });
    await attachSampleBible(t!.db, l0.id);
    const [w] = await planStoryDay(t!.services, l0.id);
    const held = await produceStoryFrame(t!.services, w!.id);
    expect(held.status).toBe('awaiting_approval');
    await expect(approveStoryFrame(t!.services, w!.id, { type: 'agent', id: 'persona-manager' })).rejects.toThrow(/Owner/);
    expect((await approveStoryFrame(t!.services, w!.id, OWNER)).status).toBe('approved');
    expect(recorded).toHaveLength(1);
    expect((await queueDueStories(t!.services, new Date('2026-10-20T12:00:00Z'))).queued).toBe(1);
    // Two days later anything still unpublished from that day is skipped, never posted late.
    expect((await queueDueStories(t!.services, new Date('2026-10-22T12:00:00Z'))).skipped).toBeGreaterThan(0);
  });

  it('grounds the world frame on a stub until the World Bible exists', async () => {
    const p = await studio({ world: false });
    const [f] = await planStoryDay(t!.services, p.id);
    expect(f!.kind).toBe('world');
    expect(f!.grounding).toMatchObject({ timezone: 'Europe/London', localDate: DATE, season: 'autumn', timeOfDay: 'morning', place: { city: 'London' } });
    expect((await produceStoryFrame(t!.services, f!.id)).status).toBe('approved');
  });

  it('ingests story metrics, curates highlights and re-tunes Stories per day within 3–5', async () => {
    const p = await studio();
    await account(t!, p.id, 'instagram', 'dot');
    await savePlan(t!.db, { studioId: t!.studioId, personaId: p.id, plan: defaultPlan(), actor: OWNER, now: new Date('2026-10-01T00:00:00Z') });
    // Two weeks of published frames.
    for (let d = 0; d < 4; d++) {
      const date = `2026-10-${String(16 + d).padStart(2, '0')}`;
      for (const f of await planStoryDay(t!.services, p.id, date)) {
        await produceStoryFrame(t!.services, f.id);
        await publishStoryFrame(t!.services, f.id);
      }
    }
    const posts = await t!.db.query<{ external_id: string; kind: string }>(`SELECT sp.external_id, f.kind FROM story_post sp JOIN story_frame f ON f.id = sp.story_frame_id`);
    expect(posts.length).toBeGreaterThanOrEqual(16);
    for (const s of posts) t!.providers.publish.storyMetrics.set(s.external_id, { reach: 500, replies: s.kind === 'engagement' ? 12 : 2, tapsForward: 40, tapsBack: 5, exits: 20 });
    // Published "now" within 2 days: metrics captured once per post per day, idempotent.
    const m = await ingestStoryMetrics(t!.services);
    expect(m.captured).toBe(posts.length);
    await ingestStoryMetrics(t!.services);
    expect((await t!.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM story_metric`)).n).toBe(posts.length);
    const stats = await storyStats(t!.services, p.id, NOW);
    expect(stats.find((s) => s.kind === 'engagement')!.replyRate).toBeGreaterThan(stats.find((s) => s.kind === 'world')!.replyRate);

    const sets = await curateHighlights(t!.services, p.id);
    expect(sets.map((s) => s.set_name).sort()).toEqual(['Free guide', 'Lore', 'Shop', 'Start here']);
    const guide = sets.find((s) => s.set_name === 'Free guide')!;
    expect(guide.frame_ids.length).toBeGreaterThan(0);
    expect(guide.curated_by).toBe('agent:persona-manager');
    expect((await highlightsFor(t!.services, p.id)).length).toBe(4);

    // Viewers stay (12% drop) and reply: one more frame a day, written as a lever version of the plan.
    const moved = await tuneStories(t!.services, p.id);
    expect(moved).toMatchObject({ from: 4, to: 5 });
    const plan = await t!.services.formatPlans.planFor(p.id);
    expect(plan).toMatchObject({ source: 'lever' });
    expect(plan!.stories.perDay).toBe(5);
    expect(await tuneStories(t!.services, p.id)).toBeNull(); // already at the 5 a day cap
  });

  it('schedules each publishing persona once its local morning starts; the jobs plan, produce and publish the day', async () => {
    const p = await studio();
    await account(t!, p.id, 'instagram', 'dot');
    const tokyo = await makeTestPersona(t!, { timezone: 'Asia/Tokyo' }); // 14:30 local
    await makeTestPersona(t!, { timezone: 'America/New_York' }); // 01:30 local: not yet
    await makeTestPersona(t!, { timezone: 'Europe/London', state: 'SETUP' }); // not publishing
    const r = await scheduleStoryDays(t!.services, NOW);
    const queued = await t!.db.query<{ persona_id: string }>(`SELECT persona_id FROM job WHERE kind = 'stories.plan_day'`);
    expect(queued.map((q) => q.persona_id).sort()).toEqual([p.id, tokyo.id].sort());
    expect(r.queued).toBe(2);
    expect(await scheduleStoryDays(t!.services, NOW)).toEqual({ queued: 0 }); // once per persona-day

    await runQueued(t!, 'stories.plan_day');
    const produced = (await runQueued(t!, 'stories.produce')) as Array<{ status: string }>;
    expect(produced.length).toBeGreaterThanOrEqual(8);
    expect(produced.every((x) => x.status === 'approved')).toBe(true);
    await queueDueStories(t!.services, new Date('2026-10-20T21:00:00Z'));
    await runQueued(t!, 'stories.publish');
    const live = await t!.db.query<{ platform: string; status: string }>(`SELECT platform, status FROM story_post WHERE persona_id = $1`, [p.id]);
    expect(live.length).toBe((await framesFor(t!.services, p.id, DATE)).length);
    expect(live.every((x) => x.platform === 'instagram' && x.status === 'published')).toBe(true);

    expect(storyChecks({ kind: 'engagement', text: 'Reply GUIDE for the list', cta_keyword: 'GUIDE' }, { width: 1080, height: 1920, ocr: 'Reply GUIDE for the list' }).every((c) => c.pass)).toBe(true);
    const bad = storyChecks({ kind: 'sell', text: 'Buy now', cta_keyword: 'SHEET' }, { width: 720, height: 1280, ocr: 'nothing' });
    expect(bad.filter((c) => !c.pass).map((c) => c.check).sort()).toEqual(['story_keyword', 'story_ocr', 'story_size']);
  });
});
