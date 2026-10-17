import type { Db } from '@troupe/db';
import { type LaunchPersona, loadArchivedPersonas } from '@troupe/core/seed';
import { nicheFilter } from '@troupe/production';
import { type NicheDef, nicheByKey, firstName } from './library';
import { type ConceptOption, type ContentPlanDraft, type DraftState, type Distinctness, type OpportunityOption, type Scorecard, SCORECARD_WEIGHTS } from './types';

/**
 * The win scorecard (Persona-Research 14 Oct §4: captivation 30, demand 20, ladder 15, gap 10, producibility 15,
 * line safety 10) and distinctness against the studio's personas and the archive. Both are computed in code from the
 * draft itself, so the numbers mean the same thing with or without a model, and every point has a reason.
 */

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

/** Credential claims, cures, guarantees and fabricated results: the legal and platform lines (PRD §3.4, §3.10). */
export const RED_FLAGS: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:as an?|I(?:'m| am) an?|(?:she|he)(?:'s| is) an?|certified|licensed|registered|board-certified)\s+(?:dr\.?|doctor|nutritionist|dietitian|lawyer|attorney|therapist|psychologist|pharmacist|cpa|financial (?:adviser|advisor|planner))\b|\bDr\.\s+[A-Z]|\bPh\.?D\b/gi, 'credential claim'],
  [/\b(?:cures?|diagnos(?:e|es|ing)|treats? (?:your|the) (?:disease|illness|insomnia|anxiety|depression|diabetes))\b/gi, 'treatment claim'],
  [/\b(?:guaranteed|guarantees?)\s+(?:returns?|results?|income|profits?|weight loss|you(?:'ll| will))\b|\b(?:I|we)\s+guarantee\b|\bmake \$\d|\$\d[\d,]*\s*(?:\/|a|per)\s*month\b/gi, 'income or result guarantee'],
  [/\bI (?:lost|made|earned) \$?\d/gi, 'fabricated personal result'],
  [/\b(?:buy|sell) (?:this|these) (?:stock|shares|coin|crypto)\b/gi, 'buy/sell call'],
];

const NEGATED = /\b(?:no|never|not|without|don't|doesn't|won't|nor|zero|avoid|bans?|blocked?)\b[^.]{0,40}$/i;

/** Line flags in `text`; a negated mention ("never claims to cure", "no guarantees") doesn't count. */
export function lineFlags(text: string): string[] {
  const out: string[] = [];
  for (const [re, label] of RED_FLAGS) {
    for (const m of text.matchAll(re)) {
      const before = text.slice(Math.max(0, (m.index ?? 0) - 60), m.index ?? 0);
      if (NEGATED.test(before)) continue;
      out.push(label);
      break;
    }
  }
  return out;
}

export interface ScoreInput {
  concept: ConceptOption;
  opportunity: OpportunityOption | null;
  ladder?: ContentPlanDraft['ladder'];
  settings?: string[];
  catchphrases?: string[];
  /** 0–100 from distinctness(), when known. */
  distinct?: number;
  /** The other options drafted alongside this one: near-identical options lose captivation points. */
  siblings?: readonly ConceptOption[];
}

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  const shared = [...a].filter((x) => b.has(x)).length;
  return shared / (a.size + b.size - shared);
};

/** How much of `c` repeats its closest sibling: shared hooks, the same first product, a near-identical mechanic or premise. */
export function siblingOverlap(c: ConceptOption, siblings: readonly ConceptOption[]): { penalty: number; nearest: string | null; why: string[] } {
  let best = { penalty: 0, nearest: null as string | null, why: [] as string[] };
  const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const mine = new Set(c.hooks.map(norm));
  for (const o of siblings) {
    const why: string[] = [];
    let p = 0;
    const sharedHooks = o.hooks.map(norm).filter((h) => mine.has(h)).length;
    if (sharedHooks) {
      p += Math.min(3, sharedHooks);
      why.push(`${sharedHooks} shared hook${sharedHooks > 1 ? 's' : ''}`);
    }
    if (o.firstProduct?.name && o.firstProduct.name === c.firstProduct?.name) {
      p += 2;
      why.push('same first product');
    }
    // Templated text with only the nouns swapped: compare the words that aren't the name, role or object.
    const strip = (t: string, x: ConceptOption) => tokens(t.split(x.name).join(' ').split(firstName(x.name)).join(' '));
    if (jaccard(strip(c.mechanic, c), strip(o.mechanic, o)) >= 0.5) {
      p += 2;
      why.push('the same mechanic shape');
    }
    if (jaccard(strip(c.premise, c), strip(o.premise, o)) >= 0.5) {
      p += 1;
      why.push('the same premise template');
    }
    if (p > best.penalty) best = { penalty: p, nearest: o.id, why };
  }
  return { penalty: Math.min(6, best.penalty), nearest: best.nearest, why: best.why };
}

export function scoreConcept(input: ScoreInput): Scorecard {
  const c = input.concept;
  const niche: NicheDef | undefined = nicheByKey(input.opportunity?.niche ?? '');
  const notes: Scorecard['notes'] = {};

  // Captivation (30): the premise raises a question in a second; named mechanic; short, quotable hooks; an ownable line.
  let cap = 0;
  const premiseOk = c.age >= 55 && /\b(?:for|after|of)\b/i.test(c.premise) && c.premise.length <= 320;
  if (premiseOk) cap += 8;
  else if (c.premise.length > 0) cap += 4;
  if (/^[^:]{3,40}:/.test(c.mechanic)) cap += 6;
  else if (c.mechanic) cap += 3;
  const hooks = c.hooks.filter(Boolean);
  if (hooks.length >= 5) cap += 3;
  const avg = hooks.length ? hooks.reduce((a, h) => a + words(h).length, 0) / hooks.length : 99;
  if (avg <= 10) cap += 3;
  if (c.signOff || input.catchphrases?.length) cap += 4;
  if (c.lookLine && c.lookLine.length <= 110) cap += 3;
  if (hooks.some((h) => words(h).length <= 7)) cap += 3;
  const twin = input.siblings?.length ? siblingOverlap(c, input.siblings) : null;
  if (twin?.penalty) cap -= twin.penalty;
  cap = clamp(cap, 0, SCORECARD_WEIGHTS.captivation);
  notes.captivation = `${premiseOk ? 'Elder-plus-contrast premise reads in a second' : 'Premise needs a sharper one-second contrast'}${twin?.penalty ? `; too like ${twin.nearest} (${twin.why.join(', ')}): -${twin.penalty}` : ''}`;

  // Demand and intent (20).
  const o = input.opportunity;
  const demand = o ? clamp(Math.round(o.scores.demand + o.scores.intent), 0, 20) : 10;
  notes.demand = o ? `Demand ${o.scores.demand}/10, buyer intent ${o.scores.intent}/10 (${o.buyingMoments.slice(0, 2).join('; ')})` : 'No opportunity picked yet';

  // Ladder fit (15): a free tool, a $9–19 entry, a $29–49 system and a monthly reason to stay.
  let ladder = 0;
  const L = input.ladder;
  if (L?.length) {
    if (L.some((x) => x.rung === 'lead_magnet' && x.priceCents === 0)) ladder += 3;
    if (L.some((x) => x.rung === 'entry' && x.priceCents >= 900 && x.priceCents <= 1900)) ladder += 4;
    if (L.some((x) => x.rung === 'core_bundle' && x.priceCents >= 2900 && x.priceCents <= 4900)) ladder += 4;
    if (L.some((x) => x.rung === 'membership')) ladder += 4;
    notes.ladder = `${L.length} rungs`;
  } else {
    const p = c.firstProduct?.priceCents ?? 0;
    ladder = (p >= 900 && p <= 1900 ? 4 : 1) + (niche ? 11 : 6);
    notes.ladder = `First product $${(p / 100).toFixed(0)}${niche ? '; the niche supports a $29–49 system and a membership' : ''}`;
  }
  ladder = clamp(ladder, 0, SCORECARD_WEIGHTS.ladder);

  // Gap (10): room in the niche and no close analogue in the studio or the archive.
  let gap = o ? o.scores.gap : 6;
  if (input.distinct !== undefined) gap = Math.min(gap, Math.round(input.distinct / 10));
  gap = clamp(gap, 0, SCORECARD_WEIGHTS.gap);
  notes.gap = input.distinct !== undefined ? `Distinctness ${input.distinct}/100` : o ? `Studio gap ${o.scores.gap}/10` : 'Unscored';

  // Producibility (15): one front-facing speaker, four sets or fewer, little motion or readable text.
  const text = `${c.premise} ${c.mechanic}`;
  const settings = input.settings ?? [];
  let prod = 0;
  if (!settings.length || settings.length <= 4) prod += 5;
  if (!/\b(?:duo|two speakers|interview|debate between|crowd|panel|couple)\b/i.test(text)) prod += 5;
  if (!/\b(?:stunt|dance|dancing|running|chase|fight|sport|parkour|skate)\b/i.test(c.mechanic)) prod += 5;
  // (IOS-5 stream K, PRD §3.15.7) The niche filter: could a real creator build a personal brand talking to camera
  // about this? Each "no" of the five questions costs 2 points; a format posing as a niche costs 5 more.
  const nf = nicheFilter({ niche: o?.niche ?? niche?.subNiche ?? '', premise: c.premise, mechanic: c.mechanic, archetype: c.archetype, hooks: c.hooks });
  prod -= (5 - nf.score) * 2 + (nf.formatNotNiche ? 5 : 0);
  prod = clamp(prod, 0, SCORECARD_WEIGHTS.producibility);
  notes.producibility = `${prod === 15 ? 'One speaker, few sets, talking-head friendly' : 'Motion, multiple speakers or a weak niche: harder to produce'}; ${nf.summary}`;

  // Line safety (10): can win without nearing the lines.
  const flags = lineFlags([c.premise, c.contrast, c.mechanic, ...c.hooks, c.signOff, c.firstProduct?.name ?? ''].join(' \n '));
  const safety = clamp((niche?.lineSafety ?? 8) - flags.length * 3, 0, SCORECARD_WEIGHTS.lineSafety);
  notes.lineSafety = flags.length ? `Near the line: ${flags.join(', ')}` : (niche?.risks[0] ?? 'Clear of the lines');

  const total = cap + demand + ladder + gap + prod + safety;
  return { captivation: cap, demand, ladder, gap, producibility: prod, lineSafety: safety, total, notes };
}

// ───────────────────────────── Distinctness ─────────────────────────────

const STOP = new Set(
  'about after again also always because been before being between both could does doing down each even every from have here into just like little made make many more most much must never only other over same should some still such than that their them then there these they this those through very want were what when where which while will with would your yours the and for are but not you all any can her his him she was one our out who how its it\'s her him had has get got off too own why yes lot use per via years year old new character fictional credential credentials licence degree claims premise viewer viewers rules niche sell label labelled platform year-old persona'.split(
    ' ',
  ),
);

/** Content words (4+ letters, no stop-words), lower-cased. */
export function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []).map((w) => w.replace(/'s$/, '')).filter((w) => !STOP.has(w)));
}

/** All string leaves of a JSON value, joined. */
export function textOf(v: unknown, max = 6000): string {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (out.join(' ').length > max) return;
    if (typeof x === 'string') out.push(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  walk(v);
  return out.join(' ').slice(0, max);
}

export interface Signature {
  slug: string;
  name: string;
  niche: string;
  source: 'studio' | 'archive' | 'draft';
  tokens: Set<string>;
}

/** What makes a character itself: identity, lore, look and voice lines (capped so a long bible doesn't swamp the match). */
export function bibleSignature(slug: string, name: string, niche: string, bible: Record<string, unknown>, source: Signature['source']): Signature {
  const parts = ['identity', 'character_lore', 'look', 'voice'].map((k) => textOf(bible[k], 1500));
  return { slug, name, niche: niche.toLowerCase(), source, tokens: capTokens(tokens(parts.join(' ')), 220) };
}

export function draftSignature(state: DraftState, title: string): Signature | null {
  const c = state.concept.chosen;
  if (!c) return null;
  const ch = state.character.chosen;
  const look = state.look.chosen?.profile;
  const text = [
    c.name,
    c.archetype,
    c.premise,
    c.contrast,
    c.mechanic,
    c.lookLine,
    c.voiceLine,
    c.signOff,
    ch?.identity ?? '',
    ch?.lore ?? '',
    ...(ch?.catchphrases ?? []),
    ...(look?.anchors ?? []),
    ...(look?.wardrobe ?? []),
  ].join(' ');
  return { slug: 'draft', name: ch?.name ?? c.name ?? title, niche: (state.opportunity.chosen?.niche ?? '').toLowerCase(), source: 'draft', tokens: capTokens(tokens(text), 220) };
}

function capTokens(set: Set<string>, n: number): Set<string> {
  return new Set([...set].slice(0, n));
}

/** 0–1. Name and niche count, then how much of the smaller signature the other one shares. */
export function similarity(a: Signature, b: Signature): { score: number; shared: string[] } {
  const fa = firstName(a.name).toLowerCase();
  const fb = firstName(b.name).toLowerCase();
  const nameSim = a.name.toLowerCase() === b.name.toLowerCase() ? 1 : fa && fa === fb ? 0.8 : 0;
  const nicheSim = a.niche && a.niche === b.niche ? 1 : 0;
  const shared = [...a.tokens].filter((t) => b.tokens.has(t));
  const overlap = Math.min(a.tokens.size, b.tokens.size) ? shared.length / Math.min(a.tokens.size, b.tokens.size) : 0;
  return { score: Math.min(1, 0.2 * nameSim + 0.2 * nicheSim + 0.6 * Math.min(1, overlap * 1.6)), shared: shared.slice(0, 8) };
}

/** Signatures of the studio's personas (current approved bible) except `excludePersonaId`. */
export async function studioSignatures(db: Db, studioId: string, excludePersonaId?: string | null): Promise<Signature[]> {
  const rows = await db.query<{ id: string; slug: string; name: string; niche: string; content: Record<string, unknown> | null }>(
    `SELECT p.id, p.slug, p.name, p.niche,
            (SELECT content FROM persona_bible b WHERE b.persona_id = p.id ORDER BY (b.status = 'approved') DESC, version DESC LIMIT 1) AS content
       FROM persona p WHERE p.studio_id = $1 AND p.state NOT IN ('KILLED','RETIRED')`,
    [studioId],
  );
  return rows.filter((r) => r.id !== excludePersonaId).map((r) => bibleSignature(r.slug, r.name, r.niche, r.content ?? { identity: r.name }, 'studio'));
}

/** Signatures of every archived persona (all archive labels), except `exclude` (a draft restored from it). */
export function archiveSignatures(exclude?: { slug: string } | null, personas?: readonly LaunchPersona[]): Signature[] {
  let list: readonly LaunchPersona[] = personas ?? [];
  if (!personas) {
    try {
      list = loadArchivedPersonas();
    } catch {
      list = [];
    }
  }
  return list.filter((p) => p.slug !== exclude?.slug).map((p) => bibleSignature(p.slug, p.name, p.niche, p.bible, 'archive'));
}

export function distinctness(draft: Signature | null, others: readonly Signature[]): Distinctness {
  if (!draft) return { score: 100, verdict: 'distinct', nearest: [] };
  const ranked = others
    .map((o) => ({ o, ...similarity(draft, o) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const max = ranked[0]?.score ?? 0;
  const score = Math.round(100 * (1 - max));
  return {
    score,
    verdict: score >= 60 ? 'distinct' : score >= 35 ? 'close' : 'clone',
    nearest: ranked.map((r) => ({ slug: r.o.slug, name: r.o.name, source: r.o.source, similarity: Math.round(r.score * 100) / 100, shared: r.shared })),
  };
}
