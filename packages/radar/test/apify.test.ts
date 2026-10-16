import { describe, expect, it } from 'vitest';
import { ApifyError, ApifyResearch, liveProviders, normalizeIgPost, normalizeIgProfile, normalizeTikTok, resolveConfig, tiktokAuthor } from '../src';

describe('Apify normalisers', () => {
  it('Instagram reels and posts', () => {
    const reel = normalizeIgPost({
      shortCode: 'Cabc',
      type: 'Video',
      productType: 'clips',
      ownerUsername: '@Demo_Budget',
      caption: 'POV: payday hits #Budgeting #sinkingfunds',
      timestamp: '2026-10-10T10:00:00.000Z',
      videoDuration: 21.4,
      videoPlayCount: 120_000,
      likesCount: 5_000,
      commentsCount: 80,
      musicInfo: { song_name: 'Golden Hour', artist_name: 'demo', uses_original_audio: false },
    })!;
    expect(reel).toMatchObject({ platform: 'instagram', handle: 'demo_budget', kind: 'video', views: 120_000, likes: 5_000, shares: null, saves: null, sound: 'Golden Hour · demo', durationS: 21.4 });
    expect(reel.hashtags).toEqual(['budgeting', 'sinkingfunds']);
    expect(reel.postedAt?.toISOString()).toBe('2026-10-10T10:00:00.000Z');
    const still = normalizeIgPost({ id: '1', type: 'Sidecar', ownerUsername: 'x', likesCount: -1 })!;
    expect(still).toMatchObject({ kind: 'carousel', views: null, likes: null });
    expect(normalizeIgPost({ caption: 'no owner' })).toBeNull();
  });

  it('Instagram profiles with related profiles and latest posts', () => {
    const p = normalizeIgProfile({ username: 'demo_a', followersCount: 12_000, followsCount: 10, postsCount: 30, biography: 'bio', externalUrl: 'https://stan.store/x', relatedProfiles: [{ username: 'Demo_B' }], latestPosts: [{ shortCode: 'C1', type: 'Image', likesCount: 300 }] })!;
    expect(p).toMatchObject({ handle: 'demo_a', followers: 12_000, posts: 30, related: ['demo_b'] });
    expect(p.recent[0]).toMatchObject({ handle: 'demo_a', kind: 'image', likes: 300 });
  });

  it('TikTok videos carry saves, shares and the author', () => {
    const item = {
      id: '7400',
      text: 'Myth vs fact #money',
      createTime: 1_760_000_000,
      playCount: 90_000,
      diggCount: 7_000,
      shareCount: 900,
      commentCount: 120,
      collectCount: 1_500,
      musicMeta: { musicName: 'original sound', musicAuthor: 'demo_tt', musicOriginal: true },
      videoMeta: { duration: 31 },
      authorMeta: { name: 'demo_tt', fans: 40_000, video: 25, signature: 'link below', bioLink: 'https://linktr.ee/x' },
    };
    expect(normalizeTikTok(item)).toMatchObject({ platform: 'tiktok', handle: 'demo_tt', views: 90_000, saves: 1_500, shares: 900, authorFollowers: 40_000, sound: 'demo_tt · original sound' });
    expect(tiktokAuthor(item)).toMatchObject({ handle: 'demo_tt', followers: 40_000, posts: 25, externalUrl: 'https://linktr.ee/x' });
  });
});

describe('ApifyResearch (live adapter over a fake fetch)', () => {
  const TOKEN = 'apify_api_TESTTOKEN';
  function fakeFetch(script: { finalStatus?: string; usd?: number } = {}) {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
    let polls = 0;
    const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    const fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
      calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
      if (url.includes('/acts/')) return ok({ data: { id: 'run1', status: 'RUNNING', defaultDatasetId: 'ds1' } });
      if (url.includes('/actor-runs/')) {
        polls += 1;
        return ok({ data: { id: 'run1', status: polls < 2 ? 'RUNNING' : (script.finalStatus ?? 'SUCCEEDED'), defaultDatasetId: 'ds1', usageTotalUsd: script.usd ?? 0.042 } });
      }
      if (url.includes('/datasets/')) return ok([{ username: 'a' }, { username: 'b' }]);
      return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
    };
    return { calls, fetch };
  }

  it('starts the run with maxItems, waits for it, reads the dataset and reports the cost', async () => {
    const f = fakeFetch();
    const apify = new ApifyResearch({ token: TOKEN, fetch: f.fetch });
    const r = await apify.runActor({ actor: 'apify/instagram-profile-scraper', input: { usernames: ['a', 'b'] }, maxItems: 2 });
    expect(r).toEqual({ runId: 'run1', items: [{ username: 'a' }, { username: 'b' }], costUsd: 0.042 });
    expect(f.calls[0]!.method).toBe('POST');
    expect(f.calls[0]!.url).toContain('/acts/apify~instagram-profile-scraper/runs?');
    expect(f.calls[0]!.url).toContain('maxItems=2');
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ usernames: ['a', 'b'] });
    expect(f.calls.at(-1)!.url).toContain('/datasets/ds1/items?');
    // The token only ever travels in the Authorization header, never in a URL; no proxy settings are added.
    for (const c of f.calls) {
      expect(c.url).not.toContain(TOKEN);
      expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(c.body ?? '').not.toMatch(/proxy/i);
    }
  });

  it('a failed run throws with what it cost, so the governor still debits it', async () => {
    const apify = new ApifyResearch({ token: TOKEN, fetch: fakeFetch({ finalStatus: 'FAILED', usd: 0.01 }).fetch });
    const err = await apify.runActor({ actor: 'apify/instagram-reel-scraper', input: {}, maxItems: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApifyError);
    expect((err as ApifyError).costUsd).toBe(0.01);
    await expect(apify.runActor({ actor: 'not an actor', input: {} })).rejects.toThrow(/bad actor id/);
  });

  it('switches on only with the integration live and the token present', () => {
    expect(liveProviders({ isLive: () => false, secret: () => TOKEN })).toEqual({});
    expect(liveProviders({ isLive: (id) => id === 'apify', secret: () => null })).toEqual({});
    const p = liveProviders({ isLive: (id) => id === 'apify', secret: (n) => (n === 'apify.token' ? TOKEN : null) });
    expect(p.research).toBeInstanceOf(ApifyResearch);
  });
});

describe('Radar config', () => {
  it('keeps actor ids and prices in config, with safe fallbacks', () => {
    const cfg = resolveConfig({ actors: { ig_reels: { id: 'someone/reels-scraper', usdPerResult: 0.003 }, tt_profile: { id: 'bad id!', usdPerResult: 'x' } }, limits: { accountsPerNiche: 999, platforms: ['instagram', 'myspace'] } });
    expect(cfg.actors.ig_reels).toEqual({ id: 'someone/reels-scraper', usdPerResult: 0.003 });
    expect(cfg.actors.tt_profile.id).toBe('clockworks/tiktok-profile-scraper');
    expect(cfg.limits.accountsPerNiche).toBe(100);
    expect(cfg.limits.platforms).toEqual(['instagram']);
  });
});
