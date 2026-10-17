import { createHmac } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { FakeZernio, isPublishRefused, type PublishRequest } from '@troupe/providers';
import { describe, expect, it } from 'vitest';
import { buildPostBody, DEFAULT_ZERNIO_PLATFORMS, echoedAiFlag, instagramAudioOptions, liveProviders, parseZernioEvent, TIKTOK_ORIGINAL_SOUND_VOLUME, tiktokMusicOptions, ZERNIO_AI_FIELD, ZernioPublisher, type ZernioPublishRequest } from '../src';

const KEY = 'zk_test_secret_value';
/** Extracted from the Zernio OpenAPI spec by scripts/extract-zernio-spec.ts (never hand-edited). */
const SPEC = JSON.parse(readFileSync(new URL('./fixtures/zernio-spec.json', import.meta.url), 'utf8')) as {
  version: string;
  schemas: Record<string, Record<string, string>>;
  paths: string[];
};
const SCHEMA_OF = { tiktok: 'TikTokPlatformData', instagram: 'InstagramPlatformData', youtube: 'YouTubePlatformData', pinterest: 'PinterestPlatformData', facebook: 'FacebookPlatformData' } as const;
const base: PublishRequest = { accountRef: 'acc_1', platform: 'tiktok', mediaUrls: ['https://cdn.zernio.test/v.mp4'], caption: 'hello #budget', aiLabel: true, idempotencyKey: 'post-1' };

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    let body: unknown = init?.body ?? null;
    if (typeof body === 'string') body = JSON.parse(body);
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers, body });
    const r = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

describe('Zernio request mapping', () => {
  it('always sets the platform AI flag to true, last, inside platformSpecificData, so options cannot override it', () => {
    const tt = buildPostBody(base);
    const ttData = (tt.platforms as Array<{ platformSpecificData: Record<string, unknown> }>)[0]!.platformSpecificData;
    // TikTokPlatformData: camelCase videoMadeWithAi, never the old root tiktokSettings.video_made_with_ai.
    expect(ttData.videoMadeWithAi).toBe(true);
    expect(ttData).not.toHaveProperty('video_made_with_ai');
    expect(ttData).not.toHaveProperty('draft');
    expect(tt).not.toHaveProperty('tiktokSettings');
    expect(tt.publishNow).toBe(true);
    const ig = buildPostBody({ ...base, platform: 'instagram', coverUrl: 'https://cdn/c.jpg' });
    const igData = (ig.platforms as Array<{ platformSpecificData: Record<string, unknown> }>)[0]!.platformSpecificData;
    expect(igData).toMatchObject({ isAiGenerated: true, instagramThumbnail: 'https://cdn/c.jpg' });
    const yt = buildPostBody({ ...base, platform: 'youtube', title: 'T'.repeat(150) });
    const ytData = (yt.platforms as Array<{ platformSpecificData: Record<string, unknown> }>)[0]!.platformSpecificData;
    expect(ytData.containsSyntheticMedia).toBe(true);
    expect(String(ytData.title)).toHaveLength(100);
    const pin = buildPostBody({ ...base, platform: 'pinterest', kind: 'image', mediaUrls: ['https://a/p.jpg'], platformOptions: { boardId: 'b1', is_ai_generated: true } });
    const pinData = (pin.platforms as Array<{ platformSpecificData: Record<string, unknown> }>)[0]!.platformSpecificData;
    expect(pinData).toEqual({ boardId: 'b1', isAiGenerated: true });
    // Untyped callers and options that try to switch the flag off are refused, in every spelling and namespace.
    expect(() => buildPostBody({ ...base, aiLabel: false } as never)).toThrow(/AI label/);
    expect(() => buildPostBody({ ...base, platform: 'instagram', platformOptions: { isAiGenerated: false } })).toThrow(/refusing/);
    expect(() => buildPostBody({ ...base, platformOptions: { tiktokSettings: { video_made_with_ai: false } } })).toThrow(/refusing/);
    expect(() => buildPostBody({ ...base, platformOptions: { videoMadeWithAi: false } })).toThrow(/refusing/);
    expect(() => buildPostBody({ ...base, platformOptions: { platformSpecificData: { videoMadeWithAi: 0 } } })).toThrow(/refusing/);
    expect(() => buildPostBody({ ...base, platformOptions: { video_made_with_ai: 'no' } })).toThrow(/refusing/);
    expect(() => buildPostBody({ ...base, platform: 'youtube', platformOptions: { containsSyntheticMedia: false } })).toThrow(/refusing/);
    // The stored contract option (video_made_with_ai: true) passes and is rewritten to Zernio's name.
    const stored = buildPostBody({ ...base, platformOptions: { video_made_with_ai: true } });
    expect((stored.platforms as Array<{ platformSpecificData: Record<string, unknown> }>)[0]!.platformSpecificData).toMatchObject({ videoMadeWithAi: true });
  });

  it('never sends a TikTok post that cannot carry the disclosure: no photo posts, no drafts (any platform)', () => {
    expect(() => buildPostBody({ ...base, kind: 'carousel', mediaUrls: ['https://a/1.jpg', 'https://a/2.jpg'] })).toThrow(/photo post cannot carry the AI disclosure/);
    expect(() => buildPostBody({ ...base, kind: 'image', mediaUrls: ['https://a/1.jpg'] })).toThrow(/slideshow video/);
    expect(() => buildPostBody({ ...base, mode: 'draft_inbox' })).toThrow(/drafts are never sent/);
    expect(() => buildPostBody({ ...base, platform: 'instagram', mode: 'draft_inbox' })).toThrow(/drafts are never sent/);
    // A draft or photo type smuggled in through options is stripped: the adapter chooses the post type.
    const body = buildPostBody({ ...base, platformOptions: { tiktokSettings: { draft: true, media_type: 'photo' }, draft: true, mediaType: 'photo' } });
    const psd = (body.platforms as Array<{ platformSpecificData: Record<string, unknown> }>)[0]!.platformSpecificData;
    expect(psd).toMatchObject({ mediaType: 'video', videoMadeWithAi: true });
    expect(psd).not.toHaveProperty('draft');
    expect(psd).not.toHaveProperty('media_type');
  });

  it('matches the createPost shape for a TikTok video: TikTokPlatformData fields, media, scheduling', () => {
    const at = new Date('2026-11-01T10:00:00Z');
    const body = buildPostBody({ ...base, coverUrl: 'https://cdn/cover.jpg', scheduledAt: at });
    expect(body).toEqual({
      content: 'hello #budget',
      mediaItems: [{ type: 'video', url: 'https://cdn.zernio.test/v.mp4' }],
      metadata: { source: 'troupe-house', idempotency_key: 'post-1' },
      platforms: [
        {
          platform: 'tiktok',
          accountId: 'acc_1',
          platformSpecificData: {
            privacyLevel: 'PUBLIC_TO_EVERYONE',
            allowComment: true,
            allowDuet: true,
            allowStitch: true,
            commercialContentType: 'none',
            contentPreviewConfirmed: true,
            expressConsentGiven: true,
            videoCoverImageUrl: 'https://cdn/cover.jpg',
            mediaType: 'video',
            videoMadeWithAi: true,
          },
        },
      ],
      scheduledFor: '2026-11-01T10:00:00.000Z',
    });
    // Never a Zernio draft: isDraft is never sent; publishNow only when not scheduled.
    expect(body).not.toHaveProperty('isDraft');
    expect(body).not.toHaveProperty('publishNow');
  });

  it('attaches licensed sound: Instagram audioConfiguration on Reels, TikTok musicSoundInfo with the voice kept at 50', () => {
    const reel = buildPostBody({ ...base, platform: 'instagram', platformOptions: instagramAudioOptions('482851939985510', { audioVolume: 80 }) });
    expect((reel.platforms as Array<{ platformSpecificData: Record<string, unknown> }>)[0]!.platformSpecificData).toMatchObject({
      audioConfiguration: { audioId: '482851939985510', audioVolume: 80 },
      isAiGenerated: true,
    });
    expect(() => instagramAudioOptions('abc')).toThrow(/digits/);
    expect(() => buildPostBody({ ...base, platform: 'instagram', kind: 'image', mediaUrls: ['https://a/1.jpg'], platformOptions: instagramAudioOptions('1') })).toThrow(/Reel only/);
    expect(() => buildPostBody({ ...base, platform: 'instagram', kind: 'story', mediaUrls: ['https://a/1.jpg'], caption: '', platformOptions: instagramAudioOptions('1') })).toThrow(/Reel only/);
    expect(() => buildPostBody({ ...base, platformOptions: instagramAudioOptions('1') })).toThrow(/Instagram-only/);

    const tt = buildPostBody({ ...base, platformOptions: tiktokMusicOptions('clip_77') });
    const psd = (tt.platforms as Array<{ platformSpecificData: Record<string, unknown> }>)[0]!.platformSpecificData;
    expect(psd).toMatchObject({ musicSoundInfo: { musicSoundId: 'clip_77', musicSoundVolume: 50 }, videoOriginalSoundVolume: 50, videoMadeWithAi: true });
    expect(TIKTOK_ORIGINAL_SOUND_VOLUME).toBe(50);
    // A raw musicSoundInfo without the volume still keeps the video's own sound at 50 (the API default 0 mutes it).
    const raw = buildPostBody({ ...base, platformOptions: { musicSoundInfo: { musicSoundId: 'c1' } } });
    expect((raw.platforms as Array<{ platformSpecificData: Record<string, unknown> }>)[0]!.platformSpecificData).toMatchObject({ videoOriginalSoundVolume: 50, musicSoundInfo: { musicSoundId: 'c1', musicSoundVolume: 50 } });
    expect(tiktokMusicOptions('c', { videoOriginalSoundVolume: 130 }).videoOriginalSoundVolume).toBe(100);
    expect(() => buildPostBody({ ...base, platformOptions: { musicSoundInfo: {} } })).toThrow(/musicSoundId/);
    expect(() => buildPostBody({ ...base, platform: 'instagram', platformOptions: tiktokMusicOptions('c') })).toThrow(/TikTok-only/);
    // No track: no stray volume field.
    expect((buildPostBody({ ...base, platformOptions: { videoOriginalSoundVolume: 10 } }).platforms as Array<{ platformSpecificData: Record<string, unknown> }>)[0]!.platformSpecificData).not.toHaveProperty('videoOriginalSoundVolume');
  });

  it('maps Facebook (feed, Reels, Stories via contentType) but only when enabled, with no AI field (Meta-side)', () => {
    const fb: ZernioPublishRequest = { ...base, platform: 'facebook', title: 'Reel title' };
    expect(DEFAULT_ZERNIO_PLATFORMS).not.toContain('facebook');
    expect(() => buildPostBody(fb)).toThrow(/not enabled/);
    const on = [...DEFAULT_ZERNIO_PLATFORMS, 'facebook'] as const;
    const reel = buildPostBody({ ...fb, coverUrl: 'https://cdn/c.jpg' }, on);
    expect(reel.mediaItems).toEqual([{ type: 'video', url: 'https://cdn.zernio.test/v.mp4', thumbnail: 'https://cdn/c.jpg' }]);
    expect((reel.platforms as Array<{ platformSpecificData: Record<string, unknown> }>)[0]!.platformSpecificData).toEqual({ contentType: 'reel', title: 'Reel title' });
    const story = buildPostBody({ ...fb, kind: 'story', mediaUrls: ['https://a/f.png'], caption: 'ignored' }, on);
    expect(story).not.toHaveProperty('content');
    expect((story.platforms as Array<{ platformSpecificData: Record<string, unknown> }>)[0]!.platformSpecificData).toEqual({ contentType: 'story' });
    const feed = buildPostBody({ ...fb, kind: 'carousel', mediaUrls: ['https://a/1.jpg', 'https://a/2.jpg'] }, on);
    expect((feed.platforms as Array<{ platformSpecificData: Record<string, unknown> }>)[0]!.platformSpecificData).toEqual({});
    expect(ZERNIO_AI_FIELD.facebook).toBeNull();
    // Facebook is never "labelled" through the API, whatever is echoed.
    expect(echoedAiFlag({ platforms: [{ platform: 'facebook', platformSpecificData: { isAiGenerated: true } }] }, 'facebook')).toBe(false);
  });

  it('confirms every platformSpecificData key the adapter writes, and the AI field, against the spec *PlatformData schemas', () => {
    expect(SPEC.version).toMatch(/^1\.290\./);
    const on = [...DEFAULT_ZERNIO_PLATFORMS, 'facebook'] as const;
    const full = { coverUrl: 'https://cdn/c.jpg', title: 'T', scheduledAt: new Date('2026-11-01T10:00:00Z') };
    const cases: ZernioPublishRequest[] = [
      { ...base, ...full, platformOptions: tiktokMusicOptions('7123') },
      { ...base, ...full, platform: 'instagram', platformOptions: instagramAudioOptions('123') },
      { ...base, platform: 'instagram', kind: 'story', mediaUrls: ['https://a/f.png'] },
      { ...base, platform: 'instagram', kind: 'carousel', mediaUrls: ['https://a/1.jpg', 'https://a/2.jpg'] },
      { ...base, ...full, platform: 'youtube' },
      { ...base, ...full, platform: 'pinterest', platformOptions: { boardId: 'b1' } },
      { ...base, ...full, platform: 'facebook' },
      { ...base, platform: 'facebook', kind: 'story', mediaUrls: ['https://a/f.png'] },
    ];
    for (const req of cases) {
      const psd = (buildPostBody(req, on).platforms as Array<{ platformSpecificData: Record<string, unknown> }>)[0]!.platformSpecificData;
      const props = SPEC.schemas[SCHEMA_OF[req.platform]]!;
      for (const key of Object.keys(psd)) expect(props, `${req.platform}.${key} is not in ${SCHEMA_OF[req.platform]}`).toHaveProperty(key);
    }
    for (const platform of ['tiktok', 'instagram', 'youtube', 'pinterest'] as const) {
      const field = ZERNIO_AI_FIELD[platform]!;
      expect(SPEC.schemas[SCHEMA_OF[platform]]![field], `${SCHEMA_OF[platform]}.${field}`).toBe('boolean');
      const body = buildPostBody({ ...base, platform });
      expect((body.platforms as Array<{ platformSpecificData: Record<string, unknown> }>)[0]!.platformSpecificData[field]).toBe(true);
    }
    // FacebookPlatformData has no AI field in any spelling: the adapter maps none.
    expect(ZERNIO_AI_FIELD.facebook).toBeNull();
    for (const k of ['isAiGenerated', 'videoMadeWithAi', 'containsSyntheticMedia']) expect(SPEC.schemas.FacebookPlatformData).not.toHaveProperty(k);
  });

  it('refuses the same requests in fake mode as the live adapter (shared rules, permanent PublishRefusedError)', async () => {
    const bad: PublishRequest[] = [
      { ...base, aiLabel: false } as never,
      { ...base, mode: 'draft_inbox' },
      { ...base, platform: 'instagram', mode: 'draft_inbox' },
      { ...base, kind: 'carousel', mediaUrls: ['https://a/1.jpg', 'https://a/2.jpg'] },
      { ...base, kind: 'image', mediaUrls: ['https://a/1.jpg'] },
      { ...base, kind: 'story', mediaUrls: ['https://a/1.jpg'] },
      { ...base, platform: 'youtube', kind: 'story', mediaUrls: ['https://a/1.jpg'] },
      { ...base, platform: 'instagram', kind: 'story', mediaUrls: ['https://a/1.jpg', 'https://a/2.jpg'] },
      { ...base, mediaUrls: [] },
      { ...base, platformOptions: { videoMadeWithAi: false } },
      { ...base, platformOptions: { platformSpecificData: { videoMadeWithAi: 'no' } } },
      { ...base, platform: 'instagram', platformOptions: { tiktokSettings: { is_ai_generated: false } } },
      { ...base, platform: 'pinterest', platformOptions: { isAiGenerated: null } },
    ];
    for (const req of bad) {
      let live: unknown;
      try {
        buildPostBody(req);
      } catch (e) {
        live = e;
      }
      expect(isPublishRefused(live), JSON.stringify(req)).toBe(true);
      const fake = await new FakeZernio().publish(req).catch((e: unknown) => e);
      expect(isPublishRefused(fake), JSON.stringify(req)).toBe(true);
      expect((fake as Error).message).toBe((live as Error).message);
    }
    // And the fake's verify only reports the label where the post type carries it.
    const f = new FakeZernio();
    const ok = await f.publish({ ...base, platform: 'instagram', kind: 'carousel', mediaUrls: ['https://a/1.jpg', 'https://a/2.jpg'] });
    expect((await f.verify(ok.externalId)).aiLabel).toBe(true);
    expect((await f.verify((await f.publish(base)).externalId)).aiLabel).toBe(true);
  });

  it('publishes with the idempotency key, keeps the key out of URLs and bodies, and maps verify from the spec shapes', async () => {
    const { fn, calls } = fakeFetch([
      { status: 201, body: { post: { _id: 'zp_1', status: 'publishing' }, message: 'Post published successfully' } },
      {
        body: {
          post: {
            _id: 'zp_1',
            status: 'published',
            mediaItems: [{ type: 'video', url: 'https://cdn.zernio.test/v.mp4' }],
            platforms: [{ platform: 'tiktok', status: 'published', platformPostUrl: 'https://tiktok.com/@a/video/1', accountId: { _id: 'acc_1', platform: 'tiktok', username: '@a' }, platformPostId: '1', platformSpecificData: { videoMadeWithAi: true } }],
          },
        },
      },
      // Content-hash duplicate: the original id sits in details.existingPostId.
      { status: 409, body: { error: 'This exact content is already scheduled', details: { accountId: 'acc_1', platform: 'tiktok', existingPostId: 'zp_1' } } },
      // Idempotent retry: 200 with the original post.
      { status: 200, body: { post: { _id: 'zp_1', status: 'published' }, message: 'Post already exists (idempotent retry)' } },
      // Idempotency key still in flight: 409 idempotency_conflict, no id.
      { status: 409, body: { error: 'in flight', code: 'idempotency_conflict' } },
    ]);
    const z = new ZernioPublisher({ apiKey: KEY, fetch: fn });
    expect(await z.publish(base)).toEqual({ externalId: 'zp_1', status: 'processing' });
    expect(await z.verify('zp_1')).toEqual({ status: 'live', url: 'https://tiktok.com/@a/video/1', aiLabel: true });
    // A duplicate is resolved to the original post, never a second one.
    expect((await z.publish(base)).externalId).toBe('zp_1');
    expect(await z.publish(base)).toEqual({ externalId: 'zp_1', status: 'published' });
    await expect(z.publish(base)).rejects.toThrow(/still processing/);
    expect(calls[0]!.headers['Idempotency-Key']).toBe('post-1');
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
    for (const c of calls) {
      expect(c.url).not.toContain(KEY);
      expect(JSON.stringify(c.body ?? {})).not.toContain(KEY);
    }
    expect(JSON.stringify(z)).not.toContain(KEY);
    expect(calls[0]!.url).toBe('https://zernio.com/api/v1/posts');
    expect(calls[1]!.url).toBe('https://zernio.com/api/v1/posts/zp_1');
  });

  it('reads a 207 (inline publish failed) as processing, and verify reports the failure and takedowns', async () => {
    const { fn } = fakeFetch([
      { status: 207, body: { post: { _id: 'zp_f', status: 'failed', platforms: [{ platform: 'instagram', status: 'failed', errorMessage: 'nope' }] }, error: 'All platforms failed' } },
      { body: { post: { _id: 'zp_f', platforms: [{ platform: 'instagram', status: 'failed', platformSpecificData: { isAiGenerated: true } }] } } },
      { body: { post: { _id: 'zp_r', platforms: [{ platform: 'instagram', status: 'published', platformPostUrl: 'https://ig/p', removedFromPlatformAt: '2026-10-20T00:00:00Z', platformSpecificData: { isAiGenerated: true } }] } } },
    ]);
    const z = new ZernioPublisher({ apiKey: KEY, fetch: fn });
    expect(await z.publish({ ...base, platform: 'instagram' })).toEqual({ externalId: 'zp_f', status: 'processing' });
    expect(await z.verify('zp_f')).toEqual({ status: 'failed', url: null, aiLabel: true });
    expect((await z.verify('zp_r')).status).toBe('failed');
  });

  it('a published TikTok post without a platformPostUrl is live (URL backfilled later); the AI flag still decides', async () => {
    const tiktok = (psd: Record<string, unknown>) => ({
      body: { post: { _id: 'zp_t', mediaItems: [{ type: 'video' }], platforms: [{ platform: 'tiktok', status: 'published', platformPostUrl: null, platformPostId: 'pub_1', accountId: 'acc_1', platformSpecificData: psd }] } },
    });
    const { fn } = fakeFetch([tiktok({ videoMadeWithAi: true }), tiktok({}), { body: { post: { platforms: [{ platform: 'tiktok', status: 'processing', platformPostUrl: null }] } } }]);
    const z = new ZernioPublisher({ apiKey: KEY, fetch: fn });
    expect(await z.verify('zp_t')).toEqual({ status: 'live', url: null, aiLabel: true });
    // Live but unlabelled: core marks it failed (never recorded as labelled).
    expect(await z.verify('zp_t')).toEqual({ status: 'live', url: null, aiLabel: false });
    expect(await z.verify('zp_t')).toEqual({ status: 'processing', url: null, aiLabel: false });
  });

  it('reports a post the vendor echoes without the AI flag as unlabelled, and TikTok drafts or photo posts as unlabelled', async () => {
    const { fn } = fakeFetch([{ body: { post: { platforms: [{ platform: 'instagram', status: 'published', platformPostUrl: 'https://ig/p', platformSpecificData: { isAiGenerated: false } }] } } }]);
    const z = new ZernioPublisher({ apiKey: KEY, fetch: fn });
    expect((await z.verify('x')).aiLabel).toBe(false);
    const tt = (psd: Record<string, unknown>, media = [{ type: 'video' }]) => echoedAiFlag({ mediaItems: media, platforms: [{ platform: 'tiktok', platformSpecificData: psd }] }, 'tiktok');
    expect(tt({ videoMadeWithAi: true })).toBe(true);
    expect(tt({ video_made_with_ai: true })).toBe(true);
    expect(tt({ videoMadeWithAi: true, draft: true })).toBe(false);
    expect(tt({ videoMadeWithAi: true, mediaType: 'photo' })).toBe(false);
    expect(tt({ videoMadeWithAi: true }, [{ type: 'image' }, { type: 'image' }])).toBe(false);
    expect(tt({})).toBe(false);
    expect(echoedAiFlag({ platforms: [{ platform: 'youtube', platformSpecificData: { containsSyntheticMedia: true } }] }, 'youtube')).toBe(true);
    expect(echoedAiFlag({ platforms: [{ platform: 'pinterest', platformSpecificData: { isAiGenerated: true } }] }, 'pinterest')).toBe(true);
  });

  it('maps comments, replies, hides, metrics, accounts and uploads from the spec shapes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zernio-'));
    const file = join(dir, 'v.mp4');
    await writeFile(file, 'bytes');
    const { fn, calls } = fakeFetch([
      { body: { post: { platforms: [{ platform: 'instagram', accountId: { _id: 'acc_9' }, platformPostId: 'ig_77', status: 'published' }] } } },
      { body: { status: 'success', comments: [{ id: 'cm1', message: 'BUDGET', createdTime: '2026-10-20T10:00:00Z', from: { id: 'u1', username: 'jo' }, platform: 'instagram' }], pagination: { hasMore: false } } },
      { body: { success: true, data: { commentId: 'cm_reply_1', isReply: true } } },
      { body: { status: 'success', commentId: 'cm1', hidden: true, platform: 'instagram' } },
      {
        body: {
          postId: 'zp_9',
          status: 'published',
          analytics: { impressions: 3000, views: 2000, likes: 100, comments: 9, shares: 9, saves: 20, clicks: 3, follows: 4, profileViews: 30, igReelsVideoViewTotalTime: 9_000_000 },
          platformAnalytics: [
            { platform: 'tiktok', analytics: { views: 800, likes: 20 } },
            { platform: 'instagram', status: 'published', analytics: { impressions: 1500, reach: 1300, views: 1200, likes: 80, comments: 4, shares: 5, saves: 12, clicks: 2, follows: 3, profileViews: 20, igReelsVideoViewTotalTime: 9_000_000 } },
          ],
          syncStatus: 'synced',
        },
      },
      { status: 424, body: { postId: 'zp_x', status: 'failed' } },
      {
        body: {
          accounts: [
            { _id: 'acc_9', platform: 'instagram', username: '@maya.money', isActive: true, metadata: { loginMethod: 'facebook_login' } },
            { _id: 'acc_8', platform: 'instagram', username: 'old.login', isActive: true, metadata: {} },
            { _id: 'acc_7', platform: 'tiktok', username: 'maya', isActive: true, enabled: false },
            { _id: 'x', platform: 'myspace', username: 'n' },
          ],
          hasAnalyticsAccess: true,
        },
      },
      { body: { uploadUrl: 'https://upload.zernio.test/put', publicUrl: 'https://media.zernio.com/temp/v.mp4', key: 'temp/v.mp4', expiresIn: 3600 } },
      { body: {} },
    ]);
    const z = new ZernioPublisher({ apiKey: KEY, fetch: fn });
    const comments = await z.listComments('zp_9');
    expect(comments).toEqual([{ id: 'cm1', authorRef: 'u1', text: 'BUDGET', at: new Date('2026-10-20T10:00:00Z') }]);
    expect(calls[1]!.url).toBe('https://zernio.com/api/v1/inbox/comments/ig_77?accountId=acc_9&limit=100');
    expect(await z.replyToComment({ externalId: 'zp_9', commentId: 'cm1', text: 'Sent!' })).toEqual({ id: 'cm_reply_1' });
    expect(calls[2]!.body).toEqual({ accountId: 'acc_9', commentId: 'cm1', message: 'Sent!' });
    expect(calls[2]!.headers['Idempotency-Key']).toMatch(/^reply:cm1:[0-9a-f]{16}$/);
    expect(await z.hideComment({ externalId: 'zp_9', commentId: 'cm1' })).toEqual({ ok: true });
    expect(calls[3]!.url).toBe('https://zernio.com/api/v1/inbox/comments/ig_77/cm1/hide');
    expect(calls[3]!.body).toEqual({ accountId: 'acc_9' });
    // The platform's own entry wins over the cross-post roll-up; watch time comes from igReelsVideoViewTotalTime (ms).
    expect(await z.fetchMetrics({ externalId: 'zp_9', platform: 'instagram' })).toEqual({ views: 1200, watchTimeS: 9000, likes: 80, comments: 4, saves: 12, shares: 5, follows: 3, profileVisits: 20, linkClicks: 2 });
    expect(calls[4]!.url).toBe('https://zernio.com/api/v1/analytics?postId=zp_9&platform=instagram');
    expect(await z.fetchMetrics({ externalId: 'zp_x', platform: 'instagram' })).toMatchObject({ views: 0, likes: 0 });
    expect(await z.listAccounts()).toEqual([
      { accountRef: 'acc_9', platform: 'instagram', handle: 'maya.money', aiProfileLabel: null, loginMethod: 'facebook_login' },
      { accountRef: 'acc_8', platform: 'instagram', handle: 'old.login', aiProfileLabel: null, loginMethod: 'instagram_login' },
    ]);
    expect(await z.uploadMedia({ filePath: file, contentType: 'video/mp4' })).toEqual({ mediaUrl: 'https://media.zernio.com/temp/v.mp4' });
    expect(calls.at(-2)!.body).toEqual({ filename: 'v.mp4', contentType: 'video/mp4', size: 5 });
    expect(calls.at(-1)!.method).toBe('PUT');
    expect(calls.at(-1)!.headers.Authorization).toBeUndefined();
  });

  it('uses the documented inbox routes: private reply for comment-to-DM, conversation messages for thread DMs', async () => {
    const { fn, calls } = fakeFetch([
      { body: { post: { platforms: [{ platform: 'instagram', accountId: 'acc_9', platformPostId: 'ig_77', status: 'published' }] } } },
      { body: { status: 'success', messageId: 'pm_1', commentId: 'cm1', platform: 'instagram' } },
      { status: 400, body: { error: 'A private reply has already been sent to this comment.', type: 'platform_error', code: 'platform_api_error', details: { privateReplyConsumed: true } } },
      { status: 400, body: { error: 'The comment is older than 7 days. Instagram only allows private replies within 7 days.', code: 'platform_api_error' } },
      { status: 502, body: { error: 'Meta did not confirm this private reply', details: { privateReplyOutcome: 'unknown' } } },
      { body: { success: true, data: { messageId: 'm_9', conversationId: 'conv 1' } } },
      { status: 500, body: { error: 'boom' } },
    ]);
    const z = new ZernioPublisher({ apiKey: KEY, fetch: fn });
    expect(await z.sendPrivateReply({ externalId: 'zp_9', commentId: 'cm1', text: 'here' })).toEqual({ id: 'pm_1' });
    expect(calls[1]!.url).toBe('https://zernio.com/api/v1/inbox/comments/ig_77/cm1/private-reply');
    expect(calls[1]!.body).toEqual({ accountId: 'acc_9', message: 'here' });
    // Consumed (one per comment), expired (7 days) and unknown-outcome 502s are results, never retried.
    expect(await z.sendPrivateReply({ externalId: 'zp_9', commentId: 'cm1', text: 'again' })).toEqual({ id: null, reason: 'consumed' });
    expect(await z.sendPrivateReply({ externalId: 'zp_9', commentId: 'cm0', text: 'late' })).toEqual({ id: null, reason: 'expired' });
    expect(await z.sendPrivateReply({ externalId: 'zp_9', commentId: 'cm3', text: 'x' })).toEqual({ id: null, reason: 'consumed' });
    expect(await z.sendDm({ accountRef: 'acc_9', userRef: 'u1', threadRef: 'conv 1', text: 'hi' })).toEqual({ id: 'm_9' });
    expect(calls[5]!.method).toBe('POST');
    expect(calls[5]!.url).toBe('https://zernio.com/api/v1/inbox/conversations/conv%201/messages');
    expect(calls[5]!.body).toEqual({ accountId: 'acc_9', message: 'hi' });
    // No conversation → no DM (Zernio can't start one on Instagram or TikTok); other errors still throw.
    await expect(z.sendDm({ accountRef: 'acc_9', userRef: 'u1', text: 'hi' })).rejects.toThrow(/existing conversation/);
    await expect(z.sendPrivateReply({ externalId: 'zp_9', commentId: 'cm2', text: 'x' })).rejects.toThrow(/500/);
    expect(calls.some((c) => c.url.includes('/inbox/messages'))).toBe(false);
  });

  it('lists DMs from the conversations and messages shapes, newest first, with no unsupported query params', async () => {
    const { fn, calls } = fakeFetch([
      {
        body: {
          data: [
            { id: 'c1', platform: 'instagram', accountId: 'acc_9', participantId: 'u1', participantName: 'Jo', updatedTime: '2026-10-20T10:00:00Z' },
            { id: 'c2', platform: 'instagram', accountId: 'acc_9', participantId: 'u2', updatedTime: '2026-10-01T10:00:00Z' },
          ],
        },
      },
      {
        body: {
          status: 'success',
          messages: [
            { id: 'mid.2', conversationId: 'c1', accountId: 'acc_9', platform: 'instagram', message: 'thanks!', senderId: 'acc_9', direction: 'outgoing', createdAt: '2026-10-20T09:59:00Z' },
            { id: 'mid.1', conversationId: 'c1', accountId: 'acc_9', platform: 'instagram', message: 'BUDGET please', senderId: 'u1', direction: 'incoming', createdAt: '2026-10-20T09:58:00Z' },
            { id: 'mid.0', conversationId: 'c1', message: 'old', senderId: 'u1', direction: 'incoming', createdAt: '2026-10-01T09:00:00Z' },
          ],
          pagination: { hasMore: false, nextCursor: null },
          sortOrderApplied: 'desc',
        },
      },
    ]);
    const z = new ZernioPublisher({ apiKey: KEY, fetch: fn });
    const dms = await z.listDms({ accountRef: 'acc_9', since: new Date('2026-10-10T00:00:00Z') });
    expect(dms.map((m) => [m.id, m.direction, m.text, m.userRef])).toEqual([
      ['mid.2', 'out', 'thanks!', 'u1'],
      ['mid.1', 'in', 'BUDGET please', 'u1'],
    ]);
    expect(calls[0]!.url).toBe('https://zernio.com/api/v1/inbox/conversations?accountId=acc_9&limit=25');
    expect(calls[1]!.url).toBe('https://zernio.com/api/v1/inbox/conversations/c1/messages?accountId=acc_9&limit=25&sortOrder=desc');
    // c2 was last updated before `since`: its messages are not fetched.
    expect(calls).toHaveLength(2);
  });

  it('never calls private-reply on platforms without the route', async () => {
    const { fn, calls } = fakeFetch([{ body: { post: { platforms: [{ platform: 'tiktok', accountId: 'acc_1', platformPostId: 'tt_1', status: 'published' }] } } }]);
    const z = new ZernioPublisher({ apiKey: KEY, fetch: fn });
    expect(await z.sendPrivateReply({ externalId: 'zp_t', commentId: 'c', text: 'x' })).toEqual({ id: null, reason: 'unsupported' });
    expect(calls).toHaveLength(1);
  });

  it('treats an AI flag the vendor does not echo as unlabelled (unknown is never "labelled")', async () => {
    const { fn } = fakeFetch([{ body: { post: { platforms: [{ platform: 'instagram', status: 'published', platformPostUrl: 'https://ig/p', platformSpecificData: {} }] } } }]);
    const z = new ZernioPublisher({ apiKey: KEY, fetch: fn });
    expect(await z.verify('x')).toEqual({ status: 'live', url: 'https://ig/p', aiLabel: false });
  });

  it('verifies webhook signatures only with the webhook secret, and parses the spec webhook payloads', () => {
    const body = JSON.stringify({
      id: 'evt_1',
      event: 'comment.received',
      comment: { id: 'c1', postId: 'zp_9', platformPostId: 'ig_77', platform: 'instagram', text: 'BUDGET', author: { id: 'u1', username: 'jo' }, createdAt: '2026-10-20T10:00:00Z', isReply: false, parentCommentId: null },
      post: { id: 'zp_9', platformPostId: 'ig_77', content: null, imageUrl: null, permalink: null },
      account: { id: 'acc_9', accountId: 'acc_9', platform: 'instagram', username: 'maya' },
      timestamp: '2026-10-20T10:00:01Z',
    });
    const sig = createHmac('sha256', 'whsec').update(body).digest('hex');
    expect(new ZernioPublisher({ apiKey: KEY }).verifyWebhook(body, sig)).toBe(false); // no secret → polling
    const z = new ZernioPublisher({ apiKey: KEY, webhookSecret: 'whsec' });
    expect(z.verifyWebhook(body, sig)).toBe(true);
    expect(z.verifyWebhook(body, `sha256=${sig}`)).toBe(true);
    expect(z.verifyWebhook(`${body} `, sig)).toBe(false);
    expect(z.verifyWebhook(body, 'nothex')).toBe(false);
    const [e] = z.parseWebhook(body);
    expect(e).toEqual({ type: 'comment', platform: 'instagram', accountRef: 'acc_9', externalPostId: 'zp_9', comment: { id: 'c1', authorRef: 'u1', text: 'BUDGET', at: new Date('2026-10-20T10:00:00Z') } });
    // A comment on a post not published through Zernio (post.id null) keys on the platform post id.
    expect(parseZernioEvent({ event: 'comment.received', comment: { id: 'c2', postId: null, platformPostId: 'ig_99', platform: 'instagram', text: 'hi', author: { id: 'u2' } }, post: { id: null, platformPostId: 'ig_99' }, account: { id: 'acc_9' } })[0]).toMatchObject({ externalPostId: 'ig_99' });
    // The old { event, data } envelope still parses.
    expect(parseZernioEvent({ event: 'comment.received', data: { platform: 'instagram', accountId: 'acc_9', postId: 'zp_9', comment: { id: 'c1', text: 'BUDGET', from: { id: 'u1' } } } })).toHaveLength(1);
    expect(
      parseZernioEvent({
        event: 'message.received',
        message: { id: 'int_1', conversationId: 'conv_1', platform: 'instagram', platformMessageId: 'mid.9', direction: 'incoming', text: 'hello', attachments: [], sender: { id: 'u5' }, sentAt: '2026-10-20T11:00:00Z', isRead: false },
        conversation: { id: 'conv_1' },
        account: { id: 'acc_9', platform: 'instagram', username: 'maya' },
      }),
    ).toEqual([{ type: 'dm', accountRef: 'acc_9', message: { id: 'mid.9', threadRef: 'conv_1', userRef: 'u5', platform: 'instagram', direction: 'in', text: 'hello', at: new Date('2026-10-20T11:00:00Z') } }]);
    expect(
      parseZernioEvent({ event: 'post.published', post: { id: 'zp_1', content: 'x', status: 'published', scheduledFor: '2026-10-20T10:00:00Z', platforms: [{ platform: 'tiktok', status: 'published', publishedUrl: 'https://tiktok.com/@a/video/1' }] } }),
    ).toEqual([{ type: 'post_status', externalId: 'zp_1', status: 'live', url: 'https://tiktok.com/@a/video/1' }]);
    expect(parseZernioEvent({ event: 'post.platform.deleted', post: { id: 'zp_1', platforms: [] } })[0]).toMatchObject({ status: 'failed' });
    expect(parseZernioEvent({ event: 'post.published', data: { postId: 'zp_1', platformPostUrl: 'https://x' } })).toEqual([{ type: 'post_status', externalId: 'zp_1', status: 'live', url: 'https://x' }]);
    expect(parseZernioEvent({ event: 'account.connected', data: {} })).toEqual([]);
  });

  it('is the live publish member only when the zernio integration is live', () => {
    const env = (live: boolean) => ({ isLive: (id: string) => live && id === 'zernio', secret: (n: string) => (n === 'zernio.api_key' ? KEY : null) });
    expect(liveProviders(env(false))).toEqual({});
    expect(liveProviders(env(true)).publish?.name).toBe('zernio');
  });
});
