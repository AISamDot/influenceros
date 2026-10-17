import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { inspect } from 'node:util';
import {
  type AccountHealth,
  AI_FLAG_SPELLINGS,
  assertAiFlagOptions as assertAiFlagOptionsShared,
  assertPublishable,
  type BestTimeSlot,
  type DistributionEvent,
  type DmMessage,
  type InstagramAudio,
  type OnlineFollowersDay,
  type Platform,
  type PostMetrics,
  type PublishAccount,
  type PublishComment,
  type PublishProvider,
  PublishRefusedError,
  type PublishRequest,
  type StoryCapability,
  type StoryMetrics,
  type TikTokCommercialTrack,
} from '@ios/providers';
import { ZERNIO_STORY_SUPPORT, type ZernioExtraPlatform } from './platforms';

/**
 * Live Zernio adapter (REST) behind `PublishProvider`, conformed to the live OpenAPI spec (Zernio API 1.290.1,
 * base https://zernio.com/api, every path under /v1).
 *
 * - Every post carries the platform AI flag, always true, inside platforms[].platformSpecificData: TikTok
 *   `videoMadeWithAi` (TikTokPlatformData), Instagram `isAiGenerated` (feed, Reels, Stories, carousels), YouTube
 *   `containsSyntheticMedia`, Pinterest `isAiGenerated` (AI_MODIFIED disclosure). The flag is written last, so no
 *   platform option can override it, and an option that tries to set it to anything but true is refused.
 * - Where a post type can't carry the flag through the API it is never sent: a TikTok photo post (the business photo
 *   endpoint has no disclosure field; the studio routes stills to TikTok as a slideshow video instead) and any TikTok
 *   draft (TikTok drops every post_info field on drafts, the disclosure included). Facebook has no AI field at all
 *   (Meta-side labelling): it is mapped but off unless enabled, and verify never reports it as labelled.
 * - The post id is sent as `Idempotency-Key`: a retried publish returns the original post (200) instead of a second.
 * - The API key stays inside this object: it is only ever sent in the Authorization header, never logged.
 */
export const ZERNIO_BASE_URL = 'https://zernio.com/api/v1';

const enc = encodeURIComponent;
export const ROUTES = {
  posts: '/posts',
  post: (id: string) => `/posts/${enc(id)}`,
  accounts: '/accounts',
  accountsHealth: '/accounts/health',
  accountHealth: (accountId: string) => `/accounts/${enc(accountId)}/health`,
  profiles: '/profiles',
  usage: '/usage',
  presign: '/media/presign',
  analytics: '/analytics',
  bestTime: '/analytics/best-time',
  instagramOnlineFollowers: '/analytics/instagram/online-followers',
  instagramAudio: (accountId: string) => `/accounts/${enc(accountId)}/instagram/audio`,
  instagramAudioAsset: (accountId: string, audioId: string) => `/accounts/${enc(accountId)}/instagram/audio/${enc(audioId)}`,
  instagramStoryInsights: (accountId: string, storyId: string) => `/accounts/${enc(accountId)}/instagram/stories/${enc(storyId)}/insights`,
  tiktokCommercialMusic: (accountId: string) => `/accounts/${enc(accountId)}/tiktok/commercial-music`,
  /** GET ?accountId&limit&cursor lists a post's comments; POST { accountId, message, commentId? } replies. */
  postComments: (postId: string) => `/inbox/comments/${enc(postId)}`,
  /** POST { accountId } (Facebook, Instagram, Threads, X, TikTok for Business). */
  hideComment: (postId: string, commentId: string) => `/inbox/comments/${enc(postId)}/${enc(commentId)}/hide`,
  /** Comment-to-DM (Instagram/Facebook only, one per comment, within 7 days): body { accountId, message }. */
  privateReply: (postId: string, commentId: string) => `/inbox/comments/${enc(postId)}/${enc(commentId)}/private-reply`,
  /** GET ?accountId&platform&limit&cursor (no `since`: the adapter filters by time itself). */
  conversations: '/inbox/conversations',
  /** GET ?accountId&limit&sortOrder lists a conversation's messages; POST { accountId, message } replies in it. */
  conversationMessages: (id: string) => `/inbox/conversations/${enc(id)}/messages`,
} as const;

/** Every platform the adapter maps: the studio's own plus Facebook (off unless enabled). */
export type ZernioPlatform = Platform | ZernioExtraPlatform;
const STUDIO_PLATFORMS: readonly Platform[] = ['tiktok', 'instagram', 'youtube', 'pinterest'];
const ALL_PLATFORMS: readonly ZernioPlatform[] = [...STUDIO_PLATFORMS, 'facebook'];
/** What the adapter publishes to unless told otherwise: Facebook stays off (FACEBOOK_ROLLOUT). */
export const DEFAULT_ZERNIO_PLATFORMS: readonly ZernioPlatform[] = STUDIO_PLATFORMS;

/** A publish request that may target Facebook (the shared contract's Platform has no Facebook yet). */
export type ZernioPublishRequest = Omit<PublishRequest, 'platform'> & { readonly platform: ZernioPlatform };

/** Platforms where Zernio's private-reply route works. */
const PRIVATE_REPLY_OK: readonly ZernioPlatform[] = ['instagram', 'facebook'];

/** Zernio's name for the AI flag inside platformSpecificData; null = the platform has none (Meta-side labelling). */
export const ZERNIO_AI_FIELD: Readonly<Record<ZernioPlatform, string | null>> = {
  tiktok: 'videoMadeWithAi',
  instagram: 'isAiGenerated',
  youtube: 'containsSyntheticMedia',
  pinterest: 'isAiGenerated',
  facebook: null,
};
/** Every spelling of an AI flag a caller might pass (contract names, Zernio's camelCase and TikTok's snake_case). */
const AI_KEYS = AI_FLAG_SPELLINGS;

/** TikTok: the API keeps the video's own sound at 0 under a commercial track; the app (and the studio) uses 50. */
export const TIKTOK_ORIGINAL_SOUND_VOLUME = 50;

export class ZernioError extends Error {
  override readonly name = 'ZernioError';
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown = null,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null);
const num = (...vs: unknown[]): number => {
  for (const v of vs) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n)) return Math.max(0, Math.round(n));
  }
  return 0;
};
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const date = (v: unknown): Date => {
  const d = new Date(typeof v === 'string' || typeof v === 'number' ? v : 0);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
};
const platformOf = (v: unknown): Platform | null => (STUDIO_PLATFORMS.includes(v as Platform) ? (v as Platform) : null);
const zPlatformOf = (v: unknown): ZernioPlatform | null => (ALL_PLATFORMS.includes(v as ZernioPlatform) ? (v as ZernioPlatform) : null);

/** Refuses any platform option that would turn the AI flag off (every spelling, top level and in nested settings). */
export function assertAiFlagOptions(platform: ZernioPlatform, options: Readonly<Record<string, unknown>> | undefined): void {
  assertAiFlagOptionsShared(platform, options);
}

/** Whether `platform` has Stories through the API (Facebook Page stories via contentType 'story'). */
const zernioStorySupported = (platform: string): boolean => platform === 'facebook' || ZERNIO_STORY_SUPPORT.some((c) => c.platform === platform && c.stories);

/** Platform options with every AI-flag spelling and the nested namespaces removed (the adapter writes the flag). */
function passThrough(options: Readonly<Record<string, unknown>> | undefined): Json {
  const out: Json = { ...rec(options), ...rec(rec(options).tiktokSettings), ...rec(rec(options).platformSpecificData) };
  delete out.tiktokSettings;
  delete out.platformSpecificData;
  for (const k of AI_KEYS) delete out[k];
  // Never a draft (a TikTok draft drops the disclosure) and never a post type the adapter didn't choose.
  delete out.draft;
  delete out.contentType;
  delete out.mediaType;
  delete out.media_type;
  return out;
}
const vol = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

/** platformOptions that attach an Instagram audio-catalog track to a Reel (Facebook-Login accounts only). */
export function instagramAudioOptions(audioId: string, opts: { audioVolume?: number; videoVolume?: number } = {}): Record<string, unknown> {
  if (!/^\d{1,30}$/.test(audioId)) throw new Error('zernio: an Instagram audio id is digits only');
  return {
    audioConfiguration: {
      audioId,
      ...(opts.audioVolume !== undefined ? { audioVolume: vol(opts.audioVolume) } : {}),
      ...(opts.videoVolume !== undefined ? { videoVolume: vol(opts.videoVolume) } : {}),
    },
  };
}

/**
 * platformOptions that attach a TikTok Commercial Music Library track to a video (TikTok for Business accounts). Send the
 * track's clip id when it has one. The video's own sound defaults to 50 (TikTok's API default 0 would mute the voice).
 */
export function tiktokMusicOptions(
  musicSoundId: string,
  opts: { musicSoundVolume?: number; musicSoundStart?: number; musicSoundEnd?: number; videoOriginalSoundVolume?: number } = {},
): Record<string, unknown> {
  if (!musicSoundId) throw new Error('zernio: a TikTok music id is required');
  return {
    musicSoundInfo: {
      musicSoundId,
      musicSoundVolume: vol(opts.musicSoundVolume ?? 50),
      ...(opts.musicSoundStart !== undefined ? { musicSoundStart: Math.max(0, Math.round(opts.musicSoundStart)) } : {}),
      ...(opts.musicSoundEnd !== undefined ? { musicSoundEnd: Math.max(0, Math.round(opts.musicSoundEnd)) } : {}),
    },
    videoOriginalSoundVolume: vol(opts.videoOriginalSoundVolume ?? TIKTOK_ORIGINAL_SOUND_VOLUME),
  };
}

/**
 * The POST /posts body for one request (OpenAPI createPost). Exported for tests. `enabled` lists the platforms the
 * adapter may publish to (Facebook is off by default).
 */
export function buildPostBody(req: ZernioPublishRequest, enabled: readonly ZernioPlatform[] = DEFAULT_ZERNIO_PLATFORMS): Json {
  // The shared publish rules (also run by FakeZernio): AI label, AI-flag options, no drafts, no TikTok photo posts,
  // Stories only where the API has them. Each refusal is a PublishRefusedError (permanent, never retried).
  assertPublishable(req, { enabled, storySupported: zernioStorySupported });
  const kind = req.kind ?? 'video';
  const extra = passThrough(req.platformOptions);
  const isVideo = kind === 'video';
  const mediaItems = req.mediaUrls.map((url, i) => ({
    type: isVideo ? 'video' : 'image',
    url,
    ...((req.platform === 'youtube' || req.platform === 'facebook') && isVideo && i === 0 && req.coverUrl ? { thumbnail: req.coverUrl } : {}),
  }));
  // Stories carry no caption (Instagram and Facebook); `content` is optional when media is attached.
  const body: Json = {
    ...(kind !== 'story' && req.caption ? { content: req.caption } : {}),
    mediaItems,
    metadata: { source: 'influencer-os', idempotency_key: req.idempotencyKey ?? null },
  };
  if (req.platform !== 'tiktok' && 'musicSoundInfo' in extra) throw new PublishRefusedError('zernio: musicSoundInfo is TikTok-only');
  if (req.platform !== 'instagram' && 'audioConfiguration' in extra) throw new PublishRefusedError('zernio: audioConfiguration is Instagram-only');
  let psd: Json;
  switch (req.platform) {
    case 'tiktok': {
      // TikTok-for-Business photo posts reject videoMadeWithAi at creation; stills reach TikTok as a slideshow video.
      if (!isVideo) throw new PublishRefusedError('zernio: a TikTok photo post cannot carry the AI disclosure; send the stills as a slideshow video');
      psd = {
        privacyLevel: 'PUBLIC_TO_EVERYONE',
        allowComment: true,
        allowDuet: true,
        allowStitch: true,
        commercialContentType: 'none',
        contentPreviewConfirmed: true,
        expressConsentGiven: true,
        ...extra,
        ...(req.coverUrl ? { videoCoverImageUrl: req.coverUrl } : {}),
      };
      if (psd.musicSoundInfo !== undefined) {
        const m = rec(psd.musicSoundInfo);
        if (!str(m.musicSoundId)) throw new PublishRefusedError('zernio: musicSoundInfo needs a musicSoundId');
        psd.musicSoundInfo = { musicSoundVolume: 50, ...m };
        if (psd.videoOriginalSoundVolume === undefined) psd.videoOriginalSoundVolume = TIKTOK_ORIGINAL_SOUND_VOLUME;
      } else delete psd.videoOriginalSoundVolume;
      psd.mediaType = 'video';
      psd.videoMadeWithAi = true;
      break;
    }
    case 'instagram': {
      if ('audioConfiguration' in extra) {
        if (!isVideo) throw new PublishRefusedError('zernio: an Instagram audio track attaches to a Reel only');
        if (!str(rec(extra.audioConfiguration).audioId)) throw new PublishRefusedError('zernio: audioConfiguration needs an audioId');
      }
      psd = {
        ...extra,
        ...(req.coverUrl && isVideo ? { instagramThumbnail: req.coverUrl } : {}),
        ...(kind === 'story' ? { contentType: 'story' } : {}),
        isAiGenerated: true,
      };
      break;
    }
    case 'youtube':
      psd = { visibility: 'public', madeForKids: false, ...extra, ...(req.title ? { title: req.title.slice(0, 100) } : {}), containsSyntheticMedia: true };
      break;
    case 'pinterest':
      psd = { ...extra, ...(req.title ? { title: req.title.slice(0, 100) } : {}), ...(req.coverUrl && isVideo ? { coverImageUrl: req.coverUrl } : {}), isAiGenerated: true };
      break;
    case 'facebook':
      // No AI field in FacebookPlatformData: labelling is Meta-side (provenance metadata / Meta's own detection).
      psd = { ...extra, ...(kind === 'story' ? { contentType: 'story' } : isVideo ? { contentType: 'reel', ...(req.title ? { title: req.title.slice(0, 255) } : {}) } : {}) };
      break;
  }
  body.platforms = [{ platform: req.platform, accountId: req.accountRef, platformSpecificData: psd }];
  if (req.scheduledAt) body.scheduledFor = req.scheduledAt.toISOString();
  else body.publishNow = true;
  return body;
}

/**
 * Reads the AI flag back from a stored Zernio post: true only when the vendor echoes it as true on a post type that
 * carries it. Not echoed = unknown = false, so core's "live without the AI label" guard fires and the Owner checks the
 * post by hand (a flag silently dropped by the vendor is never recorded as labelled). A TikTok draft or photo post and
 * any Facebook post are never "labelled" through the API, whatever the echo says.
 */
export function echoedAiFlag(post: Json, platform: ZernioPlatform): boolean {
  if (platform === 'facebook') return false;
  const entry = rec(arr(post.platforms).map(rec).find((p) => p.platform === platform));
  const psd = { ...rec(platform === 'tiktok' ? post.tiktokSettings : null), ...rec(entry.platformSpecificData) };
  if (platform === 'tiktok') {
    const tt = { ...psd, ...rec(psd.tiktokSettings) };
    const media = arr(post.mediaItems).map(rec);
    const photo = tt.mediaType === 'photo' || tt.media_type === 'photo' || (media.length > 0 && media.every((m) => m.type === 'image'));
    if (tt.draft === true || photo) return false;
    return (tt.videoMadeWithAi ?? tt.video_made_with_ai) === true;
  }
  return psd[ZERNIO_AI_FIELD[platform]!] === true;
}

export interface ZernioOptions {
  apiKey: string;
  /** zernio.webhook_secret: without it, webhooks are refused and the community worker polls. */
  webhookSecret?: string | null;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Platforms this adapter publishes to (default: the studio's four; Facebook only when the Owner enables it). */
  platforms?: readonly ZernioPlatform[];
}

/** The read-only snapshot `zernio:check` prints: counts and platforms only. */
export interface ZernioSnapshot {
  accounts: number;
  accountsByPlatform: Record<string, number>;
  activeAccounts: number;
  instagramNotFacebookLogin: number;
  profiles: number;
  usage: { connectedAccounts: number | null; uploads: number | null; profiles: number | null; uploadsLimit: number | null; profilesLimit: number | null };
}

export class ZernioPublisher implements PublishProvider {
  readonly name = 'zernio';
  readonly #apiKey: string;
  readonly #webhookSecret: string | null;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #platforms: readonly ZernioPlatform[];
  /** externalId → { accountId, platform, platformPostId } (read from GET /posts/:id once). */
  readonly #targets = new Map<string, { accountId: string; platform: ZernioPlatform; platformPostId: string }>();

  constructor(opts: ZernioOptions) {
    if (!opts.apiKey) throw new Error('ZernioPublisher needs an API key');
    this.#apiKey = opts.apiKey;
    this.#webhookSecret = opts.webhookSecret || null;
    this.#base = (opts.baseUrl || ZERNIO_BASE_URL).replace(/\/+$/, '');
    if (!/^https:\/\//.test(this.#base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(this.#base)) throw new Error('ZernioPublisher: base URL must be https');
    this.#fetch = opts.fetch ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#platforms = opts.platforms ?? DEFAULT_ZERNIO_PLATFORMS;
  }

  async #call<T = Json>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, okStatuses: number[] = []): Promise<{ status: number; data: T }> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.#apiKey}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const data = (await res.json().catch(() => ({}))) as T;
    if (!res.ok && !okStatuses.includes(res.status)) {
      const d = rec(data);
      throw new ZernioError(res.status, `zernio ${method} ${path.split('?')[0]}: ${res.status} ${str(d.error) ?? str(d.message) ?? ''}`.trim(), d);
    }
    return { status: res.status, data };
  }

  #get<T = Json>(path: string, query: Record<string, string | undefined> = {}, okStatuses: number[] = []) {
    const q = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
    const qs = q.toString();
    return this.#call<T>('GET', `${path}${qs ? `?${qs}` : ''}`, undefined, {}, okStatuses);
  }

  #postId(data: Json): string {
    const post = rec(data.post);
    const id = str(post._id) ?? str(post.id) ?? str(data.postId) ?? str(data._id) ?? str(data.id) ?? str(rec(data.details).existingPostId) ?? str(data.existingPostId);
    if (!id) throw new ZernioError(502, 'zernio: response has no post id', data);
    return id;
  }

  async #create(req: ZernioPublishRequest, scheduledAt: Date | undefined) {
    const body = buildPostBody({ ...req, scheduledAt }, this.#platforms);
    const headers: Record<string, string> = req.idempotencyKey ? { 'Idempotency-Key': req.idempotencyKey.slice(0, 255) } : {};
    // 200 = idempotent retry (original post); 201 created; 207 created but the inline publish failed or partly failed;
    // 409 = content duplicate (details.existingPostId) or an idempotent retry still processing: never a second post.
    const { status, data } = await this.#call('POST', ROUTES.posts, body, headers, [409]);
    const d = rec(data);
    if (status === 409 && !str(rec(d.details).existingPostId) && !str(d.existingPostId) && !str(d.postId)) throw new ZernioError(409, 'zernio: original post still processing; retry later', d);
    return { externalId: this.#postId(d), postStatus: str(rec(d.post).status) ?? str(d.status) };
  }

  async schedule(req: PublishRequest) {
    const { externalId } = await this.#create(req, req.scheduledAt ?? new Date());
    return { externalId, status: 'scheduled' as const };
  }

  async publish(req: PublishRequest) {
    const { externalId, postStatus } = await this.#create(req, undefined);
    // 'failed' / 'partial' / 'scheduled' (transient, retried by Zernio) all read as processing: verify() decides.
    return { externalId, status: postStatus === 'published' ? ('published' as const) : ('processing' as const) };
  }

  async #getPost(externalId: string): Promise<Json> {
    const { data } = await this.#call('GET', ROUTES.post(externalId));
    const d = rec(data);
    return Object.keys(rec(d.post)).length ? rec(d.post) : d;
  }

  async verify(externalId: string) {
    const post = await this.#getPost(externalId);
    const entry = rec(arr(post.platforms)[0]);
    const platform = zPlatformOf(entry.platform) ?? 'tiktok';
    const st = (str(entry.status) ?? str(post.status) ?? '').toLowerCase();
    const url = str(entry.platformPostUrl) ?? str(post.platformPostUrl);
    const aiLabel = echoedAiFlag(post, platform);
    this.#remember(externalId, post);
    // removedFromPlatformAt: published, then deleted or taken down on the platform (status stays "published").
    if (['failed', 'error', 'rejected', 'cancelled'].includes(st) || str(entry.removedFromPlatformAt)) return { status: 'failed' as const, url: null, aiLabel };
    // Published is live even without a URL: TikTok sometimes confirms with only a publish id and Zernio's reconcile cron
    // backfills platformPostUrl later (or never). The AI flag is still checked; the URL is backfilled by pullMetrics.
    if (st === 'published') return { status: 'live' as const, url, aiLabel };
    return { status: 'processing' as const, url: null, aiLabel };
  }

  #remember(externalId: string, post: Json): void {
    const entry = rec(arr(post.platforms)[0]);
    const platform = zPlatformOf(entry.platform);
    const accountId = str(rec(entry.accountId)._id) ?? str(entry.accountId);
    const platformPostId = str(entry.platformPostId) ?? str(entry.platform_post_id);
    if (platform && accountId && platformPostId) this.#targets.set(externalId, { platform, accountId, platformPostId });
  }

  async #target(externalId: string) {
    if (!this.#targets.has(externalId)) this.#remember(externalId, await this.#getPost(externalId));
    const t = this.#targets.get(externalId);
    if (!t) throw new ZernioError(404, `zernio: post ${externalId} has no published platform post yet`);
    return t;
  }

  async listComments(externalId: string): Promise<PublishComment[]> {
    const t = await this.#target(externalId);
    const { data } = await this.#get(ROUTES.postComments(t.platformPostId), { accountId: t.accountId, limit: '100' });
    const d = rec(data);
    return arr(d.comments ?? d.data)
      .map(rec)
      .map((c) => {
        const from = rec(c.from ?? c.author);
        return {
          id: str(c.id) ?? str(c._id) ?? str(c.commentId) ?? '',
          authorRef: str(from.id) ?? str(from.username) ?? str(c.authorId) ?? str(c.username) ?? 'unknown',
          text: str(c.message) ?? str(c.text) ?? str(c.comment) ?? str(c.content) ?? '',
          at: date(c.createdTime ?? c.created_time ?? c.createdAt ?? c.timestamp),
        };
      })
      .filter((c) => c.id && c.text);
  }

  async replyToComment(req: { externalId: string; commentId: string; text: string }) {
    const t = await this.#target(req.externalId);
    // Same key + same body replays the original reply instead of posting it twice (24 h).
    const key = `reply:${req.commentId}:${createHash('sha256').update(req.text).digest('hex').slice(0, 16)}`;
    const { data } = await this.#call('POST', ROUTES.postComments(t.platformPostId), { accountId: t.accountId, commentId: req.commentId, message: req.text }, { 'Idempotency-Key': key });
    const d = rec(data);
    return { id: str(rec(d.data).commentId) ?? str(d.commentId) ?? str(d.id) ?? str(rec(d.data).id) ?? `reply:${req.commentId}` };
  }

  async hideComment(req: { externalId: string; commentId: string }) {
    const t = await this.#target(req.externalId);
    const { data } = await this.#call('POST', ROUTES.hideComment(t.platformPostId, req.commentId), { accountId: t.accountId });
    const d = rec(data);
    return { ok: d.hidden !== false && d.success !== false };
  }

  async sendDm(req: { accountRef: string; userRef: string; text: string; threadRef?: string }) {
    if (!req.threadRef) throw new ZernioError(400, 'zernio: a DM can only be sent into an existing conversation');
    const { data } = await this.#call('POST', ROUTES.conversationMessages(req.threadRef), { accountId: req.accountRef, message: req.text });
    const d = rec(data);
    return { id: str(rec(d.data).messageId) ?? str(d.messageId) ?? str(d.id) ?? str(rec(d.data).id) ?? `dm:${req.threadRef}:${Date.now()}` };
  }

  async sendPrivateReply(req: { externalId: string; commentId: string; text: string }): Promise<{ id: string | null; reason?: 'consumed' | 'expired' | 'unsupported' }> {
    const t = await this.#target(req.externalId);
    if (!PRIVATE_REPLY_OK.includes(t.platform)) return { id: null, reason: 'unsupported' };
    try {
      const { data } = await this.#call('POST', ROUTES.privateReply(t.platformPostId, req.commentId), { accountId: t.accountId, message: req.text });
      const d = rec(data);
      return { id: str(d.messageId) ?? str(rec(d.data).messageId) ?? str(d.id) ?? `pr:${req.commentId}` };
    } catch (err) {
      if (err instanceof ZernioError) {
        const b = rec(err.body);
        const details = rec(b.details);
        // The comment's one private reply is spent (400 details.privateReplyConsumed): permanent, never retried.
        if (err.status === 400 && (details.privateReplyConsumed === true || /privateReplyConsumed/i.test(JSON.stringify(b)))) return { id: null, reason: 'consumed' };
        if (err.status === 400 && /7.?day|older than|expired|window/i.test(str(b.error) ?? '')) return { id: null, reason: 'expired' };
        // 502 privateReplyOutcome "unknown": usually delivered and the reply spent; a retry would double-DM.
        if (err.status === 502 && details.privateReplyOutcome === 'unknown') return { id: null, reason: 'consumed' };
      }
      throw err;
    }
  }

  async listDms(req: { accountRef: string; since?: Date }): Promise<DmMessage[]> {
    const { data } = await this.#get(ROUTES.conversations, { accountId: req.accountRef, limit: '25' });
    const d = rec(data);
    const out: DmMessage[] = [];
    for (const conv of arr(d.data ?? d.conversations).map(rec).slice(0, 25)) {
      const convId = str(conv.id) ?? str(conv._id);
      if (!convId) continue;
      // A conversation last updated before `since` has nothing new.
      if (req.since && str(conv.updatedTime) && date(conv.updatedTime) < req.since) continue;
      const platform = platformOf(conv.platform) ?? 'instagram';
      const { data: md } = await this.#get(ROUTES.conversationMessages(convId), { accountId: req.accountRef, limit: '25', sortOrder: 'desc' });
      const participant = str(conv.participantId) ?? str(rec(conv.participant).id) ?? str(conv.userId) ?? 'unknown';
      for (const m of arr(rec(md).messages ?? rec(md).data).map(rec)) {
        const at = date(m.createdAt ?? m.sentAt ?? m.created_time ?? m.timestamp);
        if (req.since && at < req.since) continue;
        const fromId = str(m.senderId) ?? str(rec(m.from).id) ?? str(m.from);
        out.push({
          id: str(m.id) ?? str(m._id) ?? `${convId}:${at.getTime()}`,
          threadRef: convId,
          userRef: participant,
          platform,
          direction: m.direction === 'outgoing' || m.direction === 'out' || (fromId !== null && fromId === req.accountRef) || m.isFromMe === true ? 'out' : 'in',
          text: str(m.message) ?? str(m.text) ?? '',
          at,
        });
      }
    }
    return out;
  }

  async fetchMetrics(req: { externalId: string; platform: Platform }): Promise<PostMetrics> {
    // 202 = sync pending (zeros so far); 424 = the post failed on every platform (no analytics).
    const { status, data } = await this.#get(ROUTES.analytics, { postId: req.externalId, platform: req.platform }, [424]);
    if (status === 424) return { views: 0, watchTimeS: 0, likes: 0, comments: 0, saves: 0, shares: 0, follows: 0, profileVisits: 0, linkClicks: 0 };
    const a = analyticsOf(rec(data), req.platform);
    const totalMs = numOrNull(a.igReelsVideoViewTotalTime);
    return {
      views: num(a.views, a.videoViews, a.plays, a.impressions),
      // igReelsVideoViewTotalTime: total watch time in ms (Instagram/Facebook Reels, TikTok business videos).
      watchTimeS: num(totalMs !== null ? totalMs / 1000 : null, a.watchTimeSeconds, a.totalWatchTime),
      likes: num(a.likes),
      comments: num(a.comments),
      saves: num(a.saves),
      shares: num(a.shares),
      follows: num(a.follows),
      profileVisits: num(a.profileViews, a.profileVisits),
      linkClicks: num(a.clicks, a.websiteClicks, a.linkClicks),
    };
  }

  /** (IOS-5 stream L) Which platforms take Stories through Zernio (a flag per platform). */
  async storyCapabilities(): Promise<StoryCapability[]> {
    return ZERNIO_STORY_SUPPORT.map((c) => ({ ...c }));
  }

  /**
   * (IOS-5 stream L) Story frame insights. Instagram: GET /accounts/{id}/instagram/stories/{storyId}/insights (reach,
   * replies, taps forward and back, exits; live while the story runs, then Meta's final reading). Elsewhere: /analytics.
   */
  async fetchStoryMetrics(req: { externalId: string; platform: Platform }): Promise<StoryMetrics> {
    if (req.platform === 'instagram') {
      const t = await this.#target(req.externalId);
      const { data } = await this.#get(ROUTES.instagramStoryInsights(t.accountId, t.platformPostId));
      return parseStoryMetrics(rec(data));
    }
    const { data } = await this.#get(ROUTES.analytics, { postId: req.externalId, platform: req.platform });
    return parseStoryMetrics(rec(data));
  }

  async listAccounts(): Promise<PublishAccount[]> {
    const { data } = await this.#get(ROUTES.accounts);
    const d = rec(data);
    return arr(d.accounts ?? d.data)
      .map(rec)
      .map((a): PublishAccount | null => {
        const platform = platformOf(a.platform);
        const ref = str(a._id) ?? str(a.id);
        // enabled false = created as a side effect (ads first); Zernio refuses posts to it.
        if (!platform || !ref || a.enabled === false) return null;
        const loginMethod = platform === 'instagram' ? (rec(a.metadata).loginMethod === 'facebook_login' ? ('facebook_login' as const) : ('instagram_login' as const)) : null;
        // SocialAccount exposes no platform AI profile label: unknown (the Owner ticks it in Settings → Accounts).
        return { accountRef: ref, platform, handle: (str(a.username) ?? str(a.handle) ?? '').replace(/^@/, ''), aiProfileLabel: null, ...(loginMethod ? { loginMethod } : {}) };
      })
      .filter((a): a is PublishAccount => !!a && !!a.handle);
  }

  async uploadMedia(req: { filePath: string; contentType: string }) {
    const size = (await stat(req.filePath)).size;
    const { data } = await this.#call('POST', ROUTES.presign, { filename: basename(req.filePath), contentType: req.contentType, size });
    const d = rec(data);
    const uploadUrl = str(d.uploadUrl);
    const publicUrl = str(d.publicUrl);
    if (!uploadUrl || !publicUrl) throw new ZernioError(502, 'zernio: presign returned no upload URL', d);
    const bytes = await readFile(req.filePath);
    const put = await this.#fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': req.contentType }, body: bytes, signal: AbortSignal.timeout(Math.max(this.#timeoutMs, 300_000)) });
    if (!put.ok) throw new ZernioError(put.status, `zernio: media upload failed (${put.status})`);
    return { mediaUrl: publicUrl };
  }

  // ─── Read-only catalogs and insights (Sound Engine, audience-time scheduler: round 7) ───

  async searchInstagramAudio(accountRef: string, req: { audioType: 'music' | 'original_sound'; q?: string }): Promise<InstagramAudio[]> {
    const q = req.q?.trim().slice(0, 200);
    const { data } = await this.#get(ROUTES.instagramAudio(accountRef), { audioType: req.audioType, ...(q ? { q } : {}) });
    return arr(rec(data).audio).map(rec).map(toInstagramAudio).filter((a): a is InstagramAudio => !!a);
  }

  async getInstagramAudio(accountRef: string, audioId: string): Promise<InstagramAudio | null> {
    if (!/^\d{1,30}$/.test(audioId)) return null;
    const { status, data } = await this.#get(ROUTES.instagramAudioAsset(accountRef, audioId), {}, [404]);
    return status === 404 ? null : toInstagramAudio(rec(rec(data).audio));
  }

  async listTikTokCommercialMusic(accountRef: string, req: { countryCode?: string } = {}): Promise<TikTokCommercialTrack[]> {
    const cc = req.countryCode && /^[A-Za-z]{2}$/.test(req.countryCode) ? req.countryCode.toUpperCase() : undefined;
    const { data } = await this.#get(ROUTES.tiktokCommercialMusic(accountRef), { countryCode: cc });
    return arr(rec(data).tracks)
      .map(rec)
      .map((t): TikTokCommercialTrack | null => {
        const id = str(t.id);
        if (!id) return null;
        return {
          id,
          clipId: str(rec(t.clip).id),
          name: str(t.name) ?? '',
          artist: str(t.artist),
          durationS: numOrNull(t.durationSec),
          rank: numOrNull(t.rank),
          genres: arr(t.genres).filter((g): g is string => typeof g === 'string'),
          previewUrl: str(t.previewUrl),
        };
      })
      .filter((t): t is TikTokCommercialTrack => !!t);
  }

  async instagramOnlineFollowers(accountRef: string): Promise<OnlineFollowersDay[]> {
    const { data } = await this.#get(ROUTES.instagramOnlineFollowers, { accountId: accountRef });
    return arr(rec(data).days)
      .map(rec)
      .map((d) => ({
        endTime: str(d.endTime) ?? '',
        hours: Object.fromEntries(Object.entries(rec(d.hours)).filter((e): e is [string, number] => /^\d{1,2}$/.test(e[0]) && typeof e[1] === 'number')),
      }));
  }

  async bestTime(req: { platform?: Platform; accountRef?: string; profileId?: string } = {}): Promise<BestTimeSlot[]> {
    const { data } = await this.#get(ROUTES.bestTime, { platform: req.platform, accountId: req.accountRef, profileId: req.profileId });
    return arr(rec(data).slots)
      .map(rec)
      .map((s) => ({ dayOfWeek: num(s.day_of_week), hour: num(s.hour), avgEngagement: typeof s.avg_engagement === 'number' ? s.avg_engagement : 0, postCount: num(s.post_count) }))
      .filter((s) => s.dayOfWeek <= 6 && s.hour <= 23);
  }

  async accountHealth(accountRef?: string): Promise<AccountHealth[]> {
    if (accountRef) {
      const { data } = await this.#get(ROUTES.accountHealth(accountRef));
      const d = rec(data);
      const perms = rec(d.permissions);
      return [toHealth({ ...d, canPost: perms.canPost, canFetchAnalytics: perms.canFetchAnalytics, tokenValid: rec(d.tokenStatus).valid, needsReconnect: d.needsReconnect }, accountRef)];
    }
    const { data } = await this.#get(ROUTES.accountsHealth);
    return arr(rec(data).accounts).map(rec).map((a) => toHealth(a, ''));
  }

  /**
   * Read-only snapshot for `zernio:check`: GET /accounts, /profiles and /usage, reduced to counts and platforms (no
   * ids, handles, names or plan details).
   */
  async snapshot(): Promise<ZernioSnapshot> {
    const [{ data: acc }, { data: prof }, { data: use }] = await Promise.all([this.#get(ROUTES.accounts), this.#get(ROUTES.profiles), this.#get(ROUTES.usage)]);
    const accounts = arr(rec(acc).accounts).map(rec);
    const byPlatform: Record<string, number> = {};
    for (const a of accounts) {
      const p = str(a.platform) ?? 'unknown';
      byPlatform[p] = (byPlatform[p] ?? 0) + 1;
    }
    const u = rec(rec(use).usage);
    const l = rec(rec(use).limits);
    return {
      accounts: accounts.length,
      accountsByPlatform: byPlatform,
      activeAccounts: accounts.filter((a) => a.isActive === true).length,
      instagramNotFacebookLogin: accounts.filter((a) => a.platform === 'instagram' && rec(a.metadata).loginMethod !== 'facebook_login').length,
      profiles: arr(rec(prof).profiles).length,
      usage: { connectedAccounts: numOrNull(u.connectedAccounts), uploads: numOrNull(u.uploads), profiles: numOrNull(u.profiles), uploadsLimit: numOrNull(l.uploads), profilesLimit: numOrNull(l.profiles) },
    };
  }

  verifyWebhook(rawBody: string, signature: string): boolean {
    if (!this.#webhookSecret || !signature) return false;
    const expected = createHmac('sha256', this.#webhookSecret).update(rawBody).digest('hex');
    const got = signature.trim().replace(/^sha256=/i, '');
    if (!/^[0-9a-f]+$/i.test(got) || got.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(got, 'hex'));
  }

  parseWebhook(rawBody: string): DistributionEvent[] {
    const parsed = JSON.parse(rawBody) as unknown;
    return (Array.isArray(parsed) ? parsed : [parsed]).map(rec).flatMap((e) => parseZernioEvent(e));
  }

  toJSON(): string {
    return '[ZernioPublisher]';
  }
  [inspect.custom](): string {
    return '[ZernioPublisher]';
  }
}

/** The analytics block for one platform: its platformAnalytics entry when present, over the post-level roll-up. */
function analyticsOf(d: Json, platform: string): Json {
  const first = rec(arr(d.posts ?? d.data)[0]);
  const entries = arr(d.platformAnalytics ?? first.platforms).map(rec);
  const mine = entries.find((e) => e.platform === platform);
  return { ...rec(d.analytics), ...rec(first.analytics), ...rec(rec(d.post).analytics), ...rec(mine?.analytics) };
}

function toInstagramAudio(a: Json): InstagramAudio | null {
  const audioId = str(a.audioId);
  if (!audioId) return null;
  return {
    audioId,
    title: str(a.title),
    audioType: a.audioType === 'music' || a.audioType === 'original_sound' ? a.audioType : null,
    durationMs: numOrNull(a.durationInMs),
    artist: str(a.displayArtist),
    creator: str(a.igUsername),
    previewUrl: str(a.downloadUrl),
    isAdsEligible: boolOrNull(a.isAdsEligible),
  };
}

function toHealth(a: Json, fallbackRef: string): AccountHealth {
  const status = a.status === 'healthy' || a.status === 'warning' || a.status === 'error' ? a.status : 'unknown';
  return {
    accountRef: str(a.accountId) ?? fallbackRef,
    platform: str(a.platform) ?? 'unknown',
    handle: str(a.username)?.replace(/^@/, '') ?? null,
    status,
    canPost: boolOrNull(a.canPost),
    canFetchAnalytics: boolOrNull(a.canFetchAnalytics),
    tokenValid: boolOrNull(a.tokenValid),
    needsReconnect: a.needsReconnect === true,
    issues: arr(a.issues).filter((x): x is string => typeof x === 'string'),
    recommendations: arr(a.recommendations).filter((x): x is string => typeof x === 'string'),
  };
}

/**
 * Maps one Zernio webhook payload to the contract's events. The spec's payloads are flat (`{ id, event, comment, post,
 * account, timestamp }`); a `{ event, data }` envelope is read too. Unknown events are dropped.
 */
export function parseZernioEvent(e: Json): DistributionEvent[] {
  // Already in the contract's shape (tests, replays): revive the dates.
  if (!e.event && (e.type === 'comment' || e.type === 'dm' || e.type === 'post_status')) {
    if (e.type === 'comment') {
      const c = rec(e.comment);
      return str(c.id) && str(c.text) ? [{ ...(e as unknown as Extract<DistributionEvent, { type: 'comment' }>), comment: { id: str(c.id)!, authorRef: str(c.authorRef) ?? 'unknown', text: str(c.text)!, at: date(c.at) } }] : [];
    }
    if (e.type === 'dm') {
      const m = rec(e.message);
      return str(m.id) && str(m.threadRef) ? [{ ...(e as unknown as Extract<DistributionEvent, { type: 'dm' }>), message: { ...(m as unknown as DmMessage), at: date(m.at) } }] : [];
    }
    return [e as unknown as DistributionEvent];
  }
  const event = str(e.event) ?? str(e.type) ?? '';
  const d = rec(e.data ?? e.payload ?? e);
  if (event === 'comment.received' || event === 'comment') {
    const c = rec(d.comment ?? d);
    const platform = platformOf(d.platform ?? c.platform);
    const accountRef = str(rec(d.account).accountId) ?? str(rec(d.account).id) ?? str(d.accountId);
    // The Zernio post id (null for posts not published through Zernio), else the platform's post id.
    const externalPostId = str(d.postId) ?? str(rec(d.post).id) ?? str(c.postId) ?? str(d.platformPostId) ?? str(rec(d.post).platformPostId) ?? str(c.platformPostId);
    const id = str(c.id) ?? str(c.commentId);
    const text = str(c.text) ?? str(c.message);
    if (!platform || !accountRef || !externalPostId || !id || !text) return [];
    const author = rec(c.author ?? c.from);
    return [{ type: 'comment', platform, accountRef, externalPostId, comment: { id, authorRef: str(author.id) ?? str(c.authorId) ?? str(author.username) ?? 'unknown', text, at: date(c.createdAt ?? c.createdTime ?? c.timestamp) } }];
  }
  if (event === 'message.received' || event === 'dm') {
    const m = rec(d.message ?? d);
    const accountRef = str(rec(d.account).accountId) ?? str(rec(d.account).id) ?? str(d.accountId);
    const threadRef = str(m.conversationId) ?? str(d.conversationId) ?? str(rec(d.conversation).id) ?? str(m.threadRef);
    const text = str(m.text) ?? str(m.message);
    if (!accountRef || !threadRef || !text) return [];
    return [
      {
        type: 'dm',
        accountRef,
        message: {
          id: str(m.platformMessageId) ?? str(m.id) ?? str(m._id) ?? `${threadRef}:${text.length}`,
          threadRef,
          userRef: str(rec(m.sender ?? m.from).id) ?? str(m.senderId) ?? 'unknown',
          platform: platformOf(m.platform ?? d.platform) ?? 'instagram',
          direction: m.direction === 'outgoing' || m.direction === 'out' ? 'out' : 'in',
          text,
          at: date(m.sentAt ?? m.createdAt ?? m.timestamp),
        },
      },
    ];
  }
  if (event.startsWith('post.')) {
    const post = rec(d.post);
    const externalId = str(d.postId) ?? str(post.id) ?? str(post._id) ?? str(d.id);
    if (!externalId) return [];
    const entry = rec(arr(post.platforms)[0]);
    const live = event === 'post.published' || event === 'post.platform.published';
    const failed = event === 'post.failed' || event === 'post.platform.failed' || event === 'post.platform.deleted';
    return [{ type: 'post_status', externalId, status: live ? 'live' : failed ? 'failed' : 'processing', url: str(d.platformPostUrl) ?? str(post.platformPostUrl) ?? str(entry.publishedUrl) ?? str(entry.platformPostUrl) }];
  }
  return [];
}

/**
 * Story insights: Instagram's story-insights response (`{ data: { source, metrics } }`), or an analytics response
 * (Meta's names and Zernio's camelCase both read). Exported for tests.
 */
export function parseStoryMetrics(d: Json): StoryMetrics {
  const insights = rec(rec(d.data).metrics);
  const first = rec(arr(d.posts ?? d.data)[0]);
  const a = Object.keys(insights).length ? insights : { ...rec(d.analytics), ...rec(first.analytics), ...rec(rec(d.post).analytics) };
  const nav = rec(a.navigation);
  return {
    reach: num(a.reach, a.impressions, a.views),
    replies: num(a.replies, a.storyReplies),
    tapsForward: num(a.tapsForward, a.taps_forward, nav.taps_forward, nav.tapsForward),
    tapsBack: num(a.tapsBack, a.taps_back, nav.taps_back, nav.tapsBack),
    exits: num(a.exits, a.exited, nav.exited, nav.exits),
  };
}
