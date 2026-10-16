import { CAMERA_STYLES, type CameraStyle, type MonetisationPattern } from '@ios/agents';
import type { PostFormat } from '@ios/core';

/**
 * Deterministic classifiers over scraped text and metadata: the fake analysis in tests and fake mode, and the
 * fallback when a live analysis leaves a field out. They read untrusted text but only ever return our own labels
 * (never copied text), so nothing scraped flows out verbatim.
 */

/** The hook-template library (PRD §3.15.7) plus a few common shapes. */
export const HOOK_TYPES = [
  'three_mistakes',
  'do_this_instead',
  'myth_vs_fact',
  'ranking',
  'story',
  'pov',
  'quiz',
  'beginner_guide',
  'reaction',
  'list',
  'question',
  'transformation',
  'other',
] as const;
export type HookType = (typeof HOOK_TYPES)[number];

export const HOOK_LABEL: Readonly<Record<HookType, string>> = {
  three_mistakes: '3 mistakes',
  do_this_instead: 'Do this instead',
  myth_vs_fact: 'Myth vs fact',
  ranking: 'Ranking',
  story: 'Story hook',
  pov: 'POV',
  quiz: 'Quiz',
  beginner_guide: 'Beginner guide',
  reaction: 'Reaction',
  list: 'Numbered list',
  question: 'Question',
  transformation: 'Before / after',
  other: 'Other',
};

export const CTA_KINDS = ['comment_keyword', 'link_in_bio', 'follow', 'save', 'share', 'none'] as const;
export type CtaKind = (typeof CTA_KINDS)[number];

export type MonetisationKind = MonetisationPattern['kind'];

const first = (s: string | null | undefined): string => (s ?? '').split(/\n/)[0]!.trim();

export function classifyHook(caption: string | null, transcript: string | null): HookType {
  const t = `${first(transcript)} ${first(caption)}`.toLowerCase();
  if (/\b\d+\s+(?:big\s+|common\s+)?mistakes?\b|\bmistakes? (?:everyone|you|people)\b/.test(t)) return 'three_mistakes';
  if (/\binstead\b|\bstop doing\b|\bdon['’]?t do (?:this|that)\b/.test(t)) return 'do_this_instead';
  if (/\bmyths?\b|\bfact\b|\bactually true\b/.test(t)) return 'myth_vs_fact';
  if (/\brank(?:ing|ed)?\b|\btier list\b|\bworst to best\b|\bbest to worst\b/.test(t)) return 'ranking';
  if (/^\s*pov\b|\bpov:/.test(t)) return 'pov';
  if (/\bstory ?time\b|\bthe day i\b|\bwhen i was\b|\byears ago\b/.test(t)) return 'story';
  if (/\bquiz\b|\bguess\b|\bcan you (?:spot|tell|name)\b/.test(t)) return 'quiz';
  if (/\bbeginners?\b|\bstart here\b|\b101\b|\bstep[- ]by[- ]step\b/.test(t)) return 'beginner_guide';
  if (/\breact(?:ing|ion)\b|\breplying to\b|\bstitch\b|\bduet\b/.test(t)) return 'reaction';
  if (/\bbefore (?:and|&|\/) after\b|\btransformation\b|\bglow ?up\b/.test(t)) return 'transformation';
  if (/\b\d+\s+(?:things|ways|tips|signs|reasons|habits|rules)\b/.test(t)) return 'list';
  if (/\?\s*$/.test(first(transcript) || first(caption))) return 'question';
  return 'other';
}

/**
 * Our PostFormat for a scraped post. Videos: spoken to camera → talking; spoken over B-roll (POV / day-in-the-life
 * narration) → voiceover; no speech → activity_text; plus the optional formats when their cues are clear.
 * Stills: meme, text_note or static. Carousels: photo_dump (casual camera-roll) or carousel (slides).
 */
export function classifyFormat(p: { kind: 'video' | 'image' | 'carousel'; caption: string | null; transcript: string | null; durationS: number | null }): PostFormat {
  const c = `${p.caption ?? ''}`.toLowerCase();
  if (p.kind === 'carousel') return /\bdump\b|\bcamera roll\b|\brecap\b|\bweek in\b|\bweekend\b|\blately\b/.test(c) ? 'photo_dump' : 'carousel';
  if (p.kind === 'image') {
    if (/\bme when\b|\bnobody:|\bwhen you\b|\brelatable\b|😂|🤣/.test(c)) return 'meme';
    if (/\bquote\b|\breminder\b|\bnote to self\b|\bread this\b/.test(c)) return 'text_note';
    return 'static';
  }
  if (/\breplying to\b|\breply to @|\banswering your\b/.test(c)) return 'reply_comment';
  if (/\bbreaking\b|\bheadline\b|\bjust announced\b|\bnews\b/.test(c)) return 'news_greenscreen';
  if (/\bspreadsheet\b|\bscreen ?record|\bwatch me (?:build|set up)\b|\bin the app\b/.test(c)) return 'facecam_screen';
  if (/\btrend\b|\bchallenge\b|\blip ?sync\b|\bdance\b/.test(c)) return 'trend_reenactment';
  const words = (p.transcript ?? '').split(/\s+/).filter(Boolean).length;
  const wps = p.durationS && p.durationS > 0 ? words / p.durationS : words > 0 ? 2 : 0;
  if (wps >= 1.2) return /\bpov\b|\bday in (?:my|the) life\b|\bvlog\b|\bcome with me\b/.test(c) ? 'voiceover' : 'talking';
  return 'activity_text';
}

export function classifyCamera(caption: string | null, transcript: string | null): CameraStyle | 'unknown' {
  const t = `${caption ?? ''} ${transcript ?? ''}`.toLowerCase();
  const rules: Array<[RegExp, CameraStyle]> = [
    [/\bmirror\b/, 'mirror'],
    [/\bin the car\b|\bdashcam\b|\bcar (?:chat|talk)\b/, 'dashcam'],
    [/\bwalk(?:ing)? (?:and|&) talk\b|\bon my walk\b|\bwalk with me\b/, 'walk_and_talk'],
    [/\bselfie\b|\bfront camera\b/, 'selfie'],
    [/\bpropped\b|\btripod\b|\bon the counter\b/, 'propped_phone'],
    [/\bover (?:the|my) shoulder\b/, 'over_shoulder'],
    [/\bdoorway\b|\bpeek\b/, 'doorway_peek'],
  ];
  for (const [re, style] of rules) if (re.test(t)) return style;
  return t.trim() ? 'handheld' : 'unknown';
}
export const isCameraStyle = (s: string): s is CameraStyle => (CAMERA_STYLES as readonly string[]).includes(s);

export function classifyCta(caption: string | null, transcript: string | null): CtaKind {
  const t = `${caption ?? ''} ${transcript ?? ''}`;
  if (/\bcomment\s+["“'‘]?[A-Z]{3,}\b|\bcomment (?:the word|below)\b|\btype ["“']?[A-Z]{3,}\b/.test(t)) return 'comment_keyword';
  if (/\blink in (?:my )?bio\b/i.test(t)) return 'link_in_bio';
  if (/\bsave (?:this|it|for later)\b/i.test(t)) return 'save';
  if (/\bshare (?:this|with)\b|\bsend (?:this|it) to\b/i.test(t)) return 'share';
  if (/\bfollow (?:for|me)\b/i.test(t)) return 'follow';
  return 'none';
}

const GENERIC_TAGS = new Set(['fyp', 'foryou', 'foryoupage', 'viral', 'reels', 'reel', 'explore', 'trending', 'tiktok', 'instagram', 'instagood', 'xyzbca', 'fy']);

/** A post's topic: its most specific hashtag (not the niche's own tag, not a generic one); null when none. */
export function classifyTopic(hashtags: readonly string[], nicheTags: readonly string[] = []): string | null {
  const skip = new Set([...GENERIC_TAGS, ...nicheTags.map((t) => t.toLowerCase().replace(/^#/, ''))]);
  return hashtags.find((h) => !skip.has(h.toLowerCase())) ?? null;
}

/** Monetisation signals from an account's bio, link and recent captions (PRD §3.15.10, §3.15.11). */
export function classifyMonetisation(x: { bio: string | null; externalUrl: string | null; captions: readonly (string | null)[] }): Array<{ kind: MonetisationKind; note: string }> {
  const bio = `${x.bio ?? ''} ${x.externalUrl ?? ''}`.toLowerCase();
  const caps = x.captions.filter(Boolean).join('\n').toLowerCase();
  const all = `${bio}\n${caps}`;
  const out: Array<{ kind: MonetisationKind; note: string }> = [];
  const add = (kind: MonetisationKind, note: string) => {
    if (!out.some((o) => o.kind === kind)) out.push({ kind, note });
  };
  if (/fanvue\.com|\bfanvue\b/.test(all)) add('fanvue', 'subscription page on Fanvue');
  if (/patreon\.com|substack\.com|skool\.com|\bmembership\b|\bprivate community\b/.test(all)) add('membership', 'paid membership or community');
  if (/gumroad|stan\.store|lemonsqueezy|payhip|etsy\.com|\be-?book\b|\bworkbook\b|\btemplate\b|\bplanner\b|\bcourse\b|\bguide\b/.test(all)) add('digital_product', 'sells a digital product (guide, template, planner or course)');
  if (/#ad\b|#sponsored|paid partnership|\bpartner(?:ed)? with\b|\buse (?:my )?code\b|\bdiscount code\b|\bcollab\b/.test(all)) add('brand_deal', 'brand partnerships with disclosed codes or #ad');
  if (/amzn\.to|amazon\.com\/shop|\bltk\b|liketoknow|\baffiliate\b|\bcommission\b/.test(all)) add('affiliate', 'affiliate links (storefront or shop links)');
  if (x.externalUrl || /linktr\.ee|beacons\.ai|lnk\.bio|\blink in bio\b/.test(all)) add('bio_link', 'a link-in-bio hub');
  return out;
}

/** A short structure line for a post, from its hook type and CTA. Our words. */
export function structureOf(hook: HookType, cta: CtaKind, kind: 'video' | 'image' | 'carousel'): string {
  const body: Record<HookType, string> = {
    three_mistakes: 'hook → three mistakes, one line each → the fix',
    do_this_instead: 'hook (stop doing X) → the better way → proof of ease',
    myth_vs_fact: 'myth stated → why people believe it → the fact',
    ranking: 'hook → items ranked worst to best → the winner',
    story: 'story hook → situation → turn → lesson',
    pov: 'POV caption → acted moment → relatable payoff',
    quiz: 'question to the viewer → pause → answer',
    beginner_guide: 'hook → steps in order → first action',
    reaction: 'source moment → reaction → our take',
    list: 'hook → numbered items → wrap-up',
    question: 'question hook → answer → takeaway',
    transformation: 'before → process → after',
    other: 'hook → body → close',
  };
  const shape = kind === 'carousel' ? 'slides: ' : kind === 'image' ? 'single image: ' : '';
  const close = cta === 'none' ? '' : ` → CTA (${cta.replace(/_/g, ' ')})`;
  return `${shape}${body[hook]}${close}`;
}
