import { readFileSync } from 'node:fs';
import { FakeZernio, type PublishProvider } from '@ios/providers';
import { describe, expect, it } from 'vitest';
import { ZERNIO_ROUTES, ZernioPublisher } from '../src';
import { formatSnapshot, getOnlyFetch } from '../src/zernio-check';

// Read-only Zernio methods for the Sound Engine and the audience-time scheduler (round 7), from the OpenAPI shapes.
const KEY = 'zk_test_secret_value';

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ?? null });
    const r = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

const API = 'https://zernio.com/api/v1';

describe('Zernio read-only catalogs and insights', () => {
  it('searches the Instagram audio catalog (trending without q) and reads one asset', async () => {
    const asset = {
      audioId: '482851939985510',
      title: 'Golden Hour',
      audioType: 'music',
      durationInMs: 30000,
      displayArtist: 'JVKE',
      coverArtworkThumbnailUrl: 'https://x/c.jpg',
      downloadUrl: 'https://x/p.mp3',
      igUsername: null,
      profilePictureUrl: null,
      isAdsEligible: true,
      onPlatformAudioPreviewLink: 'https://instagram.com/reels/audio/1',
    };
    const { fn, calls } = fakeFetch([{ body: { audio: [asset, { title: 'no id' }] } }, { body: { audio: [] } }, { body: { audio: asset } }, { status: 404, body: { error: 'gone' } }]);
    const z = new ZernioPublisher({ apiKey: KEY, fetch: fn });
    expect(await z.searchInstagramAudio('acc_ig', { audioType: 'music' })).toEqual([
      { audioId: '482851939985510', title: 'Golden Hour', audioType: 'music', durationMs: 30000, artist: 'JVKE', creator: null, previewUrl: 'https://x/p.mp3', isAdsEligible: true },
    ]);
    expect(calls[0]!.url).toBe(`${API}/accounts/acc_ig/instagram/audio?audioType=music`);
    expect(await z.searchInstagramAudio('acc_ig', { audioType: 'original_sound', q: ' morning routine ' })).toEqual([]);
    expect(calls[1]!.url).toBe(`${API}/accounts/acc_ig/instagram/audio?audioType=original_sound&q=morning+routine`);
    expect((await z.getInstagramAudio('acc_ig', '482851939985510'))?.audioId).toBe('482851939985510');
    expect(calls[2]!.url).toBe(`${API}/accounts/acc_ig/instagram/audio/482851939985510`);
    expect(await z.getInstagramAudio('acc_ig', '1')).toBeNull();
    // A non-numeric id never reaches the API (the path pattern is digits only).
    expect(await z.getInstagramAudio('acc_ig', '../posts')).toBeNull();
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('lists TikTok commercial music with the clip id to send as musicSoundId', async () => {
    const { fn, calls } = fakeFetch([
      {
        body: {
          tracks: [
            { id: '7001', commercialMusicId: 'cm1', name: 'Track A', artist: 'A', durationSec: 60, genres: ['Pop'], previewUrl: 'https://p', thumbnailUrl: 'https://t', rank: 1, clip: { id: '8001', durationSec: 30, previewUrl: 'https://c' } },
            { id: '7002', name: 'Track B', rank: 2 },
          ],
        },
      },
    ]);
    const z = new ZernioPublisher({ apiKey: KEY, fetch: fn });
    expect(await z.listTikTokCommercialMusic('acc_tt', { countryCode: 'gb' })).toEqual([
      { id: '7001', clipId: '8001', name: 'Track A', artist: 'A', durationS: 60, rank: 1, genres: ['Pop'], previewUrl: 'https://p' },
      { id: '7002', clipId: null, name: 'Track B', artist: null, durationS: null, rank: 2, genres: [], previewUrl: null },
    ]);
    expect(calls[0]!.url).toBe(`${API}/accounts/acc_tt/tiktok/commercial-music?countryCode=GB`);
  });

  it('reads Instagram online followers and best-time slots', async () => {
    const { fn, calls } = fakeFetch([
      { body: { success: true, accountId: 'acc_ig', platform: 'instagram', metric: 'online_followers', days: [{ endTime: '2026-10-01T07:00:00+0000', hours: { '0': 120, '18': 281, bogus: 'x' } }], note: 'n' } },
      { body: { slots: [{ day_of_week: 2, hour: 18, avg_engagement: 510.3, post_count: 15 }, { day_of_week: 9, hour: 30, avg_engagement: 1, post_count: 1 }] } },
    ]);
    const z = new ZernioPublisher({ apiKey: KEY, fetch: fn });
    expect(await z.instagramOnlineFollowers('acc_ig')).toEqual([{ endTime: '2026-10-01T07:00:00+0000', hours: { '0': 120, '18': 281 } }]);
    expect(calls[0]!.url).toBe(`${API}/analytics/instagram/online-followers?accountId=acc_ig`);
    expect(await z.bestTime({ platform: 'instagram', accountRef: 'acc_ig' })).toEqual([{ dayOfWeek: 2, hour: 18, avgEngagement: 510.3, postCount: 15 }]);
    expect(calls[1]!.url).toBe(`${API}/analytics/best-time?platform=instagram&accountId=acc_ig`);
  });

  it('reads account health for one account and for all', async () => {
    const { fn, calls } = fakeFetch([
      {
        body: {
          accountId: 'acc_ig',
          platform: 'instagram',
          username: 'maya',
          status: 'warning',
          tokenStatus: { valid: true, expiresIn: '180 days', needsRefresh: false },
          permissions: { canPost: true, canFetchAnalytics: false, missingRequired: [] },
          issues: ['analytics sync stalled'],
          recommendations: ['reconnect'],
        },
      },
      { body: { summary: { total: 1, healthy: 0, warning: 0, error: 1, needsReconnect: 1 }, accounts: [{ accountId: 'acc_x', platform: 'tiktok', username: 'x', status: 'error', canPost: false, canFetchAnalytics: false, tokenValid: false, needsReconnect: true, issues: ['Token expired'] }] } },
    ]);
    const z = new ZernioPublisher({ apiKey: KEY, fetch: fn });
    expect(await z.accountHealth('acc_ig')).toEqual([
      { accountRef: 'acc_ig', platform: 'instagram', handle: 'maya', status: 'warning', canPost: true, canFetchAnalytics: false, tokenValid: true, needsReconnect: false, issues: ['analytics sync stalled'], recommendations: ['reconnect'] },
    ]);
    expect(calls[0]!.url).toBe(`${API}/accounts/acc_ig/health`);
    expect(await z.accountHealth()).toEqual([
      { accountRef: 'acc_x', platform: 'tiktok', handle: 'x', status: 'error', canPost: false, canFetchAnalytics: false, tokenValid: false, needsReconnect: true, issues: ['Token expired'], recommendations: [] },
    ]);
    expect(calls[1]!.url).toBe(`${API}/accounts/health`);
  });

  it('has a fake for every read-only method (fake mode with no keys)', async () => {
    const f: PublishProvider = new FakeZernio();
    expect((await f.searchInstagramAudio!('a', { audioType: 'music' })).length).toBe(3);
    expect((await f.searchInstagramAudio!('a', { audioType: 'music', q: 'lofi' }))[0]!.title).toBe('lofi 1');
    expect(await f.getInstagramAudio!('a', 'nope')).toBeNull();
    expect((await f.getInstagramAudio!('a', '123'))?.audioId).toBe('123');
    const tracks = await f.listTikTokCommercialMusic!('a');
    expect(tracks.every((t) => t.clipId)).toBe(true);
    expect(await f.listTikTokCommercialMusic!('a')).toEqual(tracks);
    expect(Object.keys((await f.instagramOnlineFollowers!('a'))[0]!.hours)).toHaveLength(24);
    expect((await f.bestTime!())[0]).toMatchObject({ dayOfWeek: 2, hour: 18 });
    (f as FakeZernio).accounts.push({ accountRef: 'acc_1', platform: 'instagram', handle: 'maya', aiProfileLabel: null });
    expect(await f.accountHealth!('acc_1')).toEqual([expect.objectContaining({ accountRef: 'acc_1', status: 'healthy', needsReconnect: false })]);
  });

  it('documents every route the adapter uses as a spec path', () => {
    const paths = [
      ZERNIO_ROUTES.posts,
      ZERNIO_ROUTES.post('p'),
      ZERNIO_ROUTES.accounts,
      ZERNIO_ROUTES.accountsHealth,
      ZERNIO_ROUTES.accountHealth('a'),
      ZERNIO_ROUTES.profiles,
      ZERNIO_ROUTES.usage,
      ZERNIO_ROUTES.presign,
      ZERNIO_ROUTES.analytics,
      ZERNIO_ROUTES.bestTime,
      ZERNIO_ROUTES.instagramOnlineFollowers,
      ZERNIO_ROUTES.instagramAudio('a'),
      ZERNIO_ROUTES.instagramAudioAsset('a', '1'),
      ZERNIO_ROUTES.instagramStoryInsights('a', 's'),
      ZERNIO_ROUTES.tiktokCommercialMusic('a'),
      ZERNIO_ROUTES.postComments('p'),
      ZERNIO_ROUTES.hideComment('p', 'c'),
      ZERNIO_ROUTES.privateReply('p', 'c'),
      ZERNIO_ROUTES.conversations,
      ZERNIO_ROUTES.conversationMessages('c'),
    ];
    expect(paths).toHaveLength(Object.keys(ZERNIO_ROUTES).length);
    // Every route template must be a path in the spec (test/fixtures/zernio-spec.json, extracted from openapi.yaml).
    const spec = (JSON.parse(readFileSync(new URL('./fixtures/zernio-spec.json', import.meta.url), 'utf8')) as { paths: string[] }).paths;
    const templates = new Set(spec.map((p) => p.replace(/^\/v1/, '').replace(/\{[^}]+\}/g, '{}')));
    const asTemplate = (p: string) => p.replace(/\/(p|a|c|s|1)(?=\/|$)/g, '/{}');
    for (const p of paths) expect(templates, `${p} is not a spec path`).toContain(asTemplate(p));
  });
});

describe('zernio:check (live, read-only)', () => {
  it('lets GET through and refuses every write before it leaves the process', async () => {
    const { fn, calls } = fakeFetch([{ body: {} }]);
    const guarded = getOnlyFetch(fn);
    await guarded('https://zernio.com/api/v1/accounts');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) await expect(guarded('https://zernio.com/api/v1/posts', { method })).rejects.toThrow(/read-only/);
    expect(calls).toHaveLength(1);
  });

  it('reads accounts, profiles and usage and prints counts and platforms only', async () => {
    const { fn, calls } = fakeFetch([
      {
        body: {
          accounts: [
            { _id: 'secret_id_1', platform: 'instagram', username: '@private.handle', displayName: 'Private Name', isActive: true, metadata: { loginMethod: 'facebook_login' } },
            { _id: 'secret_id_2', platform: 'instagram', username: 'other', isActive: false, metadata: {} },
            { _id: 'secret_id_3', platform: 'tiktok', username: 'tt', isActive: true },
          ],
          hasAnalyticsAccess: true,
        },
      },
      { body: { profiles: [{ _id: 'prof_secret', name: 'Studio Profile' }] } },
      { body: { billingSystem: 'stripe', planName: 'Build', limits: { uploads: 120, profiles: 2 }, usage: { uploads: 7, profiles: 1 } } },
    ]);
    const z = new ZernioPublisher({ apiKey: KEY, fetch: getOnlyFetch(fn) });
    const snap = await z.snapshot();
    expect(snap).toEqual({
      accounts: 3,
      accountsByPlatform: { instagram: 2, tiktok: 1 },
      activeAccounts: 2,
      instagramNotFacebookLogin: 1,
      profiles: 1,
      usage: { connectedAccounts: null, uploads: 7, profiles: 1, uploadsLimit: 120, profilesLimit: 2 },
    });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', `${API}/accounts`],
      ['GET', `${API}/profiles`],
      ['GET', `${API}/usage`],
    ]);
    const out = formatSnapshot(snap);
    expect(out).toContain('accounts: 3 (2 active) · instagram 2, tiktok 1');
    expect(out).toContain('profiles: 1');
    expect(out).toContain('uploads 7/120');
    expect(out).toMatch(/1 Instagram account\(s\) not on Facebook Login/);
    for (const secret of [KEY, 'secret_id', 'private.handle', 'Private Name', 'prof_secret', 'Studio Profile', 'Build']) expect(out).not.toContain(secret);
  });

  it('prints an empty account (0 connected, 1 profile) without warnings', () => {
    const out = formatSnapshot({ accounts: 0, accountsByPlatform: {}, activeAccounts: 0, instagramNotFacebookLogin: 0, profiles: 1, usage: { connectedAccounts: 0, uploads: null, profiles: null, uploadsLimit: null, profilesLimit: null } });
    expect(out).toBe('Zernio (read-only check)\n  accounts: 0 (0 active)\n  profiles: 1\n  usage:    connected accounts 0');
  });
});
