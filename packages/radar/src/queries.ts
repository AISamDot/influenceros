import { apifyWeekSpendUsd, type FormatBenchmark } from '@troupe/agents';
import { getSettings } from '@troupe/core';
import type { Db } from '@troupe/db';
import { formatBenchmarks, latestTrends, type TrendRow } from './insights';

/** Read model for the /radar page. Handles, URLs, tags and sound names are third-party labels (rendered as text). */
export interface RadarOverview {
  spend: { usedUsd: number; capUsd: number; runs7d: number; capped7d: number };
  lastReport: { week: string; at: Date } | null;
  accounts: Array<{ id: string; platform: string; handle: string; niche: string; source: string; followers: number | null; velocity: number | null; acceleration: number | null; growth_score: number | null; accelerating: boolean; breakout: string[]; growth_basis: string; last_snapshot_at: Date | null }>;
  outliers: Array<{ id: string; platform: string; handle: string; niche: string; url: string | null; kind: string; format: string | null; hook_type: string | null; outlier_score: number; tier: string; views: number | null; likes: number | null; views_per_follower: number | null; depth: number | null; posted_at: Date | null }>;
  trends: TrendRow[];
  briefs: Array<{ id: string; kind: string; persona_name: string; persona_slug: string; title: string | null; mechanic: string | null; format: string; target_format: string | null; status: string; idea_status: string | null; created_at: Date }>;
  benchmarks: FormatBenchmark[];
  counts: { tracked: number; accelerating: number; posts: number; niches: number };
}

export async function radarOverview(db: Db, studioId: string, now: Date): Promise<RadarOverview> {
  const capUsd = (await getSettings(db, studioId)).apify_weekly_cap_usd;
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const runs = await db.one<{ runs: number; capped: number }>(
    `SELECT count(*) FILTER (WHERE kind <> 'discover_done')::int AS runs, count(*) FILTER (WHERE status = 'capped')::int AS capped FROM radar_run WHERE studio_id = $1 AND created_at > $2`,
    [studioId, since],
  );
  const rep = await db.maybeOne<{ week: string; at: Date }>(`SELECT week_start::text AS week, created_at AS at FROM radar_report WHERE studio_id = $1 ORDER BY week_start DESC LIMIT 1`, [studioId]);
  const accounts = await db.query<RadarOverview['accounts'][number]>(
    `SELECT id, platform, handle, niche, source, followers, velocity::float8 AS velocity, acceleration::float8 AS acceleration, growth_score::float8 AS growth_score,
            accelerating, breakout, growth_basis, last_snapshot_at
       FROM tracked_account WHERE studio_id = $1 AND status = 'active'
      ORDER BY accelerating DESC, growth_score DESC NULLS LAST LIMIT 30`,
    [studioId],
  );
  const outliers = await db.query<RadarOverview['outliers'][number]>(
    `SELECT id, platform, handle, niche, url, kind, format, hook_type, outlier_score::float8 AS outlier_score, tier, views::float8 AS views, likes::float8 AS likes,
            views_per_follower::float8 AS views_per_follower, depth::float8 AS depth, posted_at
       FROM radar_post WHERE studio_id = $1 AND tier IN ('outlier','strong') AND posted_at > $2
      ORDER BY outlier_score DESC LIMIT 30`,
    [studioId, new Date(now.getTime() - 14 * 86_400_000)],
  );
  const briefs = await db.query<RadarOverview['briefs'][number]>(
    `SELECT b.id, b.kind, p.name AS persona_name, p.slug AS persona_slug, b.concept->>'title' AS title, b.mechanic->>'hook_label' AS mechanic, b.format,
            b.concept->>'target_format' AS target_format, b.status, i.status AS idea_status, b.created_at
       FROM remix_brief b JOIN persona p ON p.id = b.persona_id LEFT JOIN idea i ON i.id = b.idea_id
      WHERE b.studio_id = $1 ORDER BY b.created_at DESC LIMIT 30`,
    [studioId],
  );
  const niches = (await db.query<{ niche: string }>(`SELECT DISTINCT niche FROM tracked_account WHERE studio_id = $1 ORDER BY niche`, [studioId])).map((r) => r.niche);
  const benchmarks: FormatBenchmark[] = [];
  for (const n of niches) {
    const b = await formatBenchmarks(db, studioId, n, now);
    if (b) benchmarks.push(b);
  }
  const counts = await db.one<{ tracked: number; accelerating: number; posts: number }>(
    `SELECT (SELECT count(*)::int FROM tracked_account WHERE studio_id = $1 AND status = 'active') AS tracked,
            (SELECT count(*)::int FROM tracked_account WHERE studio_id = $1 AND status = 'active' AND accelerating) AS accelerating,
            (SELECT count(*)::int FROM radar_post WHERE studio_id = $1) AS posts`,
    [studioId],
  );
  return {
    spend: { usedUsd: Math.round((await apifyWeekSpendUsd(db, studioId, now)) * 100) / 100, capUsd, runs7d: runs.runs, capped7d: runs.capped },
    lastReport: rep ? { week: rep.week, at: new Date(rep.at) } : null,
    accounts: accounts.map((a) => ({ ...a, breakout: Array.isArray(a.breakout) ? a.breakout : [] })),
    outliers,
    trends: await latestTrends(db, studioId, { limit: 20 }),
    briefs,
    benchmarks,
    counts: { ...counts, niches: niches.length },
  };
}
