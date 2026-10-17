import type { StudioServices } from '@troupe/agents';
import type { CostRef, PostFormat, PostPurpose } from '@troupe/core';
import { gateRules } from './gate';
import type { PersonaContext } from './persona';
import { asString, clamp, lowerFirst, similarity, upperFirst, wordCount } from './util';

/**
 * Hook-lab (FR-4.2, hook-lab skill): 10 hooks per idea across 10 types, scored, then 1 shipped plus 2 A/B variants
 * of different types. The model writes the hooks (and may self-score them); the score that decides is computed
 * here in code, so it's deterministic, explainable and identical on fakes.
 */
export const HOOK_TYPES = ['question', 'contrarian', 'number', 'pov', 'story', 'mistake', 'curiosity_gap', 'myth_bust', 'callout', 'how_to'] as const;
export type HookType = (typeof HOOK_TYPES)[number];

export interface Hook {
  readonly text: string;
  readonly type: HookType;
  readonly score: number;
  readonly reasons: readonly string[];
  /** Set when the hook can't ship (compliance, banned by the bible, duplicate). */
  readonly excluded?: string;
  readonly modelScore?: number;
}

export interface HookLab {
  /** All 10, best first. */
  readonly hooks: readonly Hook[];
  readonly shipped: Hook;
  /** Two A/B variants, each a different type from the shipped hook and from each other. */
  readonly variants: readonly Hook[];
  readonly runId: string | null;
}

interface RawHook {
  text: string;
  type: HookType;
  self_score?: number;
}

/** The idea's topic as a phrase ("POV: payday, and…" → "payday, and…"). */
export function topicOf(title: string): string {
  return title
    .replace(/^(?:pov|walkthrough|storytime|story ?time|day \d+ of|part \d+|reveal|teaser|faq|last call|how to|free|it'?s here|something i'?ve been building|launch (?:code|price) ends [\d-]+|would this help\?)\s*[:\-–]?\s*/i, '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s*[:,]\s*(?:your questions,? answered|the checklist|explained in 30 seconds|what nobody mentions|three quick wins|step by step)\s*$/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
}

const HOOK_TAIL_STOP = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'for', 'with', 'in', 'on', 'at', 'is', 'your', 'my', 'this', 'that']);
/** A hook that fits an on-screen line: parentheticals dropped, cut at a clause break, else the first `max` words. */
export function shortenHook(text: string, max: number): string {
  let t = text.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  if (wordCount(t) <= max) return t;
  // The longest prefix that ends at a clause break and still fits.
  const parts = t.split(/(?<=[:,;—–])\s+/);
  let prefix = '';
  for (const part of parts) {
    const next = prefix ? `${prefix} ${part}` : part;
    if (wordCount(next) > max) break;
    prefix = next;
  }
  if (wordCount(prefix) >= 3) return prefix.replace(/[,:;—–\s]+$/, '');
  const w = t.split(' ').slice(0, max);
  while (w.length > 3 && HOOK_TAIL_STOP.has(w.at(-1)!.toLowerCase().replace(/[^a-z]/g, ''))) w.pop();
  t = w.join(' ').replace(/[,:;—–-]+$/, '');
  return t;
}

function callout(pain: string | undefined, topic: string): string {
  const p = pain?.replace(/^["“]|["”]$/g, '').trim();
  if (!p) return `If ${topic} feels hard, watch this.`;
  if (/^(where|what|how|why|when|who)\b/i.test(p)) return `If you keep asking "${p.replace(/\?$/, '')}?", watch this.`;
  if (/^(i|i'm|my)\b/i.test(p)) return `If "${p}" sounds like you, watch this.`;
  return `If you're ${lowerFirst(p)}, watch this.`;
}

/** Deterministic hooks for fake mode: one per type, built from the idea and the persona's own language. */
export function fakeHooks(title: string, ctx: Pick<PersonaContext, 'audience' | 'persona'>): RawHook[] {
  const topic = topicOf(title);
  const t = lowerFirst(topic);
  const pain = ctx.audience.language[0] ?? ctx.audience.pains[0];
  return [
    { type: 'question', text: `What if ${t} took ten minutes a week?` },
    { type: 'contrarian', text: `Unpopular opinion: ${t} beats more willpower.` },
    { type: 'number', text: `Three things nobody tells you about ${t}.` },
    { type: 'pov', text: `POV: you finally get ${t}.` },
    { type: 'story', text: `Quick story about ${t}.` },
    { type: 'mistake', text: `Stop doing ${t} the hard way.` },
    { type: 'curiosity_gap', text: `Nobody talks about this part of ${t}.` },
    { type: 'myth_bust', text: `${upperFirst(t)} isn't what you think.` },
    { type: 'callout', text: callout(pain, t) },
    { type: 'how_to', text: `${upperFirst(t)}, in three simple steps.` },
  ];
}

const CLICKBAIT = /\b(secret|shocking|you won'?t believe|insane|mind[- ]blowing|they don'?t want you to know)\b/i;
const INTERRUPT = /^\s*(stop|pov|nobody|unpopular|don'?t|quit|the biggest|wait)\b/i;

/** Scores one hook 0–100 with reasons. Compliance, the bible's banned hooks and near-duplicates exclude it. */
export function scoreHook(
  h: { text: string; type: HookType; self_score?: number },
  ctx: Pick<PersonaContext, 'voice' | 'hookLibrary' | 'bannedHooks'>,
  recent: readonly string[] = [],
  recentTypes: readonly HookType[] = [],
): Hook {
  const reasons: string[] = [];
  let s = 50;
  const n = wordCount(h.text);
  if (n <= 8) (s += 15), reasons.push('short (≤ 8 words)');
  else if (n <= 12) (s += 10), reasons.push('tight (≤ 12 words)');
  else if (n <= 16) s += 2;
  else (s -= 15), reasons.push('too long to land in 2 s');
  if (/\byou(r|'re|'ll)?\b/i.test(h.text)) (s += 8), reasons.push('talks to the viewer');
  if (/\?\s*$/.test(h.text)) (s += 4), reasons.push('opens a question');
  if (INTERRUPT.test(h.text)) (s += 7), reasons.push('pattern interrupt');
  if (/\d|\b(three|five|seven|ten)\b/i.test(h.text)) (s += 5), reasons.push('specific number');
  const lex = ctx.voice.lexicon.find((w) => w && h.text.toLowerCase().includes(w.toLowerCase()));
  if (lex) (s += 6), reasons.push(`persona word "${lex}"`);
  if (ctx.hookLibrary.some((lib) => similarity(lib, h.text) >= 0.3)) (s += 4), reasons.push('close to a proven hook');
  if (CLICKBAIT.test(h.text)) (s -= 10), reasons.push('clickbait wording');
  const fatigue = recentTypes.slice(0, 6).filter((t) => t === h.type).length;
  if (fatigue) (s -= 5 * fatigue), reasons.push(`${h.type} shipped ${fatigue}× lately`);
  const avoid = ctx.voice.avoid.find((w) => w && h.text.toLowerCase().includes(w.toLowerCase()));
  if (avoid) (s -= 20), reasons.push(`off-voice word "${avoid}"`);
  let excluded: string | undefined;
  const red = gateRules({ text: h.text, kind: 'script' }).find((c) => c.verdict === 'red');
  if (red) excluded = `compliance: ${red.rule}`;
  const banned = ctx.bannedHooks.find((b) => {
    const key = b.replace(/\(.*?\)|["“”]/g, '').trim();
    return key.length > 3 && similarity(key, h.text) >= 0.5;
  });
  if (!excluded && banned) excluded = `banned by the bible: ${banned}`;
  const dupe = recent.find((r) => similarity(r, h.text) >= 0.7);
  if (!excluded && dupe) excluded = 'too close to a recent hook';
  let score = clamp(Math.round(s), 0, 100);
  const modelScore = typeof h.self_score === 'number' && Number.isFinite(h.self_score) ? clamp(Math.round(h.self_score), 0, 100) : undefined;
  if (modelScore !== undefined) score = Math.round(0.7 * score + 0.3 * modelScore);
  return { text: h.text.trim(), type: h.type, score: excluded ? 0 : score, reasons, ...(excluded ? { excluded } : {}), ...(modelScore !== undefined ? { modelScore } : {}) };
}

/** Best non-excluded hook ships; the next two of different types are the A/B variants. */
export function selectHooks(hooks: readonly Hook[]): { shipped: Hook; variants: Hook[] } {
  const ranked = [...hooks].sort((a, b) => b.score - a.score || HOOK_TYPES.indexOf(a.type) - HOOK_TYPES.indexOf(b.type));
  const ok = ranked.filter((h) => !h.excluded);
  if (!ok.length) throw new Error('hook-lab: every hook was excluded');
  const shipped = ok[0]!;
  const variants: Hook[] = [];
  for (const h of ok.slice(1)) {
    if (variants.length === 2) break;
    if (h.type !== shipped.type && !variants.some((v) => v.type === h.type)) variants.push(h);
  }
  for (const h of ok.slice(1)) {
    if (variants.length === 2) break;
    if (!variants.includes(h)) variants.push(h);
  }
  return { shipped, variants };
}

const HOOKS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hooks'],
  properties: {
    hooks: {
      type: 'array',
      description: 'Exactly 10 hooks, one per type.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'type', 'self_score'],
        properties: { text: { type: 'string' }, type: { type: 'string', enum: [...HOOK_TYPES] }, self_score: { type: 'number' } },
      },
    },
  },
} as const;

export function parseHooks(v: unknown): { hooks: RawHook[] } {
  const list = (v as { hooks?: unknown })?.hooks;
  if (!Array.isArray(list)) throw new Error('expected { hooks: [...] }');
  const hooks = list
    .map((x) => x as Record<string, unknown>)
    .filter((x) => typeof x?.text === 'string' && asString(x.text).trim() && HOOK_TYPES.includes(x.type as HookType))
    .map((x) => ({ text: asString(x.text).trim().slice(0, 200), type: x.type as HookType, ...(typeof x.self_score === 'number' ? { self_score: x.self_score } : {}) }));
  if (hooks.length < 10) throw new Error(`hook-lab needs 10 hooks, got ${hooks.length}`);
  if (new Set(hooks.map((h) => h.type)).size < 6) throw new Error('hook-lab needs at least 6 hook types');
  return { hooks: hooks.slice(0, 10) };
}

export async function runHookLab(
  services: StudioServices,
  args: { ctx: PersonaContext; title: string; pillar: string | null; format: PostFormat; purpose: PostPurpose; costRef?: CostRef; recent?: readonly string[]; recentTypes?: readonly HookType[] },
): Promise<HookLab> {
  const { ctx } = args;
  const res = await services.runtime.run<{ hooks: RawHook[] }>({
    agent: 'scriptwriter',
    scope: { studioId: ctx.persona.studio_id, personaId: ctx.persona.id },
    label: 'hook-lab: 10 hooks',
    system: `You are the Scriptwriter running the hook-lab. Write exactly 10 opening hooks for one short video idea, one per type: ${HOOK_TYPES.join(', ')}.
Each hook is the first line spoken or shown, under 12 words, in the persona's voice, English only, and true to the studio rules.
First-person story hooks are welcome ("My date stood me up tonight.", "Day 12 of my no-buy."); never a story used as proof that a product works, never a real person or brand as an endorser.
Self-score each 0–100 for stopping the scroll with this audience.`,
    cached: args.ctx.cached,
    skills: ['hook-lab'],
    prompt: `Idea: ${args.title}\nPillar: ${args.pillar ?? 'n/a'}\nFormat: ${args.format}\nPurpose: ${args.purpose}
Hook templates that work for this format (patterns for inspiration; never copy a line): ${templatesFor(args.format)
      .slice(0, 5)
      .map((t) => `${t.name} ("${t.pattern}")`)
      .join('; ')}${
      args.recent?.length ? `\nRecent hooks to avoid repeating:\n- ${args.recent.slice(0, 10).join('\n- ')}` : ''
    }`,
    maxTokens: 3000,
    jsonSchema: HOOKS_SCHEMA,
    parse: parseHooks,
    fake: () => ({ hooks: fakeHooks(args.title, ctx) }),
    costRef: args.costRef,
  });
  const hooks = res.output.hooks.map((h) => scoreHook(h, ctx, args.recent, args.recentTypes));
  const { shipped, variants } = selectHooks(hooks);
  return { hooks: [...hooks].sort((a, b) => b.score - a.score), shipped, variants, runId: res.runId };
}

// ───────────────────────────── Hook-template library (IOS-5 stream K; PRD §3.15.6–7) ─────────────────────────────

/**
 * A hook pattern from the production playbook (seeded from the Licbe AI Media resources as inspiration, never copied
 * lines). `{slots}` are filled from the idea; the hook-lab shows the patterns to the Scriptwriter, the Persona
 * Generator's niche filter asks whether a niche can feed them, and `hook_template` (migration 0019) mirrors them.
 */
export interface HookTemplate {
  readonly id: string;
  readonly name: string;
  readonly type: HookType;
  readonly pattern: string;
  readonly example: string;
  readonly formats: readonly PostFormat[];
}

export const HOOK_TEMPLATES: readonly HookTemplate[] = [
  { id: 'three_mistakes', name: '3 mistakes', type: 'mistake', pattern: '3 mistakes {audience} make with {topic}', example: '3 mistakes everyone makes with their first budget', formats: ['talking', 'carousel', 'activity_text'] },
  { id: 'do_this_instead', name: 'Do this instead', type: 'mistake', pattern: 'Stop {bad habit}. Do this instead.', example: "Stop saving what's left. Do this instead.", formats: ['talking', 'activity_text', 'static'] },
  { id: 'myth_vs_fact', name: 'Myth vs fact', type: 'myth_bust', pattern: 'Myth: {belief}. Fact: {truth}.', example: 'Myth: you need a big salary to save. Fact: you need a system.', formats: ['carousel', 'talking', 'text_note'] },
  { id: 'ranking', name: 'Ranking', type: 'number', pattern: 'Ranking {n} {things} from worst to best', example: 'Ranking 5 ways to save from worst to best', formats: ['talking', 'carousel', 'facecam_screen'] },
  { id: 'story_hook', name: 'Story hook', type: 'story', pattern: 'The day {small moment} changed how I {verb}', example: 'The day my card got declined changed how I shop', formats: ['voiceover', 'talking', 'photo_dump'] },
  { id: 'pov', name: 'POV', type: 'pov', pattern: 'POV: you finally {win}', example: 'POV: you finally stopped dreading payday', formats: ['activity_text', 'meme', 'static'] },
  { id: 'quiz', name: 'Quiz', type: 'question', pattern: 'Can you guess {question}?', example: 'Can you guess where most of your money goes?', formats: ['carousel', 'talking', 'reply_comment'] },
  { id: 'beginner_guide', name: 'Beginner guide', type: 'how_to', pattern: "The beginner's guide to {topic} in {n} steps", example: "The beginner's guide to saving in 3 steps", formats: ['carousel', 'facecam_screen', 'talking'] },
  { id: 'reaction', name: 'Reaction', type: 'contrarian', pattern: 'My honest reaction to {thing everyone is sharing}', example: 'My honest reaction to the "no-spend" trend', formats: ['news_greenscreen', 'reply_comment', 'talking'] },
  { id: 'triple_hook', name: 'Triple hook', type: 'curiosity_gap', pattern: "{demo 1}. {demo 2}. {demo 3}. Here's how.", example: "Coffee: £2. Lunch: £8. Taxi: £14. Here's the fix.", formats: ['activity_text', 'talking'] },
  { id: 'reply_to_comment', name: 'Reply to a comment', type: 'callout', pattern: "Someone asked {question}. Here's my answer.", example: "Someone asked how to start with no savings. Here's my answer.", formats: ['reply_comment', 'talking'] },
  { id: 'relatable', name: 'Relatable', type: 'pov', pattern: 'Me pretending {situation} is fine', example: "Me pretending my bank app isn't open on purpose", formats: ['meme', 'text_note', 'static'] },
];

/** The templates that suit a format (its own first, then the rest of the library). */
export function templatesFor(format: PostFormat): HookTemplate[] {
  const own = HOOK_TEMPLATES.filter((t) => t.formats.includes(format));
  return [...own, ...HOOK_TEMPLATES.filter((t) => !own.includes(t))];
}

/** Fills a template's `{slots}` for a topic (deterministic; the model writes the real hook). */
export function fillTemplate(t: HookTemplate, topic: string, o: { audience?: string; n?: number } = {}): string {
  const tp = lowerFirst(topic.replace(/[.!?]+$/, '').trim()) || 'this';
  const fills: Record<string, string> = {
    topic: tp,
    audience: o.audience || 'most people',
    n: String(o.n ?? 3),
    things: `${tp} habits`,
    'bad habit': `doing ${tp} the hard way`,
    belief: `${tp} is complicated`,
    truth: 'it takes one small system',
    'small moment': `I got ${tp} wrong`,
    verb: 'do it now',
    win: `get ${tp}`,
    question: `what most people get wrong about ${tp}`,
    'thing everyone is sharing': `the ${tp} advice everyone is sharing`,
    'demo 1': 'Step one',
    'demo 2': 'step two',
    'demo 3': 'done',
    situation: tp,
  };
  return upperFirst(t.pattern.replace(/\{([^}]+)\}/g, (_m, k: string) => fills[k] ?? k));
}
