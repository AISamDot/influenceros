import type { Db } from '@ios/db';
import { json } from '@ios/db';
import type { ScrapedPost, ScrapedProfile } from './apify';
import { classifyFormat, classifyHook, classifyTopic } from './classify';
import { nicheKey } from './config';
import {
  ageFromPosts,
  breakoutSignals,
  depthRatio,
  firstPassGrowth,
  growthFromHistory,
  historyGrowthScore,
  isAccelerating,
  median,
  metricOf,
  outlierScore,
  outlierTier,
  type ScoredPostInput,
  viewsPerFollower,
} from './scoring';
import { isoDate, weekStartOf } from './scrape';

/** Persistence for tracked accounts, weekly snapshots and scraped posts, plus the per-account scoring pass. */

export type AccountSource = 'seed' | 'hashtag' | 'search' | 'related' | 'outlier' | 'owner';

export interface TrackedAccountRow {
  id: string;
  studio_id: string;
  platform: 'instagram' | 'tiktok';
  handle: string;
  niche: string;
  source: AccountSource;
  display_name: string | null;
  bio: string | null;
  external_url: string | null;
  followers: number | null;
  following: number | null;
  posts: number | null;
  account_age_days: number | null;
  velocity: number | null;
  acceleration: number | null;
  growth_score: number | null;
  accelerating: boolean;
  breakout: string[];
  growth_basis: 'first_pass' | 'history';
  status: 'active' | 'paused' | 'dropped';
  last_snapshot_at: Date | null;
  last_reviewed_at: Date | null;
  first_seen_at: Date;
}

/** Inserts (or keeps) a tracked account. The first niche and source stick; profile fields refresh when given. */
export async function upsertAccount(
  db: Db,
  a: { studioId: string; platform: 'instagram' | 'tiktok'; handle: string; niche: string; source: AccountSource; profile?: Omit<ScrapedProfile, 'recent' | 'related'> | null },
): Promise<string> {
  const p = a.profile ?? null;
  const row = await db.one<{ id: string }>(
    `INSERT INTO tracked_account (studio_id, platform, handle, niche, source, display_name, bio, external_url, followers, following, posts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (studio_id, platform, handle) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, tracked_account.display_name),
       bio = COALESCE(EXCLUDED.bio, tracked_account.bio),
       external_url = COALESCE(EXCLUDED.external_url, tracked_account.external_url),
       followers = COALESCE(EXCLUDED.followers, tracked_account.followers),
       following = COALESCE(EXCLUDED.following, tracked_account.following),
       posts = COALESCE(EXCLUDED.posts, tracked_account.posts),
       updated_at = now()
     RETURNING id`,
    [a.studioId, a.platform, a.handle, nicheKey(a.niche), a.source, p?.displayName ?? null, p?.bio?.slice(0, 600) ?? null, p?.externalUrl ?? null, p?.followers ?? null, p?.following ?? null, p?.posts ?? null],
  );
  return row.id;
}

const POST_COLS: ReadonlyArray<[string, string]> = [
  ['studio_id', 'uuid'],
  ['account_id', 'uuid'],
  ['platform', 'text'],
  ['external_id', 'text'],
  ['url', 'text'],
  ['handle', 'text'],
  ['niche', 'text'],
  ['kind', 'text'],
  ['caption', 'text'],
  ['transcript', 'text'],
  ['hashtags', 'text[]'],
  ['sound', 'text'],
  ['posted_at', 'timestamptz'],
  ['duration_s', 'numeric'],
  ['views', 'bigint'],
  ['likes', 'bigint'],
  ['comments', 'bigint'],
  ['shares', 'bigint'],
  ['saves', 'bigint'],
  ['followers_at', 'integer'],
  ['metric', 'text'],
  ['format', 'text'],
  ['hook_type', 'text'],
  ['topic', 'text'],
];

export interface PostUpsert {
  readonly accountId: string | null;
  readonly post: ScrapedPost;
  readonly followers?: number | null;
}

/** Two scrapes of the same post in one batch (profile `latestPosts` + reels) merge: the first non-null value wins. */
function mergeDupes(rows: readonly PostUpsert[]): PostUpsert[] {
  const by = new Map<string, PostUpsert>();
  for (const r of rows) {
    const k = `${r.post.platform}:${r.post.externalId}`;
    const cur = by.get(k);
    if (!cur) {
      by.set(k, r);
      continue;
    }
    const a = cur.post;
    const b = r.post;
    const pick = <K extends keyof ScrapedPost>(key: K): ScrapedPost[K] => (a[key] ?? b[key]) as ScrapedPost[K];
    by.set(k, {
      accountId: cur.accountId ?? r.accountId,
      followers: cur.followers ?? r.followers ?? null,
      post: {
        ...a,
        url: pick('url'),
        caption: pick('caption'),
        transcript: pick('transcript'),
        hashtags: a.hashtags.length ? a.hashtags : b.hashtags,
        sound: pick('sound'),
        postedAt: pick('postedAt'),
        durationS: pick('durationS'),
        views: pick('views'),
        likes: pick('likes'),
        comments: pick('comments'),
        shares: pick('shares'),
        saves: pick('saves'),
        authorFollowers: pick('authorFollowers'),
        kind: a.views !== null ? a.kind : b.views !== null ? b.kind : a.kind,
      },
    });
  }
  return [...by.values()];
}

/**
 * Upserts scraped posts in batches (latest metrics win). New posts get a heuristic format / hook / topic until a
 * review replaces them.
 */
export async function upsertPosts(db: Db, studioId: string, niche: string, rows: readonly PostUpsert[]): Promise<number> {
  const list = mergeDupes(rows);
  const key = nicheKey(niche);
  const nicheTag = key.replace(/\s+/g, '');
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const params: unknown[] = [];
    const tuples = chunk.map((r) => {
      const p = r.post;
      const values: unknown[] = [
        studioId,
        r.accountId,
        p.platform,
        p.externalId,
        p.url,
        p.handle,
        key,
        p.kind,
        p.caption?.slice(0, 2200) ?? null,
        p.transcript?.slice(0, 4000) ?? null,
        [...p.hashtags],
        p.sound?.slice(0, 160) ?? null,
        p.postedAt,
        p.durationS,
        p.views,
        p.likes,
        p.comments,
        p.shares,
        p.saves,
        r.followers ?? p.authorFollowers ?? null,
        metricOf(p),
        classifyFormat(p),
        classifyHook(p.caption, p.transcript),
        classifyTopic(p.hashtags, [nicheTag]),
      ];
      const start = params.length;
      params.push(...values);
      return `(${POST_COLS.map(([, t], j) => `$${start + j + 1}::${t}`).join(', ')})`;
    });
    await db.query(
      `INSERT INTO radar_post (${POST_COLS.map(([c]) => c).join(', ')}) VALUES ${tuples.join(', ')}
       ON CONFLICT (studio_id, platform, external_id) DO UPDATE SET
         account_id = COALESCE(radar_post.account_id, EXCLUDED.account_id),
         views = COALESCE(EXCLUDED.views, radar_post.views), likes = COALESCE(EXCLUDED.likes, radar_post.likes),
         comments = COALESCE(EXCLUDED.comments, radar_post.comments), shares = COALESCE(EXCLUDED.shares, radar_post.shares),
         saves = COALESCE(EXCLUDED.saves, radar_post.saves), followers_at = COALESCE(EXCLUDED.followers_at, radar_post.followers_at),
         transcript = COALESCE(radar_post.transcript, EXCLUDED.transcript),
         format = CASE WHEN radar_post.analysis IS NULL THEN EXCLUDED.format ELSE radar_post.format END,
         hook_type = CASE WHEN radar_post.analysis IS NULL THEN EXCLUDED.hook_type ELSE radar_post.hook_type END,
         updated_at = now()`,
      params,
    );
  }
  return list.length;
}

/** One post (see upsertPosts). Returns its id. */
export async function upsertPost(db: Db, q: { studioId: string; niche: string; accountId: string | null; post: ScrapedPost; followers?: number | null }): Promise<string> {
  await upsertPosts(db, q.studioId, q.niche, [{ accountId: q.accountId, post: q.post, followers: q.followers }]);
  return (await db.one<{ id: string }>('SELECT id FROM radar_post WHERE studio_id = $1 AND platform = $2 AND external_id = $3', [q.studioId, q.post.platform, q.post.externalId])).id;
}

/** This week's snapshot for an account (one per week; a re-run the same week refreshes it). */
export async function recordSnapshot(db: Db, q: { studioId: string; accountId: string; now: Date; followers: number; following: number | null; posts: number | null; medianReelViews: number | null; reelsSampled: number }): Promise<void> {
  await db.query(
    `INSERT INTO profile_snapshot (account_id, studio_id, week_start, captured_at, followers, following, posts, median_reel_views, reels_sampled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (account_id, week_start) DO UPDATE SET captured_at = EXCLUDED.captured_at, followers = EXCLUDED.followers,
       following = EXCLUDED.following, posts = EXCLUDED.posts, median_reel_views = EXCLUDED.median_reel_views, reels_sampled = EXCLUDED.reels_sampled`,
    [q.accountId, q.studioId, isoDate(weekStartOf(q.now)), q.now, q.followers, q.following, q.posts, q.medianReelViews === null ? null : Math.round(q.medianReelViews), q.reelsSampled],
  );
  await db.query(`UPDATE tracked_account SET last_snapshot_at = $2, updated_at = now() WHERE id = $1`, [q.accountId, q.now]);
}

interface PostRow {
  id: string;
  kind: 'video' | 'image' | 'carousel';
  views: string | number | null;
  likes: string | number | null;
  shares: string | number | null;
  saves: string | number | null;
  posted_at: Date | null;
}
const n = (v: string | number | null): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * The scoring pass for one account: outlier score, tier, views ÷ followers and depth on each of its posts (baseline:
 * its last 20 other posts), then velocity / acceleration / breakouts / growth score / accelerating on the account
 * (history when it has ≥ 2 weekly snapshots, else the first pass).
 */
export async function scoreAccount(db: Db, accountId: string, now: Date): Promise<{ accelerating: boolean; growthScore: number }> {
  const acct = await db.one<{ followers: number | null; posts: number | null; account_age_days: number | null }>(
    'SELECT followers, posts, account_age_days FROM tracked_account WHERE id = $1',
    [accountId],
  );
  const rows = await db.query<PostRow>(
    `SELECT id, kind, views, likes, shares, saves, posted_at FROM radar_post WHERE account_id = $1 ORDER BY posted_at DESC NULLS LAST LIMIT 60`,
    [accountId],
  );
  const posts: ScoredPostInput[] = rows.map((r) => ({ id: r.id, kind: r.kind, views: n(r.views), likes: n(r.likes), shares: n(r.shares), saves: n(r.saves), postedAt: r.posted_at ? new Date(r.posted_at) : null }));
  if (posts.length) {
    const scored = posts.map((p) => {
      const score = outlierScore(p, posts);
      return { id: p.id, score, tier: outlierTier(score), vpf: metricOf(p) === 'views' ? viewsPerFollower(p.views, acct.followers) : null, depth: depthRatio(p) };
    });
    await db.query(
      `UPDATE radar_post r SET outlier_score = u.score, tier = u.tier, views_per_follower = u.vpf, depth = u.depth,
              followers_at = COALESCE(r.followers_at, $6), updated_at = now()
         FROM unnest($1::uuid[], $2::numeric[], $3::text[], $4::numeric[], $5::numeric[]) AS u(id, score, tier, vpf, depth)
        WHERE r.id = u.id`,
      [scored.map((x) => x.id), scored.map((x) => x.score), scored.map((x) => x.tier), scored.map((x) => x.vpf), scored.map((x) => x.depth), acct.followers],
    );
  }
  const recentViews = posts.filter((p) => p.kind === 'video' && p.views !== null).slice(0, 20).map((p) => p.views!);
  const age = acct.account_age_days ?? ageFromPosts(acct.posts, posts.map((p) => p.postedAt), now);
  const snaps = await db.query<{ captured_at: Date; followers: number }>(`SELECT captured_at, followers FROM profile_snapshot WHERE account_id = $1 ORDER BY week_start`, [accountId]);
  let out: { velocity: number | null; acceleration: number | null; score: number; accelerating: boolean; signals: string[]; basis: 'history' | 'first_pass' };
  if (snaps.length >= 2) {
    const g = growthFromHistory(snaps.map((s) => ({ at: new Date(s.captured_at), followers: s.followers })));
    const signals = breakoutSignals({ followers: acct.followers, posts: acct.posts, accountAgeDays: age, medianViews: median(recentViews), maxViews: recentViews.length ? Math.max(...recentViews) : null });
    const score = historyGrowthScore(g, signals);
    out = { velocity: g.velocity, acceleration: g.acceleration, score, accelerating: isAccelerating('history', { ...g, score }), signals, basis: 'history' };
  } else {
    const fp = firstPassGrowth({ followers: acct.followers, posts: acct.posts, accountAgeDays: age, recentViews });
    out = { velocity: fp.estVelocity, acceleration: null, score: fp.score, accelerating: isAccelerating('first_pass', { velocity: fp.estVelocity, acceleration: null, velocityPct: null, score: fp.score }), signals: fp.signals, basis: 'first_pass' };
  }
  await db.query(
    `UPDATE tracked_account SET velocity = $2, acceleration = $3, growth_score = $4, accelerating = $5, breakout = $6::jsonb, growth_basis = $7,
            account_age_days = COALESCE(account_age_days, $8), updated_at = now() WHERE id = $1`,
    [accountId, out.velocity, out.acceleration, out.score, out.accelerating, json(out.signals), out.basis, age],
  );
  return { accelerating: out.accelerating, growthScore: out.score };
}

export async function loadAccount(db: Db, id: string): Promise<TrackedAccountRow> {
  return db.one<TrackedAccountRow>('SELECT * FROM tracked_account WHERE id = $1', [id]);
}
