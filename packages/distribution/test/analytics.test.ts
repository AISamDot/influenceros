import { METRIC_WINDOW_MS } from '@ios/agents';
import { pnlWithTotals } from '@ios/profit';
import type { PostMetrics } from '@ios/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dueWindows, personaScorecard, pullMetrics } from '../src';
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
