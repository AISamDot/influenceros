import type { Grounding, KnowledgeHit, QcCheck, StudioServices } from '@troupe/agents';
import { type CostRef, type PostFormat, type PostPurpose, scriptShape } from '@troupe/core';
import type { Hook } from './hooks';
import { shortenHook, topicOf } from './hooks';
import type { PersonaContext } from './persona';
import { asRecord, asString, asStrings, hashInt, lowerFirst, pick, sentences, similarity, slugify, upperFirst, wordCount } from './util';

/**
 * Scriptwriter (FR-4.2): from the shipped hook, a script written for the ear (15–30 s, 40–90 words for talking and
 * voiceover), a caption, on-screen text, carousel copy, hashtags, a visual brief and the claims it makes, each
 * factual claim citing a knowledge hit id. With no knowledge it keeps to opinion and general education.
 */
export interface ScriptDraft {
  hook: string;
  /** What is said (talking / voiceover) or shown (activity, static, carousel), starting with the hook. */
  body: string;
  caption: string;
  ctaKeyword: string;
  hashtags: string[];
  onScreenText: string[];
  carousel: Array<{ title: string; body: string }> | null;
  visualBrief: string;
  claims: Array<{ text: string; evidenceId: string | null }>;
}

export interface ScriptBrief {
  readonly ctx: PersonaContext;
  readonly title: string;
  readonly pillar: string | null;
  readonly format: PostFormat;
  readonly purpose: PostPurpose;
  readonly ctaKeyword: string;
  /** What the keyword sends (lead magnet, product link). */
  readonly ctaDelivers: string;
  readonly productName?: string | null;
  readonly hook: Hook;
  readonly variants: readonly Hook[];
  readonly knowledge: readonly KnowledgeHit[];
  /** (IOS-5) Real-time grounding for when the post goes out (stream J's WorldService); null without a World Bible. */
  readonly grounding?: Grounding | null;
  /** (IOS-5) The storyline beat this slot carries (calendar_slot.meta.story), if any. */
  readonly beat?: string | null;
}

/** Formats with a voice track (talking-shaped and voiceover): the TTS text, Q2 and the talking clips. */
export const SPOKEN: readonly PostFormat[] = ['talking', 'voiceover', 'facecam_screen', 'reply_comment', 'news_greenscreen'];
const PADDING = [
  'Start small, and keep it simple.',
  "You don't need a perfect plan to begin.",
  'Do the first step today, while it is fresh.',
  'Then let the system carry the weight for you.',
];
export const WORDS = { min: 40, max: 90 } as const;
export const SECONDS = { min: 15, max: 30 } as const;
/** Max words on one on-screen line (the hook line of activity and static posts). */
export const ON_SCREEN_WORDS = { activity_text: 8, static: 10 } as const;

// ───────────────────────────── IOS-5 format library rules (stream K; FR-4.3c) ─────────────────────────────

/** Photo dump: 5–10 casual camera-roll stills (an IG carousel); each photo caption at most 8 words. */
export const PHOTO_DUMP = { min: 5, max: 10, captionWords: 8 } as const;
/** Text-on-image note / quote card: at most 25 words on the card. */
export const TEXT_NOTE_WORDS = 25;
/** Meme / relatable text post: at most 15 words. */
export const MEME_WORDS = 15;
/** Facecam over screen: 3–6 screen lines (the steps on the slides), each at most 8 words. */
export const FACECAM_LINES = { min: 3, max: 6, words: 8 } as const;
/** Reply-to-comment overlay: the comment text shown (sanitised), at most this many characters. */
export const COMMENT_OVERLAY_CHARS = 120;

/**
 * Real news outlets (and their usual short forms). The News Desk card is our own generic design: no outlet's name or
 * logo ever appears on it, and a script that names one as the source of a headline is sent back.
 */
export const REAL_OUTLETS: readonly string[] = [
  'BBC', 'CNN', 'Fox News', 'Reuters', 'Associated Press', 'AP News', 'New York Times', 'NYT', 'Washington Post', 'Wall Street Journal', 'WSJ',
  'The Guardian', 'Sky News', 'Al Jazeera', 'NBC', 'CBS', 'ABC News', 'Bloomberg', 'CNBC', 'Financial Times', 'Daily Mail', 'Mail Online',
  'The Telegraph', 'The Independent', 'Daily Mirror', 'USA Today', 'NPR', 'Politico', 'Axios', 'BuzzFeed', 'HuffPost', 'Forbes', 'Business Insider',
  'Yahoo News', 'MSNBC', 'ITV News', 'Channel 4 News', 'Daily Express', 'Times of India', 'Le Monde', 'Der Spiegel',
];
const escapeRe = (x: string): string => x.replace(/[.*+?^$()|[\]\\{}]/g, (c) => `\\${c}`).replace(/\s+/g, '\\s+');
const OUTLET_ALT = REAL_OUTLETS.map(escapeRe).join('|');
// Proper nouns: matched case-sensitively, so "the sun is out" or "a mirror selfie" never trips it.
const OUTLET_RE = new RegExp(`(?:^|[^A-Za-z])(${OUTLET_ALT})(?![A-Za-z])`);
/** The first real outlet a text names, or null. */
export function mentionsOutlet(text: string): string | null {
  const m = OUTLET_RE.exec(text);
  return m ? m[1]! : null;
}
/** Drops a trailing " - BBC News" / " | Reuters" source tag and any outlet name from a headline (our own wording). */
export function newsDeskHeadline(title: string): string {
  let t = title.replace(/\s+/g, ' ').trim();
  const tail = /\s+[|–—-]\s+([^|–—-]{2,40})$/.exec(t);
  if (tail && mentionsOutlet(tail[1]!)) t = t.slice(0, tail.index).trim();
  for (let i = 0; i < 4; i++) {
    const o = mentionsOutlet(t);
    if (!o) break;
    t = t.replace(new RegExp(escapeRe(o)), 'a news report').replace(/\s+/g, ' ').trim();
  }
  return t.slice(0, 140);
}

/**
 * A commenter's handle, anonymised for the reply-to-comment overlay: nothing of the handle survives except that it
 * was one (`@••••••`). The overlay never shows a real account name.
 */
export const anonymiseHandle = (_handle?: string | null): string => '@••••••';
/** True when a text still shows something that looks like a real @handle (anything but the anonymised form). */
export const showsHandle = (text: string): boolean => /@(?!•)[A-Za-z0-9_.]{2,}/.test(text);

/**
 * Third-party text (a viewer's comment) made safe to show on screen: links, e-mail addresses, @mentions and phone
 * numbers removed, whitespace collapsed, cut at a word boundary. Returns '' when nothing usable is left.
 */
export function sanitizeOverlay(text: string, max = COMMENT_OVERLAY_CHARS): string {
  let t = text
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+|\b\S+\.(?:com|net|org|io|co|uk|ly|me)\b\S*/gi, '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '')
    .replace(/@[A-Za-z0-9_.]+/g, '')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) t = `${t.slice(0, max).replace(/\s+\S*$/, '')}…`;
  return /[A-Za-z]{2,}/.test(t) ? t : '';
}


/** Sentences that state facts (statistics, studies, "proven"): each needs a cited knowledge hit. */
export const CLAIM_RE =
  /\b\d+(?:\.\d+)?\s?(?:%|percent)|\b(?:\d+|one|two|three|four|five|six|seven|eight|nine) (?:in|out of) (?:\d+|ten|five|four|three|a hundred)\b|\b(?:studies|study|research|researchers|scientists|science|data|surveys?|statistics|the evidence)\s+(?:show|shows|showed|says|say|suggests?|found|finds|proves?|confirms?)\b|\bscientifically\b|\b(?:clinically )?proven\b|\baccording to\b|\b(?:doctors|experts|economists|nutritionists|psychologists) (?:say|agree|recommend)\b|\bon average\b|\bthe average (?:american|person|adult|household|worker)\b/i;

export const isClaim = (sentence: string): boolean => CLAIM_RE.test(sentence);

/** The claim sentences in `text` that no valid evidence backs. */
export function uncitedClaims(text: string, claims: ScriptDraft['claims'], evidenceIds: readonly string[]): string[] {
  const valid = new Set(evidenceIds);
  return sentences(text).filter(
    (s) => isClaim(s) && !claims.some((c) => c.evidenceId && valid.has(c.evidenceId) && (s.includes(c.text) || c.text.includes(s) || similarity(s, c.text) >= 0.5)),
  );
}

/** "Paycheck Plan Starter (free)" → "the free Paycheck Plan Starter"; "the free starter guide" stays. */
export function deliverable(delivers: string): string {
  const free = /\(free\)|\bfree\b/i.test(delivers);
  const name = delivers.replace(/\s*\(free\)\s*/i, ' ').replace(/\s+link$/i, '').trim();
  if (!name) return 'the free guide';
  if (/^(?:the|a|an|my|your)\b/i.test(name)) return name;
  const titled = name.split(/\s+/).filter((w) => /^[A-Z0-9]/.test(w)).length >= Math.min(2, name.split(/\s+/).length);
  return titled ? `the ${free ? 'free ' : ''}${name}` : lowerFirst(name);
}

export function ctaLine(keyword: string, delivers: string, purpose: PostPurpose, format: PostFormat): string {
  const what = delivers ? deliverable(delivers) : 'the free guide';
  const shape = scriptShape(format);
  if (shape === 'activity_text' || shape === 'static') return purpose === 'sell' ? `Comment ${keyword} for the link` : `Comment ${keyword} for ${what}`;
  return purpose === 'sell' ? `Comment ${keyword} and I'll send you the link.` : `Comment ${keyword} and I'll send you ${what}.`;
}

function hashtagsFor(ctx: PersonaContext, pillar: string | null): string[] {
  const tag = (s: string) => `#${slugify(s).replace(/-/g, '')}`.slice(0, 30);
  const tags = [tag(ctx.persona.niche), pillar ? tag(pillar) : null, ctx.persona.sub_niche ? tag(ctx.persona.sub_niche.split(/[,;]/)[0]!.split(' ').slice(0, 2).join(' ')) : null, '#tips'];
  return [...new Set(tags.filter((t): t is string => !!t && t.length > 2))].slice(0, 5);
}

export function visualBrief(ctx: PersonaContext, format: PostFormat, title: string): string {
  const shape = scriptShape(format);
  const own = FORMAT_BRIEF[format];
  if (own) return own(ctx, title);
  if (shape !== format) return `${FORMAT_LABEL[format]}: ${visualBrief(ctx, shape, title)}`;
  const setting = pick(ctx.look.settings.length ? ctx.look.settings : ['a bright home office'], `${ctx.persona.id}:${title}:set`);
  const outfit = ctx.look.outfits.length ? `, ${lowerFirst(pick(ctx.look.outfits, `${ctx.persona.id}:${title}:fit`))}` : '';
  const who = `${ctx.persona.name} (same face as the look pack)`;
  const rules = 'No logos, brands, real people or celebrity lookalikes; no on-image text unless listed. AI-generated character: the post carries the platform AI label.';
  switch (shape) {
    case 'talking':
      return `Talking reel, 9:16, about 30 s. ${who}, chest-up in ${lower(setting)}${outfit}. ${ctx.look.stylisation}. Natural gestures, eye contact. ${rules}`;
    case 'voiceover':
      return `Voiceover reel, 9:16, about 24 s: three activity shots of ${who} in ${lower(setting)}${outfit}, matching the narration beats. ${ctx.look.stylisation}. ${rules}`;
    case 'activity_text':
      return `Activity clip, 9:16, 6–10 s loop: ${who} in ${lower(setting)}${outfit}, hands and props in frame, calm motion that loops cleanly; text overlay added in edit. ${ctx.look.stylisation}. ${rules}`;
    case 'static':
      return `Single still, 4:5: ${who} in ${lower(setting)}${outfit}, space at the top for the image line. ${ctx.look.stylisation}. ${rules}`;
    case 'carousel':
      return `Carousel, 4:5, 6–8 slides: a cover still of ${who} in ${lower(setting)}, then clean text slides in the brand palette. ${rules}`;
  }
}
const lower = (s: string) => lowerFirst(s);
const BRIEF_RULES = 'No logos, brands, real people or celebrity lookalikes; no on-image text unless listed. AI-generated character: the post carries the platform AI label.';
const briefWho = (ctx: PersonaContext) => `${ctx.persona.name} (same face as the look pack)`;
const briefSetting = (ctx: PersonaContext, title: string) => lower(pick(ctx.look.settings.length ? ctx.look.settings : ['a bright home office'], `${ctx.persona.id}:${title}:set`));
/** (IOS-5) Visual briefs for the format library: what the renderer composes, in plain words (no timecodes, no baked-in text). */
const FORMAT_BRIEF: Partial<Record<PostFormat, (ctx: PersonaContext, title: string) => string>> = {
  photo_dump: (ctx, title) =>
    `Photo dump, 4:5, 5–10 casual camera-roll stills from ${briefWho(ctx)}'s week: an arm's-length selfie, a mirror shot, a propped-phone shot in ${briefSetting(ctx, title)}, and two or three details without people (a coffee, a desk, the view). Unposed, slightly imperfect phone photos. ${ctx.look.stylisation}. ${BRIEF_RULES}`,
  text_note: (ctx) => `Text note card, 9:16: the note is typeset in the edit on a plain card in ${ctx.persona.name}'s palette; no photo generation. ${BRIEF_RULES}`,
  meme: (ctx, title) =>
    `Meme, 9:16: a reaction still of ${briefWho(ctx)} in ${briefSetting(ctx, title)}, an expressive, relatable face; the meme line is typeset in a white band above the photo in the edit. ${ctx.look.stylisation}. ${BRIEF_RULES}`,
  facecam_screen: (ctx, title) =>
    `Facecam over screen, 9:16: ${briefWho(ctx)} talking to a propped phone, head and shoulders against a plain wall in ${briefSetting(ctx, title)}, shown in a corner over clean generated slides of the steps (slide text added in the edit). ${ctx.look.stylisation}. ${BRIEF_RULES}`,
  reply_comment: (ctx, title) =>
    `Reply to a comment, 9:16: ${briefWho(ctx)} answering a viewer, chest-up in ${briefSetting(ctx, title)}, natural gestures and eye contact; the comment is shown as a sticker overlay in the edit with the handle anonymised. ${ctx.look.stylisation}. ${BRIEF_RULES}`,
  news_greenscreen: (ctx, title) =>
    `News green-screen, 9:16: ${briefWho(ctx)} reacting to a headline, head and shoulders against a plain wall in ${briefSetting(ctx, title)}, composited over our own generic News Desk headline card (never a real outlet's name or logo; the headline is added in the edit). ${ctx.look.stylisation}. ${BRIEF_RULES}`,
};
const FORMAT_LABEL: Readonly<Record<PostFormat, string>> = {
  talking: 'Talking reel',
  activity_text: 'Activity + on-screen text',
  voiceover: 'Voiceover reel',
  static: 'Static image',
  carousel: 'Carousel',
  product_in_hand: 'Product in hand (our own product as a second reference)',
  trend_reenactment: 'Trend reenactment (motion only)',
  photo_dump: 'Photo dump (5–10 casual stills, 4:5 or 1:1)',
  text_note: 'Text note / quote card',
  facecam_screen: 'Facecam over screen (persona in a corner)',
  reply_comment: 'Reply to a comment (comment overlay, handle anonymised)',
  news_greenscreen: 'News green-screen (headline card, no real outlet logo)',
  meme: 'Meme / relatable text post',
};
const slideText = (s: { title: string; body: string }) => `${s.title}${/[.!?:]$/.test(s.title) ? '' : ':'} ${s.body}`;

function stepsFor(ctx: PersonaContext, title: string, pillar: string | null): string[] {
  const key = `${title} ${pillar ?? ''}`;
  const fw = [...ctx.frameworks].sort((a, b) => similarity(b.name, key) - similarity(a.name, key)).find((f) => similarity(f.name, key) >= 0.2);
  const clean = (s: string) => s.replace(/\s*\(([^)]*)\)/g, ': $1').replace(/\s\+\s/g, ' and ').replace(/[.]+$/, '');
  if (fw && fw.steps.length >= 3) return fw.steps.slice(0, 3).map(clean);
  return ['Pick one small thing you can do today', 'Set it up once so it runs without you', 'Check in once a week and adjust'];
}

/** The first `n` words of a text, ending cleanly. */
function clipWords(text: string, n: number): string {
  const w = text.replace(/\s+/g, ' ').trim().split(' ');
  return w.length <= n ? w.join(' ') : `${w.slice(0, n).join(' ').replace(/[,;:—–-]+$/, '')}.`;
}

/** Every real outlet name in a text replaced (the News Desk never names one). */
function scrubOutlets(text: string): string {
  let t = text;
  for (let i = 0; i < 6; i++) {
    const o = mentionsOutlet(t);
    if (!o) break;
    t = t.replace(new RegExp(escapeRe(o)), 'a news report');
  }
  return t;
}

/** Casual photo-dump captions from the persona's world (deterministic; the model writes its own). */
function dumpCaptions(ctx: PersonaContext, title: string): string[] {
  const set = (ctx.look.settings.length ? ctx.look.settings : ['my kitchen', 'the desk', 'the walk home']).map((x) => lowerFirst(x).replace(/^(?:a|an|the)\s+/i, ''));
  const pool = [`Morning light in the ${set[0]}`, 'Coffee first, always', `The ${set[1 % set.length]} this week`, 'Tiny win of the week', 'The list that keeps me sane', 'Golden hour on the way home', 'Sunday reset, done'];
  const start = hashInt(`${ctx.persona.id}:${title}`) % pool.length;
  return Array.from({ length: 5 }, (_, i) => shortenHook(pool[(start + i) % pool.length]!, PHOTO_DUMP.captionWords));
}

/** Deterministic script for fake mode and the shape the model returns. */
export function fakeScript(b: ScriptBrief): ScriptDraft {
  const { ctx } = b;
  const topic = lowerFirst(topicOf(b.title));
  const steps = stepsFor(ctx, b.title, b.pillar);
  const cta = ctaLine(b.ctaKeyword, b.ctaDelivers, b.purpose, b.format);
  const catchphrase = ctx.voice.catchphrases[0] ?? 'Small steps beat big promises.';
  const claims: ScriptDraft['claims'] = [];
  const hit = b.knowledge.find((h) => h.text.trim());
  const fact = hit ? sentences(hit.text)[0]?.split(/\s+/).slice(0, 16).join(' ').replace(/[.:;,]*$/, '.') : null;
  if (hit && fact) claims.push({ text: fact, evidenceId: hit.id });
  const sell = b.purpose === 'sell' && b.productName;
  let body: string;
  let onScreenText: string[] = [];
  let carousel: ScriptDraft['carousel'] = null;
  const shape = scriptShape(b.format);
  if (SPOKEN.includes(b.format)) {
    const opener =
      b.format === 'reply_comment'
        ? `You asked me about ${topic}, so here's my honest answer.`
        : b.format === 'news_greenscreen'
          ? `Everyone's sharing this headline about ${topic}, so here's my take.`
          : b.format === 'facecam_screen'
            ? "I'll show you on screen, step by step."
            : sell
              ? `This is the ${b.productName}, and here's what's inside.`
              : `Here's the simple version of ${topic}.`;
    const lines = [
      b.hook.text,
      opener,
      `First, ${lowerFirst(steps[0]!)}.`,
      `Then, ${lowerFirst(steps[1]!)}.`,
      `Finally, ${lowerFirst(steps[2]!)}.`,
      ...(fact ? [fact] : []),
      b.purpose === 'trust' ? 'Save this so you have it when you need it.' : catchphrase,
      cta,
    ];
    body = lines.join(' ');
    onScreenText =
      b.format === 'facecam_screen'
        ? [shortenHook(b.hook.text, FACECAM_LINES.words), ...steps.map((x) => shortenHook(x, 7)), ctaLine(b.ctaKeyword, b.ctaDelivers, b.purpose, 'activity_text')]
        : b.format === 'news_greenscreen'
          ? [newsDeskHeadline(shortenHook(upperFirst(topicOf(b.title)), 12))]
          : [b.hook.text];
  } else if (shape === 'activity_text') {
    onScreenText = [shortenHook(b.hook.text, ON_SCREEN_WORDS.activity_text), ...steps.map((s) => shortenHook(s, 7)), cta];
    body = onScreenText.join('\n');
  } else if (shape === 'static') {
    onScreenText =
      b.format === 'text_note'
        ? [clipWords(`${b.hook.text} ${catchphrase}`, TEXT_NOTE_WORDS)]
        : [shortenHook(b.hook.text, b.format === 'meme' ? MEME_WORDS : ON_SCREEN_WORDS.static)];
    body = onScreenText[0]!;
  } else if (b.format === 'photo_dump') {
    carousel = [{ title: b.hook.text, body: '' }, ...dumpCaptions(ctx, b.title).map((t) => ({ title: t, body: '' }))];
    body = carousel.map((c) => c.title).join('\n');
    onScreenText = carousel.map((c) => c.title);
  } else {
    carousel = [
      { title: b.hook.text, body: sell ? `Inside the ${b.productName}.` : `Swipe for the simple version of ${topic}.` },
      ...steps.map((s, i) => ({ title: `Step ${i + 1}`, body: `${upperFirst(s)}.` })),
      { title: 'Why it works', body: fact ?? `${catchphrase}` },
      { title: 'Make it stick', body: 'Pick one step and do it this week. Then add the next.' },
      { title: 'Want the full version?', body: cta },
    ];
    body = carousel.map(slideText).join('\n');
    onScreenText = carousel.map((c) => c.title);
  }
  const caption = [
    b.hook.text,
    sell ? `The ${b.productName}: ${lowerFirst(steps[0]!)}, ${lowerFirst(steps[1]!)}, ${lowerFirst(steps[2]!)}.` : `${upperFirst(steps[0]!)}. ${upperFirst(steps[1]!)}. ${upperFirst(steps[2]!)}.`,
    cta.endsWith('.') ? cta : `${cta}.`,
  ].join('\n\n');
  return {
    hook: shape === 'activity_text' || (shape === 'static' && b.format !== 'text_note') ? onScreenText[0]! : b.hook.text,
    body,
    caption,
    ctaKeyword: b.ctaKeyword,
    hashtags: hashtagsFor(ctx, b.pillar),
    onScreenText,
    carousel,
    visualBrief: visualBrief(ctx, b.format, b.title),
    claims,
  };
}

// ─── The model's JSON shape (snake_case) ───

interface ScriptJson {
  hook: string;
  body: string;
  caption: string;
  cta_keyword: string;
  hashtags: string[];
  on_screen_text: string[];
  carousel: Array<{ title: string; body: string }> | null;
  visual_brief: string;
  claims: Array<{ text: string; evidence_id: string | null }>;
}

const SCRIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hook', 'body', 'caption', 'cta_keyword', 'hashtags', 'on_screen_text', 'carousel', 'visual_brief', 'claims'],
  properties: {
    hook: { type: 'string' },
    body: { type: 'string' },
    caption: { type: 'string' },
    cta_keyword: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
    on_screen_text: { type: 'array', items: { type: 'string' } },
    carousel: {
      anyOf: [
        { type: 'null' },
        { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'body'], properties: { title: { type: 'string' }, body: { type: 'string' } } } },
      ],
    },
    visual_brief: { type: 'string' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'evidence_id'],
        properties: { text: { type: 'string' }, evidence_id: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
      },
    },
  },
} as const;

const toJson = (d: ScriptDraft): ScriptJson => ({
  hook: d.hook,
  body: d.body,
  caption: d.caption,
  cta_keyword: d.ctaKeyword,
  hashtags: d.hashtags,
  on_screen_text: d.onScreenText,
  carousel: d.carousel,
  visual_brief: d.visualBrief,
  claims: d.claims.map((c) => ({ text: c.text, evidence_id: c.evidenceId })),
});

export function parseScriptJson(v: unknown): ScriptJson {
  const r = asRecord(v);
  const body = asString(r.body).trim();
  const hook = asString(r.hook).trim();
  if (!body || !hook) throw new Error('script needs a hook and a body');
  const carousel = Array.isArray(r.carousel)
    ? r.carousel.map((x) => asRecord(x)).map((x) => ({ title: asString(x.title).trim(), body: asString(x.body).trim() })).filter((x) => x.title || x.body)
    : null;
  return {
    hook,
    body,
    caption: asString(r.caption).trim(),
    cta_keyword: asString(r.cta_keyword).trim().toUpperCase(),
    hashtags: asStrings(r.hashtags),
    on_screen_text: asStrings(r.on_screen_text),
    carousel: carousel && carousel.length ? carousel : null,
    visual_brief: asString(r.visual_brief).trim(),
    claims: (Array.isArray(r.claims) ? r.claims : [])
      .map((x) => asRecord(x))
      .filter((x) => typeof x.text === 'string')
      .map((x) => ({ text: asString(x.text), evidence_id: typeof x.evidence_id === 'string' ? x.evidence_id : null })),
  };
}

const fromJson = (j: ScriptJson, b: ScriptBrief): ScriptDraft => ({
  hook: j.hook,
  body: j.body,
  caption: j.caption,
  // The slot's keyword is the contract with the DM automation: the model can't change it.
  ctaKeyword: b.ctaKeyword,
  hashtags: normaliseHashtags(j.hashtags),
  onScreenText: j.on_screen_text,
  carousel: j.carousel,
  visualBrief: j.visual_brief || visualBrief(b.ctx, b.format, b.title),
  claims: j.claims.map((c) => ({ text: c.text, evidenceId: c.evidence_id })),
});

export function normaliseHashtags(tags: readonly string[]): string[] {
  const out = tags
    .map((t) => `#${t.replace(/^#+/, '').replace(/[^A-Za-z0-9_]/g, '')}`)
    .filter((t) => t.length > 2)
    .map((t) => t.slice(0, 30));
  return [...new Set(out.map((t) => t.toLowerCase()))].slice(0, 5);
}

export const FORMAT_RULES: Record<PostFormat, string> = {
  talking: 'Talking reel, 15–30 s spoken: 40–90 words (aim for 55–75). The body is exactly what the persona says, starting with the hook.',
  voiceover: 'Voiceover reel, about 24 s of narration: 40–90 words (aim for 50–70), starting with the hook, over three activity shots.',
  activity_text: 'Activity + on-screen text, 6–10 s loop: 3–5 on-screen lines of at most 8 words, first line is the hook, last line is the CTA. No voice.',
  static: 'Static image + caption: one image line (the hook, at most 10 words); the caption carries the value and ends with the CTA.',
  carousel: 'Carousel, 6–8 slides: slide 1 is the hook, then one idea per slide, the last slide is the CTA.',
  // Optional formats (FR-4.3c library). Written in their script shape (FORMAT_SHAPE) until stream K gives each its own rules.
  product_in_hand: 'Product in hand, 6–10 s loop: the persona holds or uses our own product; 3–5 on-screen lines of at most 8 words, first line is the hook, last line is the CTA. No voice.',
  trend_reenactment: 'Trend reenactment, 6–10 s: the persona performs a trending movement (motion only, never the original audio); 3–5 on-screen lines, first line is the hook, last line is the CTA. No voice.',
  photo_dump: 'Photo dump, 5–10 casual camera-roll stills from the week, as carousel items: item 1 is the hook line, then one short caption per photo (at most 8 words each, no CTA item); the caption carries the story and ends with the CTA.',
  text_note: 'Text note / quote card: one note or quote of at most 25 words on a plain card, starting with the hook; the caption carries the value and ends with the CTA.',
  facecam_screen: 'Facecam over screen, 15–30 s spoken: 40–90 words while slides show the steps. The body is exactly what the persona says, starting with the hook; on_screen_text holds 3–6 slide lines of at most 8 words (hook, steps, CTA).',
  reply_comment: 'Reply to a comment, 15–30 s spoken: 40–90 words answering the top comment (shown as a sticker overlay, handle anonymised), starting with the hook. Never quote or name the commenter.',
  news_greenscreen: "News green-screen, 15–30 s spoken: 40–90 words reacting to a headline on our own News Desk card, starting with the hook. Never name a real news outlet; on_screen_text[0] is the headline in our own words.",
  meme: 'Meme / relatable text post: one relatable line of at most 15 words (the hook), typeset above a reaction photo; the caption ends with the CTA.',
};

const SCRIPT_SYSTEM = `You are the Scriptwriter. Write one short-form post for the persona, in their voice, English only, written for the ear:
short sentences, contractions, one idea per sentence, no lists read aloud, no hashtags or emoji in the spoken body.
Start with the given hook word for word. End with the CTA line using the given comment keyword exactly.
Every factual claim (statistics, studies, "research shows") must come from a supplied knowledge hit and list its id in claims;
without knowledge, keep to opinion and general education. First-person stories, situations, dramatised scenarios and lore are
character content: use them freely ("my date stood me up tonight", "day 12 of my no-buy"). Follow the studio rules: never use a
story as proof that a product works ("this workbook got me over him"), no real people or brands without permission, no
credentials, no medical cure claims, no buy/sell calls, no income guarantees, no fake scarcity, never deny being AI.`;

/** Writes a script (and, with `revise`, rewrites one to fix Q1 defects). */
export async function writeScript(
  services: StudioServices,
  b: ScriptBrief,
  opts: { costRef?: CostRef; revise?: { previous: ScriptDraft; defects: readonly QcCheck[] } } = {},
): Promise<{ draft: ScriptDraft; runId: string }> {
  const { ctx } = b;
  const knowledge = b.knowledge.length
    ? `\nKnowledge you may cite (id: text):\n${b.knowledge.map((h) => `- ${h.id}: ${h.title}. ${h.text.slice(0, 400)}`).join('\n')}`
    : '\nNo knowledge hits: no statistics or study claims; opinion and general education only.';
  const revise = opts.revise
    ? `\nRevise this draft to fix the QC defects, changing as little as possible.\nDefects:\n${opts.revise.defects.map((d) => `- [${d.severity}] ${d.check}: ${d.message}`).join('\n')}\nDraft JSON:\n${JSON.stringify(toJson(opts.revise.previous))}`
    : '';
  const res = await services.runtime.run<ScriptJson>({
    agent: 'scriptwriter',
    scope: { studioId: ctx.persona.studio_id, personaId: ctx.persona.id },
    label: opts.revise ? `script: revise (${b.format})` : `script: ${b.format}`,
    system: SCRIPT_SYSTEM,
    cached: ctx.cached,
    skills: scriptShape(b.format) === 'carousel' ? ['hook-lab', 'carousel-designer'] : ['hook-lab', 'video-prompt-pack'],
    prompt: `Idea: ${b.title}\nPillar: ${b.pillar ?? 'n/a'}\nPurpose: ${b.purpose}${b.productName ? ` (product: ${b.productName})` : ''}\nFormat: ${FORMAT_RULES[b.format]}
Hook (ship this): ${b.hook.text}\nA/B variants (for reference): ${b.variants.map((v) => v.text).join(' | ')}
CTA keyword: ${b.ctaKeyword} (sends: ${b.ctaDelivers || 'the free guide'})${b.beat ? `\nStoryline beat to carry: ${b.beat}` : ''}${
      b.grounding ? `\nGrounding (the persona's real local moment; wardrobe, light and topical references must match): ${b.grounding.block}` : ''
    }${knowledge}${revise}`,
    maxTokens: 4000,
    jsonSchema: SCRIPT_SCHEMA,
    parse: parseScriptJson,
    fake: () => toJson(opts.revise ? enforceScript(opts.revise.previous, b) : fakeScript(b)),
    costRef: opts.costRef,
  });
  const draft = fromJson(res.output, b);
  return { draft: opts.revise ? enforceScript(draft, b) : draft, runId: res.runId };
}

/**
 * The maker's deterministic fixes (the safety net after a revise): hook first, CTA present, no uncited claims,
 * no repeated lines, no off-voice words, length inside 40–90 words, 3–5 on-screen lines, 6–8 carousel slides,
 * 3–5 hashtags.
 */
export function enforceScript(d: ScriptDraft, b: Pick<ScriptBrief, 'ctx' | 'format' | 'purpose' | 'ctaKeyword' | 'ctaDelivers' | 'knowledge' | 'title' | 'pillar'>): ScriptDraft {
  const evidence = b.knowledge.map((h) => h.id);
  const cta = ctaLine(b.ctaKeyword, b.ctaDelivers, b.purpose, b.format);
  const hasCta = (s: string) => new RegExp(`\\b${b.ctaKeyword}\\b`).test(s);
  const avoid = b.ctx.voice.avoid.map((w) => w.toLowerCase()).filter(Boolean);
  const offVoice = (s: string) => avoid.some((w) => s.toLowerCase().includes(w));
  const claims = d.claims.filter((c) => c.evidenceId && evidence.includes(c.evidenceId));
  const hookSentences = Math.max(1, sentences(d.hook).length);
  const opensWithHook = (lines: readonly string[]) => {
    const opening = lines.slice(0, hookSentences).join(' ');
    return !!opening && (opening.startsWith(d.hook) || similarity(opening, d.hook) >= 0.8);
  };
  const clean = (lines: string[], keepFirst = true) => {
    const out: string[] = [];
    for (const [i, s] of lines.entries()) {
      const isHook = keepFirst && i < hookSentences;
      if (!isHook && (uncitedClaims(s, claims, evidence).length || offVoice(s))) continue;
      if (out.some((o) => o.toLowerCase() === s.toLowerCase())) continue;
      out.push(s);
    }
    return out;
  };
  const filler = stepsFor(b.ctx, b.title, b.pillar).map((s) => `${upperFirst(s)}.`);
  let hook = d.hook;
  let body = d.body;
  let onScreenText = [...d.onScreenText];
  let carousel = d.carousel ? [...d.carousel] : null;
  const shape = scriptShape(b.format);

  if (SPOKEN.includes(b.format)) {
    let lines = clean(sentences(body));
    if (!opensWithHook(lines)) lines.unshift(d.hook);
    lines = lines.filter((s, i) => i === 0 || !hasCta(s));
    const total = () => wordCount([...lines, cta].join(' '));
    while (total() > WORDS.max - 5 && lines.length > 2) lines.splice(lines.length - 1, 1);
    for (const f of filler) if (total() < WORDS.min + 5 && !lines.includes(f)) lines.push(f);
    for (const f of PADDING) if (total() < WORDS.min + 5 && !lines.includes(f)) lines.push(f);
    body = [...lines, cta].join(' ');
    if (!onScreenText.length) onScreenText = [d.hook];
    if (b.format === 'facecam_screen') {
      // 3–6 slide lines of at most 8 words: the hook, the steps, the CTA last.
      const short = cta.replace(/\s+and I'll send you.*$/i, '').replace(/[.]$/, '');
      let slides = clean(onScreenText, false)
        .filter((x) => !hasCta(x))
        .map((x) => shortenHook(x, FACECAM_LINES.words));
      if (!slides[0] || similarity(slides[0], shortenHook(d.hook, FACECAM_LINES.words)) < 0.8) slides.unshift(shortenHook(d.hook, FACECAM_LINES.words));
      slides = slides.slice(0, FACECAM_LINES.max - 1);
      for (const f of filler) if (slides.length < FACECAM_LINES.min - 1 && !slides.includes(shortenHook(f, 7))) slides.push(shortenHook(f, 7));
      onScreenText = [...slides, shortenHook(short, FACECAM_LINES.words)];
    }
    if (b.format === 'news_greenscreen') {
      onScreenText = [newsDeskHeadline(onScreenText[0] && onScreenText[0] !== d.hook ? onScreenText[0] : upperFirst(topicOf(b.title))), ...onScreenText.slice(1)];
      body = scrubOutlets(body);
    }
  } else if (shape === 'activity_text') {
    hook = shortenHook(d.hook, ON_SCREEN_WORDS.activity_text);
    let lines = clean(onScreenText.length ? onScreenText : sentences(body), false).map((s) => shortenHook(s, ON_SCREEN_WORDS.activity_text));
    lines = lines.filter((s) => similarity(s, hook) < 0.8 && similarity(s, d.hook) < 0.8 && !hasCta(s));
    lines = [hook, ...lines].slice(0, 4);
    for (const f of filler) if (lines.length < 3 && !lines.includes(shortenHook(f, 7))) lines.push(shortenHook(f, 7));
    onScreenText = [...lines, cta];
    body = onScreenText.join('\n');
  } else if (shape === 'static') {
    if (b.format === 'text_note') {
      const note = (onScreenText[0] ?? body).trim();
      const opens = note.startsWith(d.hook) || similarity(note.slice(0, d.hook.length + 10), d.hook) >= 0.8;
      onScreenText = [clipWords(opens ? note : `${d.hook} ${note}`, TEXT_NOTE_WORDS)];
    } else {
      hook = shortenHook(d.hook, b.format === 'meme' ? MEME_WORDS : ON_SCREEN_WORDS.static);
      onScreenText = [hook];
    }
    body = onScreenText[0]!;
  } else if (b.format === 'photo_dump') {
    const source = (carousel?.length ? carousel.map((x) => x.title) : onScreenText.length ? onScreenText : sentences(body)).map((x) => x.trim()).filter(Boolean);
    let items = clean(source, false).filter((x) => !hasCta(x) && !uncitedClaims(x, claims, evidence).length);
    if (!items[0] || similarity(items[0], d.hook) < 0.8) items.unshift(d.hook);
    items = [items[0]!, ...items.slice(1).map((x) => shortenHook(x, PHOTO_DUMP.captionWords))].slice(0, PHOTO_DUMP.max);
    for (const c of dumpCaptions(b.ctx, b.title)) if (items.length < PHOTO_DUMP.min + 1 && !items.includes(c)) items.push(c);
    carousel = items.map((t) => ({ title: t, body: '' }));
    onScreenText = [...items];
    body = items.join('\n');
  } else {
    let slides = (carousel ?? []).filter((s) => !uncitedClaims(`${s.title}. ${s.body}`, claims, evidence).length && !offVoice(`${s.title} ${s.body}`));
    if (!slides[0] || similarity(slides[0].title, d.hook) < 0.8) slides.unshift({ title: d.hook, body: 'Swipe for the simple version.' });
    slides = slides.filter((s, i) => i === 0 || !hasCta(`${s.title} ${s.body}`)).slice(0, 7);
    let k = 0;
    while (slides.length < 5) slides.push({ title: `Step ${++k}`, body: filler[(k - 1) % filler.length]! });
    slides.push({ title: 'Want the full version?', body: cta });
    carousel = slides;
    onScreenText = slides.map((s) => s.title);
    body = slides.map(slideText).join('\n');
  }

  let caption = d.caption.trim() || d.hook;
  if (b.format === 'news_greenscreen') caption = scrubOutlets(caption);
  caption = sentences(caption)
    .filter((s) => !uncitedClaims(s, claims, evidence).length)
    .join(' ');
  if (!hasCta(caption)) caption = `${caption}\n\n${cta.endsWith('.') ? cta : `${cta}.`}`;
  caption = caption.slice(0, 2000);
  const hashtags = normaliseHashtags(d.hashtags.length >= 3 ? d.hashtags : [...d.hashtags, ...hashtagsFor(b.ctx, b.pillar)]);
  return { ...d, hook, body, caption, ctaKeyword: b.ctaKeyword, hashtags, onScreenText, carousel, claims };
}
