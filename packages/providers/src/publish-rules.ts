import { AI_FLAG_FIELDS, type Platform, type PublishRequest } from './types';

/**
 * The publish rules every PublishProvider applies before anything leaves the process, shared by the live Zernio
 * adapter (buildPostBody) and FakeZernio, so fake mode refuses exactly what the live adapter refuses:
 * - the AI label is always the literal `true`;
 * - no platform option may set an AI flag to anything but true (every spelling, top level and nested settings);
 * - no inbox draft on any platform (a TikTok draft drops every post_info field, the AI disclosure included);
 * - no TikTok photo post (image, carousel or story): the business photo endpoint has no disclosure field, so stills
 *   reach TikTok as a slideshow video instead;
 * - a story only where the platform has Stories through the API, and exactly one frame;
 * - a post needs media.
 */

/** A request the publisher refuses for good (retrying the same request can never succeed). */
export class PublishRefusedError extends Error {
  override readonly name = 'PublishRefusedError';
  readonly permanent = true;
}

/** True for a PublishRefusedError, also across package copies (duck-typed on the name). */
export const isPublishRefused = (err: unknown): err is PublishRefusedError =>
  err instanceof PublishRefusedError || (err instanceof Error && err.name === 'PublishRefusedError');

/** Every spelling of an AI flag a caller might pass (contract names, Zernio's camelCase and TikTok's snake_case). */
export const AI_FLAG_SPELLINGS = ['videoMadeWithAi', 'video_made_with_ai', 'isAiGenerated', 'is_ai_generated', 'containsSyntheticMedia', 'contains_synthetic_media'] as const;

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});

/** Refuses any platform option that would turn the AI flag off (every spelling, top level and in nested settings). */
export function assertAiFlagOptions(platform: string, options: Readonly<Record<string, unknown>> | undefined, prefix = 'zernio: '): void {
  if (!options) return;
  const contract = (AI_FLAG_FIELDS as Record<string, string | undefined>)[platform];
  const check = (o: Json, where: string) => {
    for (const field of new Set([...(contract ? [contract] : []), ...AI_FLAG_SPELLINGS])) {
      if (field in o && o[field] !== true) throw new PublishRefusedError(`${prefix}refusing ${where}${field}=${String(o[field])}; every post carries the AI flag`);
    }
  };
  check(rec(options), '');
  check(rec(options.tiktokSettings), 'tiktokSettings.');
  check(rec(options.platformSpecificData), 'platformSpecificData.');
}

/** A request whose platform may be outside the studio's contract list (the live adapter also maps Facebook). */
export type PublishableRequest = Omit<PublishRequest, 'platform'> & { readonly platform: string };

export interface PublishRuleOptions {
  /** Platforms the publisher may post to (default: any). */
  readonly enabled?: readonly string[];
  /** Whether `platform` has Stories through the publishing API. */
  readonly storySupported: (platform: string) => boolean;
  /** Message prefix (the live adapter uses 'zernio: '). */
  readonly prefix?: string;
}

/** Throws PublishRefusedError for any request the live adapter would refuse. */
export function assertPublishable(req: PublishableRequest, opts: PublishRuleOptions): void {
  const p = opts.prefix ?? 'zernio: ';
  if (req.aiLabel !== true) throw new PublishRefusedError(`${p}the AI label is required on every post`);
  if (opts.enabled && !opts.enabled.includes(req.platform)) {
    throw new PublishRefusedError(`${p}${req.platform} is not enabled for publishing (Facebook joins with the day-30 rollout, off by default)`);
  }
  assertAiFlagOptions(req.platform, req.platformOptions, p);
  if (!req.mediaUrls?.length) throw new PublishRefusedError(`${p}a post needs media`);
  // A `draft` platform option is stripped by the adapter (never forwarded), so only the request mode can ask for one.
  if (req.mode === 'draft_inbox') {
    throw new PublishRefusedError(`${p}${req.platform} inbox drafts are never sent (a draft cannot carry the AI disclosure); publish directly`);
  }
  const kind = req.kind ?? 'video';
  if (kind === 'story') {
    if (!opts.storySupported(req.platform)) throw new PublishRefusedError(`${p}${req.platform} has no Stories through the API`);
    if (req.mediaUrls.length !== 1) throw new PublishRefusedError(`${p}a story is exactly one frame`);
  }
  if (req.platform === 'tiktok' && kind !== 'video') {
    throw new PublishRefusedError(`${p}a TikTok photo post cannot carry the AI disclosure; send the stills as a slideshow video`);
  }
}

/**
 * Whether a request, once published, carries the platform AI label through the API. False for a TikTok non-video or
 * draft (never sent anyway) and for any platform without an AI field (Facebook). Used by FakeZernio.verify.
 */
export function carriesAiLabel(req: PublishableRequest): boolean {
  if (req.aiLabel !== true || req.mode === 'draft_inbox') return false;
  if (req.platform === 'tiktok') return (req.kind ?? 'video') === 'video';
  return (Object.keys(AI_FLAG_FIELDS) as Platform[]).includes(req.platform as Platform);
}
