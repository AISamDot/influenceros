import type { KnowledgeHit, QcCheck, StudioServices } from '@ios/agents';
import type { CostRef, PostFormat, PostPurpose } from '@ios/core';
import type { Hook } from './hooks';
import { shortenHook, topicOf } from './hooks';
import type { PersonaContext } from './persona';
import { asRecord, asString, asStrings, lowerFirst, pick, sentences, similarity, slugify, upperFirst, wordCount } from './util';

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
}

export const SPOKEN: readonly PostFormat[] = ['talking', 'voiceover'];
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
  if (format === 'activity_text' || format === 'static') return purpose === 'sell' ? `Comment ${keyword} for the link` : `Comment ${keyword} for ${what}`;
  return purpose === 'sell' ? `Comment ${keyword} and I'll send you the link.` : `Comment ${keyword} and I'll send you ${what}.`;
}

function hashtagsFor(ctx: PersonaContext, pillar: string | null): string[] {
  const tag = (s: string) => `#${slugify(s).replace(/-/g, '')}`.slice(0, 30);
  const tags = [tag(ctx.persona.niche), pillar ? tag(pillar) : null, ctx.persona.sub_niche ? tag(ctx.persona.sub_niche.split(/[,;]/)[0]!.split(' ').slice(0, 2).join(' ')) : null, '#tips'];
  return [...new Set(tags.filter((t): t is string => !!t && t.length > 2))].slice(0, 5);
}

export function visualBrief(ctx: PersonaContext, format: PostFormat, title: string): string {
  const setting = pick(ctx.look.settings.length ? ctx.look.settings : ['a bright home office'], `${ctx.persona.id}:${title}:set`);
  const outfit = ctx.look.outfits.length ? `, ${lowerFirst(pick(ctx.look.outfits, `${ctx.persona.id}:${title}:fit`))}` : '';
  const who = `${ctx.persona.name} (same face as the look pack)`;
  const rules = 'No logos, brands, real people or celebrity lookalikes; no on-image text unless listed. AI-generated character: the post carries the platform AI label.';
  switch (format) {
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
const slideText = (s: { title: string; body: string }) => `${s.title}${/[.!?:]$/.test(s.title) ? '' : ':'} ${s.body}`;

function stepsFor(ctx: PersonaContext, title: string, pillar: string | null): string[] {
  const key = `${title} ${pillar ?? ''}`;
  const fw = [...ctx.frameworks].sort((a, b) => similarity(b.name, key) - similarity(a.name, key)).find((f) => similarity(f.name, key) >= 0.2);
  const clean = (s: string) => s.replace(/\s*\(([^)]*)\)/g, ': $1').replace(/\s\+\s/g, ' and ').replace(/[.]+$/, '');
  if (fw && fw.steps.length >= 3) return fw.steps.slice(0, 3).map(clean);
  return ['Pick one small thing you can do today', 'Set it up once so it runs without you', 'Check in once a week and adjust'];
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
  if (b.format === 'talking' || b.format === 'voiceover') {
    const lines = [
      b.hook.text,
      sell ? `This is the ${b.productName}, and here's what's inside.` : `Here's the simple version of ${topic}.`,
      `First, ${lowerFirst(steps[0]!)}.`,
      `Then, ${lowerFirst(steps[1]!)}.`,
      `Finally, ${lowerFirst(steps[2]!)}.`,
      ...(fact ? [fact] : []),
      b.purpose === 'trust' ? 'Save this so you have it when you need it.' : catchphrase,
      cta,
    ];
    body = lines.join(' ');
    onScreenText = [b.hook.text];
  } else if (b.format === 'activity_text') {
    onScreenText = [shortenHook(b.hook.text, ON_SCREEN_WORDS.activity_text), ...steps.map((s) => shortenHook(s, 7)), cta];
    body = onScreenText.join('\n');
  } else if (b.format === 'static') {
    onScreenText = [shortenHook(b.hook.text, ON_SCREEN_WORDS.static)];
    body = onScreenText[0]!;
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
    hook: b.format === 'activity_text' || b.format === 'static' ? onScreenText[0]! : b.hook.text,
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

const FORMAT_RULES: Record<PostFormat, string> = {
  talking: 'Talking reel, 15–30 s spoken: 40–90 words (aim for 55–75). The body is exactly what the persona says, starting with the hook.',
  voiceover: 'Voiceover reel, about 24 s of narration: 40–90 words (aim for 50–70), starting with the hook, over three activity shots.',
  activity_text: 'Activity + on-screen text, 6–10 s loop: 3–5 on-screen lines of at most 8 words, first line is the hook, last line is the CTA. No voice.',
  static: 'Static image + caption: one image line (the hook, at most 10 words); the caption carries the value and ends with the CTA.',
  carousel: 'Carousel, 6–8 slides: slide 1 is the hook, then one idea per slide, the last slide is the CTA.',
};

const SCRIPT_SYSTEM = `You are the Scriptwriter. Write one short-form post for the persona, in their voice, English only, written for the ear:
short sentences, contractions, one idea per sentence, no lists read aloud, no hashtags or emoji in the spoken body.
Start with the given hook word for word. End with the CTA line using the given comment keyword exactly.
Every factual claim (statistics, studies, "research shows") must come from a supplied knowledge hit and list its id in claims;
without knowledge, keep to opinion and general education. Follow the studio rules: no income or results claims, no credentials,
no medical cure claims, no buy/sell calls, no fake scarcity, never deny being AI.`;

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
    skills: b.format === 'carousel' ? ['hook-lab', 'carousel-designer'] : ['hook-lab', 'video-prompt-pack'],
    prompt: `Idea: ${b.title}\nPillar: ${b.pillar ?? 'n/a'}\nPurpose: ${b.purpose}${b.productName ? ` (product: ${b.productName})` : ''}\nFormat: ${FORMAT_RULES[b.format]}
Hook (ship this): ${b.hook.text}\nA/B variants (for reference): ${b.variants.map((v) => v.text).join(' | ')}
CTA keyword: ${b.ctaKeyword} (sends: ${b.ctaDelivers || 'the free guide'})${knowledge}${revise}`,
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
  } else if (b.format === 'activity_text') {
    hook = shortenHook(d.hook, ON_SCREEN_WORDS.activity_text);
    let lines = clean(onScreenText.length ? onScreenText : sentences(body), false).map((s) => shortenHook(s, ON_SCREEN_WORDS.activity_text));
    lines = lines.filter((s) => similarity(s, hook) < 0.8 && similarity(s, d.hook) < 0.8 && !hasCta(s));
    lines = [hook, ...lines].slice(0, 4);
    for (const f of filler) if (lines.length < 3 && !lines.includes(shortenHook(f, 7))) lines.push(shortenHook(f, 7));
    onScreenText = [...lines, cta];
    body = onScreenText.join('\n');
  } else if (b.format === 'static') {
    hook = shortenHook(d.hook, ON_SCREEN_WORDS.static);
    onScreenText = [hook];
    body = hook;
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
  caption = sentences(caption)
    .filter((s) => !uncitedClaims(s, claims, evidence).length)
    .join(' ');
  if (!hasCta(caption)) caption = `${caption}\n\n${cta.endsWith('.') ? cta : `${cta}.`}`;
  caption = caption.slice(0, 2000);
  const hashtags = normaliseHashtags(d.hashtags.length >= 3 ? d.hashtags : [...d.hashtags, ...hashtagsFor(b.ctx, b.pillar)]);
  return { ...d, hook, body, caption, ctaKeyword: b.ctaKeyword, hashtags, onScreenText, carousel, claims };
}
