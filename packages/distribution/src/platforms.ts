import type { PostFormat } from '@ios/core';
import { AI_FLAG_FIELDS, type Platform, type StoryCapability } from '@ios/providers';
import { DAY_MS } from './util';

/**
 * Per-platform publishing rules (PRD FR-7): TikTok and Instagram from day 1, YouTube Shorts from the persona's day 30.
 * Every post carries the platform's AI flag (owner rule); nothing here can switch it off.
 */

/** Publishing order: the first platform with a post is the slot's primary post. */
export const PLATFORM_ORDER: readonly Platform[] = ['tiktok', 'instagram', 'youtube'];
export const YOUTUBE_FROM_DAY = 30;

/**
 * (IOS-5 integration) What the renderer (stream K) exports per format: stills are one 1080×1920 image (static,
 * text_note, meme) or a 1080×1350 slide set (carousel, photo_dump); every other format, the core reels and the
 * optional talking / text-loop formats, is one vertical video.
 */
const IMAGE_FORMATS: readonly PostFormat[] = ['static', 'text_note', 'meme'];
const SLIDE_FORMATS: readonly PostFormat[] = ['carousel', 'photo_dump'];
export const isSlideFormat = (f: PostFormat): boolean => SLIDE_FORMATS.includes(f);
export const isVideoFormat = (f: PostFormat): boolean => !IMAGE_FORMATS.includes(f) && !SLIDE_FORMATS.includes(f);

export function mediaKind(format: PostFormat): 'video' | 'image' | 'carousel' {
  if (isVideoFormat(format)) return 'video';
  return isSlideFormat(format) ? 'carousel' : 'image';
}

/**
 * Where a format goes.
 * - Video: TikTok, Instagram (Reel), and YouTube Shorts once the persona is 30 days old.
 * - Static and carousel: Instagram as photos. TikTok rejects the AI disclosure (videoMadeWithAi) on direct photo posts
 *   from TikTok-for-Business accounts, and a TikTok draft drops it too, so a TikTok photo post is never sent. Instead,
 *   when the render hands over a slideshow (the stills as a short vertical video, `tiktokSlideshow`), TikTok gets that
 *   video with the AI flag on: automatic, no manual step. Without one, stills skip TikTok. YouTube Shorts is video only.
 */
export function targetPlatforms(format: PostFormat, personaStartedAt: Date, now: Date, opts: { slideshow?: boolean } = {}): Platform[] {
  if (!isVideoFormat(format)) return opts.slideshow ? ['tiktok', 'instagram'] : ['instagram'];
  const day30 = now.getTime() - personaStartedAt.getTime() >= YOUTUBE_FROM_DAY * DAY_MS;
  return day30 ? ['tiktok', 'instagram', 'youtube'] : ['tiktok', 'instagram'];
}

/**
 * (Zernio) Platforms the adapter can map beyond the studio's own list. Facebook (Pages: feed, Reels via contentType
 * 'reel', Stories via contentType 'story') is mapped but OFF by default: it joins with the day-30 rollout (FR-4.3d)
 * only when the Owner switches it on. FacebookPlatformData has no AI-label field, so Facebook's label is Meta-side
 * ("AI info", applied by Meta from the C2PA/IPTC provenance in the file or its own detection); the adapter never
 * claims a Facebook post is labelled (verify reports aiLabel false = unknown, and the Owner checks it).
 */
export const ZERNIO_EXTRA_PLATFORMS = ['facebook'] as const;
export type ZernioExtraPlatform = (typeof ZERNIO_EXTRA_PLATFORMS)[number];
export const FACEBOOK_ROLLOUT = { enabledByDefault: false, fromDay: YOUTUBE_FROM_DAY, aiLabel: 'meta_side' } as const;

/** Staggered posting (FR-7.3): the same slot goes out a few minutes apart per platform, never in one burst. */
export const PLATFORM_OFFSET_MIN: Readonly<Record<Platform, number>> = { tiktok: 0, instagram: 7, youtube: 13, pinterest: 19 };

export const CAPTION_MAX: Readonly<Record<Platform, number>> = { tiktok: 2200, instagram: 2200, youtube: 5000, pinterest: 500 };
export const TITLE_MAX = 100;
export const HASHTAG_MAX: Readonly<Record<Platform, number>> = { tiktok: 5, instagram: 5, youtube: 3, pinterest: 5 };
export const CAROUSEL_SLIDES = { min: 2, max: 10 } as const;
/** Export sizes (contracts §1): 1080×1920; carousel slides 1080×1350. */
export const EXPORT_SIZE = { vertical: { width: 1080, height: 1920 }, carousel: { width: 1080, height: 1350 } } as const;
export const MAX_VIDEO_S: Readonly<Record<Platform, number>> = { tiktok: 600, instagram: 180, youtube: 180, pinterest: 300 };

const tag = (h: string) => `#${h.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '')}`;

/** Caption variant per platform (FR-7.4): the CTA stays, hashtags are capped, raw links are dropped (bio link / DM instead). */
export function platformCaption(platform: Platform, caption: string, hashtags: readonly string[]): string {
  const body = caption.replace(/\bhttps?:\/\/\S+/gi, '').replace(/[ \t]+\n/g, '\n').trim();
  const tags = [...new Set(hashtags.map(tag).filter((t) => t.length > 1))].slice(0, HASHTAG_MAX[platform]);
  if (platform === 'youtube' && !tags.some((t) => t.toLowerCase() === '#shorts')) tags.unshift('#Shorts');
  const present = tags.filter((t) => !new RegExp(`${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(body));
  const out = present.length ? `${body}\n\n${present.join(' ')}` : body;
  return out.slice(0, CAPTION_MAX[platform]);
}

/** YouTube Shorts title: the caption's first line, ≤ 100 characters, no hashtags. */
export function shortsTitle(caption: string, fallback: string): string {
  const first = caption.split('\n').map((l) => l.replace(/#[\p{L}\p{N}_]+/gu, '').trim()).find(Boolean) ?? fallback;
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1).trimEnd()}…` : first;
}

/** Platform options stored on the post: the AI flag field, always true. */
export function aiPlatformOptions(platform: Platform): Record<string, unknown> {
  return { [AI_FLAG_FIELDS[platform]]: true };
}

// ─── (IOS-5 stream L) Stories (FR-4.3d) ───

/**
 * Story support through Zernio's API, per platform (a capability flag each; the Stories engine publishes a frame only
 * where it is on). Checked against the OpenAPI spec (1.290): Instagram Stories are a post with one media item and
 * platformSpecificData.contentType 'story' (no caption; isAiGenerated applies to Stories); TikTokPlatformData,
 * YouTubePlatformData and PinterestPlatformData have no story type. Facebook Page Stories (contentType 'story') are
 * mapped in the adapter but Facebook is off by default (FACEBOOK_ROLLOUT).
 */
export const ZERNIO_STORY_SUPPORT: readonly StoryCapability[] = [
  { platform: 'instagram', stories: true, note: 'image story via contentType "story"; link and poll stickers are not available through the API' },
  { platform: 'tiktok', stories: false, note: 'the Content Posting API has no Stories' },
  { platform: 'youtube', stories: false, note: 'no Stories' },
  { platform: 'pinterest', stories: false, note: 'no Stories' },
];
/** Story frames are 9:16 stills at the vertical export size. */
export const STORY_SIZE = EXPORT_SIZE.vertical;
