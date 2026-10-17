import { OUTLIER } from '@troupe/agents';

/**
 * Trend clustering (PRD §3.15.10): a trend is a hook, format, topic or sound adopted by several accelerating
 * accounts within the last 14 days, scored by adoption velocity × average outlier score. Pure.
 */
export const TREND_DIMENSIONS = ['hook', 'format', 'topic', 'sound'] as const;
export type TrendDimension = (typeof TREND_DIMENSIONS)[number];

export interface TrendPost {
  readonly id: string;
  readonly accountId: string;
  readonly handle: string;
  readonly postedAt: Date | null;
  readonly outlier: number | null;
  readonly hook: string | null;
  readonly format: string | null;
  readonly topic: string | null;
  readonly sound: string | null;
}

export interface Trend {
  readonly dimension: TrendDimension;
  readonly key: string;
  readonly label: string;
  /** Distinct accelerating accounts that used it in the window. */
  readonly adopters: number;
  /** Adopters per week since the first adoption in the window. */
  readonly adoptionVelocity: number;
  /** Mean of each adopter's best outlier score on it (a post without a score counts as 1×). */
  readonly avgOutlier: number;
  /** adoptionVelocity × avgOutlier. */
  readonly score: number;
  readonly accounts: readonly string[];
  readonly posts: readonly string[];
  readonly firstSeen: Date;
  readonly lastSeen: Date;
}

/** Keys that look shared but aren't a trend (every creator's "original audio" is different). */
const NOISE = /^(?:original (?:audio|sound)|son original|sonido original|unknown|other|none|n\/a)\b/i;

export function trendKey(dimension: TrendDimension, raw: string | null): string | null {
  if (!raw) return null;
  const k = raw.toLowerCase().replace(/[“”"']/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!k || NOISE.test(k)) return null;
  // "<creator> · Original audio" is that creator's own sound, not a shared one.
  if (dimension === 'sound' && /\boriginal (?:audio|sound)\b/.test(k)) return null;
  return k;
}

const DAY = 86_400_000;
const round = (x: number, dp = 3) => Math.round(x * 10 ** dp) / 10 ** dp;

export function clusterTrends(
  posts: readonly TrendPost[],
  accelerating: ReadonlySet<string>,
  now: Date,
  opts: { windowDays?: number; minAdopters?: number } = {},
): Trend[] {
  const windowDays = opts.windowDays ?? OUTLIER.recencyDays;
  const minAdopters = opts.minAdopters ?? 2;
  const since = now.getTime() - windowDays * DAY;
  const groups = new Map<string, { dimension: TrendDimension; key: string; label: string; posts: TrendPost[] }>();
  for (const p of posts) {
    if (!accelerating.has(p.accountId) || !p.postedAt) continue;
    const t = p.postedAt.getTime();
    if (t < since || t > now.getTime() + DAY) continue;
    for (const dimension of TREND_DIMENSIONS) {
      const raw = p[dimension];
      const key = trendKey(dimension, raw);
      if (!key) continue;
      const id = `${dimension}:${key}`;
      const g = groups.get(id) ?? { dimension, key, label: (raw ?? key).trim().slice(0, 120), posts: [] };
      g.posts.push(p);
      groups.set(id, g);
    }
  }
  const out: Trend[] = [];
  for (const g of groups.values()) {
    const best = new Map<string, number>();
    for (const p of g.posts) best.set(p.accountId, Math.max(best.get(p.accountId) ?? 0, p.outlier ?? 1));
    if (best.size < minAdopters) continue;
    const times = g.posts.map((p) => p.postedAt!.getTime());
    const first = Math.min(...times);
    const last = Math.max(...times);
    const weeks = Math.max(1, (now.getTime() - first) / (7 * DAY));
    const adoptionVelocity = round(best.size / weeks);
    const avgOutlier = round([...best.values()].reduce((a, b) => a + b, 0) / best.size);
    out.push({
      dimension: g.dimension,
      key: g.key,
      label: g.label,
      adopters: best.size,
      adoptionVelocity,
      avgOutlier,
      score: round(adoptionVelocity * avgOutlier),
      accounts: [...new Set(g.posts.map((p) => p.handle))],
      posts: g.posts.map((p) => p.id),
      firstSeen: new Date(first),
      lastSeen: new Date(last),
    });
  }
  return out.sort((a, b) => b.score - a.score || b.adopters - a.adopters || a.key.localeCompare(b.key));
}
