import { INTERNAL_WINNER_LIFT, OUTLIER } from '@ios/agents';
import { describe, expect, it } from 'vitest';
import {
  ageFromPosts,
  breakoutSignals,
  coverage,
  depthRatio,
  firstPassGrowth,
  growthFromHistory,
  historyGrowthScore,
  internalLift,
  isAccelerating,
  median,
  novelty,
  outlierScore,
  outlierTier,
  postsPerWeek,
  recency,
  type ScoredPostInput,
  viewsPerFollower,
  winnerScore,
} from '../src';

const DAY = 86_400_000;
const NOW = new Date('2026-10-16T12:00:00Z');
const video = (id: string, views: number, daysAgo: number, extra: Partial<ScoredPostInput> = {}): ScoredPostInput => ({
  id,
  kind: 'video',
  views,
  likes: Math.round(views / 20),
  shares: null,
  saves: null,
  postedAt: new Date(NOW.getTime() - daysAgo * DAY),
  ...extra,
});

describe('outlier score: views ÷ the creator’s median over the last 20 posts', () => {
  it('uses the median of the 20 most recent other posts, excluding the post itself', () => {
    // 25 older posts at 1,000 views plus 20 recent ones at 2,000: only the recent 20 count.
    const posts = [
      ...Array.from({ length: 25 }, (_, i) => video(`old${i}`, 1_000, 60 + i)),
      ...Array.from({ length: 20 }, (_, i) => video(`new${i}`, 2_000, 2 + i)),
    ];
    const hit = video('hit', 20_000, 1);
    expect(outlierScore(hit, [...posts, hit])).toBe(10);
    // The window is OUTLIER.window posts.
    expect(OUTLIER.window).toBe(20);
  });

  it('tiers ≥ 5× as an outlier and ≥ 10× as strong', () => {
    expect(OUTLIER.outlier).toBe(5);
    expect(OUTLIER.strong).toBe(10);
    expect(outlierTier(4.99)).toBe('normal');
    expect(outlierTier(5)).toBe('outlier');
    expect(outlierTier(9.99)).toBe('outlier');
    expect(outlierTier(10)).toBe('strong');
    expect(outlierTier(null)).toBe('normal');
  });

  it('compares stills on likes and never mixes them with video views', () => {
    const vids = Array.from({ length: 5 }, (_, i) => video(`v${i}`, 10_000, i + 1));
    const stills: ScoredPostInput[] = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, kind: 'image', views: null, likes: 200, shares: null, saves: null, postedAt: new Date(NOW.getTime() - (i + 1) * DAY) }));
    const still: ScoredPostInput = { id: 'still', kind: 'carousel', views: null, likes: 1_200, shares: null, saves: null, postedAt: NOW };
    expect(outlierScore(still, [...vids, ...stills, still])).toBe(6);
  });

  it('needs at least three baseline posts and a non-zero median', () => {
    const p = video('p', 5_000, 1);
    expect(outlierScore(p, [p, video('a', 100, 2), video('b', 100, 3)])).toBeNull();
    expect(outlierScore(p, [p, video('a', 0, 2), video('b', 0, 3), video('c', 0, 4)])).toBeNull();
  });
});

describe('per-post weights', () => {
  it('views ÷ followers and (saves + shares) ÷ views', () => {
    expect(viewsPerFollower(50_000, 10_000)).toBe(5);
    expect(viewsPerFollower(50_000, 0)).toBeNull();
    expect(viewsPerFollower(null, 10)).toBeNull();
    expect(depthRatio({ saves: 300, shares: 200, views: 10_000 })).toBe(0.05);
    expect(depthRatio({ saves: null, shares: null, views: 10_000 })).toBeNull();
    expect(depthRatio({ saves: 1, shares: null, views: 0 })).toBeNull();
  });

  it('recency: fresh for 14 days, weight falls from 1 to 0.5, then 0', () => {
    expect(recency(NOW, NOW)).toMatchObject({ ageDays: 0, fresh: true, weight: 1 });
    expect(recency(new Date(NOW.getTime() - 7 * DAY), NOW)).toMatchObject({ fresh: true, weight: 0.75 });
    expect(recency(new Date(NOW.getTime() - 14 * DAY), NOW)).toMatchObject({ fresh: true, weight: 0.5 });
    expect(recency(new Date(NOW.getTime() - 15 * DAY), NOW)).toMatchObject({ fresh: false, weight: 0 });
    expect(recency(null, NOW).fresh).toBe(false);
  });

  it('the winner score rises with each signal and stays within 0–1', () => {
    const base = { outlier: 5, viewsPerFollower: 1, depth: 0.01, recencyWeight: 0.8, replicability: 0.6, monetisationFit: 0.3, novelty: 0.7 };
    const s = winnerScore(base);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
    expect(winnerScore({ ...base, outlier: 15 })).toBeGreaterThan(s);
    expect(winnerScore({ ...base, viewsPerFollower: 4 })).toBeGreaterThan(s);
    expect(winnerScore({ ...base, depth: 0.04 })).toBeGreaterThan(s);
    expect(winnerScore({ ...base, recencyWeight: 1 })).toBeGreaterThan(s);
    expect(winnerScore({ ...base, replicability: 0.9 })).toBeGreaterThan(s);
    expect(winnerScore({ ...base, monetisationFit: 0.9 })).toBeGreaterThan(s);
    expect(winnerScore({ ...base, novelty: 1 })).toBeGreaterThan(s);
    expect(winnerScore({ outlier: 1e6, viewsPerFollower: 1e6, depth: 1, recencyWeight: 1, replicability: 1, monetisationFit: 1, novelty: 1 })).toBe(1);
  });

  it('monetisation fit and novelty from word overlap', () => {
    expect(coverage('#budgeting tips for a sinking fund', ['budgeting', 'sinking funds'])).toBeGreaterThan(0);
    expect(coverage('cat videos', ['budgeting'])).toBe(0);
    expect(novelty('3 budgeting mistakes', ['3 budgeting mistakes'])).toBe(0);
    expect(novelty('sourdough starter care', ['3 budgeting mistakes'])).toBe(1);
  });
});

describe('growth: velocity, acceleration, breakouts, first pass', () => {
  const snap = (week: number, followers: number) => ({ at: new Date(NOW.getTime() + week * 7 * DAY), followers });

  it('velocity is the follower Δ per week, acceleration the change in velocity per week', () => {
    const g = growthFromHistory([snap(0, 10_000), snap(1, 11_000), snap(2, 13_000)]);
    expect(g.velocity).toBe(2_000);
    expect(g.acceleration).toBe(1_000);
    expect(g.velocityPct).toBeCloseTo(2_000 / 11_000, 4);
    // Unsorted input and a half-week interval are normalised to per week.
    const h = growthFromHistory([{ at: new Date(NOW.getTime() + 3.5 * DAY), followers: 1_500 }, snap(0, 1_000)]);
    expect(h.velocity).toBe(1_000);
    expect(h.acceleration).toBeNull();
    expect(growthFromHistory([snap(0, 1)])).toEqual({ velocity: null, acceleration: null, velocityPct: null });
  });

  it('accelerating needs growth that speeds up (or ≥ 2 %/week with two snapshots)', () => {
    expect(isAccelerating('history', { velocity: 2_000, acceleration: 1_000, velocityPct: 0.18, score: 0.8 })).toBe(true);
    expect(isAccelerating('history', { velocity: 2_000, acceleration: -500, velocityPct: 0.18, score: 0.8 })).toBe(false);
    expect(isAccelerating('history', { velocity: -10, acceleration: 50, velocityPct: -0.01, score: 0.1 })).toBe(false);
    expect(isAccelerating('history', { velocity: 300, acceleration: null, velocityPct: 0.03, score: 0.4 })).toBe(true);
    expect(isAccelerating('history', { velocity: 100, acceleration: null, velocityPct: 0.01, score: 0.4 })).toBe(false);
    expect(isAccelerating('first_pass', { velocity: null, acceleration: null, velocityPct: null, score: 0.5 })).toBe(true);
    expect(isAccelerating('first_pass', { velocity: null, acceleration: null, velocityPct: null, score: 0.49 })).toBe(false);
  });

  it('breakout signals: young account with high followers per post; reel views ≫ followers', () => {
    expect(breakoutSignals({ followers: 30_000, posts: 20, accountAgeDays: 90, medianViews: 120_000 })).toEqual(['young_high_followers_per_post', 'reels_far_above_followers']);
    expect(breakoutSignals({ followers: 30_000, posts: 900, accountAgeDays: 2_000, medianViews: 10_000 })).toEqual([]);
    expect(breakoutSignals({ followers: 1_000, posts: 900, accountAgeDays: null, medianViews: 500, maxViews: 25_000 })).toEqual(['viral_hit']);
  });

  it('first pass without history: recent reel views ÷ followers, account age and post count', () => {
    const hot = firstPassGrowth({ followers: 10_000, posts: 25, accountAgeDays: 70, recentViews: [40_000, 50_000, 60_000] });
    const cold = firstPassGrowth({ followers: 200_000, posts: 1_500, accountAgeDays: 2_500, recentViews: [20_000, 25_000, 30_000] });
    expect(hot.viewsToFollowers).toBe(5);
    expect(hot.estVelocity).toBe(1_000);
    expect(hot.signals).toContain('reels_far_above_followers');
    expect(hot.score).toBeGreaterThan(0.5);
    expect(cold.score).toBeLessThan(0.5);
    expect(firstPassGrowth({ followers: null, posts: null, accountAgeDays: null, recentViews: [] }).score).toBeLessThan(0.5);
    expect(historyGrowthScore({ velocityPct: 0.1, acceleration: 10 }, [])).toBeCloseTo(0.85, 4);
  });

  it('cadence and account age from post dates', () => {
    const dates = [0, 2, 4, 6, 8].map((d) => new Date(NOW.getTime() - d * DAY));
    expect(postsPerWeek(dates)).toBe(3.5);
    expect(postsPerWeek([NOW])).toBeNull();
    expect(ageFromPosts(5, dates, NOW)).toBe(8);
    expect(ageFromPosts(50, dates, NOW)).toBeNull();
    expect(median([3, 1, 2, 10])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('internal winners', () => {
  const hist = Array.from({ length: 10 }, (_, i) => ({ id: `h${i}`, views: 1_000, savesShares: 20 }));
  it(`beats the persona's median by ≥ ${INTERNAL_WINNER_LIFT}× on views and saves + shares`, () => {
    expect(internalLift({ id: 'w', views: 2_500, savesShares: 60 }, hist)).toMatchObject({ viewsLift: 2.5, depthLift: 3, winner: true });
    expect(internalLift({ id: 'w', views: 2_500, savesShares: 30 }, hist).winner).toBe(false);
    expect(internalLift({ id: 'w', views: 1_500, savesShares: 90 }, hist).winner).toBe(false);
    expect(internalLift({ id: 'w', views: 9_000, savesShares: 90 }, hist.slice(0, 2)).winner).toBe(false);
  });
});
