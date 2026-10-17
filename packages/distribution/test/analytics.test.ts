import { METRIC_WINDOW_MS } from '@troupe/agents';
import { pnlWithTotals } from '@troupe/profit';
import type { PostMetrics } from '@troupe/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectAnomalies, dueWindows, ingestEvents, personaScorecard, pullMetrics } from '../src';
import { account, type Ctx, persona, setup } from './helpers';

let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => ctx.db.close());

const H = 3_600_000;
const metrics = (views: number): PostMetrics => ({
  views,
  watchTimeS: views * 7,
  likes: Math.round(views * 0.05),
  comments: Math.round(views * 0.004),
  saves: Math.round(views * 0.01),
  shares: Math.round(views * 0.006),
  follows: Math.round(views * 0.003),
  profileVisits: Math.round(views * 0.02),
  linkClicks: Math.round(views * 0.002),
});

describe('metric windows', () => {
  it('captures each window once it is due and skips captures that would be mislabelled', () => {
    const t0 = new Date('2026-10-01T00:00:00Z');
    const at = (ms: number) => new Date(t0.getTime() + ms);
    expect(dueWindows(t0, at(30 * 60_000), new Set())).toEqual([]);
    expect(dueWindows(t0, at(H + 1), new Set())).toEqual(['1h']);
    expect(dueWindows(t0, at(H + 1), new Set(['1h']))).toEqual([]);
    expect(dueWindows(t0, at(25 * H), new Set())).toEqual(['24h']);
    expect(dueWindows(t0, at(73 * H), new Set())).toEqual(['72h']);
    expect(dueWindows(t0, at(METRIC_WINDOW_MS['7d'] + H), new Set())).toEqual(['7d']);
    expect(dueWindows(t0, at(15 * 24 * H), new Set())).toEqual([]);
  });

  it('lands metrics at 1h/24h/72h/7d, rolls up the account day, and feeds the Profit Engine and the scorecard', async () => {
    const p = await persona(ctx);
    const acc = await account(ctx, p.id, 'tiktok');
    const published = new Date('2026-10-10T09:00:00Z');
    const post = await ctx.db.one<{ id: string }>(
      `INSERT INTO post (persona_id, account_id, platform, format, caption, status, external_id, published_at) VALUES ($1, $2, 'tiktok', 'talking', 'x', 'live', 'ext_a', $3) RETURNING id`,
      [p.id, acc.id, published],
    );
    const pub = ctx.providers.publish;
    const steps: Array<[number, number, string]> = [
      [1.2 * H, 800, '1h'],
      [25 * H, 5_000, '24h'],
      [73 * H, 9_000, '72h'],
      [7 * 24 * H + 2 * H, 12_000, '7d'],
    ];
    for (const [offset, views, w] of steps) {
      pub.metrics.set('ext_a', metrics(views));
      const now = new Date(published.getTime() + offset);
      const r = await pullMetrics(ctx.svc, { now });
      expect([w, r.captured]).toEqual([w, 1]);
      // Idempotent: the same window is never captured twice.
      expect((await pullMetrics(ctx.svc, { now })).captured).toBe(0);
    }
    const rows = await ctx.db.query<{ window: string; views: number; follows: number; link_clicks: number }>(
      `SELECT "window", views, follows, link_clicks FROM metric_snapshot WHERE post_id = $1 ORDER BY created_at`,
      [post.id],
    );
    expect(rows.map((r) => [r.window, r.views])).toEqual([
      ['1h', 800],
      ['24h', 5_000],
      ['72h', 9_000],
      ['7d', 12_000],
    ]);
    // Account rows: one per day captured, holding that day's growth; followers carried forward.
    const daily = await ctx.db.query<{ captured_on: string; views: number; followers: number }>(
      `SELECT to_char(captured_on, 'YYYY-MM-DD') AS captured_on, views, followers FROM metric_snapshot WHERE persona_id = $1 AND post_id IS NULL ORDER BY captured_on`,
      [p.id],
    );
    expect(daily.map((d) => d.views)).toEqual([800, 4_200, 4_000, 3_000]);
    expect(daily.reduce((a, d) => a + d.views, 0)).toBe(12_000);
    expect(daily.at(-1)!.followers).toBe(36);

    // The Profit Engine reads the latest snapshot per post (not a sum of the windows).
    const { rows: pnl } = await pnlWithTotals(ctx.db, { studioId: ctx.studioId, from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z'), grain: 'post', personaId: p.id });
    expect(pnl.find((r) => r.key === post.id)!.views).toBe(12_000);

    const card = await personaScorecard(ctx.svc, p.id, 30, new Date('2026-10-20T00:00:00Z'));
    expect(card).toMatchObject({ posts: 1, views: 12_000, avgViews: 12_000, avgWatchS: 7, followsPer1k: 3, linkClicks: 24 });
    expect(card.medianByWindow).toEqual({ '1h': 800, '24h': 5_000, '72h': 9_000, '7d': 12_000 });
  });

  it('records fetch errors without stopping the pull', async () => {
    const p = await persona(ctx);
    const acc = await account(ctx, p.id, 'instagram');
    const published = new Date('2026-10-10T09:00:00Z');
    for (const ext of ['e_ok', 'e_bad']) {
      await ctx.db.query(`INSERT INTO post (persona_id, account_id, platform, format, caption, status, external_id, published_at) VALUES ($1, $2, 'instagram', 'talking', 'x', 'live', $3, $4)`, [p.id, acc.id, ext, published]);
    }
    const real = ctx.providers.publish.fetchMetrics.bind(ctx.providers.publish);
    ctx.providers.publish.fetchMetrics = async (req) => {
      if (req.externalId === 'e_bad') throw new Error('rate limited');
      return real(req);
    };
    const r = await pullMetrics(ctx.svc, { now: new Date(published.getTime() + 2 * H) });
    expect(r.captured).toBe(1);
    expect(r.errors[0]).toMatch(/rate limited/);
  });
});

describe('URL backfill', () => {
  it('stores the permalink of a post that went live without one once the vendor has it', async () => {
    const p = await persona(ctx);
    const acc = await account(ctx, p.id, 'tiktok');
    const published = new Date('2026-10-10T09:00:00Z');
    const { id } = await ctx.db.one<{ id: string }>(
      `INSERT INTO post (persona_id, account_id, platform, format, caption, status, external_id, published_at) VALUES ($1, $2, 'tiktok', 'talking', 'x', 'live', 'e_nourl', $3) RETURNING id`,
      [p.id, acc.id, published],
    );
    const pub = ctx.providers.publish;
    let url: string | null = null;
    pub.verify = async () => ({ status: 'live', url, aiLabel: true });
    await pullMetrics(ctx.svc, { now: new Date(published.getTime() + 2 * H) });
    expect((await ctx.db.one<{ url: string | null }>('SELECT url FROM post WHERE id = $1', [id])).url).toBeNull();
    url = 'https://www.tiktok.com/@a/video/1';
    await pullMetrics(ctx.svc, { now: new Date(published.getTime() + 25 * H) });
    expect((await ctx.db.one<{ url: string | null }>('SELECT url FROM post WHERE id = $1', [id])).url).toBe(url);
  });
});

describe('anomalies and circuit breakers (FR-13.4, FR-17.2)', () => {
  it('a takedown of a live post pauses the persona (kill switch + L0) and raises an S1 alert', async () => {
    const p = await persona(ctx);
    await ctx.db.query(`UPDATE persona SET autonomy = 'L2' WHERE id = $1`, [p.id]);
    const acc = await account(ctx, p.id, 'tiktok');
    await ctx.db.query(`INSERT INTO post (persona_id, account_id, platform, format, caption, status, external_id, published_at) VALUES ($1, $2, 'tiktok', 'talking', 'x', 'live', 'ext_td', now())`, [p.id, acc.id]);
    const res = await ingestEvents(ctx.svc, [{ type: 'post_status', externalId: 'ext_td', status: 'failed', url: null }]);
    expect(res.statuses).toBe(1);
    expect((await ctx.db.one<{ status: string }>(`SELECT status FROM post WHERE external_id = 'ext_td'`)).status).toBe('failed');
    expect((await ctx.db.one<{ autonomy: string }>('SELECT autonomy FROM persona WHERE id = $1', [p.id])).autonomy).toBe('L0');
    const ks = await ctx.db.query(`SELECT 1 FROM kill_switch WHERE scope = 'persona' AND persona_id = $1 AND active`, [p.id]);
    expect(ks).toHaveLength(1);
    const n = await ctx.db.one<{ severity: string; title: string }>(`SELECT severity, title FROM notification WHERE persona_id = $1 AND severity = 'critical' ORDER BY created_at DESC LIMIT 1`, [p.id]);
    expect(n.title).toMatch(/posting paused \(takedown\)/);
  });

  it('warns once a day on a views collapse, a refund spike and a cost spike', async () => {
    const p = await persona(ctx, { state: 'TESTING' });
    const acc = await account(ctx, p.id, 'tiktok');
    const views = [40, 30, 25, 900, 1000, 1100, 950, 1200, 1050];
    for (let i = 0; i < views.length; i++) {
      const post = await ctx.db.one<{ id: string }>(
        `INSERT INTO post (persona_id, account_id, platform, format, caption, status, external_id, published_at) VALUES ($1, $2, 'tiktok', 'talking', 'x', 'live', $3, $4) RETURNING id`,
        [p.id, acc.id, `ext_v${i}`, new Date(ctx.clock.now.getTime() - (i + 2) * 86_400_000)],
      );
      await ctx.db.query(`INSERT INTO metric_snapshot (persona_id, post_id, platform, captured_on, "window", views) VALUES ($1, $2, 'tiktok', $3, '24h', $4)`, [p.id, post.id, '2026-10-10', views[i]]);
    }
    for (let i = 0; i < 5; i++) {
      const o = await ctx.db.one<{ id: string }>(`INSERT INTO orders (persona_id, store_order_id, amount_cents, status, ordered_at) VALUES ($1, $2, 1700, 'paid', $3) RETURNING id`, [p.id, `o${i}`, new Date(ctx.clock.now.getTime() - 86_400_000)]);
      if (i < 2) await ctx.db.query(`INSERT INTO refund (order_id, persona_id, amount_cents, status) VALUES ($1, $2, 1700, 'refunded')`, [o.id, p.id]);
    }
    await ctx.db.query(
      `INSERT INTO credit_ledger (studio_id, persona_id, unit, entry_type, amount, period, created_at) VALUES ($1, $2, 'llm_usd', 'debit', 30, '2026-10', $3), ($1, $2, 'llm_usd', 'debit', 7, '2026-10', $4)`,
      [ctx.studioId, p.id, new Date(ctx.clock.now.getTime() - 3_600_000), new Date(ctx.clock.now.getTime() - 3 * 86_400_000)],
    );
    const warns = async () => (await ctx.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM notification WHERE persona_id = $1 AND severity = 'warn' AND title ~ '(collapsed|spike)'`, [p.id])).n;
    const found = await detectAnomalies(ctx.svc, ctx.clock.now);
    expect(found.map((f) => f.kind).sort()).toEqual(['cost_spike', 'refund_spike', 'views_collapse']);
    expect(await warns()).toBe(3);
    await detectAnomalies(ctx.svc, ctx.clock.now);
    expect(await warns()).toBe(3); // once a day
    // Warnings never pause posting on their own.
    expect(await ctx.db.query(`SELECT 1 FROM kill_switch WHERE persona_id = $1 AND active`, [p.id])).toHaveLength(0);
  });
});
