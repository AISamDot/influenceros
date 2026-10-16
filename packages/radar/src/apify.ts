import type { Platform } from '@ios/core';
import type { ResearchProvider } from '@ios/providers';

/**
 * Apify: the live ResearchProvider (real HTTP, `apify.token`) and the normalisers that turn the actors' dataset
 * items into our ScrapedProfile / ScrapedPost shapes. Public data only, no proxies or ban evasion: we pass no proxy
 * settings and never retry around a block. Every run is wrapped by `meteredApify` (governor + weekly cap) in
 * scrape.ts; this file never meters on its own.
 */

export interface ScrapedPost {
  readonly platform: 'instagram' | 'tiktok';
  readonly externalId: string;
  readonly url: string | null;
  readonly handle: string;
  readonly kind: 'video' | 'image' | 'carousel';
  /** Untrusted third-party text. */
  readonly caption: string | null;
  /** Untrusted third-party text (the actor's transcript, when it returns one). */
  readonly transcript: string | null;
  readonly hashtags: readonly string[];
  readonly sound: string | null;
  readonly postedAt: Date | null;
  readonly durationS: number | null;
  readonly views: number | null;
  readonly likes: number | null;
  readonly comments: number | null;
  readonly shares: number | null;
  readonly saves: number | null;
  /** The author's followers when the item carries them (TikTok authorMeta.fans). */
  readonly authorFollowers: number | null;
}

export interface ScrapedProfile {
  readonly platform: 'instagram' | 'tiktok';
  readonly handle: string;
  readonly displayName: string | null;
  /** Untrusted third-party text. */
  readonly bio: string | null;
  readonly followers: number | null;
  readonly following: number | null;
  readonly posts: number | null;
  readonly externalUrl: string | null;
  readonly related: readonly string[];
  readonly recent: readonly ScrapedPost[];
}

type R = Record<string, unknown>;
const rec = (v: unknown): R => (v && typeof v === 'object' && !Array.isArray(v) ? (v as R) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const int = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};
const dur = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};
const date = (v: unknown): Date | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v);
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(/^\d+$/.test(v) ? Number(v) * 1000 : v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
};
export const normHandle = (h: string): string => h.trim().replace(/^@+/, '').toLowerCase();
const tagsFrom = (v: unknown, caption: string | null): string[] => {
  const list = (Array.isArray(v) ? v : []).map((t) => (typeof t === 'string' ? t : str(rec(t).name))).filter((t): t is string => !!t);
  const fromCaption = caption ? [...caption.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]!) : [];
  return [...new Set([...list, ...fromCaption].map((t) => t.replace(/^#/, '').toLowerCase()))].slice(0, 30);
};

/** apify/instagram-reel-scraper, -hashtag-scraper and profile `latestPosts` items. */
export function normalizeIgPost(item: unknown): ScrapedPost | null {
  const o = rec(item);
  const handle = str(o.ownerUsername) ?? str(rec(o.owner).username);
  const externalId = str(o.shortCode) ?? str(o.id) ?? str(o.code);
  if (!handle || !externalId) return null;
  const type = (str(o.type) ?? '').toLowerCase();
  const isVideo = type === 'video' || str(o.productType) === 'clips' || o.isVideo === true || o.videoPlayCount !== undefined || o.videoViewCount !== undefined;
  const kind: ScrapedPost['kind'] = isVideo ? 'video' : type === 'sidecar' || Array.isArray(o.childPosts) ? 'carousel' : 'image';
  const caption = str(o.caption);
  const music = rec(o.musicInfo);
  const song = str(music.song_name) ?? str(music.songName);
  const artist = str(music.artist_name) ?? str(music.artistName);
  const original = music.uses_original_audio === true || music.usesOriginalAudio === true;
  const likes = int(o.likesCount);
  return {
    platform: 'instagram',
    externalId,
    url: str(o.url) ?? `https://www.instagram.com/${isVideo ? 'reel' : 'p'}/${externalId}/`,
    handle: normHandle(handle),
    kind,
    caption,
    transcript: str(o.transcript),
    hashtags: tagsFrom(o.hashtags, caption),
    sound: song ? (original ? `${artist ?? handle} · original audio` : [song, artist].filter(Boolean).join(' · ')) : null,
    postedAt: date(o.timestamp ?? o.takenAt),
    durationS: dur(o.videoDuration),
    views: isVideo ? (int(o.videoPlayCount) ?? int(o.videoViewCount)) : null,
    likes,
    comments: int(o.commentsCount),
    shares: null,
    saves: null,
    authorFollowers: null,
  };
}

/** apify/instagram-profile-scraper (and -search-scraper user results). */
export function normalizeIgProfile(item: unknown): ScrapedProfile | null {
  const o = rec(item);
  const handle = str(o.username);
  if (!handle) return null;
  const related = (Array.isArray(o.relatedProfiles) ? o.relatedProfiles : []).map((r) => str(rec(r).username)).filter((h): h is string => !!h).map(normHandle);
  const recent = (Array.isArray(o.latestPosts) ? o.latestPosts : []).map((p) => normalizeIgPost({ ownerUsername: handle, ...rec(p) })).filter((p): p is ScrapedPost => !!p);
  return {
    platform: 'instagram',
    handle: normHandle(handle),
    displayName: str(o.fullName),
    bio: str(o.biography),
    followers: int(o.followersCount),
    following: int(o.followsCount),
    posts: int(o.postsCount),
    externalUrl: str(o.externalUrl),
    related,
    recent,
  };
}

/** clockworks/tiktok-profile-scraper and -hashtag-scraper items (one video each, with authorMeta). */
export function normalizeTikTok(item: unknown): ScrapedPost | null {
  const o = rec(item);
  const author = rec(o.authorMeta);
  const handle = str(author.name) ?? str(author.uniqueId);
  const externalId = str(o.id) ?? (typeof o.id === 'number' ? String(o.id) : null);
  if (!handle || !externalId) return null;
  const caption = str(o.text);
  const music = rec(o.musicMeta);
  const musicName = str(music.musicName);
  const slideshow = o.isSlideshow === true || Array.isArray(o.slideshowImageLinks) || o.imagePost !== undefined;
  return {
    platform: 'tiktok',
    externalId,
    url: str(o.webVideoUrl) ?? `https://www.tiktok.com/@${normHandle(handle)}/video/${externalId}`,
    handle: normHandle(handle),
    kind: slideshow ? 'carousel' : 'video',
    caption,
    transcript: str(o.transcript),
    hashtags: tagsFrom(o.hashtags, caption),
    sound: musicName ? (music.musicOriginal === true ? `${handle} · original sound` : [musicName, str(music.musicAuthor)].filter(Boolean).join(' · ')) : null,
    postedAt: date(o.createTimeISO ?? o.createTime),
    durationS: dur(rec(o.videoMeta).duration),
    views: int(o.playCount),
    likes: int(o.diggCount),
    comments: int(o.commentCount),
    shares: int(o.shareCount),
    saves: int(o.collectCount),
    authorFollowers: int(author.fans),
  };
}

/** The TikTok author profile carried on a video item. */
export function tiktokAuthor(item: unknown): Omit<ScrapedProfile, 'recent'> | null {
  const a = rec(rec(item).authorMeta);
  const handle = str(a.name) ?? str(a.uniqueId);
  if (!handle) return null;
  return {
    platform: 'tiktok',
    handle: normHandle(handle),
    displayName: str(a.nickName),
    bio: str(a.signature),
    followers: int(a.fans),
    following: int(a.following),
    posts: int(a.video),
    externalUrl: str(a.bioLink) ?? str(rec(a.bioLink).link),
    related: [],
  };
}

// ───────────────────────────── Live adapter ─────────────────────────────

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export class ApifyError extends Error {
  override readonly name = 'ApifyError';
  constructor(
    message: string,
    /** What the run cost before failing (meteredApify debits it). */
    readonly costUsd?: number,
  ) {
    super(message);
  }
}

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT', 'TIMED_OUT']);

/**
 * Apify REST API v2: start the actor run (`maxItems` caps the pay-per-result spend), wait for it (long-polling
 * `waitForFinish`, ≤ 60 s per call), then read its default dataset. Reports the run's `usageTotalUsd` as `costUsd`.
 * The token travels in the Authorization header only; it is never logged or put in a URL.
 */
export class ApifyResearch implements ResearchProvider {
  readonly name = 'apify';
  private readonly fetch: FetchLike;
  private readonly base: string;
  constructor(private readonly opts: { token: string; fetch?: FetchLike; baseUrl?: string; now?: () => number }) {
    this.fetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.base = (opts.baseUrl ?? 'https://api.apify.com/v2').replace(/\/$/, '');
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json', accept: 'application/json' };
  }

  private async call(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const res = await this.fetch(`${this.base}${path}`, { method: init.method ?? 'GET', headers: this.headers(), ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApifyError(`Apify ${init.method ?? 'GET'} ${path.split('?')[0]} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  async runActor(req: { actor: string; input: Record<string, unknown>; maxItems?: number; timeoutS?: number }): Promise<{ runId: string; items: unknown[]; costUsd?: number }> {
    if (!/^[\w.-]+[/~][\w.-]+$/.test(req.actor)) throw new ApifyError(`bad actor id: ${req.actor}`);
    const actor = encodeURIComponent(req.actor.replace('/', '~'));
    const timeoutS = Math.min(900, Math.max(30, req.timeoutS ?? 300));
    const q = new URLSearchParams({ waitForFinish: '60', timeout: String(timeoutS) });
    if (req.maxItems !== undefined) q.set('maxItems', String(Math.max(1, Math.floor(req.maxItems))));
    let run = rec(rec(await this.call(`/acts/${actor}/runs?${q}`, { method: 'POST', body: req.input })).data);
    const now = this.opts.now ?? Date.now;
    const deadline = now() + (timeoutS + 60) * 1000;
    while (!TERMINAL.has(String(run.status)) && now() < deadline) {
      run = rec(rec(await this.call(`/actor-runs/${encodeURIComponent(String(run.id))}?waitForFinish=60`)).data);
    }
    const cost = typeof run.usageTotalUsd === 'number' ? run.usageTotalUsd : undefined;
    if (run.status !== 'SUCCEEDED') throw new ApifyError(`Apify run ${String(run.id)} ended ${String(run.status ?? 'unknown')}`, cost);
    const ds = str(run.defaultDatasetId);
    if (!ds) throw new ApifyError(`Apify run ${String(run.id)} has no dataset`, cost);
    const iq = new URLSearchParams({ clean: 'true', format: 'json' });
    if (req.maxItems !== undefined) iq.set('limit', String(Math.max(1, Math.floor(req.maxItems))));
    const items = await this.call(`/datasets/${encodeURIComponent(ds)}/items?${iq}`);
    return { runId: String(run.id), items: Array.isArray(items) ? items : [], costUsd: cost };
  }

  /** Top recent posts for a niche hashtag (unmetered here: callers wrap it like runActor). */
  async topPosts(req: { niche: string; platform: Platform; limit?: number }) {
    const tag = req.niche.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const limit = Math.min(50, Math.max(1, req.limit ?? 10));
    const tiktok = req.platform === 'tiktok';
    const r = await this.runActor({
      actor: tiktok ? 'clockworks/tiktok-hashtag-scraper' : 'apify/instagram-hashtag-scraper',
      input: tiktok ? { hashtags: [tag], resultsPerPage: limit } : { hashtags: [tag], resultsLimit: limit, resultsType: 'reels' },
      maxItems: limit,
    });
    return r.items
      .map((i) => (tiktok ? normalizeTikTok(i) : normalizeIgPost(i)))
      .filter((p): p is ScrapedPost => !!p && p.url !== null)
      .sort((a, b) => (b.views ?? b.likes ?? 0) - (a.views ?? a.likes ?? 0))
      .map((p) => ({
        url: p.url!,
        hook: (p.caption ?? '').split('\n')[0]!.slice(0, 120),
        format: p.kind === 'video' ? 'talking' : p.kind === 'carousel' ? 'carousel' : 'static',
        views: p.views ?? p.likes ?? 0,
        postedAt: p.postedAt ?? new Date(0),
      }));
  }
}
