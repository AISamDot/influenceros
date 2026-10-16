import { createHmac } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PublishRequest } from '@ios/providers';
import { describe, expect, it } from 'vitest';
import { buildPostBody, liveProviders, parseZernioEvent, ZernioPublisher } from '../src';

const KEY = 'zk_test_secret_value';
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
  it('always sets the platform AI flag to true, last, so options cannot override it', () => {
    const tt = buildPostBody(base);
    expect((tt.tiktokSettings as Record<string, unknown>).video_made_with_ai).toBe(true);
    expect((tt.tiktokSettings as Record<string, unknown>).draft).toBe(false);
    expect(tt.publishNow).toBe(true);
    const ig = buildPostBody({ ...base, platform: 'instagram', coverUrl: 'https://cdn/c.jpg' });
    const igData = (ig.platforms as Array<{ platformSpecificData: Record<string, unknown> }>)[0]!.platformSpecificData;
    expect(igData).toMatchObject({ isAiGenerated: true, instagramThumbnail: 'https://cdn/c.jpg' });
    const yt = buildPostBody({ ...base, platform: 'youtube', title: 'T'.repeat(150) });
    const ytData = (yt.platforms as Array<{ platformSpecificData: Record<string, unknown> }>)[0]!.platformSpecificData;
    expect(ytData.containsSyntheticMedia).toBe(true);
    expect(String(ytData.title)).toHaveLength(100);
    // Untyped callers and options that try to switch the flag off are refused.
    expect(() => buildPostBody({ ...base, aiLabel: false } as never)).toThrow(/AI label/);
    expect(() => buildPostBody({ ...base, platform: 'instagram', platformOptions: { isAiGenerated: false } })).toThrow(/refusing/);
    expect(() => buildPostBody({ ...base, platformOptions: { tiktokSettings: { video_made_with_ai: false } } })).toThrow(/refusing/);
    expect(() => buildPostBody({ ...base, platformOptions: { video_made_with_ai: 'no' } })).toThrow(/refusing/);
  });

  it('sends TikTok drafts to the inbox, and refuses unlabelled TikTok photo posts', () => {
    const draft = buildPostBody({ ...base, mode: 'draft_inbox' });
    expect(draft.tiktokSettings).toMatchObject({ draft: true, video_made_with_ai: true });
    expect(() => buildPostBody({ ...base, kind: 'carousel', mediaUrls: ['https://a/1.jpg', 'https://a/2.jpg'] })).toThrow(/photo/);
  });

  it('publishes with the idempotency key, keeps the key out of URLs and bodies, and maps verify', async () => {
    const { fn, calls } = fakeFetch([
      { status: 201, body: { post: { _id: 'zp_1', status: 'publishing' } } },
      { body: { post: { _id: 'zp_1', platforms: [{ platform: 'tiktok', status: 'published', platformPostUrl: 'https://tiktok.com/@a/video/1', accountId: 'acc_1', platformPostId: '1', platformSpecificData: {} }], tiktokSettings: { video_made_with_ai: true } } } },
      { status: 409, body: { existingPostId: 'zp_1' } },
    ]);
    const z = new ZernioPublisher({ apiKey: KEY, fetch: fn });
    expect(await z.publish(base)).toEqual({ externalId: 'zp_1', status: 'processing' });
    expect(await z.verify('zp_1')).toEqual({ status: 'live', url: 'https://tiktok.com/@a/video/1', aiLabel: true });
    // A duplicate is resolved to the original post, never a second one.
    expect((await z.publish(base)).externalId).toBe('zp_1');
    expect(calls[0]!.headers['Idempotency-Key']).toBe('post-1');
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
    for (const c of calls) {
      expect(c.url).not.toContain(KEY);
      expect(JSON.stringify(c.body ?? {})).not.toContain(KEY);
    }
    expect(JSON.stringify(z)).not.toContain(KEY);
    expect(calls[0]!.url).toBe('https://zernio.com/api/v1/posts');
  });

  it('reports a post the vendor echoes without the AI flag as unlabelled', async () => {
    const { fn } = fakeFetch([{ body: { post: { platforms: [{ platform: 'instagram', status: 'published', platformPostUrl: 'https://ig/p', platformSpecificData: { isAiGenerated: false } }] } } }]);
    const z = new ZernioPublisher({ apiKey: KEY, fetch: fn });
    expect((await z.verify('x')).aiLabel).toBe(false);
  });

  it('maps comments, hides, metrics, accounts and uploads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zernio-'));
    const file = join(dir, 'v.mp4');
    await writeFile(file, 'bytes');
    const { fn, calls } = fakeFetch([
      { body: { post: { platforms: [{ platform: 'instagram', accountId: 'acc_9', platformPostId: 'ig_77', status: 'published' }] } } },
      { body: { comments: [{ id: 'cm1', from: { id: 'u1' }, text: 'BUDGET', createdTime: '2026-10-20T10:00:00Z' }] } },
      { body: { success: true } },
      { body: { analytics: { views: 1200, likes: 80, saves: 12, shares: 5, comments: 4, watchTimeSeconds: 9000, newFollowers: 3, profileVisits: 20, linkClicks: 2 } } },
      { body: { accounts: [{ _id: 'acc_9', platform: 'instagram', username: '@maya.money', aiLabel: true }, { _id: 'x', platform: 'myspace', username: 'n' }] } },
      { body: { uploadUrl: 'https://upload.zernio.test/put', publicUrl: 'https://cdn.zernio.test/v.mp4' } },
      { body: {} },
    ]);
    const z = new ZernioPublisher({ apiKey: KEY, fetch: fn });
    const comments = await z.listComments('zp_9');
    expect(comments).toEqual([{ id: 'cm1', authorRef: 'u1', text: 'BUDGET', at: new Date('2026-10-20T10:00:00Z') }]);
    expect(await z.hideComment({ externalId: 'zp_9', commentId: 'cm1' })).toEqual({ ok: true });
    expect(calls[2]!.url).toContain('/inbox/comments/ig_77/cm1/hide');
    expect(await z.fetchMetrics({ externalId: 'zp_9', platform: 'instagram' })).toEqual({ views: 1200, watchTimeS: 9000, likes: 80, comments: 4, saves: 12, shares: 5, follows: 3, profileVisits: 20, linkClicks: 2 });
    expect(await z.listAccounts()).toEqual([{ accountRef: 'acc_9', platform: 'instagram', handle: 'maya.money', aiProfileLabel: true }]);
    expect(await z.uploadMedia({ filePath: file, contentType: 'video/mp4' })).toEqual({ mediaUrl: 'https://cdn.zernio.test/v.mp4' });
    expect(calls.at(-1)!.method).toBe('PUT');
    expect(calls.at(-1)!.headers.Authorization).toBeUndefined();
  });

  it('uses the documented inbox routes: private reply for comment-to-DM, conversation messages for thread DMs', async () => {
    const { fn, calls } = fakeFetch([
      { body: { post: { platforms: [{ platform: 'instagram', accountId: 'acc_9', platformPostId: 'ig_77', status: 'published' }] } } },
      { body: { id: 'pm_1' } },
      { status: 400, body: { error: 'Private reply already sent', code: 'privateReplyConsumed' } },
      { body: { messageId: 'm_9' } },
      { status: 500, body: { error: 'boom' } },
    ]);
    const z = new ZernioPublisher({ apiKey: KEY, fetch: fn });
    expect(await z.sendPrivateReply({ externalId: 'zp_9', commentId: 'cm1', text: 'here' })).toEqual({ id: 'pm_1' });
    expect(calls[1]!.url).toBe('https://zernio.com/api/v1/inbox/comments/ig_77/cm1/private-reply');
    expect(calls[1]!.body).toEqual({ accountId: 'acc_9', message: 'here' });
    // Consumed (one per comment) is a result, not an error: callers never retry it.
    expect(await z.sendPrivateReply({ externalId: 'zp_9', commentId: 'cm1', text: 'again' })).toEqual({ id: null, reason: 'consumed' });
    expect(await z.sendDm({ accountRef: 'acc_9', userRef: 'u1', threadRef: 'conv 1', text: 'hi' })).toEqual({ id: 'm_9' });
    expect(calls[3]!.method).toBe('POST');
    expect(calls[3]!.url).toBe('https://zernio.com/api/v1/inbox/conversations/conv%201/messages');
    expect(calls[3]!.body).toEqual({ accountId: 'acc_9', message: 'hi' });
    // No conversation → no DM (Zernio can't start one on Instagram or TikTok); other errors still throw.
    await expect(z.sendDm({ accountRef: 'acc_9', userRef: 'u1', text: 'hi' })).rejects.toThrow(/existing conversation/);
    await expect(z.sendPrivateReply({ externalId: 'zp_9', commentId: 'cm2', text: 'x' })).rejects.toThrow(/500/);
    expect(calls.some((c) => c.url.includes('/inbox/messages'))).toBe(false);
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

  it('verifies webhook signatures only with the webhook secret, and parses Zernio events', () => {
    const body = JSON.stringify({ event: 'comment.received', data: { platform: 'instagram', accountId: 'acc_9', postId: 'zp_9', comment: { id: 'c1', text: 'BUDGET', from: { id: 'u1' } } } });
    const sig = createHmac('sha256', 'whsec').update(body).digest('hex');
    expect(new ZernioPublisher({ apiKey: KEY }).verifyWebhook(body, sig)).toBe(false); // no secret → polling
    const z = new ZernioPublisher({ apiKey: KEY, webhookSecret: 'whsec' });
    expect(z.verifyWebhook(body, sig)).toBe(true);
    expect(z.verifyWebhook(body, `sha256=${sig}`)).toBe(true);
    expect(z.verifyWebhook(`${body} `, sig)).toBe(false);
    expect(z.verifyWebhook(body, 'nothex')).toBe(false);
    const [e] = z.parseWebhook(body);
    expect(e).toMatchObject({ type: 'comment', platform: 'instagram', accountRef: 'acc_9', externalPostId: 'zp_9', comment: { id: 'c1', authorRef: 'u1', text: 'BUDGET' } });
    expect(parseZernioEvent({ event: 'post.published', data: { postId: 'zp_1', platformPostUrl: 'https://x' } })).toEqual([{ type: 'post_status', externalId: 'zp_1', status: 'live', url: 'https://x' }]);
    expect(parseZernioEvent({ event: 'account.connected', data: {} })).toEqual([]);
  });

  it('is the live publish member only when the zernio integration is live', () => {
    const env = (live: boolean) => ({ isLive: (id: string) => live && id === 'zernio', secret: (n: string) => (n === 'zernio.api_key' ? KEY : null) });
    expect(liveProviders(env(false))).toEqual({});
    expect(liveProviders(env(true)).publish?.name).toBe('zernio');
  });
});
