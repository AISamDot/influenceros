import { enqueueOnceFor, METRIC_WINDOW_MS, METRIC_WINDOWS, type MetricWindow, type StudioServices } from '@troupe/agents';
import type { Platform, PostMetrics } from '@troupe/providers';
import { DAY_MS, errorText, isoDate } from './util';

/**
 * Analytics ingestion (PRD FR-13.1): per-post cumulative metrics at 1h / 24h / 72h / 7d after publishing into
 * metric_snapshot (one row per (post_id, window)), plus one account-level row per persona, platform and day (post_id
 * NULL) holding that day's views and the follower count. The Profit Engine reads the latest snapshot per post (P&L,
 * levers) and the daily account rows (forecast); the scorecards read both.
 */

export const JOB = { pull: 'analytics.pull' } as const;

/**
 * A window is captured once it is due and until the next window is due (7d: until day 14). A capture that is that late
 * would be mislabelled, so it is skipped instead.
 */
export function dueWindows(publishedAt: Date, now: Date, have: ReadonlySet<string>): MetricWindow[] {
  const age = now.getTime() - publishedAt.getTime();
  const out: MetricWindow[] = [];
  METRIC_WINDOWS.forEach((w, i) => {
    const start = METRIC_WINDOW_MS[w];
    const end = i + 1 < METRIC_WINDOWS.length ? METRIC_WINDOW_MS[METRIC_WINDOWS[i + 1]!] : 2 * METRIC_WINDOW_MS[w];
    if (age >= start && age < end && !have.has(w)) out.push(w);
  });
  return out;
}

export async function enqueuePull(services: StudioServices, now: Date = services.now()): Promise<boolean> {
  return !!(await enqueueOnceFor(services.db, { kind: JOB.pull, key: 'analytics:pull', payload: {}, priority: 110, runAt: now }));
}

export interface PullResult {
  captured: number;
  skipped: number;
  accounts: number;
  errors: string[];
}

/** Captures every due window for live posts published in the last 14 days. Idempotent (unique (post_id, window)). */
export async function pullMetrics(services: StudioServices, opts: { now?: Date; personaId?: string; limit?: number; heartbeat?: () => Promise<boolean> } = {}): Promise<PullResult> {
  const { db, providers } = services;
  const now = opts.now ?? services.now();
  const out: PullResult = { captured: 0, skipped: 0, accounts: 0, errors: [] };
  const posts = await db.query<{ id: string; persona_id: string; platform: Platform; external_id: string; url: string | null; published_at: Date; windows: string[] | null }>(
    `SELECT po.id, po.persona_id, po.platform, po.external_id, po.url, po.published_at,
            (SELECT array_agg(m."window") FROM metric_snapshot m WHERE m.post_id = po.id AND m."window" IS NOT NULL) AS windows
       FROM post po
      WHERE po.status = 'live' AND po.external_id IS NOT NULL AND po.published_at IS NOT NULL
        AND po.published_at > $1 AND po.published_at <= $2 AND ($3::uuid IS NULL OR po.persona_id = $3)
      ORDER BY po.published_at LIMIT $4`,
    [new Date(now.getTime() - 14 * DAY_MS), now, opts.personaId ?? null, opts.limit ?? 500],
  );
  const touched = new Set<string>();
  for (const p of posts) {
    if (!p.url) await backfillUrl(services, p.id, p.external_id);
    const due = dueWindows(new Date(p.published_at), now, new Set(p.windows ?? []));
    if (!due.length) continue;
    if (opts.heartbeat && !(await opts.heartbeat())) break;
    let m: PostMetrics;
    try {
      m = await providers.publish.fetchMetrics({ externalId: p.external_id, platform: p.platform });
    } catch (err) {
      out.errors.push(`${p.platform} ${p.id}: ${errorText(err)}`);
      continue;
    }
    // One fetch is the cumulative value now; it is recorded under the window that is due (normally exactly one).
    const w = due[due.length - 1]!;
    out.skipped += due.length - 1;
    const row = await db.maybeOne(
      `INSERT INTO metric_snapshot (persona_id, post_id, platform, captured_on, "window", views, watch_time_s, likes, comments, saves, shares, follows, profile_visits, link_clicks, created_at)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (post_id, "window") WHERE post_id IS NOT NULL AND "window" IS NOT NULL DO NOTHING RETURNING id`,
      [p.persona_id, p.id, p.platform, isoDate(now), w, m.views, m.watchTimeS, m.likes, m.comments, m.saves, m.shares, m.follows, m.profileVisits, m.linkClicks, now],
    );
    if (row) {
      out.captured += 1;
      touched.add(`${p.persona_id}|${p.platform}`);
    }
  }
  for (const key of touched) {
    const [personaId, platform] = key.split('|') as [string, Platform];
    await rollupAccountDay(services, personaId, platform, now);
    out.accounts += 1;
  }
  return out;
}

/**
 * A post can go live before the platform hands back its permalink (TikTok sometimes confirms with only a publish id;
 * Zernio's reconcile backfills platformPostUrl later). Each pull re-reads such a post and stores the URL once it has one.
 */
async function backfillUrl(services: StudioServices, postId: string, externalId: string): Promise<void> {
  try {
    const v = await services.providers.publish.verify(externalId);
    if (v.url) await services.db.query(`UPDATE post SET url = $2, updated_at = now() WHERE id = $1 AND url IS NULL`, [postId, v.url]);
  } catch {
    // Best effort: the next pull tries again.
  }
}

const METRIC_COLS = ['views', 'watch_time_s', 'likes', 'comments', 'saves', 'shares', 'follows', 'profile_visits', 'link_clicks'] as const;

/**
 * The persona/platform account row for `day`: the growth of every post's cumulative metrics on that day (latest
 * snapshot captured by the end of the day minus the latest before it), and the follower count carried forward.
 */
export async function rollupAccountDay(services: StudioServices, personaId: string, platform: Platform, at: Date): Promise<void> {
  const { db } = services;
  const day = isoDate(at);
  const sums = METRIC_COLS.map((c) => `COALESCE(sum(GREATEST(COALESCE(cur.${c}, 0) - COALESCE(prev.${c}, 0), 0)), 0)::int AS ${c}`).join(', ');
  const delta = await db.one<Record<(typeof METRIC_COLS)[number], number>>(
    `SELECT ${sums}
       FROM post po
       LEFT JOIN LATERAL (SELECT * FROM metric_snapshot m WHERE m.post_id = po.id AND m.captured_on <= $3::date ORDER BY m.captured_on DESC, m.created_at DESC LIMIT 1) cur ON true
       LEFT JOIN LATERAL (SELECT * FROM metric_snapshot m WHERE m.post_id = po.id AND m.captured_on < $3::date ORDER BY m.captured_on DESC, m.created_at DESC LIMIT 1) prev ON true
      WHERE po.persona_id = $1 AND po.platform = $2 AND cur.id IS NOT NULL`,
    [personaId, platform, day],
  );
  const prevFollowers = await db.maybeOne<{ followers: number | null }>(
    `SELECT followers FROM metric_snapshot WHERE persona_id = $1 AND platform = $2 AND post_id IS NULL AND captured_on < $3::date AND followers IS NOT NULL
      ORDER BY captured_on DESC LIMIT 1`,
    [personaId, platform, day],
  );
  const followers = (prevFollowers?.followers ?? 0) + delta.follows;
  const vals = METRIC_COLS.map((c) => delta[c]);
  const updated = await db.query(
    `UPDATE metric_snapshot SET views = $4, watch_time_s = $5, likes = $6, comments = $7, saves = $8, shares = $9, follows = $10, profile_visits = $11, link_clicks = $12, followers = $13
      WHERE id = (SELECT id FROM metric_snapshot WHERE persona_id = $1 AND platform = $2 AND post_id IS NULL AND captured_on = $3::date ORDER BY created_at LIMIT 1) RETURNING id`,
    [personaId, platform, day, ...vals, followers],
  );
  if (!updated.length) {
    await db.query(
      `INSERT INTO metric_snapshot (persona_id, post_id, platform, captured_on, views, watch_time_s, likes, comments, saves, shares, follows, profile_visits, link_clicks, followers)
       VALUES ($1, NULL, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [personaId, platform, day, ...vals, followers],
    );
  }
}

export interface Scorecard {
  personaId: string;
  days: number;
  posts: number;
  views: number;
  avgViews: number;
  /** Average watch time per view, seconds. */
  avgWatchS: number;
  likeRate: number;
  saveRate: number;
  shareRate: number;
  /** Follows per 1,000 views. */
  followsPer1k: number;
  profileVisits: number;
  linkClicks: number;
  /** Link clicks per 1,000 views. */
  clicksPer1k: number;
  /** Median views at each window across the period's posts (null when no post reached it). */
  medianByWindow: Record<MetricWindow, number | null>;
  top: Array<{ postId: string; platform: Platform; format: string; views: number; url: string | null; window: string | null }>;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

/** Per-persona scorecard (FR-13.3) from the latest snapshot of each post published in the last `days` days. */
export async function personaScorecard(services: Pick<StudioServices, 'db' | 'now'>, personaId: string, days = 7, now: Date = services.now()): Promise<Scorecard> {
  const { db } = services;
  const rows = await db.query<{ id: string; platform: Platform; format: string; url: string | null; views: number; watch: number; likes: number; saves: number; shares: number; follows: number; visits: number; clicks: number; window: string | null }>(
    `SELECT po.id, po.platform, po.format, po.url, l.views, l.watch_time_s AS watch, l.likes, l.saves, l.shares, l.follows, l.profile_visits AS visits, l.link_clicks AS clicks, l."window"
       FROM post po
       JOIN LATERAL (SELECT * FROM metric_snapshot m WHERE m.post_id = po.id ORDER BY m.captured_on DESC, m.created_at DESC LIMIT 1) l ON true
      WHERE po.persona_id = $1 AND po.published_at > $2 AND po.published_at <= $3
      ORDER BY l.views DESC`,
    [personaId, new Date(now.getTime() - days * DAY_MS), now],
  );
  const byWindow = await db.query<{ window: MetricWindow; views: number }>(
    `SELECT m."window", m.views FROM metric_snapshot m JOIN post po ON po.id = m.post_id
      WHERE po.persona_id = $1 AND po.published_at > $2 AND po.published_at <= $3 AND m."window" IS NOT NULL`,
    [personaId, new Date(now.getTime() - days * DAY_MS), now],
  );
  const sum = (k: keyof (typeof rows)[number]) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const views = sum('views');
  const rate = (n: number) => (views ? Math.round((n / views) * 10_000) / 10_000 : 0);
  const per1k = (n: number) => (views ? Math.round((n / views) * 1000 * 100) / 100 : 0);
  const medianByWindow = Object.fromEntries(METRIC_WINDOWS.map((w) => [w, median(byWindow.filter((r) => r.window === w).map((r) => r.views))])) as Record<MetricWindow, number | null>;
  return {
    personaId,
    days,
    posts: rows.length,
    views,
    avgViews: rows.length ? Math.round(views / rows.length) : 0,
    avgWatchS: views ? Math.round((sum('watch') / views) * 10) / 10 : 0,
    likeRate: rate(sum('likes')),
    saveRate: rate(sum('saves')),
    shareRate: rate(sum('shares')),
    followsPer1k: per1k(sum('follows')),
    profileVisits: sum('visits'),
    linkClicks: sum('clicks'),
    clicksPer1k: per1k(sum('clicks')),
    medianByWindow,
    top: rows.slice(0, 5).map((r) => ({ postId: r.id, platform: r.platform, format: r.format, views: r.views, url: r.url, window: r.window })),
  };
}
