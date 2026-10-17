import { FakeApify, type Providers } from '@troupe/providers';
import { DEFAULT_ACTORS, type RadarConfig, type ScraperKind } from './config';

/**
 * Deterministic, clearly fictional Apify datasets for fake mode (no keys) and tests: every handle starts with
 * `demo_`, nothing is a real creator. Accounts grow week over week (some accelerate), a few reels per hot account
 * break out at 6–12× within the last two weeks, hooks and sounds are shared across accounts so trends form, and the
 * post mix includes stills and carousels. `installFakeFixtures` registers a generator for each configured actor on
 * a FakeApify that has no fixture for it, so test fixtures always win.
 */

const DAY = 86_400_000;
const ANCHOR = Date.UTC(2026, 8, 7); // a Monday: week 0 of the synthetic growth curves

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
const pick = <T>(xs: readonly T[], n: number): T => xs[n % xs.length]!;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 18) || 'niche';
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();

const SUFFIXES = ['lab', 'diaries', 'daily', 'notes', 'club', 'studio', 'corner', 'journal', 'hq', 'room', 'desk', 'circle'];
const HOOKS = [
  (n: string) => `POV: you finally got your ${n} sorted`,
  (n: string) => `3 mistakes everyone makes with ${n}`,
  (n: string) => `Stop doing this with your ${n}. Do this instead`,
  (n: string) => `Myth vs fact: ${n} edition`,
  (n: string) => `Ranking every ${n} tip from worst to best`,
  (n: string) => `Storytime: the day I gave up on ${n}`,
  (n: string) => `${n} for beginners: start here`,
];
const SOUNDS = ['Golden Hour (sped up) · demo artist', 'Lo-fi kitchen beat · demo producer', 'Espresso loop · demo band'];
const TOPICS = ['tips', 'hacks', 'beginners', 'routine', 'mistakes'];
const LINKS = ['https://stan.store/demo_shop', 'https://linktr.ee/demo_links', 'https://patreon.com/demo_club', 'https://amzn.to/demo', 'https://fanvue.com/demo_page'];
const BIOS = [
  (n: string) => `Making ${n} simple · free guide below`,
  (n: string) => `${n} that actually works · use code DEMO10 with our partner`,
  (n: string) => `Daily ${n} notes · members get the templates`,
  (n: string) => `${n} storyteller · my planner is in the link`,
];

export interface DemoAccount {
  readonly handle: string;
  readonly platform: 'instagram' | 'tiktok';
  readonly niche: string;
  readonly hot: boolean;
  readonly followersAt: (at: Date) => number;
  readonly posts: number;
  readonly bio: string;
  readonly link: string | null;
}

/** The niche a demo handle belongs to is encoded in it: demo_<nicheslug>_<suffix>. */
export function demoAccount(handle: string, platform: 'instagram' | 'tiktok', nicheHint?: string): DemoAccount {
  const h = hash(`${platform}:${handle}`);
  const niche = nicheHint ?? handle.replace(/^demo_/, '').replace(/_[a-z]+$/, '');
  const hot = h % 3 === 0;
  const base = 2_000 + (h % 60_000);
  const g = hot ? 0.06 + (h % 7) / 100 : 0.004 + (h % 5) / 1000;
  const followersAt = (at: Date) => {
    const w = Math.max(0, Math.floor((at.getTime() - ANCHOR) / (7 * DAY)));
    let f = base;
    for (let i = 0; i < w; i += 1) f *= 1 + g * (hot ? 1 + 0.12 * i : 1);
    return Math.round(f);
  };
  return {
    handle,
    platform,
    niche,
    hot,
    followersAt,
    posts: hot ? 24 + (h % 30) : 120 + (h % 400),
    bio: pick(BIOS, h)(words(niche)),
    link: h % 4 === 3 ? null : pick(LINKS, h >> 3),
  };
}

const handlesFor = (tag: string, platform: 'instagram' | 'tiktok', n: number) =>
  Array.from({ length: n }, (_, i) => `demo_${slug(tag)}_${pick(SUFFIXES, i + (platform === 'tiktok' ? 5 : 0))}`);

interface DemoPost {
  id: string;
  handle: string;
  kind: 'video' | 'image' | 'carousel';
  caption: string;
  transcript: string | null;
  hashtags: string[];
  sound: string | null;
  postedAt: Date;
  durationS: number | null;
  views: number | null;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
}

/** A demo account's last `n` posts as of `now`. Hot accounts have two breakouts (≈6× and ≈12×) in the last 14 days. */
export function demoPosts(a: DemoAccount, now: Date, n = 20): DemoPost[] {
  const h = hash(`${a.platform}:${a.handle}:posts`);
  const f = a.followersAt(now);
  const ratio = a.hot ? 3 + (h % 4) : 0.4 + (h % 8) / 10;
  const medViews = Math.max(200, Math.round(f * ratio));
  const n0 = words(a.niche);
  const tag = slug(a.niche);
  return Array.from({ length: n }, (_, j) => {
    const postedAt = new Date(now.getTime() - (j * 1.7 + (h % 10) / 10 + 0.3) * DAY);
    const kind: DemoPost['kind'] = a.platform === 'instagram' && j % 5 === 3 ? 'carousel' : a.platform === 'instagram' && j % 7 === 4 ? 'image' : 'video';
    // Hot accounts break out on a reel (12×, 6×), a carousel (7×) and a still (5.5×) within the last two weeks.
    const boost = !a.hot ? 1 : j === 2 ? 12 : j === 5 ? 6 : j === 3 && kind === 'carousel' ? 7 : j === 4 && kind === 'image' ? 5.5 : 1;
    const jitter = 0.8 + ((h >> (j % 16)) % 40) / 100;
    const views = Math.round(medViews * jitter * boost);
    const hookIx = a.hot ? (j % 3 === 0 ? 0 : j % 3 === 1 ? 3 : (h + j) % HOOKS.length) : (h + j) % HOOKS.length;
    const hook = HOOKS[hookIx]!(n0);
    const topic = `${tag}${a.hot && j < 8 ? 'hacks' : pick(TOPICS, h + j)}`;
    const cta = j % 2 === 0 ? 'Comment GUIDE and I will send it.' : 'Save this for later.';
    const caption =
      kind === 'carousel'
        ? `${j % 10 === 8 ? 'Weekend recap, a little dump' : hook} · swipe for all of it. ${cta} #${tag} #${topic}`
        : kind === 'image'
          ? `${j % 2 ? `My ${n0} setup, saved for you.` : `Reminder: ${n0} is a marathon.`} ${cta} #${tag} #${topic}`
          : `${hook} ${cta} #${tag} #${topic} #fyp`;
    const durationS = kind === 'video' ? 12 + ((h + j) % 40) : null;
    // Spoken posts run at ~2.5 words a second; a quarter of the videos have no speech (text over B-roll).
    const line = `${hook}. Here is what changed everything for me with ${n0}, step by step, and why it works for real people.`;
    const want = Math.round((durationS ?? 0) * 2.5);
    const transcript = kind === 'video' && (h + j) % 4 !== 0 ? Array.from({ length: Math.max(1, Math.ceil(want / line.split(' ').length)) }, () => line).join(' ').split(' ').slice(0, Math.max(10, want)).join(' ') : null;
    return {
      id: `${a.platform === 'tiktok' ? '7' : 'C'}${(hash(`${a.handle}:${j}`) % 1e9).toString(36)}${j}`,
      handle: a.handle,
      kind,
      caption,
      transcript,
      hashtags: [tag, topic],
      sound: kind === 'video' ? (a.hot && j < 8 ? SOUNDS[0]! : (h + j) % 3 === 0 ? pick(SOUNDS, j) : `${a.handle} · original audio`) : null,
      postedAt,
      durationS,
      views: kind === 'video' ? views : null,
      likes: Math.round(views * 0.06),
      comments: Math.round(views * 0.004),
      shares: Math.round(views * (a.hot ? 0.012 : 0.004)),
      saves: Math.round(views * (a.hot ? 0.02 : 0.006)),
    };
  });
}

function igPostItem(p: DemoPost) {
  return {
    id: p.id,
    shortCode: p.id,
    type: p.kind === 'video' ? 'Video' : p.kind === 'carousel' ? 'Sidecar' : 'Image',
    productType: p.kind === 'video' ? 'clips' : 'feed',
    url: `https://www.instagram.com/${p.kind === 'video' ? 'reel' : 'p'}/${p.id}/`,
    ownerUsername: p.handle,
    caption: p.caption,
    hashtags: p.hashtags,
    timestamp: p.postedAt.toISOString(),
    videoDuration: p.durationS ?? undefined,
    videoPlayCount: p.views ?? undefined,
    likesCount: p.likes,
    commentsCount: p.comments,
    musicInfo: p.sound ? { song_name: p.sound.split(' · ')[0], artist_name: p.sound.split(' · ')[1] ?? p.handle, uses_original_audio: /original/.test(p.sound) } : undefined,
    transcript: p.transcript ?? undefined,
  };
}

function ttItem(a: DemoAccount, p: DemoPost, now: Date) {
  return {
    id: p.id,
    text: p.caption,
    createTimeISO: p.postedAt.toISOString(),
    webVideoUrl: `https://www.tiktok.com/@${p.handle}/video/${p.id}`,
    playCount: p.views ?? p.likes * 15,
    diggCount: p.likes,
    shareCount: p.shares,
    commentCount: p.comments,
    collectCount: p.saves,
    hashtags: p.hashtags.map((name) => ({ name })),
    musicMeta: p.sound ? { musicName: p.sound.split(' · ')[0], musicAuthor: p.sound.split(' · ')[1] ?? p.handle, musicOriginal: /original/.test(p.sound) } : undefined,
    videoMeta: { duration: p.durationS ?? 15 },
    transcript: p.transcript ?? undefined,
    authorMeta: { name: a.handle, nickName: a.handle.replace(/^demo_/, '').replace(/_/g, ' '), fans: a.followersAt(now), following: 180, video: a.posts, signature: a.bio, bioLink: a.link ?? undefined },
  };
}

function igProfileItem(a: DemoAccount, now: Date, related: string[]) {
  return {
    username: a.handle,
    fullName: a.handle.replace(/^demo_/, '').replace(/_/g, ' '),
    biography: a.bio,
    externalUrl: a.link,
    followersCount: a.followersAt(now),
    followsCount: 300,
    postsCount: a.posts,
    relatedProfiles: related.map((username) => ({ username })),
    latestPosts: demoPosts(a, now, 6).map(igPostItem),
  };
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);
const tagsOf = (input: Record<string, unknown>) => strs(input.hashtags).map((h) => h.replace(/^#/, ''));

/** The fixture generator for one scraper kind (input shapes match the real actors' inputs built in scrape.ts). */
export function demoDataset(kind: ScraperKind, now: () => Date): (input: Record<string, unknown>) => unknown[] {
  return (input) => {
    const at = now();
    switch (kind) {
      case 'ig_hashtag':
        return tagsOf(input).flatMap((t) => handlesFor(t, 'instagram', 6).flatMap((h) => demoPosts(demoAccount(h, 'instagram'), at, 5).map(igPostItem)));
      case 'tt_hashtag':
        return tagsOf(input).flatMap((t) =>
          handlesFor(t, 'tiktok', 5).flatMap((h) => {
            const a = demoAccount(h, 'tiktok');
            return demoPosts(a, at, 5).map((p) => ttItem(a, p, at));
          }),
        );
      case 'ig_search':
        return strs(input.search).flatMap((q) => handlesFor(q.split(' ')[0] ?? q, 'instagram', 4).map((h) => igProfileItem(demoAccount(h, 'instagram'), at, [])));
      case 'ig_profile':
        return strs(input.usernames).map((h) => {
          const a = demoAccount(h, 'instagram');
          return igProfileItem(a, at, [`${h.replace(/_[a-z]+$/, '')}_${pick(SUFFIXES, hash(h) + 3)}`].filter((x) => x !== h));
        });
      case 'ig_reels': {
        const per = Number(input.resultsLimit) || 20;
        return strs(input.username).flatMap((h) => demoPosts(demoAccount(h, 'instagram'), at, per).map(igPostItem));
      }
      case 'tt_profile': {
        const per = Number(input.resultsPerPage) || 20;
        return strs(input.profiles).flatMap((h) => {
          const a = demoAccount(h, 'tiktok');
          return demoPosts(a, at, per).map((p) => ttItem(a, p, at));
        });
      }
    }
  };
}

/**
 * Registers the demo datasets on a FakeApify for every configured actor that has no fixture yet. No-op on a live
 * provider. Returns whether anything was installed.
 */
export function installFakeFixtures(providers: Pick<Providers, 'research'>, cfg: Pick<RadarConfig, 'actors'> | null, now: () => Date): boolean {
  const r = providers.research;
  if (!(r instanceof FakeApify)) return false;
  let added = false;
  const actors = cfg?.actors ?? DEFAULT_ACTORS;
  for (const kind of Object.keys(actors) as ScraperKind[]) {
    const id = actors[kind].id;
    if ([...r.fixtures.keys()].some((k) => id.startsWith(k))) continue;
    r.fixture(id, demoDataset(kind, now));
    added = true;
  }
  return added;
}
