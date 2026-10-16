import { apifyWeekSpendUsd } from '@ios/agents';
import { addMessage, findThread, getSettings, notify, type PostFormat } from '@ios/core';
import { type Db, json } from '@ios/db';
import { FORMAT_LABEL, formatBenchmarks, latestTrends, safeLabel } from './insights';
import { isoDate, weekStartOf } from './scrape';

/**
 * The weekly Trend Report (PRD §3.15.10 "Feed back"): one Studio-chat message per studio per week from the Trend
 * Scout (meta.kind 'trend_report', marked untrusted because it quotes short scraped tags and sound names), plus an
 * Owner notification linking to /radar. Our words and numbers only; never a caption.
 */

export interface RadarSummary {
  week: string;
  niches: string[];
  tracked: number;
  accelerating: number;
  strongOutliers: number;
  trends: Array<{ niche: string; label: string; adopters: number; avg_outlier: number; score: number }>;
  growing: Array<{ platform: string; handle: string; niche: string; followers: number | null; velocity: number | null; growth_score: number | null; breakout: string[] }>;
  formats: Array<{ niche: string; top: Array<{ format: PostFormat; share: number; lift: number | null }>; postsPerWeek: number | null; confidence: string }>;
  remix: { booked: number; blocked: number; doubleDowns: number };
  apify: { spentUsd: number; capUsd: number };
}

export async function radarSummary(db: Db, studioId: string, now: Date): Promise<RadarSummary> {
  const week = isoDate(weekStartOf(now));
  const niches = (await db.query<{ niche: string }>(`SELECT DISTINCT niche FROM tracked_account WHERE studio_id = $1 AND status = 'active' ORDER BY niche`, [studioId])).map((r) => r.niche);
  const counts = await db.one<{ tracked: number; accel: number }>(
    `SELECT count(*)::int AS tracked, count(*) FILTER (WHERE accelerating)::int AS accel FROM tracked_account WHERE studio_id = $1 AND status = 'active'`,
    [studioId],
  );
  const strong = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM radar_post WHERE studio_id = $1 AND tier = 'strong' AND posted_at > $2`, [studioId, new Date(now.getTime() - 14 * 86_400_000)]);
  const trends = (await latestTrends(db, studioId, { limit: 8 })).map((t) => ({ niche: t.niche, label: t.label, adopters: t.adopters, avg_outlier: t.avg_outlier, score: t.score }));
  const growing = await db.query<RadarSummary['growing'][number]>(
    `SELECT platform, handle, niche, followers, velocity::float8 AS velocity, growth_score::float8 AS growth_score, breakout FROM tracked_account
      WHERE studio_id = $1 AND status = 'active' AND accelerating ORDER BY growth_score DESC NULLS LAST LIMIT 8`,
    [studioId],
  );
  const formats: RadarSummary['formats'] = [];
  for (const niche of niches) {
    const b = await formatBenchmarks(db, studioId, niche, now);
    if (!b) continue;
    const top = (Object.entries(b.formatShare) as Array<[PostFormat, number]>)
      .sort((a, c) => c[1] - a[1])
      .slice(0, 4)
      .map(([format, share]) => ({ format, share, lift: b.formatLift[format] ?? null }));
    formats.push({ niche, top, postsPerWeek: b.postsPerWeek, confidence: b.confidence });
  }
  const remix = await db.one<{ booked: number; blocked: number; dd: number }>(
    `SELECT count(*) FILTER (WHERE kind = 'remix' AND status = 'booked')::int AS booked, count(*) FILTER (WHERE status = 'blocked_repeat')::int AS blocked,
            count(*) FILTER (WHERE kind = 'double_down' AND status = 'booked')::int AS dd
       FROM remix_brief WHERE studio_id = $1 AND week_start = $2`,
    [studioId, week],
  );
  const capUsd = (await getSettings(db, studioId)).apify_weekly_cap_usd;
  return {
    week,
    niches,
    tracked: counts.tracked,
    accelerating: counts.accel,
    strongOutliers: strong.n,
    trends,
    growing: growing.map((g) => ({ ...g, breakout: Array.isArray(g.breakout) ? g.breakout : [] })),
    formats,
    remix: { booked: remix.booked, blocked: remix.blocked, doubleDowns: remix.dd },
    apify: { spentUsd: Math.round((await apifyWeekSpendUsd(db, studioId, now)) * 100) / 100, capUsd },
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function reportText(s: RadarSummary): string {
  const lines: string[] = [`**Weekly Trend Report** (week of ${s.week})`];
  lines.push(`Tracking ${s.tracked} public accounts across ${s.niches.length} niche${s.niches.length === 1 ? '' : 's'}; ${s.accelerating} are accelerating. ${s.strongOutliers} strong outliers (≥ 10×) in the last 14 days.`);
  if (s.trends.length) {
    lines.push('', '**Trends** (adopted by several accelerating accounts in 14 days):');
    for (const t of s.trends.slice(0, 5)) lines.push(`- ${t.niche}: ${safeLabel(t.label)}, ${t.adopters} accounts, avg ${t.avg_outlier.toFixed(1)}× their median`);
  } else lines.push('', 'No trend has crossed two accelerating accounts yet.');
  if (s.formats.length) {
    lines.push('', '**What breaks out, by format** (share of the niche’s winners):');
    for (const f of s.formats) {
      const mix = f.top.map((x) => `${FORMAT_LABEL[x.format]} ${pct(x.share)}${x.lift !== null ? ` (${x.lift}×)` : ''}`).join(', ');
      lines.push(`- ${f.niche}: ${mix}${f.postsPerWeek !== null ? `; fast growers post ~${f.postsPerWeek}/week` : ''} (${f.confidence} confidence)`);
    }
  }
  if (s.growing.length) {
    lines.push('', '**Growing accounts**:');
    for (const g of s.growing.slice(0, 5)) lines.push(`- @${safeLabel(g.handle)} (${g.platform}, ${g.niche}): ${g.followers ?? '?'} followers${g.velocity !== null ? `, +${Math.round(g.velocity)}/week` : ''}${g.breakout.length ? `, ${g.breakout.join(', ').replace(/_/g, ' ')}` : ''}`);
  }
  lines.push('', `**Viral Remix**: ${s.remix.booked} remix brief${s.remix.booked === 1 ? '' : 's'} and ${s.remix.doubleDowns} double-down${s.remix.doubleDowns === 1 ? '' : 's'} booked into calendars this week${s.remix.blocked ? `; ${s.remix.blocked} blocked as too close to past content` : ''}.`);
  lines.push(`Apify spend: $${s.apify.spentUsd.toFixed(2)} of the $${s.apify.capUsd.toFixed(2)} weekly cap.${s.apify.spentUsd >= s.apify.capUsd * 0.9 ? ' The cap is nearly used: I can propose raising it, but only you can change it.' : ''}`);
  return lines.join('\n');
}

/** Posts this week's report once (idempotent per studio and week). Returns the message id, or null when it already exists. */
export async function postTrendReport(db: Db, studioId: string, now: Date): Promise<string | null> {
  const week = isoDate(weekStartOf(now));
  if (await db.maybeOne('SELECT 1 FROM radar_report WHERE studio_id = $1 AND week_start = $2', [studioId, week])) return null;
  const summary = await radarSummary(db, studioId, now);
  if (!summary.tracked) return null;
  const thread = await findThread(db, studioId, 'studio');
  // Claim the week first, so two workers never post the same report twice.
  const posted = await db.transaction(async (tx) => {
    const row = await tx.maybeOne<{ id: string }>(
      `INSERT INTO radar_report (studio_id, week_start, summary) VALUES ($1, $2, $3::jsonb) ON CONFLICT (studio_id, week_start) DO NOTHING RETURNING id`,
      [studioId, week, json(summary)],
    );
    if (!row) return null;
    const msg = await addMessage(tx, { threadId: thread.id, role: 'agent', author: 'agent:trend-scout', body: reportText(summary), meta: { kind: 'trend_report', week, untrusted: true, link: '/radar' }, at: now });
    await tx.query('UPDATE radar_report SET message_id = $2 WHERE id = $1', [row.id, msg.id]);
    return msg.id;
  });
  if (!posted) return null;
  await notify(db, { studioId, kind: 'digest', title: 'Weekly Trend Report', body: `${summary.accelerating} accelerating accounts, ${summary.trends.length} trends, ${summary.remix.booked} remix briefs booked.`, link: '/radar' });
  return posted;
}
