import type { PublishRequest } from '@troupe/providers';
import { describe, expect, it } from 'vitest';
import { buildPostBody, ZERNIO_STORY_SUPPORT, ZernioPublisher } from '../src';
import { parseStoryMetrics } from '../src/zernio';

// (IOS-5 stream L) Story publishing on the live Zernio adapter: kind 'story', a capability flag per platform, metrics.
const KEY = 'zk_test_secret_value';
const story: PublishRequest = { accountRef: 'acc_ig', platform: 'instagram', mediaUrls: ['https://cdn.zernio.test/frame.png'], caption: '', aiLabel: true, kind: 'story', idempotencyKey: 'story:f1:instagram' };

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    let body: unknown = init?.body ?? null;
    if (typeof body === 'string') body = JSON.parse(body);
    calls.push({ url: String(url), method: init?.method ?? 'GET', body });
    const r = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

describe('Zernio stories (FR-4.3d)', () => {
  it('maps an Instagram story to one image with contentType "story" and the AI flag on', () => {
    const body = buildPostBody(story);
    expect(body.mediaItems).toEqual([{ type: 'image', url: 'https://cdn.zernio.test/frame.png' }]);
    // Stories carry no caption (InstagramPlatformData: "stories require media (no captions)").
    expect(body).not.toHaveProperty('content');
    expect(buildPostBody({ ...story, caption: 'not sent' })).not.toHaveProperty('content');
    const psd = (body.platforms as Array<{ platformSpecificData: Record<string, unknown> }>)[0]!.platformSpecificData;
    expect(psd).toMatchObject({ contentType: 'story', isAiGenerated: true });
    expect(() => buildPostBody({ ...story, platformOptions: { isAiGenerated: false } })).toThrow(/refusing/);
  });

  it('refuses stories where the platform has none, multi-frame stories and inbox drafts', () => {
    expect(() => buildPostBody({ ...story, platform: 'tiktok' })).toThrow(/no Stories/);
    expect(() => buildPostBody({ ...story, platform: 'youtube' })).toThrow(/no Stories/);
    expect(() => buildPostBody({ ...story, mediaUrls: ['a', 'b'] })).toThrow(/exactly one frame/);
    expect(() => buildPostBody({ ...story, mode: 'draft_inbox' })).toThrow(/drafts are never sent/);
    expect(() => buildPostBody({ ...story, platform: 'pinterest' })).toThrow(/no Stories/);
  });

  it('reports story capabilities per platform and reads Instagram story insights from the story-insights route', async () => {
    const { fn, calls } = fakeFetch([
      { body: { post: { _id: 'p_1', status: 'published' } } },
      { body: { post: { _id: 'p_1', platforms: [{ platform: 'instagram', accountId: { _id: 'acc_ig' }, platformPostId: '17900001', status: 'published' }] } } },
      {
        body: {
          data: {
            source: 'live',
            metrics: { views: 900, reach: 812, replies: 4, shares: 1, navigation: 306, tapsForward: 230, tapsBack: 21, exits: 55, swipesForward: 0, profileVisits: 3, follows: 1, reposts: 0, totalInteractions: 9 },
          },
        },
      },
    ]);
    const z = new ZernioPublisher({ apiKey: KEY, fetch: fn });
    const caps = await z.storyCapabilities();
    expect(caps).toEqual(ZERNIO_STORY_SUPPORT.map((c) => ({ ...c })));
    expect(caps.filter((c) => c.stories).map((c) => c.platform)).toEqual(['instagram']);
    expect(await z.publish(story)).toEqual({ externalId: 'p_1', status: 'published' });
    expect(calls[0]!.body).toMatchObject({ platforms: [{ platform: 'instagram', platformSpecificData: { contentType: 'story', isAiGenerated: true } }] });
    expect(await z.fetchStoryMetrics({ externalId: 'p_1', platform: 'instagram' })).toEqual({ reach: 812, replies: 4, tapsForward: 230, tapsBack: 21, exits: 55 });
    expect(calls[2]!.url).toBe('https://zernio.com/api/v1/accounts/acc_ig/instagram/stories/17900001/insights');
    expect(parseStoryMetrics({ posts: [{ analytics: { impressions: 10, tapsForward: 2, exits: 1 } }] })).toEqual({ reach: 10, replies: 0, tapsForward: 2, tapsBack: 0, exits: 1 });
    expect(parseStoryMetrics({ analytics: { reach: 812, replies: 4, navigation: { taps_forward: 230, taps_back: 21, exited: 55 } } })).toEqual({ reach: 812, replies: 4, tapsForward: 230, tapsBack: 21, exits: 55 });
  });
});
