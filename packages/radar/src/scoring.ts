import { INTERNAL_WINNER_LIFT, OUTLIER } from '@ios/agents';

/**
 * The Winner Finder and Growth Radar maths (PRD §3.15.9–10). Pure functions: the jobs feed them stored rows and
 * persist what they return, and the tests pin them on fixtures.
 */

const DAY = 86_400_000;
const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const round = (x: number, dp = 3) => Math.round(x * 10 ** dp) / 10 ** dp;

export function median(xs: readonly number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

// ───────────────────────────── Per-post outlier scoring ─────────────────────────────

export interface ScoredPostInput {
  readonly id: string;
  readonly kind: 'video' | 'image' | 'carousel';
  readonly views: number | null;
  readonly likes: number | null;
  readonly shares: number | null;
  readonly saves: number | null;
  readonly postedAt: Date | null;
}

/**
 * The metric a post is compared on: views for videos (reels, TikToks), likes for stills and carousels (public view
 * counts don't exist for those). A creator's posts are only compared within the same metric.
 */
export const metricOf = (p: Pick<ScoredPostInput, 'kind' | 'views'>): 'views' | 'likes' => (p.kind === 'video' && p.views !== null ? 'views' : 'likes');
const valueOf = (p: ScoredPostInput, m: 'views' | 'likes'): number | null => (m === 'views' ? p.views : p.likes);

/** Minimum baseline posts before an outlier ratio means anything. */
export const MIN_BASELINE = 3;

/**
 * Outlier score: the post's views ÷ the median views of the creator's last 20 other posts (OUTLIER.window), on the
 * same metric. The post itself is left out of its own baseline. null when the baseline is too thin or zero.
 */
export function outlierScore(post: ScoredPostInput, creatorPosts: readonly ScoredPostInput[]): number | null {
  const m = metricOf(post);
  const v = valueOf(post, m);
  if (v === null) return null;
  const base = creatorPosts
    .filter((p) => p.id !== post.id && metricOf(p) === m && valueOf(p, m) !== null)
    .sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0))
    .slice(0, OUTLIER.window)
    .map((p) => valueOf(p, m)!);
  if (base.length < MIN_BASELINE) return null;
  const med = median(base)!;
  return med > 0 ? round(v / med) : null;
}

export type OutlierTier = 'normal' | 'outlier' | 'strong';
/** ≥ 5× is an outlier, ≥ 10× a strong one (OUTLIER). */
export const outlierTier = (score: number | null): OutlierTier => (score === null ? 'normal' : score >= OUTLIER.strong ? 'strong' : score >= OUTLIER.outlier ? 'outlier' : 'normal');

/** Views ÷ followers: a small account with a big hit means the content won, not the audience. */
export const viewsPerFollower = (views: number | null, followers: number | null): number | null =>
  views === null || !followers || followers <= 0 ? null : round(views / followers, 4);

/** (saves + shares) ÷ views; null when neither is public or there are no views. */
export function depthRatio(p: Pick<ScoredPostInput, 'saves' | 'shares' | 'views'>): number | null {
  if (p.saves === null && p.shares === null) return null;
  if (!p.views || p.views <= 0) return null;
  return round(((p.saves ?? 0) + (p.shares ?? 0)) / p.views, 5);
}

/** Recency: fresh within 14 days (OUTLIER.recencyDays); the weight falls from 1 to 0.5 across the window, 0 after. */
export function recency(postedAt: Date | null, now: Date): { ageDays: number | null; fresh: boolean; weight: number } {
  if (!postedAt) return { ageDays: null, fresh: false, weight: 0 };
  const ageDays = Math.max(0, (now.getTime() - postedAt.getTime()) / DAY);
  const fresh = ageDays <= OUTLIER.recencyDays;
  return { ageDays: round(ageDays, 2), fresh, weight: fresh ? round(1 - (0.5 * ageDays) / OUTLIER.recencyDays, 4) : 0 };
}

export interface WinnerInputs {
  readonly outlier: number | null;
  readonly viewsPerFollower: number | null;
  readonly depth: number | null;
  readonly recencyWeight: number;
  /** 0–1: one host, ≤ 2 locations, no complex VFX. */
  readonly replicability: number;
  /** 0–1: can it lead to our product? */
  readonly monetisationFit: number;
  /** 0–1: distance from the persona's own history. */
  readonly novelty: number;
}

/** Weights of the composite winner score (sum to 1). */
export const WINNER_WEIGHTS = { outlier: 0.35, viewsPerFollower: 0.15, depth: 0.1, recency: 0.1, replicability: 0.12, monetisationFit: 0.1, novelty: 0.08 } as const;

/**
 * Composite Winner Finder score, 0–1. Outlier saturates at 20×, views ÷ followers at 5×, depth at 5 % (saves +
 * shares per view). A missing public metric counts as neutral (0.5) rather than zero, so Instagram (no public saves)
 * isn't penalised against TikTok.
 */
export function winnerScore(x: WinnerInputs): number {
  const W = WINNER_WEIGHTS;
  const o = x.outlier === null ? 0 : clamp01(Math.log(Math.max(1, x.outlier)) / Math.log(20));
  const vpf = x.viewsPerFollower === null ? 0.5 : clamp01(x.viewsPerFollower / 5);
  const d = x.depth === null ? 0.5 : clamp01(x.depth / 0.05);
  return round(
    W.outlier * o +
      W.viewsPerFollower * vpf +
      W.depth * d +
      W.recency * clamp01(x.recencyWeight) +
      W.replicability * clamp01(x.replicability) +
      W.monetisationFit * clamp01(x.monetisationFit) +
      W.novelty * clamp01(x.novelty),
    4,
  );
}

/** Replicability without a review: stills and carousels are easy; short videos easier than long ones. */
export function heuristicReplicability(kind: ScoredPostInput['kind'], durationS: number | null): number {
  if (kind !== 'video') return 0.9;
  if (durationS === null) return 0.6;
  return durationS <= 30 ? 0.8 : durationS <= 60 ? 0.7 : 0.5;
}

// ───────────────────────────── Text overlap (niche fit, monetisation fit, novelty) ─────────────────────────────

const STOP = new Set(
  'the and for you your with this that are was were how what why when who from have has had not but all can will just our out get got its it’s into about more most than then them they she her his him one two three day days week new make made like dont don’t im i’m ive i’ve too very really here there over'.split(' '),
);
export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[#@]/g, ' ')
      .split(/[^a-z0-9’']+/)
      .map((w) => w.replace(/['’]s$/, ''))
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}
/** Share of `terms` found in `text` (0–1), for niche and monetisation fit. */
export function coverage(text: string, terms: readonly string[]): number {
  const t = tokens(text);
  const want = new Set(terms.flatMap((x) => [...tokens(x)]));
  if (!want.size || !t.size) return 0;
  let hit = 0;
  for (const w of want) if (t.has(w)) hit += 1;
  return hit / Math.min(want.size, 6);
}
/** 1 − the highest overlap with the persona's history (titles, hooks). */
export function novelty(candidate: string, history: readonly string[]): number {
  const c = tokens(candidate);
  let max = 0;
  for (const h of history) max = Math.max(max, jaccard(c, tokens(h)));
  return round(1 - max, 4);
}

// ───────────────────────────── Account growth ─────────────────────────────

export interface Snapshot {
  readonly at: Date;
  readonly followers: number;
}

/**
 * Growth from weekly snapshots (sorted any order): velocity = follower Δ per week over the latest interval,
 * acceleration = the change in velocity per week against the interval before. null where history is too short.
 */
export function growthFromHistory(snaps: readonly Snapshot[]): { velocity: number | null; acceleration: number | null; velocityPct: number | null } {
  const s = snaps.slice().sort((a, b) => a.at.getTime() - b.at.getTime());
  if (s.length < 2) return { velocity: null, acceleration: null, velocityPct: null };
  const perWeek = (a: Snapshot, b: Snapshot) => {
    const weeks = Math.max(1 / 7, (b.at.getTime() - a.at.getTime()) / (7 * DAY));
    return (b.followers - a.followers) / weeks;
  };
  const n = s.length;
  const velocity = perWeek(s[n - 2]!, s[n - 1]!);
  let acceleration: number | null = null;
  if (n >= 3) {
    const prev = perWeek(s[n - 3]!, s[n - 2]!);
    const weeks = Math.max(1 / 7, (s[n - 1]!.at.getTime() - s[n - 2]!.at.getTime()) / (7 * DAY));
    acceleration = (velocity - prev) / weeks;
  }
  const base = s[n - 2]!.followers;
  return { velocity: round(velocity, 2), acceleration: acceleration === null ? null : round(acceleration, 2), velocityPct: base > 0 ? round(velocity / base, 4) : null };
}

export type BreakoutSignal = 'young_high_followers_per_post' | 'reels_far_above_followers' | 'viral_hit';

/** Breakout signals (PRD §3.15.10): a young account with high followers per post; reel views far above followers. */
export function breakoutSignals(x: { followers: number | null; posts: number | null; accountAgeDays: number | null; medianViews: number | null; maxViews?: number | null }): BreakoutSignal[] {
  const out: BreakoutSignal[] = [];
  const f = x.followers ?? 0;
  const young = (x.accountAgeDays !== null && x.accountAgeDays <= 365) || (x.posts !== null && x.posts <= 60);
  if (young && x.posts && x.posts > 0 && f / x.posts >= 500) out.push('young_high_followers_per_post');
  if (f > 0 && x.medianViews !== null && x.medianViews / f >= 3) out.push('reels_far_above_followers');
  if (f > 0 && x.maxViews && x.maxViews / f >= 20) out.push('viral_hit');
  return out;
}

/**
 * First pass with no history (one snapshot): recent reel views ÷ followers, account age and post count.
 * Score 0–1: reach beyond the audience (log scale, saturates at 10×), youth, and breakout signals.
 * `estVelocity` = followers ÷ account age in weeks when the age is known.
 */
export function firstPassGrowth(x: { followers: number | null; posts: number | null; accountAgeDays: number | null; recentViews: readonly number[] }): {
  score: number;
  viewsToFollowers: number | null;
  estVelocity: number | null;
  signals: BreakoutSignal[];
} {
  const f = x.followers ?? 0;
  const med = median(x.recentViews);
  const v2f = f > 0 && med !== null ? round(med / f, 3) : null;
  const reach = v2f === null ? 0 : clamp01(Math.log10(1 + v2f) / Math.log10(11));
  const ageWeeks = x.accountAgeDays !== null ? Math.max(1, x.accountAgeDays / 7) : null;
  const youth = x.accountAgeDays !== null ? clamp01(1 - x.accountAgeDays / 730) : x.posts !== null ? clamp01(1 - x.posts / 300) : 0.3;
  const signals = breakoutSignals({ followers: x.followers, posts: x.posts, accountAgeDays: x.accountAgeDays, medianViews: med, maxViews: x.recentViews.length ? Math.max(...x.recentViews) : null });
  const score = clamp01(0.6 * reach + 0.2 * youth + 0.1 * signals.length);
  return { score: round(score, 4), viewsToFollowers: v2f, estVelocity: ageWeeks !== null && f > 0 ? round(f / ageWeeks, 2) : null, signals };
}

/** Growth score from history: weekly velocity as a share of followers (saturates at 10 %/week), acceleration, breakouts. */
export function historyGrowthScore(g: { velocityPct: number | null; acceleration: number | null }, signals: readonly BreakoutSignal[]): number {
  const v = g.velocityPct === null ? 0 : clamp01(g.velocityPct / 0.1);
  const a = g.acceleration === null ? 0.5 : g.acceleration > 0 ? 1 : 0;
  return round(clamp01(0.6 * v + 0.25 * a + 0.05 * signals.length), 4);
}

/**
 * Accelerating: with history, growing and speeding up (velocity > 0 and acceleration > 0; with only two snapshots,
 * ≥ 2 % a week). Without history, the first-pass score ≥ 0.5.
 */
export function isAccelerating(basis: 'history' | 'first_pass', x: { velocity: number | null; acceleration: number | null; velocityPct: number | null; score: number }): boolean {
  if (basis === 'first_pass') return x.score >= 0.5;
  if (x.velocity === null || x.velocity <= 0) return false;
  if (x.acceleration !== null) return x.acceleration > 0;
  return (x.velocityPct ?? 0) >= 0.02;
}

/** Feed posts a week from post dates (n − 1 intervals over the span); null with fewer than 2 dated posts. */
export function postsPerWeek(dates: ReadonlyArray<Date | null>): number | null {
  const t = dates.filter((d): d is Date => d instanceof Date).map((d) => d.getTime()).sort((a, b) => a - b);
  if (t.length < 2) return null;
  const spanDays = Math.max(1, (t[t.length - 1]! - t[0]!) / DAY);
  return round(((t.length - 1) / spanDays) * 7, 2);
}

/** Estimated account age from its oldest visible post when every post is visible (else unknown). */
export function ageFromPosts(posts: number | null, dates: ReadonlyArray<Date | null>, now: Date): number | null {
  const t = dates.filter((d): d is Date => d instanceof Date).map((d) => d.getTime());
  if (!t.length || posts === null || posts > t.length) return null;
  return Math.max(0, Math.round((now.getTime() - Math.min(...t)) / DAY));
}

// ───────────────────────────── Internal winners ─────────────────────────────

/**
 * Internal winner (PRD §3.15.9): our post beats the persona's median by ≥ INTERNAL_WINNER_LIFT on views AND on
 * saves + shares. Medians come from the persona's last 20 posts (the post itself excluded).
 */
export function internalLift(
  post: { id: string; views: number; savesShares: number },
  history: ReadonlyArray<{ id: string; views: number; savesShares: number }>,
): { viewsLift: number | null; depthLift: number | null; winner: boolean } {
  const base = history.filter((h) => h.id !== post.id).slice(0, OUTLIER.window);
  if (base.length < MIN_BASELINE) return { viewsLift: null, depthLift: null, winner: false };
  const mv = median(base.map((h) => h.views))!;
  const ms = median(base.map((h) => h.savesShares))!;
  const viewsLift = mv > 0 ? round(post.views / mv) : null;
  const depthLift = ms > 0 ? round(post.savesShares / ms) : post.savesShares > 0 ? Number.POSITIVE_INFINITY : null;
  return { viewsLift, depthLift, winner: viewsLift !== null && depthLift !== null && viewsLift >= INTERNAL_WINNER_LIFT && depthLift >= INTERNAL_WINNER_LIFT };
}
