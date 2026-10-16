import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { inspect } from 'node:util';
import {
  AI_FLAG_FIELDS,
  type DistributionEvent,
  type DmMessage,
  type Platform,
  type PostMetrics,
  type PublishAccount,
  type PublishComment,
  type PublishProvider,
  type PublishRequest,
} from '@ios/providers';

/**
 * Live Zernio adapter (REST, https://docs.zernio.com) behind `PublishProvider`.
 *
 * - Every post carries the platform AI flag, always true: TikTok `video_made_with_ai`, Instagram `isAiGenerated`
 *   (Zernio's name for Meta's `is_ai_generated`), YouTube `containsSyntheticMedia`. The flag is written last, so no
 *   platform option can override it, and an option that tries to set it to anything but true is refused.
 * - The post id is sent as `Idempotency-Key`: a retried publish returns the original post instead of a second one.
 * - `mode: 'draft_inbox'` sends a TikTok draft to the creator's inbox (trending-sound posts).
 * - The API key stays inside this object: it is only ever sent in the Authorization header, never logged.
 *
 * Endpoint paths live in ROUTES. Posts, accounts, analytics and media presign follow the public docs (Oct 2026);
 * the inbox paths (comments, hide, DMs) are documented less precisely and are checked again with the first live key.
 */
export const ZERNIO_BASE_URL = 'https://zernio.com/api/v1';

export const ROUTES = {
  posts: '/posts',
  post: (id: string) => `/posts/${encodeURIComponent(id)}`,
  accounts: '/accounts',
  presign: '/media/presign',
  analytics: '/analytics',
  postComments: (platformPostId: string) => `/inbox/comments/${encodeURIComponent(platformPostId)}`,
  hideComment: (platformPostId: string, commentId: string) => `/inbox/comments/${encodeURIComponent(platformPostId)}/${encodeURIComponent(commentId)}/hide`,
  /** Comment-to-DM (Instagram/Facebook only, one per comment, within 7 days): body { accountId, message }. */
  privateReply: (platformPostId: string, commentId: string) => `/inbox/comments/${encodeURIComponent(platformPostId)}/${encodeURIComponent(commentId)}/private-reply`,
  conversations: '/inbox/conversations',
  /** GET lists a conversation's messages; POST { accountId, message } replies in it. There is no "new DM" route. */
  conversationMessages: (id: string) => `/inbox/conversations/${encodeURIComponent(id)}/messages`,
} as const;

/** Platforms where Zernio's private-reply route works (of ours). */
const PRIVATE_REPLY_OK: readonly Platform[] = ['instagram'];

/** Zernio's names for the AI flag inside platformSpecificData (TikTok's sits in tiktokSettings). */
export const ZERNIO_AI_FIELD: Readonly<Record<Platform, string>> = {
  tiktok: 'video_made_with_ai',
  instagram: 'isAiGenerated',
  youtube: 'containsSyntheticMedia',
  pinterest: 'isAiGenerated',
};

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
const date = (v: unknown): Date => {
  const d = new Date(typeof v === 'string' || typeof v === 'number' ? v : 0);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
};
const PLATFORMS: readonly Platform[] = ['tiktok', 'instagram', 'youtube', 'pinterest'];
const platformOf = (v: unknown): Platform | null => (PLATFORMS.includes(v as Platform) ? (v as Platform) : null);

/** Refuses any platform option that would turn the AI flag off (both the contract name and Zernio's). */
export function assertAiFlagOptions(platform: Platform, options: Readonly<Record<string, unknown>> | undefined): void {
  if (!options) return;
  for (const field of new Set([AI_FLAG_FIELDS[platform], ZERNIO_AI_FIELD[platform], 'is_ai_generated', 'isAiGenerated', 'video_made_with_ai', 'containsSyntheticMedia'])) {
    if (field in options && options[field] !== true) throw new Error(`zernio: refusing ${field}=${String(options[field])}; every post carries the AI flag`);
  }
  const tt = rec(options.tiktokSettings);
  if ('video_made_with_ai' in tt && tt.video_made_with_ai !== true) throw new Error('zernio: refusing tiktokSettings.video_made_with_ai=false');
}

/** The POST /posts body for one request. Exported for tests. */
export function buildPostBody(req: PublishRequest): Json {
  if (req.aiLabel !== true) throw new Error('zernio: the AI label is required on every post');
  assertAiFlagOptions(req.platform, req.platformOptions);
  if (!req.mediaUrls.length) throw new Error('zernio: a post needs media');
  const kind = req.kind ?? 'video';
  const draft = req.mode === 'draft_inbox';
  const extra: Json = { ...(req.platformOptions ?? {}) };
  delete extra.tiktokSettings;
  for (const f of [AI_FLAG_FIELDS[req.platform]]) delete extra[f];
  const mediaItems = req.mediaUrls.map((url, i) => ({
    type: kind === 'video' ? 'video' : 'image',
    url,
    ...(req.platform === 'youtube' && i === 0 && req.coverUrl ? { thumbnail: req.coverUrl } : {}),
  }));
  const body: Json = { content: req.caption, mediaItems, metadata: { source: 'influencer-os', idempotency_key: req.idempotencyKey ?? null } };
  let platformSpecificData: Json = { ...extra };
  if (req.platform === 'tiktok') {
    if (kind !== 'video' && !draft) {
      // TikTok rejects the AI flag on direct photo posts; an unlabelled post is never sent.
      throw new Error('zernio: TikTok photo posts cannot carry the AI flag unless sent as an inbox draft');
    }
    body.tiktokSettings = {
      privacy_level: 'PUBLIC_TO_EVERYONE',
      allow_comment: true,
      ...(kind === 'video' ? { allow_duet: true, allow_stitch: true } : { media_type: 'photo' }),
      content_preview_confirmed: true,
      express_consent_given: true,
      ...rec(rec(req.platformOptions).tiktokSettings),
      ...(req.coverUrl && kind === 'video' ? { video_cover_image_url: req.coverUrl } : {}),
      draft,
      video_made_with_ai: true,
    };
  } else if (req.platform === 'instagram') {
    platformSpecificData = { ...platformSpecificData, ...(req.coverUrl && kind === 'video' ? { instagramThumbnail: req.coverUrl } : {}), isAiGenerated: true };
  } else if (req.platform === 'youtube') {
    platformSpecificData = {
      visibility: 'public',
      madeForKids: false,
      ...platformSpecificData,
      ...(req.title ? { title: req.title.slice(0, 100) } : {}),
      containsSyntheticMedia: true,
    };
  } else {
    platformSpecificData = { ...platformSpecificData, isAiGenerated: true };
  }
  body.platforms = [{ platform: req.platform, accountId: req.accountRef, platformSpecificData }];
  if (req.scheduledAt && !draft) body.scheduledFor = req.scheduledAt.toISOString();
  else body.publishNow = true;
  return body;
}

/**
 * Reads the AI flag back from a stored Zernio post: true only when the vendor echoes it as true. Not echoed = unknown =
 * false, so core's "live without the AI label" guard fires and the Owner checks the post by hand (a flag silently
 * dropped by the vendor is never recorded as labelled).
 */
function echoedAiFlag(post: Json, platform: Platform): boolean {
  const entry = rec(arr(post.platforms).map(rec).find((p) => p.platform === platform));
  const psd = rec(entry.platformSpecificData);
  const tt = { ...rec(post.tiktokSettings), ...rec(psd.tiktokSettings) };
  const v = platform === 'tiktok' ? (tt.video_made_with_ai ?? tt.videoMadeWithAi ?? psd.video_made_with_ai) : psd[ZERNIO_AI_FIELD[platform]];
  return v === true;
}

export interface ZernioOptions {
  apiKey: string;
  /** zernio.webhook_secret: without it, webhooks are refused and the community worker polls. */
  webhookSecret?: string | null;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class ZernioPublisher implements PublishProvider {
  readonly name = 'zernio';
  readonly #apiKey: string;
  readonly #webhookSecret: string | null;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  /** externalId → { accountId, platform, platformPostId } (read from GET /posts/:id once). */
  readonly #targets = new Map<string, { accountId: string; platform: Platform; platformPostId: string }>();

  constructor(opts: ZernioOptions) {
    if (!opts.apiKey) throw new Error('ZernioPublisher needs an API key');
    this.#apiKey = opts.apiKey;
    this.#webhookSecret = opts.webhookSecret || null;
    this.#base = (opts.baseUrl || ZERNIO_BASE_URL).replace(/\/+$/, '');
    if (!/^https:\/\//.test(this.#base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(this.#base)) throw new Error('ZernioPublisher: base URL must be https');
    this.#fetch = opts.fetch ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
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

  #postId(data: Json): string {
    const post = rec(data.post);
    const id = str(post._id) ?? str(post.id) ?? str(data.postId) ?? str(data._id) ?? str(data.id) ?? str(data.existingPostId);
    if (!id) throw new ZernioError(502, 'zernio: response has no post id', data);
    return id;
  }

  async schedule(req: PublishRequest) {
    const body = buildPostBody({ ...req, scheduledAt: req.scheduledAt ?? new Date() });
    const headers: Record<string, string> = req.idempotencyKey ? { 'Idempotency-Key': req.idempotencyKey } : {};
    const { data } = await this.#call('POST', ROUTES.posts, body, headers, [409]);
    return { externalId: this.#postId(rec(data)), status: 'scheduled' as const };
  }

  async publish(req: PublishRequest) {
    const body = buildPostBody({ ...req, scheduledAt: undefined });
    const headers: Record<string, string> = req.idempotencyKey ? { 'Idempotency-Key': req.idempotencyKey } : {};
    // 409 = content duplicate (existingPostId) or an idempotent retry still processing: never a second post.
    const { status, data } = await this.#call('POST', ROUTES.posts, body, headers, [409]);
    const d = rec(data);
    if (status === 409 && !str(d.existingPostId) && !str(d.postId)) throw new ZernioError(409, 'zernio: original post still processing; retry later', d);
    const externalId = this.#postId(d);
    const st = str(rec(d.post).status) ?? str(d.status);
    return { externalId, status: st === 'published' && req.mode !== 'draft_inbox' ? ('published' as const) : ('processing' as const) };
  }

  async #getPost(externalId: string): Promise<Json> {
    const { data } = await this.#call('GET', ROUTES.post(externalId));
    const d = rec(data);
    return Object.keys(rec(d.post)).length ? rec(d.post) : d;
  }

  async verify(externalId: string) {
    const post = await this.#getPost(externalId);
    const entry = rec(arr(post.platforms)[0]);
    const platform = platformOf(entry.platform) ?? 'tiktok';
    const st = (str(entry.status) ?? str(post.status) ?? '').toLowerCase();
    const url = str(entry.platformPostUrl) ?? str(post.platformPostUrl);
    const aiLabel = echoedAiFlag(post, platform);
    this.#remember(externalId, post);
    if (['failed', 'error', 'rejected', 'cancelled'].includes(st)) return { status: 'failed' as const, url: null, aiLabel };
    if (st === 'published' && url) return { status: 'live' as const, url, aiLabel };
    return { status: 'processing' as const, url: null, aiLabel };
  }

  #remember(externalId: string, post: Json): void {
    const entry = rec(arr(post.platforms)[0]);
    const platform = platformOf(entry.platform);
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
    const { data } = await this.#call('GET', `${ROUTES.postComments(t.platformPostId)}?accountId=${encodeURIComponent(t.accountId)}&limit=100`);
    const d = rec(data);
    const list = arr(d.comments ?? d.data);
    return list.map(rec).map((c) => {
      const from = rec(c.from ?? c.author);
      return {
        id: str(c.id) ?? str(c._id) ?? str(c.commentId) ?? '',
        authorRef: str(from.id) ?? str(from.username) ?? str(c.authorId) ?? str(c.username) ?? 'unknown',
        text: str(c.text) ?? str(c.message) ?? str(c.comment) ?? str(c.content) ?? '',
        at: date(c.createdTime ?? c.created_time ?? c.createdAt ?? c.timestamp),
      };
    }).filter((c) => c.id && c.text);
  }

  async replyToComment(req: { externalId: string; commentId: string; text: string }) {
    const t = await this.#target(req.externalId);
    const { data } = await this.#call('POST', ROUTES.postComments(t.platformPostId), { accountId: t.accountId, commentId: req.commentId, message: req.text });
    const d = rec(data);
    return { id: str(d.id) ?? str(d.commentId) ?? str(rec(d.data).id) ?? `reply:${req.commentId}` };
  }

  async hideComment(req: { externalId: string; commentId: string }) {
    const t = await this.#target(req.externalId);
    const { data } = await this.#call('POST', ROUTES.hideComment(t.platformPostId, req.commentId), { accountId: t.accountId });
    return { ok: rec(data).success !== false };
  }

  async sendDm(req: { accountRef: string; userRef: string; text: string; threadRef?: string }) {
    if (!req.threadRef) throw new ZernioError(400, 'zernio: a DM can only be sent into an existing conversation');
    const { data } = await this.#call('POST', ROUTES.conversationMessages(req.threadRef), { accountId: req.accountRef, message: req.text });
    const d = rec(data);
    return { id: str(d.id) ?? str(d.messageId) ?? str(rec(d.data).id) ?? str(rec(d.message).id) ?? `dm:${req.threadRef}:${Date.now()}` };
  }

  async sendPrivateReply(req: { externalId: string; commentId: string; text: string }): Promise<{ id: string | null; reason?: 'consumed' | 'expired' | 'unsupported' }> {
    const t = await this.#target(req.externalId);
    if (!PRIVATE_REPLY_OK.includes(t.platform)) return { id: null, reason: 'unsupported' };
    try {
      const { data } = await this.#call('POST', ROUTES.privateReply(t.platformPostId, req.commentId), { accountId: t.accountId, message: req.text });
      const d = rec(data);
      return { id: str(d.id) ?? str(d.messageId) ?? str(rec(d.data).id) ?? `pr:${req.commentId}` };
    } catch (err) {
      // 400 privateReplyConsumed / outside the 7-day window: permanent, never retried.
      if (err instanceof ZernioError && err.status === 400) {
        const body = JSON.stringify(err.body ?? {});
        if (/privateReplyConsumed/i.test(body) || /privateReplyConsumed/i.test(err.message)) return { id: null, reason: 'consumed' };
        if (/7.?day|expired|window/i.test(body)) return { id: null, reason: 'expired' };
      }
      throw err;
    }
  }

  async listDms(req: { accountRef: string; since?: Date }): Promise<DmMessage[]> {
    const q = new URLSearchParams({ accountId: req.accountRef, limit: '25', ...(req.since ? { since: req.since.toISOString() } : {}) });
    const { data } = await this.#call('GET', `${ROUTES.conversations}?${q}`);
    const d = rec(data);
    const out: DmMessage[] = [];
    for (const conv of arr(d.conversations ?? d.data).map(rec).slice(0, 25)) {
      const convId = str(conv.id) ?? str(conv._id);
      if (!convId) continue;
      const platform = platformOf(conv.platform) ?? 'instagram';
      const { data: md } = await this.#call('GET', `${ROUTES.conversationMessages(convId)}?accountId=${encodeURIComponent(req.accountRef)}&limit=25`);
      const participant = str(rec(conv.participant).id) ?? str(conv.participantId) ?? str(conv.userId) ?? 'unknown';
      for (const m of arr(rec(md).messages ?? rec(md).data).map(rec)) {
        const at = date(m.createdAt ?? m.created_time ?? m.timestamp);
        if (req.since && at < req.since) continue;
        const fromId = str(rec(m.from).id) ?? str(m.senderId) ?? str(m.from);
        out.push({
          id: str(m.id) ?? str(m._id) ?? `${convId}:${at.getTime()}`,
          threadRef: convId,
          userRef: participant,
          platform,
          direction: m.direction === 'outgoing' || m.direction === 'out' || (fromId !== null && fromId === req.accountRef) || m.isFromMe === true ? 'out' : 'in',
          text: str(m.text) ?? str(m.message) ?? '',
          at,
        });
      }
    }
    return out;
  }

  async fetchMetrics(req: { externalId: string; platform: Platform }): Promise<PostMetrics> {
    const { data } = await this.#call('GET', `${ROUTES.analytics}?postId=${encodeURIComponent(req.externalId)}&platform=${req.platform}`);
    const d = rec(data);
    const first = rec(arr(d.posts ?? d.data)[0]);
    const a = { ...rec(d.analytics), ...rec(first.analytics), ...rec(rec(d.post).analytics) };
    return {
      views: num(a.views, a.videoViews, a.plays, a.impressions),
      watchTimeS: num(a.watchTimeSeconds, a.totalWatchTime, a.watchTime, num(a.watchTimeMinutes) * 60),
      likes: num(a.likes),
      comments: num(a.comments),
      saves: num(a.saves, a.saved, a.bookmarks),
      shares: num(a.shares),
      follows: num(a.follows, a.newFollowers, a.followsGained),
      profileVisits: num(a.profileVisits, a.profileViews),
      linkClicks: num(a.linkClicks, a.clicks, a.websiteClicks),
    };
  }

  async listAccounts(): Promise<PublishAccount[]> {
    const { data } = await this.#call('GET', ROUTES.accounts);
    const d = rec(data);
    return arr(d.accounts ?? d.data)
      .map(rec)
      .map((a) => {
        const platform = platformOf(a.platform);
        const ref = str(a._id) ?? str(a.id);
        const label = a.aiLabel ?? a.aiProfileLabel ?? a.isAiCreator;
        return platform && ref ? { accountRef: ref, platform, handle: (str(a.username) ?? str(a.handle) ?? '').replace(/^@/, ''), aiProfileLabel: typeof label === 'boolean' ? label : null } : null;
      })
      .filter((a): a is PublishAccount => !!a && !!a.handle);
  }

  async uploadMedia(req: { filePath: string; contentType: string }) {
    const { data } = await this.#call('POST', ROUTES.presign, { filename: basename(req.filePath), contentType: req.contentType });
    const d = rec(data);
    const uploadUrl = str(d.uploadUrl);
    const publicUrl = str(d.publicUrl) ?? str(d.url);
    if (!uploadUrl || !publicUrl) throw new ZernioError(502, 'zernio: presign returned no upload URL', d);
    const bytes = await readFile(req.filePath);
    const put = await this.#fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': req.contentType }, body: bytes, signal: AbortSignal.timeout(Math.max(this.#timeoutMs, 300_000)) });
    if (!put.ok) throw new ZernioError(put.status, `zernio: media upload failed (${put.status})`);
    return { mediaUrl: publicUrl };
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

/** Maps one Zernio webhook payload (`{ event, data }`) to the contract's events. Unknown events are dropped. */
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
    const accountRef = str(rec(d.account).id) ?? str(d.accountId);
    const externalPostId = str(d.postId) ?? str(rec(d.post).id) ?? str(d.platformPostId);
    const id = str(c.id) ?? str(c.commentId);
    const text = str(c.text) ?? str(c.message);
    if (!platform || !accountRef || !externalPostId || !id || !text) return [];
    return [{ type: 'comment', platform, accountRef, externalPostId, comment: { id, authorRef: str(rec(c.from ?? c.author).id) ?? str(c.authorId) ?? str(rec(c.from ?? c.author).username) ?? 'unknown', text, at: date(c.createdTime ?? c.createdAt ?? c.timestamp) } }];
  }
  if (event === 'message.received' || event === 'dm') {
    const m = rec(d.message ?? d);
    const accountRef = str(rec(d.account).id) ?? str(d.accountId);
    const threadRef = str(d.conversationId) ?? str(m.conversationId) ?? str(m.threadRef);
    const text = str(m.text) ?? str(m.message);
    if (!accountRef || !threadRef || !text) return [];
    return [
      {
        type: 'dm',
        accountRef,
        message: {
          id: str(m.id) ?? str(m._id) ?? `${threadRef}:${text.length}`,
          threadRef,
          userRef: str(rec(m.from ?? m.sender).id) ?? str(m.senderId) ?? 'unknown',
          platform: platformOf(d.platform ?? m.platform) ?? 'instagram',
          direction: m.direction === 'outgoing' || m.direction === 'out' ? 'out' : 'in',
          text,
          at: date(m.createdAt ?? m.timestamp),
        },
      },
    ];
  }
  if (event.startsWith('post.')) {
    const externalId = str(d.postId) ?? str(rec(d.post)._id) ?? str(rec(d.post).id) ?? str(d.id);
    if (!externalId) return [];
    const status = event === 'post.published' ? 'live' : event === 'post.failed' ? 'failed' : 'processing';
    return [{ type: 'post_status', externalId, status, url: str(d.platformPostUrl) ?? str(rec(d.post).platformPostUrl) }];
  }
  return [];
}
