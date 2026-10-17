import { type Db, json } from '@troupe/db';

/**
 * Radar config (table `radar_config`, one row per studio): the Apify actor ids, their pay-per-result prices (the
 * estimate meteredApify reserves is maxItems × price), per-run limits that keep scraping low-volume, and per-niche
 * seeds (hashtags, keywords, accounts) the Owner or the Studio Manager added. Defaults apply until a row exists.
 */
export const SCRAPER_KINDS = ['ig_profile', 'ig_reels', 'ig_hashtag', 'ig_search', 'tt_profile', 'tt_hashtag'] as const;
export type ScraperKind = (typeof SCRAPER_KINDS)[number];

export interface ActorConfig {
  /** Apify actor id, e.g. 'apify/instagram-profile-scraper'. */
  readonly id: string;
  /** Pay-per-result price in USD (Apify store price; an estimate, settled at the run's reported cost). */
  readonly usdPerResult: number;
}

export const DEFAULT_ACTORS: Readonly<Record<ScraperKind, ActorConfig>> = {
  ig_profile: { id: 'apify/instagram-profile-scraper', usdPerResult: 0.0026 },
  ig_reels: { id: 'apify/instagram-reel-scraper', usdPerResult: 0.0026 },
  ig_hashtag: { id: 'apify/instagram-hashtag-scraper', usdPerResult: 0.0023 },
  ig_search: { id: 'apify/instagram-search-scraper', usdPerResult: 0.0026 },
  tt_profile: { id: 'clockworks/tiktok-profile-scraper', usdPerResult: 0.004 },
  tt_hashtag: { id: 'clockworks/tiktok-hashtag-scraper', usdPerResult: 0.004 },
};

export interface RadarLimits {
  /** Platforms scanned. */
  readonly platforms: ReadonlyArray<'instagram' | 'tiktok'>;
  /** Niches scanned per week (persona niches first, then generator drafts, then Owner seeds). */
  readonly nichesPerWeek: number;
  readonly hashtagsPerNiche: number;
  readonly keywordsPerNiche: number;
  readonly postsPerHashtag: number;
  readonly searchResults: number;
  /** Related profiles kept per seed account. */
  readonly relatedPerSeed: number;
  /** Active tracked accounts per niche and platform (the rest are paused, lowest growth first). */
  readonly accountsPerNiche: number;
  /** Profiles per profile-scraper run. */
  readonly profileBatch: number;
  /** Recent posts pulled per account (the outlier baseline is the median of the last 20). */
  readonly postsPerAccount: number;
  /** High-growth accounts reviewed per niche per week. */
  readonly reviewAccounts: number;
  /** Top reels per reviewed account sent to the analysis. */
  readonly reviewPosts: number;
  /** Winner Finder shortlist size per persona. */
  readonly shortlistSize: number;
  /** Remix briefs booked per persona per week (automatic). */
  readonly remixPerWeek: number;
  /** Double-down ideas per persona per week (automatic). */
  readonly doubleDownPerWeek: number;
}

export const DEFAULT_LIMITS: RadarLimits = {
  platforms: ['instagram', 'tiktok'],
  nichesPerWeek: 6,
  hashtagsPerNiche: 3,
  keywordsPerNiche: 2,
  postsPerHashtag: 30,
  searchResults: 10,
  relatedPerSeed: 5,
  accountsPerNiche: 12,
  profileBatch: 20,
  postsPerAccount: 20,
  reviewAccounts: 4,
  reviewPosts: 8,
  shortlistSize: 10,
  remixPerWeek: 2,
  doubleDownPerWeek: 1,
};

export interface NicheSeeds {
  readonly hashtags: readonly string[];
  readonly keywords: readonly string[];
  /** '@handle' (Instagram) or 'tiktok:@handle'. */
  readonly accounts: readonly string[];
}

export interface RadarConfig {
  readonly actors: Readonly<Record<ScraperKind, ActorConfig>>;
  readonly limits: RadarLimits;
  /** Keyed by lower-cased niche. */
  readonly seeds: Readonly<Record<string, NicheSeeds>>;
}

const num = (v: unknown, d: number, min = 0, max = 10_000): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const strs = (v: unknown, max = 20): string[] =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()).slice(0, max);

export const nicheKey = (niche: string): string => niche.trim().toLowerCase().replace(/\s+/g, ' ');

/** Merges a stored row over the defaults; anything malformed falls back to the default (prices and limits clamped). */
export function resolveConfig(row: { actors?: unknown; seeds?: unknown; limits?: unknown } | null): RadarConfig {
  const a = (row?.actors && typeof row.actors === 'object' ? row.actors : {}) as Record<string, { id?: unknown; usdPerResult?: unknown }>;
  const actors = Object.fromEntries(
    SCRAPER_KINDS.map((k) => {
      const d = DEFAULT_ACTORS[k];
      const v = a[k] ?? {};
      const id = typeof v.id === 'string' && /^[\w.-]+[/~][\w.-]+$/.test(v.id.trim()) ? v.id.trim() : d.id;
      return [k, { id, usdPerResult: num(v.usdPerResult, d.usdPerResult, 0.0001, 1) }];
    }),
  ) as Record<ScraperKind, ActorConfig>;
  const l = (row?.limits && typeof row.limits === 'object' ? row.limits : {}) as Record<string, unknown>;
  const D = DEFAULT_LIMITS;
  const platforms = strs(l.platforms).filter((p): p is 'instagram' | 'tiktok' => p === 'instagram' || p === 'tiktok');
  const limits: RadarLimits = {
    platforms: platforms.length ? platforms : D.platforms,
    nichesPerWeek: num(l.nichesPerWeek, D.nichesPerWeek, 1, 30),
    hashtagsPerNiche: num(l.hashtagsPerNiche, D.hashtagsPerNiche, 0, 10),
    keywordsPerNiche: num(l.keywordsPerNiche, D.keywordsPerNiche, 0, 10),
    postsPerHashtag: num(l.postsPerHashtag, D.postsPerHashtag, 1, 100),
    searchResults: num(l.searchResults, D.searchResults, 1, 50),
    relatedPerSeed: num(l.relatedPerSeed, D.relatedPerSeed, 0, 20),
    accountsPerNiche: num(l.accountsPerNiche, D.accountsPerNiche, 1, 100),
    profileBatch: num(l.profileBatch, D.profileBatch, 1, 50),
    postsPerAccount: num(l.postsPerAccount, D.postsPerAccount, 5, 50),
    reviewAccounts: num(l.reviewAccounts, D.reviewAccounts, 0, 20),
    reviewPosts: num(l.reviewPosts, D.reviewPosts, 1, 30),
    shortlistSize: num(l.shortlistSize, D.shortlistSize, 1, 50),
    remixPerWeek: num(l.remixPerWeek, D.remixPerWeek, 0, 7),
    doubleDownPerWeek: num(l.doubleDownPerWeek, D.doubleDownPerWeek, 0, 7),
  };
  const s = (row?.seeds && typeof row.seeds === 'object' ? row.seeds : {}) as Record<string, { hashtags?: unknown; keywords?: unknown; accounts?: unknown }>;
  const seeds = Object.fromEntries(
    Object.entries(s).map(([k, v]) => [nicheKey(k), { hashtags: strs(v?.hashtags), keywords: strs(v?.keywords), accounts: strs(v?.accounts, 50) }]),
  );
  return { actors, limits, seeds };
}

export async function loadConfig(db: Db, studioId: string): Promise<RadarConfig> {
  const row = await db.maybeOne<{ actors: unknown; seeds: unknown; limits: unknown }>('SELECT actors, seeds, limits FROM radar_config WHERE studio_id = $1', [studioId]);
  return resolveConfig(row);
}

/** Adds seeds for a niche (deduplicated). Returns the niche's seeds after the change. */
export async function addSeeds(db: Db, studioId: string, niche: string, add: Partial<NicheSeeds>): Promise<NicheSeeds> {
  return db.transaction(async (tx) => {
    await tx.query(`INSERT INTO radar_config (studio_id) VALUES ($1) ON CONFLICT (studio_id) DO NOTHING`, [studioId]);
    const row = await tx.one<{ seeds: Record<string, NicheSeeds> }>('SELECT seeds FROM radar_config WHERE studio_id = $1 FOR UPDATE', [studioId]);
    const key = nicheKey(niche);
    const cur = resolveConfig({ seeds: row.seeds }).seeds[key] ?? { hashtags: [], keywords: [], accounts: [] };
    const uniq = (a: readonly string[], b: readonly string[] | undefined, max: number) => [...new Set([...a, ...(b ?? []).map((x) => x.trim()).filter(Boolean)])].slice(0, max);
    const next: NicheSeeds = {
      hashtags: uniq(cur.hashtags, add.hashtags?.map((h) => h.replace(/^#/, '').toLowerCase()), 20),
      keywords: uniq(cur.keywords, add.keywords, 20),
      accounts: uniq(cur.accounts, add.accounts, 50),
    };
    await tx.query(`UPDATE radar_config SET seeds = $2::jsonb, updated_at = now() WHERE studio_id = $1`, [studioId, json({ ...(row.seeds ?? {}), [key]: next })]);
    return next;
  });
}

/** Estimated cost of one run: maxItems × the actor's pay-per-result price. */
export const estimateUsd = (cfg: RadarConfig, kind: ScraperKind, maxItems: number): number => Math.round(maxItems * cfg.actors[kind].usdPerResult * 10_000) / 10_000;
