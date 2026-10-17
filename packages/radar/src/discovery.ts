import { OUTLIER, type ServiceBase } from '@troupe/agents';
import type { Db } from '@troupe/db';
import { normalizeIgPost, normalizeIgProfile, normalizeTikTok, normHandle, type ScrapedPost, type ScrapedProfile, tiktokAuthor } from './apify';
import { nicheKey, type RadarConfig } from './config';
import { median } from './scoring';
import { runScrape } from './scrape';
import { type AccountSource, upsertAccount, upsertPosts } from './store';

/**
 * Discovery per niche (PRD §3.15.10 "Discover"): seed hashtags, keywords and accounts from the personas, the
 * Persona Generator's drafts and the Owner's seeds; hashtag and search scrapers; related-profile expansion from seed
 * accounts; and the accounts behind outliers in the hashtag sample. Results are `tracked_account` rows (capped per
 * niche and platform) and the sampled posts as `radar_post` rows.
 */

export interface NicheScan {
  readonly niche: string;
  readonly hashtags: readonly string[];
  readonly keywords: readonly string[];
  /** '@handle' (Instagram) or 'tiktok:@handle'. */
  readonly accounts: readonly string[];
  readonly personaIds: readonly string[];
  readonly from: ReadonlyArray<'persona' | 'generator' | 'seed'>;
}

const ACTIVE_STATES = ['SETUP', 'TESTING', 'MONETISING', 'RE_ANGLE', 'SCALING', 'BRAND'];
export const tagOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** The niches to scan this week: active personas' niches first, then recent generator drafts, then Owner seeds. */
export async function nichesToScan(db: Db, studioId: string, cfg: RadarConfig, now: Date): Promise<NicheScan[]> {
  const out = new Map<string, { niche: string; hashtags: Set<string>; keywords: Set<string>; accounts: Set<string>; personaIds: Set<string>; from: Set<'persona' | 'generator' | 'seed'> }>();
  const add = (niche: string, from: 'persona' | 'generator' | 'seed', extra: { sub?: string | null; pillars?: string[]; personaId?: string } = {}) => {
    const key = nicheKey(niche);
    if (!key) return;
    const e = out.get(key) ?? { niche: key, hashtags: new Set<string>(), keywords: new Set<string>(), accounts: new Set<string>(), personaIds: new Set<string>(), from: new Set() };
    e.from.add(from);
    e.hashtags.add(tagOf(key));
    if (extra.sub) {
      e.hashtags.add(tagOf(extra.sub));
      e.keywords.add(extra.sub.toLowerCase());
    }
    e.keywords.add(key);
    e.hashtags.add(`${tagOf(key)}tips`);
    for (const p of extra.pillars ?? []) e.keywords.add(p.toLowerCase());
    if (extra.personaId) e.personaIds.add(extra.personaId);
    out.set(key, e);
  };
  const personas = await db.query<{ id: string; niche: string; sub_niche: string | null }>(
    `SELECT id, niche, sub_niche FROM persona WHERE studio_id = $1 AND state = ANY($2::text[]) ORDER BY created_at`,
    [studioId, ACTIVE_STATES],
  );
  for (const p of personas) add(p.niche, 'persona', { sub: p.sub_niche, personaId: p.id });
  const drafts = await db.query<{ state: { opportunity?: { chosen?: { niche?: string; subNiche?: string } | null; options?: Array<{ niche?: string; subNiche?: string }> } } }>(
    `SELECT state FROM persona_draft WHERE studio_id = $1 AND status = 'active' AND updated_at > $2 ORDER BY updated_at DESC LIMIT 10`,
    [studioId, new Date(now.getTime() - 21 * 86_400_000)],
  );
  for (const d of drafts) {
    const opp = d.state?.opportunity;
    const picks = opp?.chosen?.niche ? [opp.chosen] : (opp?.options ?? []).slice(0, 2);
    for (const o of picks) if (o?.niche) add(o.niche, 'generator', { sub: o.subNiche ?? null });
  }
  for (const [niche, s] of Object.entries(cfg.seeds)) {
    add(niche, 'seed');
    const e = out.get(nicheKey(niche))!;
    for (const h of s.hashtags) e.hashtags.add(tagOf(h));
    for (const k of s.keywords) e.keywords.add(k.toLowerCase());
    for (const a of s.accounts) e.accounts.add(a);
  }
  const L = cfg.limits;
  return [...out.values()].slice(0, L.nichesPerWeek).map((e) => {
    const seeds = cfg.seeds[e.niche];
    // Owner seeds go first, then the derived ones.
    const hashtags = [...new Set([...(seeds?.hashtags ?? []).map(tagOf), ...e.hashtags])].filter(Boolean).slice(0, L.hashtagsPerNiche);
    const keywords = [...new Set([...(seeds?.keywords ?? []).map((k) => k.toLowerCase()), ...e.keywords])].filter(Boolean).slice(0, L.keywordsPerNiche);
    return { niche: e.niche, hashtags, keywords, accounts: [...e.accounts], personaIds: [...e.personaIds], from: [...e.from] };
  });
}

/** '@handle' → instagram, 'tiktok:@handle' → tiktok. */
export function parseSeedAccount(s: string): { platform: 'instagram' | 'tiktok'; handle: string } | null {
  const m = /^(?:(instagram|ig|tiktok|tt):)?@?([A-Za-z0-9._]{2,40})$/.exec(s.trim());
  if (!m) return null;
  const platform = m[1] === 'tiktok' || m[1] === 'tt' ? 'tiktok' : 'instagram';
  return { platform, handle: normHandle(m[2]!) };
}

interface Candidate {
  platform: 'instagram' | 'tiktok';
  handle: string;
  source: AccountSource;
  profile: Omit<ScrapedProfile, 'recent' | 'related'> | null;
  best: number;
}
const RANK: Record<AccountSource, number> = { owner: 0, seed: 0, outlier: 1, related: 2, search: 3, hashtag: 4 };

export interface DiscoverResult {
  readonly niche: string;
  readonly runs: number;
  readonly postsSeen: number;
  readonly added: number;
  readonly tracked: number;
}

/**
 * Discovery for one niche (the scan job runs it once per niche per week). Throws ApifyWeeklyCapError when the cap is
 * reached (the caller defers); accounts and posts stored before that stay.
 */
export async function discoverNiche(services: Pick<ServiceBase, 'db' | 'providers' | 'now'>, studioId: string, scan: NicheScan, cfg: RadarConfig): Promise<DiscoverResult> {
  const { db } = services;
  const L = cfg.limits;
  const cands = new Map<string, Candidate>();
  const samplePosts: Array<{ post: ScrapedPost; followers: number | null }> = [];
  const consider = (c: Candidate) => {
    const k = `${c.platform}:${c.handle}`;
    const cur = cands.get(k);
    if (!cur) cands.set(k, c);
    else cands.set(k, { ...cur, source: RANK[c.source] < RANK[cur.source] ? c.source : cur.source, profile: cur.profile ?? c.profile, best: Math.max(cur.best, c.best) });
  };
  let runs = 0;
  const scrape = async (kind: Parameters<typeof runScrape>[1]['kind'], input: Record<string, unknown>, maxItems: number) => {
    runs += 1;
    return runScrape(services, { studioId, niche: scan.niche, kind, input, maxItems, cfg });
  };

  // Seed accounts (and related-profile expansion on Instagram).
  const seeds = scan.accounts.map(parseSeedAccount).filter((s): s is NonNullable<ReturnType<typeof parseSeedAccount>> => !!s);
  for (const s of seeds) consider({ ...s, source: 'seed', profile: null, best: 0 });
  const igSeeds = seeds.filter((s) => s.platform === 'instagram').map((s) => s.handle);
  if (L.platforms.includes('instagram') && igSeeds.length && L.relatedPerSeed > 0) {
    const items = await scrape('ig_profile', { usernames: igSeeds }, igSeeds.length);
    for (const it of items) {
      const p = normalizeIgProfile(it);
      if (!p) continue;
      consider({ platform: 'instagram', handle: p.handle, source: 'seed', profile: p, best: 0 });
      for (const r of p.related.slice(0, L.relatedPerSeed)) consider({ platform: 'instagram', handle: r, source: 'related', profile: null, best: 0 });
    }
  }

  // Hashtag scrapers (posts of every type, so stills and carousels are sampled too).
  if (scan.hashtags.length && L.platforms.includes('instagram')) {
    const items = await scrape('ig_hashtag', { hashtags: scan.hashtags, resultsLimit: L.postsPerHashtag, resultsType: 'posts' }, scan.hashtags.length * L.postsPerHashtag);
    for (const it of items) {
      const p = normalizeIgPost(it);
      if (p) samplePosts.push({ post: p, followers: null });
    }
  }
  if (scan.hashtags.length && L.platforms.includes('tiktok')) {
    const items = await scrape('tt_hashtag', { hashtags: scan.hashtags, resultsPerPage: L.postsPerHashtag }, scan.hashtags.length * L.postsPerHashtag);
    for (const it of items) {
      const p = normalizeTikTok(it);
      const a = tiktokAuthor(it);
      if (p) samplePosts.push({ post: p, followers: a?.followers ?? null });
      if (a) consider({ platform: 'tiktok', handle: a.handle, source: 'hashtag', profile: a, best: 0 });
    }
  }
  // Keyword search (Instagram users).
  if (L.platforms.includes('instagram')) {
    for (const kw of scan.keywords) {
      const items = await scrape('ig_search', { search: kw, searchType: 'user', searchLimit: L.searchResults }, L.searchResults);
      for (const it of items) {
        const p = normalizeIgProfile(it);
        if (p) consider({ platform: 'instagram', handle: p.handle, source: 'search', profile: p, best: 0 });
      }
    }
  }

  // The accounts behind outliers in the hashtag sample: well above the sample's median reach (per platform and metric).
  for (const platform of ['instagram', 'tiktok'] as const) {
    const vids = samplePosts.filter((s) => s.post.platform === platform && s.post.views !== null);
    const med = median(vids.map((s) => s.post.views!)) ?? 0;
    for (const s of samplePosts.filter((x) => x.post.platform === platform)) {
      const reach = s.post.views ?? (s.post.likes ?? 0) * 15;
      const outlier = med > 0 && s.post.views !== null && s.post.views >= OUTLIER.outlier * med;
      consider({ platform, handle: s.post.handle, source: outlier ? 'outlier' : 'hashtag', profile: null, best: reach });
    }
  }

  // Keep the best candidates up to the per-niche cap (per platform), counting accounts already tracked.
  let added = 0;
  for (const platform of L.platforms) {
    const existing = await db.query<{ handle: string }>(`SELECT handle FROM tracked_account WHERE studio_id = $1 AND niche = $2 AND platform = $3 AND status = 'active'`, [studioId, scan.niche, platform]);
    const have = new Set(existing.map((e) => e.handle));
    const room = Math.max(0, L.accountsPerNiche - have.size);
    const list = [...cands.values()]
      .filter((c) => c.platform === platform && !have.has(c.handle))
      .sort((a, b) => RANK[a.source] - RANK[b.source] || b.best - a.best || a.handle.localeCompare(b.handle))
      .slice(0, room);
    for (const c of list) {
      await upsertAccount(db, { studioId, platform, handle: c.handle, niche: scan.niche, source: c.source, profile: c.profile });
      added += 1;
    }
  }
  // Store the sampled posts (linked to their account when it is tracked).
  const ids = new Map(
    (await db.query<{ id: string; platform: string; handle: string }>(`SELECT id, platform, handle FROM tracked_account WHERE studio_id = $1 AND handle = ANY($2::text[])`, [studioId, [...new Set(samplePosts.map((s) => s.post.handle))]])).map((r) => [`${r.platform}:${r.handle}`, r.id]),
  );
  await upsertPosts(db, studioId, scan.niche, samplePosts.map((s) => ({ accountId: ids.get(`${s.post.platform}:${s.post.handle}`) ?? null, post: s.post, followers: s.followers })));
  const tracked = (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM tracked_account WHERE studio_id = $1 AND niche = $2 AND status = 'active'`, [studioId, scan.niche])).n;
  return { niche: scan.niche, runs, postsSeen: samplePosts.length, added, tracked };
}
