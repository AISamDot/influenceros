import { describe, expect, it } from 'vitest';
import { clusterTrends, type TrendPost, trendKey } from '../src';

const DAY = 86_400_000;
const NOW = new Date('2026-10-16T12:00:00Z');
let n = 0;
const post = (accountId: string, daysAgo: number, f: Partial<TrendPost> = {}): TrendPost => ({
  id: `p${(n += 1)}`,
  accountId,
  handle: `demo_${accountId}`,
  postedAt: new Date(NOW.getTime() - daysAgo * DAY),
  outlier: 2,
  hook: null,
  format: null,
  topic: null,
  sound: null,
  ...f,
});

describe('trend clustering', () => {
  it('finds a hook adopted by ≥ 2 accelerating accounts within 14 days, scored by adoption velocity × average outlier', () => {
    const posts = [post('a', 3, { hook: 'pov', outlier: 8 }), post('a', 5, { hook: 'pov', outlier: 2 }), post('b', 6, { hook: 'pov', outlier: 4 }), post('c', 2, { hook: 'ranking', outlier: 9 })];
    const trends = clusterTrends(posts, new Set(['a', 'b', 'c']), NOW);
    expect(trends).toHaveLength(1);
    const t = trends[0]!;
    expect(t).toMatchObject({ dimension: 'hook', key: 'pov', adopters: 2 });
    // First adoption 6 days ago → less than a week → velocity = 2 adopters per week. Best outlier per account: 8 and 4.
    expect(t.adoptionVelocity).toBe(2);
    expect(t.avgOutlier).toBe(6);
    expect(t.score).toBe(12);
    expect(t.accounts).toEqual(['demo_a', 'demo_b']);
  });

  it('spreads velocity over the weeks since first adoption, and ranks by score', () => {
    const posts = [
      post('a', 13, { topic: 'sinkingfunds', outlier: 3 }),
      post('b', 1, { topic: 'sinkingfunds', outlier: 3 }),
      post('c', 1, { topic: 'sinkingfunds', outlier: 3 }),
      post('a', 1, { sound: 'Golden Hour (sped up) · demo', outlier: 10 }),
      post('d', 1, { sound: 'Golden Hour (sped up) · demo', outlier: 10 }),
    ];
    const trends = clusterTrends(posts, new Set(['a', 'b', 'c', 'd']), NOW);
    const topic = trends.find((t) => t.dimension === 'topic')!;
    expect(topic.adopters).toBe(3);
    expect(topic.adoptionVelocity).toBeCloseTo(3 / (13 / 7), 3);
    expect(trends[0]!.dimension).toBe('sound');
  });

  it('ignores accounts that are not accelerating, posts older than 14 days and one-account "trends"', () => {
    const posts = [post('a', 2, { format: 'carousel' }), post('b', 2, { format: 'carousel' }), post('c', 20, { format: 'carousel' }), post('d', 1, { format: 'meme' })];
    expect(clusterTrends(posts, new Set(['a', 'c', 'd']), NOW)).toEqual([]);
    expect(clusterTrends(posts, new Set(['a', 'b']), NOW).map((t) => t.key)).toEqual(['carousel']);
  });

  it('never treats "original audio" as a shared sound', () => {
    expect(trendKey('sound', 'demo_a · original audio')).toBeNull();
    expect(trendKey('sound', 'Original sound')).toBeNull();
    expect(trendKey('topic', '  Sinking   Funds ')).toBe('sinking funds');
    const posts = [post('a', 1, { sound: 'demo_a · original audio' }), post('b', 1, { sound: 'demo_a · original audio' })];
    expect(clusterTrends(posts, new Set(['a', 'b']), NOW)).toEqual([]);
  });
});
