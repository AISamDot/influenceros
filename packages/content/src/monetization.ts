import type { StudioServices } from '@ios/agents';
import { addMessage, findThread, notify, type PostFormat } from '@ios/core';
import { type Db, json } from '@ios/db';
import { gateRules, runGate, saveGateResult, verdictOf } from './gate';
import { loadPersonaContext, type PersonaContext } from './persona';
import { asRecord, asString, asStrings, clamp, clamp01, DAY_MS, isoDate, keywordFrom, slugify, upperFirst } from './util';

/**
 * Monetization Agent v1 (PRD §3.5, FR-20): listens for demand, scores each opportunity (Product Opportunity Score,
 * 0–100), validates honestly, writes product briefs, listing packs (Lemon Squeezy fields + an Etsy variant) and a
 * launch plan with real deadlines only. It decides what gets sold and when; it books the calendar's sell slots
 * (sellQueue) and never publishes anything itself. No fake scarcity, countdowns, "sold" counts or reviews.
 */

export type Rung = 'lead_magnet' | 'entry' | 'addon' | 'core_bundle' | 'upsell' | 'product_2_3' | 'marketplace' | 'membership' | 'course';
const LADDER: readonly Rung[] = ['lead_magnet', 'entry', 'core_bundle', 'addon', 'upsell', 'product_2_3', 'membership', 'course', 'marketplace'];
const BASE_PRICE: Record<Rung, number> = {
  lead_magnet: 0, entry: 1200, addon: 700, core_bundle: 2900, upsell: 1900, product_2_3: 1500, marketplace: 900, membership: 900, course: 4900,
};

// ─────────────────────────────── Demand signals ───────────────────────────────

const PRODUCT_NOUNS = [
  'cheat sheet', 'meal plan', 'spreadsheet', 'template', 'planner', 'tracker', 'checklist', 'workbook', 'printable', 'calendar', 'journal',
  'toolkit', 'course', 'guide', 'ebook', 'kit', 'sheet', 'challenge', 'routine', 'program', 'script', 'notion',
];
const TOPIC_STOP = new Set([
  'where', 'can', 'get', 'this', 'that', 'the', 'a', 'an', 'do', 'you', 'have', 'is', 'there', 'how', 'what', 'which', 'your', 'my', 'for', 'to',
  'and', 'of', 'in', 'on', 'it', 'please', 'link', 'want', 'need', 'would', 'love', 'buy', 'sell', 'any', 'some', 'i', 'me', 'with', 'make', 'does',
  'are', 'be', 'or', 'good', 'best', 'free', 'pls', 'thanks', 'thank', 'hi', 'hey', 'just', 'like', 'really', 'one', 'use', 'should',
]);

/** A normalised topic for grouping signals: "where can I get your budget template?" → budget template. */
export function topicKey(text: string): { key: string; label: string; noun: string } {
  const t = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ');
  const noun = PRODUCT_NOUNS.find((n) => new RegExp(`\\b${n}s?\\b`).test(t));
  const toks = t.split(/\s+/).filter((w) => w.length > 2 && !TOPIC_STOP.has(w));
  if (noun) {
    const before = t.slice(0, t.search(new RegExp(`\\b${noun}`))).split(/\s+/).filter((w) => w.length > 2 && !TOPIC_STOP.has(w));
    const qual = before.at(-1) ?? toks.find((w) => !noun.includes(w));
    const label = qual ? `${qual} ${noun}` : noun;
    return { key: slugify(label), label, noun };
  }
  const label = `${toks.slice(0, 2).join(' ') || 'starter'} guide`;
  return { key: slugify(label), label, noun: 'guide' };
}

export async function addSignal(
  db: Db,
  s: { personaId: string; source: string; text: string; topic?: string; weight?: number; ref?: Record<string, unknown>; sourceRef?: string },
): Promise<string | null> {
  const t = topicKey(s.topic ?? s.text);
  const row = await db.maybeOne<{ id: string }>(
    `INSERT INTO demand_signal (persona_id, source, text, topic, topic_key, weight, ref, source_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (persona_id, source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING RETURNING id`,
    [s.personaId, s.source, s.text.slice(0, 1000), s.topic ?? t.label, t.key, s.weight ?? 1, json(s.ref ?? {}), s.sourceRef ?? null],
  );
  return row?.id ?? null;
}

const INTENT_RE = /\?|where can i|link|how do i|do you (?:have|sell)|template|planner|tracker|checklist|guide|sheet|workbook|need this|want this|price|how much/i;

/** Audience intake: questions and "where can I get this?" comments, purchase-intent DMs, refund reasons, sibling sales. */
export async function ingestAudienceSignals(services: StudioServices, personaId: string, since: Date): Promise<number> {
  const { db } = services;
  let added = 0;
  const comments = await db.query<{ id: string; text: string; classification: string | null }>(
    `SELECT id, text, classification FROM comment WHERE persona_id = $1 AND created_at >= $2 ORDER BY created_at LIMIT 2000`,
    [personaId, since],
  );
  for (const c of comments) {
    if (c.classification !== 'purchase_intent' && c.classification !== 'question' && !INTENT_RE.test(c.text)) continue;
    if (await addSignal(db, { personaId, source: 'comment', text: c.text, weight: c.classification === 'purchase_intent' ? 3 : 1, sourceRef: c.id })) added += 1;
  }
  const dms = await db.query<{ id: string; messages: Array<{ text?: string }> }>(
    `SELECT id, messages FROM dm_thread WHERE persona_id = $1 AND classification = 'purchase_intent' AND created_at >= $2 LIMIT 500`,
    [personaId, since],
  );
  for (const d of dms) {
    const text = (Array.isArray(d.messages) ? d.messages : []).map((m) => asString(m?.text)).join(' ').trim();
    if (text && (await addSignal(db, { personaId, source: 'dm', text, weight: 3, sourceRef: d.id }))) added += 1;
  }
  const refunds = await db.query<{ id: string; reason: string }>(
    `SELECT id, reason FROM refund WHERE persona_id = $1 AND created_at >= $2 AND reason IS NOT NULL LIMIT 200`,
    [personaId, since],
  );
  for (const r of refunds) if (await addSignal(db, { personaId, source: 'refund', text: r.reason, weight: 0.5, sourceRef: r.id })) added += 1;
  // What already sold for sibling personas in the same niche (studio learning).
  const sibling = await db.query<{ product_id: string; name: string; n: number }>(
    `SELECT pr.id AS product_id, pr.name, count(*)::int AS n FROM orders o JOIN product pr ON pr.id = o.product_id
       JOIN persona sp ON sp.id = o.persona_id JOIN persona me ON me.id = $1
      WHERE sp.studio_id = me.studio_id AND sp.id <> me.id AND lower(sp.niche) = lower(me.niche) AND o.ordered_at >= $2 AND o.status = 'paid'
      GROUP BY pr.id, pr.name ORDER BY n DESC LIMIT 10`,
    [personaId, since],
  );
  for (const s of sibling) {
    if (await addSignal(db, { personaId, source: 'sibling', text: `${s.name} sold ${s.n} times for a sibling persona`, topic: s.name, weight: Math.log2(s.n + 1), sourceRef: `${s.product_id}:${isoDate(since)}` })) added += 1;
  }
  return added;
}

/** Market scan (Apify actors for Etsy / KDP best-sellers). Items without a title and price are ignored. */
export async function marketScan(services: StudioServices, ctx: PersonaContext, weekKey: string): Promise<number> {
  let added = 0;
  try {
    const res = await services.providers.research.runActor({ actor: 'etsy-bestsellers', input: { query: `${ctx.persona.niche} printable`, limit: 20 } });
    for (const raw of res.items.slice(0, 20)) {
      const it = asRecord(raw);
      const title = asString(it.title);
      const price = Number(it.price);
      if (!title || !Number.isFinite(price)) continue;
      const reviews = Number(it.reviews ?? it.review_count ?? 0) || 0;
      if (await addSignal(services.db, { personaId: ctx.persona.id, source: 'etsy', text: title, weight: 1 + Math.log10(reviews + 1), ref: { price, reviews }, sourceRef: `${weekKey}:${slugify(title)}` })) added += 1;
    }
  } catch {
    /* market data is optional: the audience signals still score */
  }
  return added;
}

// ─────────────────────────────── Product Opportunity Score ───────────────────────────────

/** Each factor is 0–1 where 1 is good (high demand, easy to build, safe, etc.). */
export interface OpportunityFactors {
  demand: number;
  willingness: number;
  ladderFit: number;
  competition: number;
  effort: number;
  seasonal: number;
  complianceRisk: number;
  reuse: number;
}
/** PRD §3.5 step 2: the eight inputs and their weights (sum 100). */
export const POS_WEIGHTS: Readonly<Record<keyof OpportunityFactors, number>> = {
  demand: 25, willingness: 15, ladderFit: 10, competition: 10, effort: 10, seasonal: 10, complianceRisk: 10, reuse: 10,
};
export function productOpportunityScore(f: OpportunityFactors): number {
  return Math.round(Object.entries(POS_WEIGHTS).reduce((a, [k, w]) => a + w * clamp01(f[k as keyof OpportunityFactors]), 0));
}

const EFFORT: Record<string, number> = { checklist: 0.95, 'cheat sheet': 0.95, printable: 0.9, tracker: 0.9, calendar: 0.85, template: 0.8, sheet: 0.8, spreadsheet: 0.75, notion: 0.75, planner: 0.7, 'meal plan': 0.7, journal: 0.7, challenge: 0.7, routine: 0.75, script: 0.8, guide: 0.6, workbook: 0.55, ebook: 0.55, kit: 0.55, toolkit: 0.5, program: 0.4, course: 0.3 };
const WTP: Record<string, number> = { template: 0.75, spreadsheet: 0.75, sheet: 0.7, planner: 0.75, tracker: 0.65, printable: 0.6, notion: 0.7, workbook: 0.65, kit: 0.65, toolkit: 0.65, 'meal plan': 0.6, course: 0.5, program: 0.5, guide: 0.45, checklist: 0.35, 'cheat sheet': 0.35 };
const MARKETPLACE_FRIENDLY = new Set(['printable', 'planner', 'template', 'tracker', 'calendar', 'journal', 'spreadsheet', 'sheet', 'meal plan']);

export function seasonalFit(label: string, now: Date): number {
  const m = now.getUTCMonth();
  if (/plan|planner|goal|budget|reset|new year|calendar|journal/i.test(label) && (m === 11 || m === 0)) return 1;
  if (/gift|holiday|christmas|black friday/i.test(label) && (m === 10 || m === 11)) return 1;
  if (/school|study|student/i.test(label) && (m === 7 || m === 8)) return 1;
  if (/summer|travel/i.test(label) && (m >= 4 && m <= 6)) return 0.9;
  return 0.5;
}

export interface OpportunityRow {
  id: string;
  persona_id: string;
  title: string;
  topic_key: string;
  score: number;
  status: string;
  factors: OpportunityFactors;
  evidence: unknown[];
  product_id: string | null;
}

/** Groups the last 60 days of signals by topic, scores each and upserts the ranked backlog. */
export async function scoreOpportunities(services: StudioServices, ctx: PersonaContext, now: Date): Promise<OpportunityRow[]> {
  const { db } = services;
  const groups = await db.query<{ topic_key: string; label: string; weight: number; n: number; sources: number; samples: string[]; prices: number[] }>(
    `SELECT topic_key, min(topic) AS label, sum(weight)::float8 AS weight, count(*)::int AS n, count(DISTINCT source)::int AS sources,
            (array_agg(text ORDER BY weight DESC, created_at DESC))[1:3] AS samples,
            array_remove(array_agg((ref->>'price')::float8), NULL) AS prices
       FROM demand_signal WHERE persona_id = $1 AND created_at >= $2 AND topic_key IS NOT NULL
      GROUP BY topic_key`,
    [ctx.persona.id, new Date(now.getTime() - 60 * DAY_MS)],
  );
  const products = await db.query<{ ladder_rung: Rung; name: string; status: string }>(`SELECT ladder_rung, name, status FROM product WHERE persona_id = $1 AND status <> 'retired'`, [ctx.persona.id]);
  const siblings = await db.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM persona WHERE studio_id = $1 AND id <> $2 AND lower(niche) = lower($3) AND state NOT IN ('KILLED','RETIRED','ARCHIVED')`,
    [ctx.persona.studio_id, ctx.persona.id, ctx.persona.niche],
  );
  const rungs = new Set(products.map((p) => p.ladder_rung));
  const out: OpportunityRow[] = [];
  for (const g of groups) {
    const { noun } = topicKey(g.label);
    const dup = products.some((p) => topicKey(p.name).key === g.topic_key);
    const marketPrices = (g.prices ?? []).filter((p) => Number.isFinite(p));
    const factors: OpportunityFactors = {
      demand: 1 - Math.exp(-g.weight / 12) + Math.min(0.1, (g.sources - 1) * 0.05),
      willingness: (WTP[noun] ?? 0.5) + (marketPrices.length ? Math.min(0.2, marketPrices.length * 0.02) : 0),
      ladderFit: dup ? 0.15 : !rungs.has('lead_magnet') && /checklist|guide|cheat sheet/.test(noun) ? 1 : !rungs.has('entry') && /template|sheet|planner|tracker|spreadsheet/.test(noun) ? 1 : 0.6,
      competition: marketPrices.length > 15 ? 0.35 : marketPrices.length > 5 ? 0.5 : 0.65,
      effort: EFFORT[noun] ?? 0.6,
      seasonal: seasonalFit(g.label, now),
      complianceRisk: (() => {
        const v = verdictOf(gateRules({ text: [g.label, ...(g.samples ?? [])].join('. '), kind: 'listing' }));
        return v === 'red' ? 0 : v === 'amber' ? 0.5 : 1;
      })(),
      reuse: Math.min(1, (MARKETPLACE_FRIENDLY.has(noun) ? 0.6 : 0.3) + Math.min(0.4, siblings.n * 0.2)),
    };
    const score = productOpportunityScore(factors);
    const title = upperFirst(g.label);
    const evidence = [{ signals: g.n, weight: Math.round(g.weight * 100) / 100, sources: g.sources, samples: g.samples ?? [], market_prices: marketPrices.slice(0, 10) }];
    const row = await db.one<OpportunityRow>(
      `INSERT INTO product_opportunity (persona_id, title, score, evidence, topic_key, factors, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7)
       ON CONFLICT (persona_id, topic_key) WHERE topic_key IS NOT NULL
       DO UPDATE SET score = EXCLUDED.score, evidence = EXCLUDED.evidence, factors = EXCLUDED.factors, updated_at = EXCLUDED.updated_at
       RETURNING id, persona_id, title, topic_key, score, status, factors, evidence, product_id`,
      [ctx.persona.id, title, score, json(evidence), g.topic_key, json(factors), now],
    );
    out.push(row);
  }
  return out.sort((a, b) => b.score - a.score);
}

export async function backlog(db: Db, personaId: string, limit = 20): Promise<OpportunityRow[]> {
  return db.query<OpportunityRow>(
    `SELECT id, persona_id, title, topic_key, score, status, factors, evidence, product_id FROM product_opportunity
      WHERE persona_id = $1 AND status <> 'dropped' ORDER BY score DESC NULLS LAST, updated_at DESC LIMIT $2`,
    [personaId, limit],
  );
}

// ─────────────────────────────── Briefs ───────────────────────────────

export interface ProductBrief {
  name: string;
  promise: string;
  audience: string;
  outline: string[];
  format: string;
  page_count: number;
  bonuses: string[];
  price_cents: number;
  ladder_rung: Rung;
  upsell_pairing: string;
  cta_keyword: string;
  validation: string;
}

const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'promise', 'audience', 'outline', 'format', 'page_count', 'bonuses', 'price_cents', 'ladder_rung', 'upsell_pairing', 'cta_keyword', 'validation'],
  properties: {
    name: { type: 'string' },
    promise: { type: 'string' },
    audience: { type: 'string' },
    outline: { type: 'array', items: { type: 'string' } },
    format: { type: 'string' },
    page_count: { type: 'integer' },
    bonuses: { type: 'array', items: { type: 'string' } },
    price_cents: { type: 'integer' },
    ladder_rung: { type: 'string', enum: [...LADDER] },
    upsell_pairing: { type: 'string' },
    cta_keyword: { type: 'string' },
    validation: { type: 'string' },
  },
} as const;

function parseBrief(v: unknown): ProductBrief {
  const r = asRecord(v);
  const name = asString(r.name).trim();
  const outline = asStrings(r.outline).filter(Boolean);
  if (!name || outline.length < 3) throw new Error('a brief needs a name and at least 3 outline sections');
  const rung = LADDER.includes(r.ladder_rung as Rung) ? (r.ladder_rung as Rung) : 'entry';
  return {
    name: name.slice(0, 80),
    promise: asString(r.promise).slice(0, 300),
    audience: asString(r.audience).slice(0, 300),
    outline: outline.slice(0, 12),
    format: asString(r.format, 'PDF'),
    page_count: clamp(Math.round(Number(r.page_count) || 10), 1, 120),
    bonuses: asStrings(r.bonuses).slice(0, 5),
    price_cents: Math.max(0, Math.round(Number(r.price_cents) || 0)),
    ladder_rung: rung,
    upsell_pairing: asString(r.upsell_pairing),
    cta_keyword: keywordFrom(asString(r.cta_keyword) || name),
    validation: asString(r.validation),
  };
}

const NOUN_FORMAT: Record<string, { format: string; pages: number }> = {
  checklist: { format: 'Printable PDF checklist', pages: 3 }, 'cheat sheet': { format: 'One-page PDF', pages: 2 }, template: { format: 'Google Sheets template + PDF guide', pages: 8 },
  sheet: { format: 'Google Sheets template', pages: 6 }, spreadsheet: { format: 'Google Sheets template', pages: 6 }, planner: { format: 'Printable + fillable PDF planner', pages: 30 },
  tracker: { format: 'Printable PDF tracker', pages: 8 }, workbook: { format: 'Fillable PDF workbook', pages: 24 }, guide: { format: 'PDF guide', pages: 12 },
};

export function fakeBrief(ctx: PersonaContext, title: string, rung: Rung, priceCents: number, signals: readonly string[]): ProductBrief {
  const { noun } = topicKey(title);
  const nf = NOUN_FORMAT[noun] ?? { format: 'PDF guide', pages: 12 };
  const name = rung === 'lead_magnet' && !/starter|free|checklist/i.test(title) ? `${upperFirst(title)} Starter` : upperFirst(title);
  const fw = ctx.frameworks[0];
  return {
    name,
    promise: `Set up ${title.toLowerCase()} in one sitting and keep it running in minutes a week.`,
    audience: ctx.audience.pains.length ? `People who say: ${ctx.audience.pains.slice(0, 2).join('; ')}` : `Beginners in ${ctx.persona.niche.toLowerCase()} who want a simple system`,
    outline: [
      'Start here: how to use this in 10 minutes',
      ...(fw ? fw.steps.slice(0, 3).map((s, i) => `Part ${i + 1}: ${s.replace(/\s*\(.*?\)/g, '')}`) : ['Part 1: the setup', 'Part 2: the weekly routine', 'Part 3: fixing what slips']),
      'Worked example',
      'Your one-page summary',
    ],
    format: rung === 'lead_magnet' ? 'Printable PDF (free)' : nf.format,
    page_count: rung === 'lead_magnet' ? Math.min(nf.pages, 5) : nf.pages,
    bonuses: rung === 'lead_magnet' ? [] : ['Printable one-page summary', 'Example filled in'],
    price_cents: priceCents,
    ladder_rung: rung,
    upsell_pairing: rung === 'lead_magnet' ? 'Entry product on the thank-you page' : 'Pairs with the next rung as a bundle',
    cta_keyword: nounKeyword(title) ?? keywordFrom(title),
    validation: signals.length ? `${signals.length} audience signals, e.g. "${signals[0]!.slice(0, 80)}"` : 'Lead magnet / entry product briefed from niche research (FR-20.1).',
  };
}

export function suggestRung(existing: ReadonlySet<string>, noun: string): Rung {
  if (!existing.has('lead_magnet')) return 'lead_magnet';
  if (!existing.has('entry')) return 'entry';
  if (noun === 'course' || noun === 'program') return 'course';
  if (/workbook|kit|toolkit|planner/.test(noun) && !existing.has('core_bundle')) return 'core_bundle';
  if (!existing.has('addon')) return 'addon';
  return 'product_2_3';
}

/** Lead magnets are free; everything else is rounded to whole dollars inside the persona's price band. */
export const priceFor = (rung: Rung, band: { minCents: number; maxCents: number }, proposed?: number): number =>
  rung === 'lead_magnet' ? 0 : clamp(Math.round((proposed || BASE_PRICE[rung]) / 100) * 100, band.minCents, band.maxCents);

/** The product's noun as a keyword when it is distinctive ("… starter checklist" → CHECKLIST), else null. */
export function nounKeyword(name: string): string | null {
  const { noun } = topicKey(name);
  const kw = noun.replace(/\s+/g, '').toUpperCase();
  return kw.length <= 10 && noun !== 'guide' && PRODUCT_NOUNS.some((n) => name.toLowerCase().includes(n)) ? kw : null;
}

/** A comment keyword for a product: the proposed one or its noun (CHECKLIST, TEMPLATE), unique among the persona's keywords. */
export async function productKeyword(db: Db, personaId: string, name: string, proposed?: string, exceptProductId?: string): Promise<string> {
  const candidates = [proposed ? keywordFrom(proposed) : null, nounKeyword(name), keywordFrom(name)].filter((x): x is string => !!x);
  const taken = new Set(
    (
      await db.query<{ k: string | null }>(
        `SELECT cta_keyword AS k FROM product WHERE persona_id = $1 AND id IS DISTINCT FROM $2 AND status <> 'retired'
         UNION SELECT upper(k->>'keyword') FROM persona_bible b, jsonb_array_elements(COALESCE(b.content->'engagement_style'->'comment_keywords', '[]'::jsonb)) k WHERE b.persona_id = $1`,
        [personaId, exceptProductId ?? null],
      )
    ).map((r) => (r.k ?? '').toUpperCase()),
  );
  for (const c of candidates) if (!taken.has(c)) return c;
  for (let i = 2; i < 10; i++) if (!taken.has(`${candidates[0]}${i}`.slice(0, 12))) return `${candidates[0]}${i}`.slice(0, 12);
  return candidates[0]!;
}

async function uniqueSlug(db: Db, personaId: string, base: string, exceptId?: string): Promise<string> {
  for (let i = 1; i < 50; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const taken = await db.maybeOne('SELECT 1 FROM product WHERE persona_id = $1 AND slug = $2 AND id IS DISTINCT FROM $3', [personaId, slug, exceptId ?? null]);
    if (!taken) return slug;
  }
  return `${base}-${Date.now()}`;
}

async function agentNotice(services: StudioServices, ctx: PersonaContext, title: string, body: string, runId: string | null, link: string) {
  await notify(services.db, { studioId: ctx.persona.studio_id, personaId: ctx.persona.id, kind: 'system', title, body, link });
  const thread = await findThread(services.db, ctx.persona.studio_id, 'monetization');
  await addMessage(services.db, {
    threadId: thread.id,
    role: 'agent',
    author: 'agent:monetization-agent',
    body: `${title}. ${body}`,
    personaId: ctx.persona.id,
    meta: { kind: 'notice', runId, fake: services.runtime.mode === 'fake' },
  });
}

/**
 * Writes a product brief (strong tier) and creates the `product` row at status 'brief' (cost ref: product). With an
 * opportunity it briefs that topic; without one it briefs the persona's next ladder rung from niche research
 * (FR-20.1: a lead magnet and an entry product so every persona can sell from day 1).
 */
export async function briefProduct(
  services: StudioServices,
  args: { personaId: string; opportunityId?: string; rung?: Rung; title?: string; notify?: boolean },
): Promise<{ productId: string; briefId: string; brief: ProductBrief; runId: string }> {
  const { db } = services;
  const ctx = await loadPersonaContext(db, args.personaId);
  const opp = args.opportunityId
    ? await db.one<OpportunityRow>('SELECT * FROM product_opportunity WHERE id = $1 AND persona_id = $2', [args.opportunityId, args.personaId])
    : null;
  const existing = new Set((await db.query<{ ladder_rung: string }>(`SELECT ladder_rung FROM product WHERE persona_id = $1 AND status <> 'retired'`, [args.personaId])).map((r) => r.ladder_rung));
  const knowledge = await services.knowledge.retrieve({ studioId: ctx.persona.studio_id, niche: ctx.persona.niche, query: opp?.title ?? args.title ?? `${ctx.persona.niche} beginner product`, k: 4 });
  const fallbackTitle = args.title ?? opp?.title ?? (!existing.has('lead_magnet') ? `${ctx.persona.niche} starter checklist` : `${ctx.persona.niche} template`);
  const rung = args.rung ?? suggestRung(existing, topicKey(fallbackTitle).noun);
  const price = priceFor(rung, ctx.priceBand);
  const samples = asStrings(asRecord((opp?.evidence as unknown[] | undefined)?.[0]).samples);

  const slug = await uniqueSlug(db, args.personaId, slugify(fallbackTitle));
  const product = await db.one<{ id: string }>(
    `INSERT INTO product (persona_id, name, slug, ladder_rung, status, price_cents, cta_keyword) VALUES ($1, $2, $3, $4, 'brief', $5, $6) RETURNING id`,
    [args.personaId, upperFirst(fallbackTitle).slice(0, 80), slug, rung, price, await productKeyword(db, args.personaId, fallbackTitle)],
  );
  const res = await services.runtime.run<ProductBrief>({
    agent: 'monetization-agent',
    scope: { studioId: ctx.persona.studio_id, personaId: ctx.persona.id },
    label: `product brief: ${rung}`,
    system: `You are the Monetization Agent. Write a product brief for a simple digital product the persona's audience will pay for.
Cover: name, promise, audience, outline, format, page count, bonuses, price (in cents, inside the persona's price band; lead magnets are free),
ladder rung, upsell pairing, the comment keyword and the validation evidence. No income or health claims; the promise is what the product helps
someone do, never a result it guarantees.`,
    cached: ctx.cached,
    skills: ['workbook-builder'],
    prompt: `Persona: ${ctx.persona.name} (${ctx.persona.niche}). Price band: $${ctx.priceBand.minCents / 100}–$${ctx.priceBand.maxCents / 100}.
Ladder rung: ${rung}. Existing rungs: ${[...existing].join(', ') || 'none'}.
Opportunity: ${opp ? `${opp.title} (score ${opp.score})` : fallbackTitle}
Demand evidence: ${samples.length ? samples.map((s) => `"${s}"`).join('; ') : 'niche research only'}
${knowledge.length ? `Field Brain:\n${knowledge.map((k) => `- ${k.title}: ${k.text.slice(0, 300)}`).join('\n')}` : ''}`,
    maxTokens: 4000,
    jsonSchema: BRIEF_SCHEMA,
    parse: parseBrief,
    fake: () => fakeBrief(ctx, fallbackTitle, rung, price, samples),
    costRef: { type: 'product', id: product.id },
  });
  const brief: ProductBrief = {
    ...res.output,
    ladder_rung: rung,
    price_cents: priceFor(rung, ctx.priceBand, res.output.price_cents),
    cta_keyword: await productKeyword(db, args.personaId, res.output.name, res.output.cta_keyword, product.id),
  };
  const finalSlug = await uniqueSlug(db, args.personaId, slugify(brief.name), product.id);
  await db.query(`UPDATE product SET name = $2, slug = $3, price_cents = $4, cta_keyword = $5 WHERE id = $1`, [product.id, brief.name, finalSlug, brief.price_cents, brief.cta_keyword]);
  const briefRow = await db.one<{ id: string }>(
    `INSERT INTO product_brief (persona_id, opportunity_id, product_id, content) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [args.personaId, opp?.id ?? null, product.id, json(brief)],
  );
  if (opp) await db.query(`UPDATE product_opportunity SET status = 'briefed', product_id = $2, updated_at = now() WHERE id = $1`, [opp.id, product.id]);
  if (args.notify !== false) {
    await agentNotice(services, ctx, `New product brief for ${ctx.persona.name}: ${brief.name}`, `${rung.replace('_', ' ')}, ${brief.price_cents ? `$${(brief.price_cents / 100).toFixed(0)}` : 'free'}. The Product Builder makes v1 next; you approve v1 with one tap.`, res.runId, '/money');
  }
  return { productId: product.id, briefId: briefRow.id, brief, runId: res.runId };
}

// ─────────────────────────────── Listing packs ───────────────────────────────

export interface LemonSqueezyListing {
  name: string;
  slug: string;
  status: 'draft';
  price_cents: number;
  currency: 'USD';
  pay_what_you_want: boolean;
  summary: string;
  description_html: string;
  variants: Array<{ name: string; price_cents: number }>;
  files: Array<{ name: string }>;
  thumbnail_alt: string;
  checkout: { receipt_button_text: string; receipt_thank_you_note: string; redirect_note: string };
}
export interface EtsyListing {
  title: string;
  description: string;
  price_usd: number;
  quantity: number;
  tags: string[];
  materials: string[];
  who_made: 'i_did';
  when_made: 'made_to_order';
  is_digital: true;
  type: 'download';
  taxonomy_hint: string;
  ai_disclosure: string;
}

interface ListingCopy {
  title: string;
  summary: string;
  description: string;
  bullets: string[];
  tags: string[];
  thank_you_note: string;
  etsy_title: string;
}
const LISTING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'description', 'bullets', 'tags', 'thank_you_note', 'etsy_title'],
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    description: { type: 'string' },
    bullets: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } },
    thank_you_note: { type: 'string' },
    etsy_title: { type: 'string' },
  },
} as const;
function parseListing(v: unknown): ListingCopy {
  const r = asRecord(v);
  const title = asString(r.title).trim();
  if (!title) throw new Error('listing needs a title');
  return {
    title: title.slice(0, 90),
    summary: asString(r.summary).slice(0, 300),
    description: asString(r.description).slice(0, 4000),
    bullets: asStrings(r.bullets).slice(0, 8),
    tags: asStrings(r.tags).slice(0, 13),
    thank_you_note: asString(r.thank_you_note).slice(0, 500),
    etsy_title: asString(r.etsy_title).slice(0, 140),
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Lemon Squeezy fields and an Etsy variant from a brief; both pass the Gate (no income/health claims, no fake scarcity). */
export async function buildListingPack(
  services: StudioServices,
  productId: string,
): Promise<{ lemonsqueezy: LemonSqueezyListing; etsy: EtsyListing; verdict: 'green' | 'amber' | 'red'; runId: string }> {
  const { db } = services;
  const p = await db.one<{ id: string; persona_id: string; name: string; slug: string; price_cents: number; ladder_rung: Rung }>(
    'SELECT id, persona_id, name, slug, price_cents, ladder_rung FROM product WHERE id = $1',
    [productId],
  );
  const ctx = await loadPersonaContext(db, p.persona_id);
  const briefRow = await db.maybeOne<{ content: ProductBrief }>('SELECT content FROM product_brief WHERE product_id = $1 ORDER BY created_at DESC LIMIT 1', [productId]);
  const brief = briefRow?.content ?? fakeBrief(ctx, p.name, p.ladder_rung, p.price_cents, []);
  const fake = (): ListingCopy => ({
    title: brief.name,
    summary: brief.promise,
    description: `${brief.promise}\n\nWho it's for: ${brief.audience}.\n\nInside: ${brief.outline.join('; ')}.`,
    bullets: [`${brief.format}, ${brief.page_count} pages`, ...brief.outline.slice(1, 4), ...brief.bonuses.map((b) => `Bonus: ${b}`)],
    tags: [ctx.persona.niche, topicKey(brief.name).noun, 'printable', 'digital download', 'planner', 'beginner', 'template', 'organization', 'pdf', 'checklist', 'routine', 'habit', 'system'],
    thank_you_note: `Thank you! Your download is ready. Start with the "Start here" page: it takes 10 minutes.`,
    etsy_title: `${brief.name} | ${upperFirst(ctx.persona.niche)} Printable | Digital Download PDF | ${upperFirst(topicKey(brief.name).noun)}`,
  });
  const res = await services.runtime.run<ListingCopy>({
    agent: 'monetization-agent',
    tier: 'standard',
    scope: { studioId: ctx.persona.studio_id, personaId: ctx.persona.id },
    label: 'listing pack',
    system: `You are the Monetization Agent writing a store listing pack for a digital product: a Lemon Squeezy listing and an Etsy variant.
Clear, specific, honest. No income or health claims, no "only N left", no countdowns, no "sold" counts, no reviews or testimonials.`,
    cached: ctx.cached,
    skills: ['listing-pack-writer'],
    prompt: `Brief:\n${JSON.stringify(brief)}`,
    maxTokens: 4000,
    jsonSchema: LISTING_SCHEMA,
    parse: parseListing,
    fake,
    costRef: { type: 'product', id: productId },
  });
  const copy = res.output;
  const price = brief.price_cents ?? p.price_cents;
  const upsell = brief.upsell_pairing || 'the next product in the ladder';
  const lemonsqueezy: LemonSqueezyListing = {
    name: copy.title,
    slug: p.slug,
    status: 'draft',
    price_cents: price,
    currency: 'USD',
    pay_what_you_want: price === 0,
    summary: copy.summary,
    description_html: `<p>${esc(copy.description).replace(/\n\n/g, '</p><p>')}</p><ul>${copy.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`,
    variants: [{ name: 'Default', price_cents: price }],
    files: [{ name: `${p.slug}.pdf` }],
    thumbnail_alt: `${copy.title} cover`,
    checkout: { receipt_button_text: 'Download now', receipt_thank_you_note: copy.thank_you_note, redirect_note: `Thank-you page offers ${upsell}` },
  };
  const etsyTags = [...new Set(copy.tags.map((t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().slice(0, 20)).filter((t) => t.length >= 2))].slice(0, 13);
  const etsy: EtsyListing = {
    title: (copy.etsy_title || copy.title).slice(0, 140),
    description: `${copy.description}\n\nThis is a digital download: no physical item ships.\n\nDesigned with AI tools by an AI creator studio.`,
    price_usd: Math.max(0.2, price / 100),
    quantity: 999,
    tags: etsyTags,
    materials: ['digital download', 'PDF'],
    who_made: 'i_did',
    when_made: 'made_to_order',
    is_digital: true,
    type: 'download',
    taxonomy_hint: 'Paper & Party Supplies > Paper > Calendars & Planners',
    ai_disclosure: 'Created with the help of AI tools (Etsy creativity standards).',
  };
  const verdicts: Array<'green' | 'amber' | 'red'> = [];
  for (const [channel, fields, text] of [
    ['lemonsqueezy', lemonsqueezy, [lemonsqueezy.name, lemonsqueezy.summary, copy.description, ...copy.bullets, copy.thank_you_note].join('\n')],
    ['etsy', etsy, [etsy.title, etsy.description].join('\n')],
  ] as const) {
    const gate = await runGate(services, { studioId: ctx.persona.studio_id, personaId: ctx.persona.id, input: { kind: 'listing', text, purpose: 'sell' }, cached: ctx.cached, costRef: { type: 'product', id: productId }, label: `gate: listing ${channel}` });
    await saveGateResult(services, { personaId: ctx.persona.id, subjectType: 'product', subjectId: productId, stage: 'pre_publish', verdict: gate.verdict, checks: gate.checks.map((c) => ({ ...c, message: `${channel}: ${c.message}` })) });
    verdicts.push(gate.verdict);
    await db.query(
      `INSERT INTO product_listing (persona_id, product_id, channel, fields, gate_verdict) VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (product_id, channel) DO UPDATE SET fields = EXCLUDED.fields, gate_verdict = EXCLUDED.gate_verdict, updated_at = now()`,
      [ctx.persona.id, productId, channel, json(fields), gate.verdict],
    );
  }
  const verdict = verdicts.includes('red') ? 'red' : verdicts.includes('amber') ? 'amber' : 'green';
  return { lemonsqueezy, etsy, verdict, runId: res.runId };
}

// ─────────────────────────────── Launch plan ───────────────────────────────

export interface LaunchBeat {
  beat: 'teaser' | 'reveal' | 'walkthrough' | 'faq' | 'last_call' | 'reminder';
  date: string;
  format: PostFormat;
  title: string;
  angle: string;
  cta_keyword: string;
}

/**
 * Teaser → reveal → walkthrough → FAQ and objections → last call. The last call exists only when there is a real
 * deadline (the launch price ends on `ends_on`); free products get a reminder instead. Every beat passes the Gate.
 */
export async function planLaunch(
  services: StudioServices,
  args: { productId: string; startsOn?: Date },
): Promise<{ launchId: string; beats: LaunchBeat[]; endsOn: string | null; verdict: 'green' | 'amber' | 'red' }> {
  const { db } = services;
  const p = await db.one<{ id: string; persona_id: string; name: string; price_cents: number; ladder_rung: Rung; cta_keyword: string | null }>(
    'SELECT id, persona_id, name, price_cents, ladder_rung, cta_keyword FROM product WHERE id = $1',
    [args.productId],
  );
  const start = args.startsOn ?? new Date(Date.UTC(services.now().getUTCFullYear(), services.now().getUTCMonth(), services.now().getUTCDate() + 3));
  const day = (n: number) => isoDate(new Date(start.getTime() + n * DAY_MS));
  const kw = p.cta_keyword ?? keywordFrom(p.name);
  const paid = p.price_cents > 0;
  const endsOn = paid ? day(6) : null;
  const coupon = paid ? `${kw}20`.slice(0, 16) : null;
  const beats: LaunchBeat[] = [
    { beat: 'teaser', date: day(-3), format: 'activity_text', title: `Something I've been building: ${p.name}`, angle: 'The problem it solves, no product shown yet; comment for early access', cta_keyword: kw },
    { beat: 'reveal', date: day(0), format: 'talking', title: `It's here: ${p.name}`, angle: 'What it is, who it is for, what is inside', cta_keyword: kw },
    { beat: 'walkthrough', date: day(1), format: 'carousel', title: `Walkthrough: ${p.name}`, angle: 'Page by page: how to use it in 10 minutes', cta_keyword: kw },
    { beat: 'faq', date: day(3), format: 'voiceover', title: `${p.name}: your questions, answered`, angle: 'Real buyer questions and objections from comments and DMs', cta_keyword: kw },
    paid
      ? { beat: 'last_call', date: day(5), format: 'talking', title: `Launch code ends ${endsOn}: ${p.name}`, angle: `The 20% launch code ${coupon} really ends on ${endsOn}; after that it is the full $${(p.price_cents / 100).toFixed(0)}`, cta_keyword: kw }
      : { beat: 'reminder', date: day(5), format: 'static', title: `Free: ${p.name}`, angle: 'A reminder that it is free, and what to do first', cta_keyword: kw },
  ];
  // Every beat passes the Gate; deadline language is allowed only on the last call, which has a real date.
  const checks = beats.flatMap((b) =>
    gateRules({ kind: 'launch', purpose: 'sell', text: `${b.title}. ${b.angle}`, realDeadline: b.beat === 'last_call' && endsOn ? new Date(`${endsOn}T23:59:59Z`) : null }).map((c) => ({ ...c, message: `${b.beat}: ${c.message}` })),
  );
  const verdict = verdictOf(checks);
  const next = await db.maybeOne<{ name: string }>(
    `SELECT name FROM product WHERE persona_id = $1 AND id <> $2 AND status IN ('live','approved') AND price_cents > $3 ORDER BY price_cents LIMIT 1`,
    [p.persona_id, p.id, p.price_cents],
  );
  const plan = {
    waitlist_email: { send_on: day(0), subject: `${p.name} is here`, body: `You asked for this. ${p.name} is ready${paid ? `, with 20% off (code ${coupon}) until ${endsOn}` : ' and free'}.` },
    thank_you_upsell: next ? { offer: next.name } : { offer: 'bundle with the next rung once it exists' },
    bundle: p.ladder_rung === 'entry' || p.ladder_rung === 'addon' ? 'Add to the core bundle when one is live' : null,
    coupon: coupon ? { code: coupon, discount_pct: 20, valid_until: endsOn, purpose: 'launch discount and attribution for launch posts' } : null,
    regular_price_cents: p.price_cents,
    requires: 'Owner-approved v1 before the reveal (product_v1 card)',
  };
  const row = await db.one<{ id: string }>(
    `INSERT INTO launch (persona_id, product_id, starts_on, ends_on, sequence, plan, status) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'planned') RETURNING id`,
    [p.persona_id, p.id, isoDate(start), endsOn, json(beats), json({ ...plan, gate: { verdict, checks: checks.filter((c) => c.verdict !== 'green') } })],
  );
  await saveGateResult(services, { personaId: p.persona_id, subjectType: 'product', subjectId: p.id, stage: 'pre_publish', verdict, checks });
  return { launchId: row.id, beats, endsOn, verdict };
}

// ─────────────────────────────── Sell queue (books the calendar's sell slots) ───────────────────────────────

export interface SellItem {
  readonly kind: 'launch' | 'validation' | 'product' | 'lead_magnet';
  readonly title: string;
  readonly productId: string | null;
  readonly ctaKeyword: string;
  readonly delivers: string;
  readonly beat?: string;
  readonly date?: string;
  readonly format?: PostFormat;
}

/**
 * What the calendar's sell slots push this week, in Monetization Agent order: launch beats due this week (only for
 * Owner-approved or live products), open validation tests, then live products least recently pushed (ladder order),
 * then the free lead magnet keyword.
 */
export async function sellQueue(db: Db, ctx: PersonaContext, weekStart: Date): Promise<SellItem[]> {
  const from = isoDate(weekStart);
  const to = isoDate(new Date(weekStart.getTime() + 7 * DAY_MS));
  const items: SellItem[] = [];
  const launches = await db.query<{ product_id: string; name: string; cta_keyword: string | null; sequence: LaunchBeat[] }>(
    `SELECT l.product_id, p.name, p.cta_keyword, l.sequence FROM launch l JOIN product p ON p.id = l.product_id
      WHERE l.persona_id = $1 AND l.status IN ('planned','running') AND p.status IN ('approved','live') ORDER BY l.starts_on`,
    [ctx.persona.id],
  );
  for (const l of launches) {
    for (const b of (Array.isArray(l.sequence) ? l.sequence : []).filter((x) => x.date >= from && x.date < to).sort((a, b) => a.date.localeCompare(b.date))) {
      items.push({ kind: 'launch', title: b.title, productId: l.product_id, ctaKeyword: b.cta_keyword || l.cta_keyword || keywordFrom(l.name), delivers: `${l.name} link`, beat: b.beat, date: b.date, format: b.format });
    }
  }
  const validations = await db.query<{ keyword: string; title: string }>(
    `SELECT v.keyword, o.title FROM validation_test v JOIN product_opportunity o ON o.id = v.opportunity_id
      WHERE v.persona_id = $1 AND v.passed IS NULL AND v.keyword IS NOT NULL AND o.status = 'validating' AND (v.ends_at IS NULL OR v.ends_at > $2)
      ORDER BY v.created_at`,
    [ctx.persona.id, weekStart],
  );
  for (const v of validations) items.push({ kind: 'validation', title: `Would this help? ${v.title}`, productId: null, ctaKeyword: v.keyword, delivers: 'early access' });
  const live = await db.query<{ id: string; name: string; ladder_rung: Rung; cta_keyword: string | null; last: Date | null }>(
    `SELECT p.id, p.name, p.ladder_rung, p.cta_keyword, (SELECT max(s.slot_at) FROM calendar_slot s WHERE s.product_id = p.id) AS last
       FROM product p WHERE p.persona_id = $1 AND p.status = 'live'`,
    [ctx.persona.id],
  );
  live.sort((a, b) => (a.last ? new Date(a.last).getTime() : 0) - (b.last ? new Date(b.last).getTime() : 0) || LADDER.indexOf(a.ladder_rung) - LADDER.indexOf(b.ladder_rung));
  for (const p of live) {
    const kw = p.cta_keyword ?? ctx.keywords.find((k) => k.delivers.toLowerCase().includes(p.name.toLowerCase()))?.keyword ?? keywordFrom(p.name);
    items.push({
      kind: 'product',
      title: p.ladder_rung === 'lead_magnet' ? `Free: ${p.name}` : `Walkthrough: ${p.name}`,
      productId: p.id,
      ctaKeyword: kw,
      delivers: p.ladder_rung === 'lead_magnet' ? `${p.name} (free)` : `${p.name} link`,
    });
  }
  const lead = ctx.keywords.find((k) => k.keyword === ctx.leadKeyword);
  items.push({ kind: 'lead_magnet', title: `Free ${ctx.persona.niche.toLowerCase()} starter`, productId: null, ctaKeyword: ctx.leadKeyword, delivers: lead?.delivers ?? 'the free starter guide' });
  return items;
}

// ─────────────────────────────── Validation and the weekly cycle ───────────────────────────────

/** Default pass mark (tunable): ≥ 50 keyword comments, or ≥ 2% of viewers of the validation posts. */
export const VALIDATION_PASS = { comments: 50, rate: 0.02, minViews: 1000 } as const;

export async function startValidation(services: StudioServices, opp: OpportunityRow, now: Date): Promise<string> {
  const keyword = keywordFrom(opp.title, 'EARLY');
  const row = await services.db.one<{ id: string }>(
    `INSERT INTO validation_test (persona_id, opportunity_id, type, keyword, starts_at, ends_at) VALUES ($1, $2, 'comment_keyword', $3, $4, $5) RETURNING id`,
    [opp.persona_id, opp.id, keyword, now, new Date(now.getTime() + 10 * DAY_MS)],
  );
  await services.db.query(`UPDATE product_opportunity SET status = 'validating', updated_at = now() WHERE id = $1`, [opp.id]);
  return row.id;
}

export async function evaluateValidations(services: StudioServices, personaId: string, now: Date): Promise<Array<{ opportunityId: string; passed: boolean | null }>> {
  const { db } = services;
  const open = await db.query<{ id: string; opportunity_id: string; keyword: string; starts_at: Date; ends_at: Date | null }>(
    `SELECT id, opportunity_id, keyword, starts_at, ends_at FROM validation_test WHERE persona_id = $1 AND passed IS NULL AND type = 'comment_keyword'`,
    [personaId],
  );
  const out: Array<{ opportunityId: string; passed: boolean | null }> = [];
  for (const v of open) {
    const c = await db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM comment WHERE persona_id = $1 AND created_at >= $2 AND text ~* ('\\m' || $3 || '\\M')`,
      [personaId, v.starts_at, v.keyword],
    );
    const views = await db.one<{ v: number }>(
      // Latest snapshot per post: metric windows (1h/24h/72h/7d) are cumulative, so summing them would double-count.
      `SELECT COALESCE(sum(x.views), 0)::int AS v FROM (
         SELECT DISTINCT ON (m.post_id) m.views FROM metric_snapshot m JOIN post p ON p.id = m.post_id JOIN calendar_slot s ON s.id = p.calendar_slot_id
          WHERE s.persona_id = $1 AND s.cta_keyword = $2 AND s.slot_at >= $3
          ORDER BY m.post_id, m.captured_on DESC, m.created_at DESC) x`,
      [personaId, v.keyword, v.starts_at],
    );
    const passed = c.n >= VALIDATION_PASS.comments || (views.v >= VALIDATION_PASS.minViews && c.n / views.v >= VALIDATION_PASS.rate) ? true : v.ends_at && v.ends_at < now ? false : null;
    if (passed !== null) {
      await db.query(`UPDATE validation_test SET passed = $2, result = $3::jsonb WHERE id = $1`, [v.id, passed, json({ comments: c.n, views: views.v, evaluated_at: now.toISOString() })]);
      await db.query(`UPDATE product_opportunity SET status = $2, updated_at = now() WHERE id = $1`, [v.opportunity_id, passed ? 'validated' : 'backlog']);
    }
    out.push({ opportunityId: v.opportunity_id, passed });
  }
  return out;
}

export interface CycleSummary {
  signals: number;
  opportunities: number;
  briefed: string[];
  validating: string[];
  listings: string[];
  launches: string[];
}

/**
 * The weekly cycle for one persona: intake → score → (FR-20.1) brief a lead magnet and an entry product if the
 * persona has none → validate the top backlog idea → brief validated ones → listing pack + launch plan for briefs.
 */
export async function runMonetizationCycle(services: StudioServices, personaId: string, now = services.now()): Promise<CycleSummary> {
  const { db } = services;
  const ctx = await loadPersonaContext(db, personaId);
  const last = await db.maybeOne<{ at: Date }>(`SELECT max(created_at) AS at FROM demand_signal WHERE persona_id = $1`, [personaId]);
  const since = last?.at ? new Date(new Date(last.at).getTime() - DAY_MS) : new Date(now.getTime() - 30 * DAY_MS);
  const summary: CycleSummary = { signals: 0, opportunities: 0, briefed: [], validating: [], listings: [], launches: [] };
  summary.signals += await ingestAudienceSignals(services, personaId, since);
  summary.signals += await marketScan(services, ctx, isoDate(now));
  const opps = await scoreOpportunities(services, ctx, now);
  summary.opportunities = opps.length;

  const rungs = new Set((await db.query<{ ladder_rung: string }>(`SELECT ladder_rung FROM product WHERE persona_id = $1 AND status <> 'retired'`, [personaId])).map((r) => r.ladder_rung));
  for (const rung of ['lead_magnet', 'entry'] as const) {
    if (rungs.has(rung)) continue;
    const match = opps.find((o) => o.status === 'backlog' && suggestRung(rungs, topicKey(o.title).noun) === rung);
    const b = await briefProduct(services, { personaId, rung, opportunityId: match?.id });
    rungs.add(rung);
    summary.briefed.push(b.productId);
  }
  for (const v of await evaluateValidations(services, personaId, now)) {
    if (v.passed) summary.briefed.push((await briefProduct(services, { personaId, opportunityId: v.opportunityId })).productId);
  }
  const validatingNow = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM product_opportunity WHERE persona_id = $1 AND status = 'validating'`, [personaId]);
  const top = (await backlog(db, personaId)).find((o) => o.status === 'backlog' && o.score >= 60);
  if (top && validatingNow.n === 0) {
    await startValidation(services, top, now);
    summary.validating.push(top.id);
  }
  const needsPack = await db.query<{ id: string; price_cents: number }>(
    `SELECT p.id, p.price_cents FROM product p WHERE p.persona_id = $1 AND p.status IN ('brief','building','qc','awaiting_approval','approved')
        AND NOT EXISTS (SELECT 1 FROM product_listing l WHERE l.product_id = p.id)`,
    [personaId],
  );
  for (const p of needsPack) {
    await buildListingPack(services, p.id);
    summary.listings.push(p.id);
    if (!(await db.maybeOne('SELECT 1 FROM launch WHERE product_id = $1', [p.id]))) {
      summary.launches.push((await planLaunch(services, { productId: p.id })).launchId);
    }
  }
  return summary;
}
