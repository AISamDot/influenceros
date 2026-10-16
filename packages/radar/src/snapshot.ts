import type { ServiceBase } from '@ios/agents';
import { normalizeIgPost, normalizeIgProfile, normalizeTikTok, type ScrapedPost, tiktokAuthor } from './apify';
import type { RadarConfig } from './config';
import { median } from './scoring';
import { isoDate, runScrape, weekStartOf } from './scrape';
import { recordSnapshot, scoreAccount, upsertAccount, upsertPosts } from './store';

/**
 * The weekly track pass for one niche (PRD §3.15.10 "Track"): a profile snapshot per active account (followers,
 * posts, recent reel views) and its recent posts, then the scoring pass (outliers per post; velocity, acceleration
 * and breakouts per account). Accounts already snapshotted this week are skipped, so a deferred job resumes where it
 * stopped. Throws ApifyWeeklyCapError when the cap is reached.
 */
export async function snapshotNiche(services: Pick<ServiceBase, 'db' | 'providers' | 'now'>, studioId: string, niche: string, cfg: RadarConfig): Promise<{ snapshots: number; posts: number; accelerating: number }> {
  const { db } = services;
  const now = services.now();
  const week = isoDate(weekStartOf(now));
  const L = cfg.limits;
  const due = await db.query<{ id: string; platform: 'instagram' | 'tiktok'; handle: string }>(
    `SELECT a.id, a.platform, a.handle FROM tracked_account a
      WHERE a.studio_id = $1 AND a.niche = $2 AND a.status = 'active' AND a.platform = ANY($3::text[])
        AND NOT EXISTS (SELECT 1 FROM profile_snapshot s WHERE s.account_id = a.id AND s.week_start = $4)
      ORDER BY a.growth_score DESC NULLS LAST, a.first_seen_at`,
    [studioId, niche, [...L.platforms], week],
  );
  let snapshots = 0;
  let posts = 0;
  const touched: string[] = [];
  // An account the scraper no longer returns (private, renamed or gone) is paused, so retries don't pay for it again.
  const pauseMissing = async (ids: string[]) => {
    if (ids.length) await db.query(`UPDATE tracked_account SET status = 'paused', updated_at = now() WHERE id = ANY($1::uuid[])`, [ids]);
  };
  const byHandle = (platform: string) => new Map(due.filter((d) => d.platform === platform).map((d) => [d.handle, d.id]));

  const ig = byHandle('instagram');
  const igHandles = [...ig.keys()];
  for (let i = 0; i < igHandles.length; i += L.profileBatch) {
    const batch = igHandles.slice(i, i + L.profileBatch);
    const profiles = (await runScrape(services, { studioId, niche, kind: 'ig_profile', input: { usernames: batch }, maxItems: batch.length, cfg })).map(normalizeIgProfile);
    const reels = (await runScrape(services, { studioId, niche, kind: 'ig_reels', input: { username: batch, resultsLimit: L.postsPerAccount, includeTranscript: true }, maxItems: batch.length * L.postsPerAccount, cfg }))
      .map(normalizeIgPost)
      .filter((p): p is ScrapedPost => !!p);
    for (const p of profiles) {
      if (!p || !ig.has(p.handle)) continue;
      const id = ig.get(p.handle)!;
      await upsertAccount(db, { studioId, platform: 'instagram', handle: p.handle, niche, source: 'hashtag', profile: p });
      const mine = [...reels.filter((r) => r.handle === p.handle), ...p.recent];
      posts += await upsertPosts(db, studioId, niche, mine.map((post) => ({ accountId: id, post, followers: p.followers })));
      if (p.followers !== null) {
        const views = reels.filter((r) => r.handle === p.handle && r.views !== null).map((r) => r.views!);
        await recordSnapshot(db, { studioId, accountId: id, now, followers: p.followers, following: p.following, posts: p.posts, medianReelViews: median(views), reelsSampled: views.length });
        snapshots += 1;
      }
      touched.push(id);
    }
    await pauseMissing(batch.filter((h) => !profiles.some((p) => p?.handle === h)).map((h) => ig.get(h)!));
  }

  const tt = byHandle('tiktok');
  const ttHandles = [...tt.keys()];
  for (let i = 0; i < ttHandles.length; i += L.profileBatch) {
    const batch = ttHandles.slice(i, i + L.profileBatch);
    const items = await runScrape(services, { studioId, niche, kind: 'tt_profile', input: { profiles: batch, resultsPerPage: L.postsPerAccount }, maxItems: batch.length * L.postsPerAccount, cfg });
    const grouped = new Map<string, { author: ReturnType<typeof tiktokAuthor>; posts: ScrapedPost[] }>();
    for (const it of items) {
      const a = tiktokAuthor(it);
      const p = normalizeTikTok(it);
      if (!a || !tt.has(a.handle)) continue;
      const g = grouped.get(a.handle) ?? { author: a, posts: [] };
      if (p) g.posts.push(p);
      grouped.set(a.handle, g);
    }
    for (const [handle, g] of grouped) {
      const id = tt.get(handle)!;
      await upsertAccount(db, { studioId, platform: 'tiktok', handle, niche, source: 'hashtag', profile: g.author });
      posts += await upsertPosts(db, studioId, niche, g.posts.map((post) => ({ accountId: id, post, followers: g.author?.followers ?? null })));
      if (g.author?.followers !== null && g.author?.followers !== undefined) {
        const views = g.posts.filter((p) => p.views !== null).map((p) => p.views!);
        await recordSnapshot(db, { studioId, accountId: id, now, followers: g.author.followers, following: g.author.following, posts: g.author.posts, medianReelViews: median(views), reelsSampled: views.length });
        snapshots += 1;
      }
      touched.push(id);
    }
    await pauseMissing(batch.filter((h) => !grouped.has(h)).map((h) => tt.get(h)!));
  }

  let accelerating = 0;
  for (const id of touched) if ((await scoreAccount(db, id, now)).accelerating) accelerating += 1;
  return { snapshots, posts, accelerating };
}
