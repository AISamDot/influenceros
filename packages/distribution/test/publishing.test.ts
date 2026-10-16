import { PUBLISH_PREPARE_JOB } from '@ios/agents';
import { DeferJob, decide, OWNER, recoverPublishing, setKillSwitch, sweepAutoApprovals } from '@ios/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enqueueDuePosts, jobs, PREPARE_DEAD_LIMIT, preparePublish, publishOne, sweepStuckPrepares } from '../src';
import { account, type Ctx, persona, preparePayload, setup, slot, status } from './helpers';

let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => ctx.db.close());

const posts = (slotId: string) =>
  ctx.db.query<{ id: string; platform: string; status: string; ai_flag: boolean; caption: string; meta: Record<string, any>; approval_id: string | null }>(
    `SELECT id, platform, status, ai_flag, caption, meta, approval_id FROM post WHERE calendar_slot_id = $1 ORDER BY platform`,
    [slotId],
  );

async function approveAll(slotId: string) {
  for (const p of await posts(slotId)) {
    if (p.approval_id && p.status === 'awaiting_approval') await decide(ctx.db, { approvalId: p.approval_id, decision: 'approve', actor: OWNER });
  }
}

describe('publish.prepare', () => {
  it('creates one post per platform with the AI flag on, passes post Q4 and the Gate, and proposes each for approval', async () => {
    const p = await persona(ctx, { autonomy: 'L0' });
    await account(ctx, p.id, 'tiktok');
    await account(ctx, p.id, 'instagram');
    await account(ctx, p.id, 'youtube');
    const s = await slot(ctx, p.id);
    const res = await preparePublish(ctx.svc, await preparePayload(ctx, p.id, s.id, 'talking'));
    expect(res.slotStatus).toBe('scheduled');
    // Day 5: no YouTube Shorts yet (day 30).
    expect(res.posts.map((x) => x.platform).sort()).toEqual(['instagram', 'tiktok']);
    const rows = await posts(s.id);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.ai_flag).toBe(true);
      expect(r.status).toBe('awaiting_approval');
      expect(Object.values(r.meta.platform_options)).toEqual([true]);
      expect(r.caption).toMatch(/BUDGET/);
      expect(r.caption.match(/#\w+/g)!.length).toBeLessThanOrEqual(5);
    }
    expect(rows.find((r) => r.platform === 'tiktok')!.meta.platform_options).toEqual({ video_made_with_ai: true });
    expect(rows.find((r) => r.platform === 'instagram')!.meta.platform_options).toEqual({ is_ai_generated: true });
    const q4 = await ctx.db.query<{ pass: boolean }>(`SELECT pass FROM qc_report WHERE subject_type = 'post' AND stage = 'Q4' AND subject_id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
    expect(q4.map((q) => q.pass)).toEqual([true, true]);
    const gates = await ctx.db.query<{ verdict: string }>(`SELECT verdict FROM gate_result WHERE subject_type = 'post' AND subject_id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
    expect(gates.map((g) => g.verdict)).toEqual(['green', 'green']);
    const slotRow = await ctx.db.one<{ status: string; post_id: string; thumbnail_url: string }>('SELECT status, post_id, thumbnail_url FROM calendar_slot WHERE id = $1', [s.id]);
    expect(slotRow.post_id).toBe(rows.find((r) => r.platform === 'tiktok')!.id);
    expect(slotRow.thumbnail_url).toMatch(/cover\.jpg/);

    // Idempotent: a retried job reuses the posts and proposes nothing new.
    await preparePublish(ctx.svc, await preparePayload(ctx, p.id, s.id, 'talking'));
    expect(await posts(s.id)).toHaveLength(2);
    expect((await ctx.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM approval WHERE kind = 'post'`)).n).toBe(2);
  });

  it('adds YouTube Shorts from day 30 and posts static images to Instagram only', async () => {
    const p = await persona(ctx, { ageDays: 31 });
    for (const pl of ['tiktok', 'instagram', 'youtube'] as const) await account(ctx, p.id, pl);
    const video = await slot(ctx, p.id, 'voiceover');
    const r1 = await preparePublish(ctx.svc, await preparePayload(ctx, p.id, video.id, 'voiceover'));
    expect(r1.posts.map((x) => x.platform)).toEqual(['tiktok', 'instagram', 'youtube']);
    const yt = (await posts(video.id)).find((x) => x.platform === 'youtube')!;
    expect(yt.meta.platform_options).toEqual({ containsSyntheticMedia: true });
    expect(yt.meta.title.length).toBeLessThanOrEqual(100);
    expect(yt.caption).toMatch(/#Shorts/);

    const still = await slot(ctx, p.id, 'static');
    const r2 = await preparePublish(ctx.svc, await preparePayload(ctx, p.id, still.id, 'static'));
    expect(r2.posts.map((x) => x.platform)).toEqual(['instagram']);
    const car = await slot(ctx, p.id, 'carousel');
    const r3 = await preparePublish(ctx.svc, await preparePayload(ctx, p.id, car.id, 'carousel'));
    expect(r3.posts.map((x) => [x.platform, x.q4])).toEqual([['instagram', true]]);
  });

  it('waits (DeferJob) and tells the Owner once when the persona has no active account', async () => {
    const p = await persona(ctx);
    await account(ctx, p.id, 'tiktok', { status: 'pending' });
    const s = await slot(ctx, p.id);
    const payload = await preparePayload(ctx, p.id, s.id, 'talking');
    await expect(preparePublish(ctx.svc, payload)).rejects.toBeInstanceOf(DeferJob);
    await expect(preparePublish(ctx.svc, payload)).rejects.toBeInstanceOf(DeferJob);
    const n = await ctx.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM notification WHERE link = '/settings/accounts'`);
    expect(n.n).toBe(1);
    expect(await posts(s.id)).toHaveLength(0);
  });

  it('blocks a post that fails post Q4 (wrong export size) and a post the Gate marks red', async () => {
    const p = await persona(ctx);
    await account(ctx, p.id, 'tiktok');
    await account(ctx, p.id, 'instagram');
    const bad = await slot(ctx, p.id);
    const r = await preparePublish(ctx.svc, await preparePayload(ctx, p.id, bad.id, 'talking', { size: [720, 1280] }));
    expect(r.slotStatus).toBe('blocked');
    expect(r.posts.every((x) => x.status === 'blocked' && x.q4 === false)).toBe(true);
    const defects = await ctx.db.query<{ type: string }>(`SELECT type FROM qc_defect WHERE persona_id = $1`, [p.id]);
    expect(defects.map((d) => d.type)).toContain('export_size');
    expect((await ctx.db.one<{ block_reason: string }>('SELECT block_reason FROM calendar_slot WHERE id = $1', [bad.id])).block_reason).toMatch(/post Q4/);

    const red = await slot(ctx, p.id);
    const r2 = await preparePublish(ctx.svc, await preparePayload(ctx, p.id, red.id, 'talking', { caption: 'This system guarantees you will make $5,000 a month. Comment BUDGET.' }));
    expect(r2.posts.map((x) => x.gate)).toEqual(['red', 'red']);
    expect(await status(ctx, 'calendar_slot', red.id)).toBe('blocked');
    expect((await ctx.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM approval WHERE kind = 'post'`)).n).toBe(0);
  });

  it('is registered as the publish.prepare job and validates the AI flag in the payload', async () => {
    expect(typeof jobs[PUBLISH_PREPARE_JOB]).toBe('function');
    const p = await persona(ctx);
    const s = await slot(ctx, p.id);
    const payload = { ...(await preparePayload(ctx, p.id, s.id, 'talking')), aiGenerated: false };
    const job = { payload, persona_id: p.id } as never;
    await expect(jobs[PUBLISH_PREPARE_JOB]!({ services: ctx.svc, job, heartbeat: async () => true })).rejects.toThrow(/aiGenerated/);
  });
});

describe('publish.post', () => {
  async function ready(opts: { trendingSound?: boolean; autonomy?: 'L0' | 'L1' } = {}) {
    const p = await persona(ctx, { autonomy: opts.autonomy ?? 'L0' });
    await account(ctx, p.id, 'tiktok');
    await account(ctx, p.id, 'instagram');
    const s = await slot(ctx, p.id, 'talking', { at: new Date(ctx.clock.now.getTime() - 60_000) });
    await preparePublish(ctx.svc, await preparePayload(ctx, p.id, s.id, 'talking', { trendingSound: opts.trendingSound }));
    return { p, s };
  }

  it('publishes approved posts through Zernio with the AI flag, verifies, stores the URL and never double-posts', async () => {
    const { s } = await ready();
    // Not approved yet: nothing is due.
    expect(await enqueueDuePosts(ctx.svc, new Date(ctx.clock.now.getTime() + 30 * 60_000))).toEqual([]);
    await approveAll(s.id);
    const later = new Date(ctx.clock.now.getTime() + 30 * 60_000);
    const queued = await enqueueDuePosts(ctx.svc, later);
    expect(queued).toHaveLength(2);
    // Enqueued once per post.
    expect(await enqueueDuePosts(ctx.svc, later)).toEqual([]);
    for (const id of queued) expect((await publishOne(ctx.svc, id)).status).toBe('live');

    const pub = ctx.providers.publish;
    const calls = pub.callsTo('publish').map((c) => c.args as Record<string, any>);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.aiLabel).toBe(true);
      expect(c.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      expect(c.mediaUrls[0]).toMatch(/^https:\/\/fake\.zernio\.local\/media\//);
      expect(c.accountRef).toMatch(/^zr_/);
      expect(c.kind).toBe('video');
      expect(c.coverUrl).toMatch(/fake\.zernio\.local/);
    }
    expect(calls.find((c) => c.platform === 'tiktok')!.platformOptions).toEqual({ video_made_with_ai: true });
    const rows = await posts(s.id);
    expect(rows.every((r) => r.status === 'live')).toBe(true);
    const urls = await ctx.db.query<{ url: string }>('SELECT url FROM post WHERE calendar_slot_id = $1', [s.id]);
    expect(urls.every((u) => /^https:\/\/fake\./.test(u.url))).toBe(true);
    expect(await status(ctx, 'calendar_slot', s.id)).toBe('live');

    // A second run (retry, second worker) skips: the post is live, nothing is sent again.
    expect((await publishOne(ctx.svc, queued[0]!)).status).toBe('skipped');
    expect(pub.callsTo('publish')).toHaveLength(2);
    // Media went up once per post (recorded vendor URLs are reused).
    expect(pub.callsTo('uploadMedia')).toHaveLength(4);
  });

  it('never publishes past a kill switch: due posts are not queued and a queued job defers', async () => {
    const { p, s } = await ready();
    await approveAll(s.id);
    const later = new Date(ctx.clock.now.getTime() + 30 * 60_000);
    const [first] = await posts(s.id);
    await setKillSwitch(ctx.db, ctx.studioId, { scope: 'persona', personaId: p.id }, OWNER, 'test');
    expect(await enqueueDuePosts(ctx.svc, later)).toEqual([]);
    await expect(publishOne(ctx.svc, first!.id)).rejects.toBeInstanceOf(DeferJob);
    await setKillSwitch(ctx.db, ctx.studioId, { scope: 'platform', platform: 'tiktok' }, OWNER, 'test');
    expect(ctx.providers.publish.callsTo('publish')).toHaveLength(0);
    expect(await status(ctx, 'post', first!.id)).toBe('scheduled');
  });

  it('L1: a green post auto-approves after the veto window, then publishes', async () => {
    const { s } = await ready({ autonomy: 'L1' });
    const t = new Date(ctx.clock.now.getTime() + 121 * 60_000);
    expect(await sweepAutoApprovals(ctx.db, { now: t })).toHaveLength(2);
    const queued = await enqueueDuePosts(ctx.svc, t);
    for (const id of queued) await publishOne(ctx.svc, id);
    expect((await posts(s.id)).map((r) => r.status)).toEqual(['live', 'live']);
  });

  it('sends a trending-sound post to the TikTok inbox as a draft; it is not failed while it waits, and goes live once posted', async () => {
    const { s } = await ready({ trendingSound: true });
    const tt = (await posts(s.id)).find((r) => r.platform === 'tiktok')!;
    expect(tt.meta.mode).toBe('draft_inbox');
    expect((await posts(s.id)).find((r) => r.platform === 'instagram')!.meta.mode).toBe('publish');
    await approveAll(s.id);
    const res = await publishOne(ctx.svc, tt.id);
    expect(res.status).toBe('verifying');
    const call = ctx.providers.publish.callsTo('publish')[0]!.args as Record<string, unknown>;
    expect(call).toMatchObject({ mode: 'draft_inbox', aiLabel: true });
    expect(await status(ctx, 'post', tt.id)).toBe('publishing');
    const n = await ctx.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM notification WHERE title LIKE 'Draft in the tiktok inbox%'`);
    expect(n.n).toBe(1);

    // Recovery keeps checking past maxAttempts while the draft is younger than 72 h.
    const soon = new Date(Date.now() + 60 * 60_000);
    for (let i = 0; i < 4; i++) await recoverPublishing(ctx.db, ctx.providers.publish, { now: soon, maxAttempts: 2 });
    expect(await status(ctx, 'post', tt.id)).toBe('publishing');
    const ext = (await ctx.db.one<{ external_id: string }>('SELECT external_id FROM post WHERE id = $1', [tt.id])).external_id;
    ctx.providers.publish.completeDraft(ext);
    expect((await recoverPublishing(ctx.db, ctx.providers.publish, { now: soon })).live).toEqual([tt.id]);
  });
});

describe('publish.sweep', () => {
  it('re-queues a dead publish.prepare for a slot stuck in final_gate, and blocks it after repeated deaths', async () => {
    const p = await persona(ctx);
    const s = await slot(ctx, p.id);
    await ctx.db.query(`UPDATE calendar_slot SET stage_changed_at = $2 WHERE id = $1`, [s.id, new Date(ctx.clock.now.getTime() - 2 * 3_600_000)]);
    const payload = await preparePayload(ctx, p.id, s.id, 'talking');
    const dead = () =>
      ctx.db.query(`INSERT INTO job (kind, payload, persona_id, status, last_error) VALUES ($1, $2::jsonb, $3, 'dead', 'gate llm 500')`, [PUBLISH_PREPARE_JOB, JSON.stringify({ ...payload, dedupe: `slot:${s.id}` }), p.id]);
    await dead();
    expect(await sweepStuckPrepares(ctx.svc, ctx.clock.now)).toEqual({ requeued: 1, blocked: 0 });
    const queued = await ctx.db.one<{ payload: { slotId: string; dedupe: string } }>(`SELECT payload FROM job WHERE kind = $1 AND status = 'queued'`, [PUBLISH_PREPARE_JOB]);
    expect(queued.payload).toMatchObject({ slotId: s.id, dedupe: `slot:${s.id}` });
    // While one is queued, nothing more is added.
    expect(await sweepStuckPrepares(ctx.svc, ctx.clock.now)).toEqual({ requeued: 0, blocked: 0 });
    await ctx.db.query(`UPDATE job SET status = 'dead' WHERE kind = $1 AND status = 'queued'`, [PUBLISH_PREPARE_JOB]);
    for (let i = 2; i < PREPARE_DEAD_LIMIT; i++) await dead();
    expect(await sweepStuckPrepares(ctx.svc, ctx.clock.now)).toEqual({ requeued: 0, blocked: 1 });
    expect(await status(ctx, 'calendar_slot', s.id)).toBe('blocked');
  });
});

describe('publish anyway (qc_override, FR-21.5/21.6)', () => {
  it('post QC failing on majors only proposes an Owner-only card; approving with a reason publishes, blockers never', async () => {
    const p = await persona(ctx, { autonomy: 'L0' });
    await account(ctx, p.id, 'tiktok');
    const s = await slot(ctx, p.id);
    // No CTA keyword in the caption: a major.
    const payload = await preparePayload(ctx, p.id, s.id, 'talking', { caption: 'Three envelopes, one rule: spend on purpose.' });
    const res = await preparePublish(ctx.svc, payload);
    expect(res.slotStatus).toBe('blocked');
    const card = await ctx.db.one<{ id: string; mode: string; payload: { failing: Array<{ check: string; severity: string }>; stage: string } }>(`SELECT id, mode, payload FROM approval WHERE kind = 'qc_override' AND status = 'pending'`);
    expect(card.mode).toBe('explicit');
    expect(card.payload.stage).toBe('post_Q4');
    expect(card.payload.failing.map((f) => f.check)).toEqual(['cta']);
    // A second blocked run doesn't stack cards.
    await preparePublish(ctx.svc, payload);
    expect(await ctx.db.query(`SELECT 1 FROM approval WHERE kind = 'qc_override'`)).toHaveLength(1);

    // A reason is required.
    await expect(decide(ctx.db, { approvalId: card.id, decision: 'approve', actor: OWNER })).rejects.toThrow(/reason/);
    await decide(ctx.db, { approvalId: card.id, decision: 'approve', actor: OWNER, note: 'CTA is in the pinned comment' });
    expect(await status(ctx, 'calendar_slot', s.id)).toBe('final_gate');
    const job = await ctx.db.one<{ id: string; payload: Record<string, unknown> }>(`SELECT id, payload FROM job WHERE kind = $1 AND payload ? 'qcOverride'`, [PUBLISH_PREPARE_JOB]);
    expect(job.payload.qcOverride).toMatchObject({ approvalId: card.id, reason: 'CTA is in the pinned comment' });
    const out = (await jobs[PUBLISH_PREPARE_JOB]!({ services: ctx.svc, job: job as never, heartbeat: async () => true })) as { slotStatus: string };
    expect(out.slotStatus).toBe('scheduled');
    const rows = await posts(s.id);
    expect(rows[0]!.status).toBe('awaiting_approval');
    expect(rows[0]!.meta.qc_override).toMatchObject({ reason: 'CTA is in the pinned comment' });

    // Blockers never get a card, and a card that lists one can't be approved.
    const s2 = await slot(ctx, p.id);
    await preparePublish(ctx.svc, await preparePayload(ctx, p.id, s2.id, 'talking', { size: [720, 1280] }));
    expect(await ctx.db.query(`SELECT 1 FROM approval WHERE kind = 'qc_override' AND payload->'prepare'->>'slotId' = $1`, [s2.id])).toHaveLength(0);
  });
});
