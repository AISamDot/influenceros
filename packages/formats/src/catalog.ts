import { CADENCE_BOUNDS, type StoryFrameKind } from '@ios/agents';
import { isOptionalFormat, POST_FORMATS, type PostFormat } from '@ios/core';

/**
 * The format library as the Format Plan sees it (PRD FR-4.3c): what each format is, what it costs per post on
 * all-Higgsfield media, and why it earns its place. Costs are the PRD's per-post estimates (talking via Higgsfield
 * Seedance at ~$3 is the most expensive; stills are near-free). Stream K renders the optional formats.
 */

export const FORMAT_LABEL: Readonly<Record<PostFormat, string>> = {
  talking: 'Talking reel',
  activity_text: 'Activity + on-screen text',
  voiceover: 'Voiceover reel',
  static: 'Static image post',
  carousel: 'Carousel',
  product_in_hand: 'Product in hand',
  trend_reenactment: 'Trend reenactment',
  photo_dump: 'Photo dump',
  text_note: 'Text note / quote card',
  facecam_screen: 'Facecam over screen',
  reply_comment: 'Reply to a comment',
  news_greenscreen: 'News green-screen',
  meme: 'Meme / relatable text post',
};

/** USD per post (FR-4.3c table; optional formats estimated from what they're made of). */
export const FORMAT_COST_USD: Readonly<Record<PostFormat, number>> = {
  talking: 3,
  activity_text: 0.5,
  voiceover: 1,
  static: 0.05,
  carousel: 0.2,
  product_in_hand: 0.5,
  trend_reenactment: 0.6,
  photo_dump: 0.2,
  text_note: 0.05,
  facecam_screen: 2.5,
  reply_comment: 1.5,
  news_greenscreen: 2.5,
  meme: 0.05,
};

/** Why a format is in the plan (the base reason every line starts from). */
export const FORMAT_WHY: Readonly<Record<PostFormat, string>> = {
  talking: 'trust and selling; the most expensive',
  activity_text: 'cheap reach that loops (POV, "day 3 of…")',
  voiceover: 'storyline chapters (storytime, day-in-the-life)',
  static: 'near-free; carries the story and the World Bible',
  carousel: 'top saves and shares; the best format for selling a digital product',
  product_in_hand: 'sell slots: the persona holds our own product',
  trend_reenactment: 'rides a trending movement (motion only, our character)',
  photo_dump: 'realism and parasocial trust ("camera roll" from the week)',
  text_note: 'near-free written post: a note or quote card in the persona\'s voice',
  facecam_screen: 'explainers: the persona in a corner over a screen or slides',
  reply_comment: 'answers a top comment: community and replies',
  news_greenscreen: 'reacts to a News Desk headline while it is fresh',
  meme: 'near-free relatable post that gets shared',
};

/** A story frame is one still + text: nearly free. */
export const STORY_FRAME_COST_USD = 0.05;

export const STORY_KIND_LABEL: Readonly<Record<StoryFrameKind, string>> = {
  world: 'Where I am today',
  storyline: 'Storyline beat',
  reshare: 'Feed reshare',
  engagement: 'Reply with a keyword',
  sell: 'Sell / lead magnet',
};

export const STORY_KIND_WHY: Readonly<Record<StoryFrameKind, string>> = {
  world: 'real local weather, season and place from the World Bible',
  storyline: 'continues the arc between feed posts',
  reshare: 'sends Story viewers to the newest feed post',
  engagement: 'a question or "reply with X" (the API has no stickers, so keywords DM the resource)',
  sell: 'the lead magnet or product, on sell days only',
};

export const optional = (f: PostFormat): boolean => isOptionalFormat(f);
export const ALL_FORMATS: readonly PostFormat[] = POST_FORMATS;
export { CADENCE_BOUNDS };

export const usd = (n: number): string => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const WEEKS_PER_MONTH = 52 / 12;
