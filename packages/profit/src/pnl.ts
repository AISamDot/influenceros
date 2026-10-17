import type { Platform, PostFormat } from '@troupe/core';
import type { Db } from '@troupe/db';
import { getProfitSettings } from './settings';
import type { PnlGrain, PnlQuery, PnlRow, PnlTotals } from './types';
import { isoDate, mondayOf, round, sum, WEEK_MS } from './util';

/**
 * P&L read models (PRD §3.11 unit economics, FR-24.1). Built from:
 *  - revenue: `orders` (gross, fees) and `refund`, attributed to a post by orders.source_post_id, then the coupon's
 *    source post, then the short link's post;
 *  - cost: `credit_ledger` debits (holds and grants are not spend), attributed by ref: a `post`, a `calendar_slot`
 *    (→ the slot's post once it exists), a `product`; anything else is persona (or studio) overhead.
 * LLM and media USD convert to cents; Higgsfield credits convert at the Profit Engine's credit price.
 * Every grain of the same window sums to the same totals: rows that can't be attributed at a grain land in
 * synthetic rows (`overhead`, `unattributed`, `studio`), and a persona's unattributed sales are spread over its
 * posts by views on post/format/platform rows (`allocatedRevenueCents`).
 */

export const FORMAT_LABELS: Readonly<Record<PostFormat, string>> = {
  talking: 'Talking',
  activity_text: 'Activity + text',
  voiceover: 'Voiceover',
  static: 'Static',
  carousel: 'Carousel',
  product_in_hand: 'Product in hand',
  trend_reenactment: 'Trend reenactment',
  photo_dump: 'Photo dump',
  text_note: 'Text note',
  facecam_screen: 'Facecam + screen',
  reply_comment: 'Reply to comment',
  news_greenscreen: 'News green-screen',
  meme: 'Meme',
};
const PLATFORM_LABELS: Readonly<Record<string, string>> = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', pinterest: 'Pinterest' };

/** Keys of synthetic rows. */
export const OVERHEAD_KEY = 'overhead';
export const UNATTRIBUTED_KEY = 'unattributed';
export const STUDIO_KEY = 'studio';
const SYNTHETIC = new Set([OVERHEAD_KEY, UNATTRIBUTED_KEY, STUDIO_KEY]);
export const isSyntheticRow = (r: Pick<PnlRow, 'key'>): boolean => SYNTHETIC.has(r.key);

export interface PostFact {
  id: string;
  personaId: string;
  format: PostFormat;
  platform: Platform;
  publishedAt: Date | null;
  label: string;
  views: number;
  inWindow: boolean;
}
export interface OrderFact {
  personaId: string;
  productId: string | null;
  postId: string | null;
  grossCents: number;
  feeCents: number;
  refundCents: number;
  at: Date;
}
export interface CostFact {
  personaId: string | null;
  llmCents: number;
  mediaCents: number;
  creditsCents: number;
  hfCredits: number;
  postId: string | null;
  slotFormat: PostFormat | null;
  productId: string | null;
  agent: string | null;
  at: Date;
}
export interface Facts {
  from: Date;
  to: Date;
  personas: Map<string, { name: string; state: string }>;
  products: Map<string, { name: string; personaId: string }>;
  posts: Map<string, PostFact>;
  orders: OrderFact[];
  costs: CostFact[];
  creditPriceCents: number;
}

const costCents = (c: Pick<CostFact, 'llmCents' | 'mediaCents' | 'creditsCents'>) => c.llmCents + c.mediaCents + c.creditsCents;

/** Loads the raw facts of a window once; every grain and the weekly series are aggregated from them. */
export async function loadFacts(db: Db, q: { studioId: string; from: Date; to: Date; personaId?: string | null }): Promise<Facts> {
  const pid = q.personaId ?? null;
  const settings = await getProfitSettings(db, q.studioId);
  const price = settings.creditPriceCents;
  const [personas, orders, costs] = await Promise.all([
    db.query<{ id: string; name: string; state: string }>(
      `SELECT id, name, state FROM persona WHERE studio_id = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY name`,
      [q.studioId, pid],
    ),
    db.query<{
      persona_id: string;
      product_id: string | null;
      post_id: string | null;
      amount_cents: number;
      fee_cents: number;
      status: string;
      refunded: number;
      ordered_at: Date;
    }>(
      `SELECT o.persona_id, o.product_id, COALESCE(o.source_post_id, c.source_post_id, sl.post_id) AS post_id,
              o.amount_cents, o.fee_cents, o.status, o.ordered_at,
              COALESCE((SELECT SUM(r.amount_cents) FROM refund r WHERE r.order_id = o.id AND r.status IN ('approved','refunded')), 0)::int AS refunded
         FROM orders o
         JOIN persona p ON p.id = o.persona_id
         LEFT JOIN coupon c ON c.id = o.coupon_id
         LEFT JOIN short_link sl ON sl.id = o.short_link_id
        WHERE p.studio_id = $1 AND o.ordered_at >= $2 AND o.ordered_at < $3 AND ($4::uuid IS NULL OR o.persona_id = $4)`,
      [q.studioId, q.from, q.to, pid],
    ),
    db.query<{
      persona_id: string | null;
      unit: 'llm_usd' | 'hf_credits' | 'media_usd';
      amount: number;
      post_id: string | null;
      slot_format: PostFormat | null;
      product_id: string | null;
      agent: string | null;
      created_at: Date;
    }>(
      `SELECT l.persona_id, l.unit, l.amount, l.created_at, l.meta->>'agent' AS agent,
              CASE WHEN l.ref_type = 'post' THEN l.ref_id WHEN l.ref_type = 'calendar_slot' THEN s.post_id END AS post_id,
              s.format AS slot_format,
              CASE WHEN l.ref_type = 'product' THEN l.ref_id END AS product_id
         FROM credit_ledger l
         LEFT JOIN calendar_slot s ON l.ref_type = 'calendar_slot' AND s.id = l.ref_id
        WHERE l.studio_id = $1 AND l.entry_type = 'debit' AND l.created_at >= $2 AND l.created_at < $3
          AND ($4::uuid IS NULL OR l.persona_id = $4)`,
      [q.studioId, q.from, q.to, pid],
    ),
  ]);
  const personaMap = new Map(personas.map((p) => [p.id, { name: p.name, state: p.state }]));

  const orderFacts: OrderFact[] = orders
    .filter((o) => personaMap.has(o.persona_id))
    .map((o) => ({
      personaId: o.persona_id,
      productId: o.product_id,
      postId: o.post_id,
      grossCents: Number(o.amount_cents),
      feeCents: Number(o.fee_cents),
      refundCents: Math.min(Number(o.amount_cents), Math.max(Number(o.refunded), o.status === 'refunded' ? Number(o.amount_cents) : 0)),
      at: new Date(o.ordered_at),
    }));
  const costFacts: CostFact[] = costs.map((c) => {
    const amt = Number(c.amount);
    return {
      personaId: c.persona_id,
      llmCents: c.unit === 'llm_usd' ? amt * 100 : 0,
      mediaCents: c.unit === 'media_usd' ? amt * 100 : 0,
      creditsCents: c.unit === 'hf_credits' ? amt * price : 0,
      hfCredits: c.unit === 'hf_credits' ? amt : 0,
      postId: c.post_id,
      slotFormat: c.slot_format,
      productId: c.product_id,
      agent: c.agent,
      at: new Date(c.created_at),
    };
  });

  const referenced = [...new Set([...orderFacts.map((o) => o.postId), ...costFacts.map((c) => c.postId)].filter((x): x is string => !!x))];
  const lastDay = isoDate(new Date(q.to.getTime() - 1));
  const posts = await db.query<{ id: string; persona_id: string; format: PostFormat; platform: Platform; published_at: Date | null; label: string | null; views: number }>(
    `SELECT po.id, po.persona_id, po.format, po.platform, po.published_at, COALESCE(cs.title, left(po.caption, 80)) AS label,
            COALESCE((SELECT m.views FROM metric_snapshot m WHERE m.post_id = po.id AND m.captured_on <= $6::date
                       ORDER BY m.captured_on DESC, m.created_at DESC LIMIT 1), 0)::int AS views
       FROM post po
       JOIN persona p ON p.id = po.persona_id
       LEFT JOIN calendar_slot cs ON cs.id = po.calendar_slot_id
      WHERE p.studio_id = $1 AND ($4::uuid IS NULL OR po.persona_id = $4)
        AND ((po.published_at >= $2 AND po.published_at < $3) OR po.id = ANY($5::uuid[]))`,
    [q.studioId, q.from, q.to, pid, referenced, lastDay],
  );
  const postMap = new Map<string, PostFact>();
  for (const p of posts) {
    const publishedAt = p.published_at ? new Date(p.published_at) : null;
    postMap.set(p.id, {
      id: p.id,
      personaId: p.persona_id,
      format: p.format,
      platform: p.platform,
      publishedAt,
      label: p.label ?? `${FORMAT_LABELS[p.format]} post`,
      views: Number(p.views),
      inWindow: !!publishedAt && publishedAt >= q.from && publishedAt < q.to,
    });
  }
  // A post ref from another studio (or a deleted post) is treated as overhead, not as a phantom row.
  for (const o of orderFacts) if (o.postId && !postMap.has(o.postId)) o.postId = null;
  for (const c of costFacts) if (c.postId && !postMap.has(c.postId)) c.postId = null;

  const productIds = [...new Set([...orderFacts.map((o) => o.productId), ...costFacts.map((c) => c.productId)].filter((x): x is string => !!x))];
  const products = productIds.length
    ? await db.query<{ id: string; name: string; persona_id: string }>('SELECT id, name, persona_id FROM product WHERE id = ANY($1::uuid[])', [productIds])
    : [];
  return {
    from: q.from,
    to: q.to,
    personas: personaMap,
    products: new Map(products.map((p) => [p.id, { name: p.name, personaId: p.persona_id }])),
    posts: postMap,
    orders: orderFacts,
    costs: costFacts,
    creditPriceCents: price,
  };
}

// ───────────────────────────── Aggregation ─────────────────────────────

interface Acc {
  key: string;
  label: string;
  personaId: string | null;
  format?: PostFormat;
  platform?: Platform;
  revenue: number;
  allocated: number;
  fees: number;
  refunds: number;
  llm: number;
  media: number;
  credits: number;
  hf: number;
  posts: number;
  views: number;
}

function acc(key: string, label: string, personaId: string | null, extra: Partial<Acc> = {}): Acc {
  return { key, label, personaId, revenue: 0, allocated: 0, fees: 0, refunds: 0, llm: 0, media: 0, credits: 0, hf: 0, posts: 0, views: 0, ...extra };
}

function addOrder(a: Acc, o: Pick<OrderFact, 'grossCents' | 'feeCents' | 'refundCents'>, share = 1, allocated = false) {
  a.revenue += o.grossCents * share;
  if (allocated) a.allocated += o.grossCents * share;
  a.fees += o.feeCents * share;
  a.refunds += o.refundCents * share;
}
function addCost(a: Acc, c: CostFact) {
  a.llm += c.llmCents;
  a.media += c.mediaCents;
  a.credits += c.creditsCents;
  a.hf += c.hfCredits;
}

function toRow(grain: PnlGrain, a: Acc): PnlRow {
  const cost = a.llm + a.media + a.credits;
  const net = a.revenue - a.fees - a.refunds;
  const row: PnlRow = {
    grain,
    key: a.key,
    label: a.label,
    personaId: a.personaId,
    revenueCents: round(a.revenue),
    feesCents: round(a.fees),
    refundsCents: round(a.refunds),
    costCents: round(cost),
    costBreakdown: { llmCents: round(a.llm), mediaCents: round(a.media), creditsCents: round(a.credits), hfCredits: Math.round(a.hf * 100) / 100 },
    profitCents: round(net - cost),
    posts: a.posts,
    views: a.views,
    revenuePerPostCents: a.posts ? round(net / a.posts) : 0,
    costPerPostCents: a.posts ? round(cost / a.posts) : 0,
    rpmCents: a.views ? round((a.revenue / a.views) * 1000) : 0,
  };
  if (a.format) row.format = a.format;
  if (a.platform) row.platform = a.platform;
  if (a.allocated) row.allocatedRevenueCents = round(a.allocated);
  return row;
}

/**
 * Post-level accumulation shared by the post, format and platform grains: direct revenue and cost per post, the
 * persona's unattributed sales spread over its in-window posts by views (evenly when nobody has views yet), and
 * whatever can't be placed on a post.
 */
function postLevel(f: Facts): { byPost: Map<string, Acc>; unattributed: Map<string, OrderFact[]>; loose: CostFact[] } {
  const byPost = new Map<string, Acc>();
  for (const p of f.posts.values()) {
    byPost.set(p.id, acc(p.id, p.label, p.personaId, { format: p.format, platform: p.platform, posts: p.inWindow ? 1 : 0, views: p.inWindow ? p.views : 0 }));
  }
  const unattributed = new Map<string, OrderFact[]>();
  for (const o of f.orders) {
    if (o.postId) addOrder(byPost.get(o.postId)!, o);
    else unattributed.set(o.personaId, [...(unattributed.get(o.personaId) ?? []), o]);
  }
  const leftover = new Map<string, OrderFact[]>();
  for (const [personaId, list] of unattributed) {
    const posts = [...f.posts.values()].filter((p) => p.personaId === personaId && p.inWindow);
    if (!posts.length) {
      leftover.set(personaId, list);
      continue;
    }
    const totalViews = sum(posts.map((p) => p.views));
    for (const p of posts) {
      const share = totalViews > 0 ? p.views / totalViews : 1 / posts.length;
      for (const o of list) addOrder(byPost.get(p.id)!, o, share, true);
    }
  }
  const loose: CostFact[] = [];
  for (const c of f.costs) {
    if (c.postId) addCost(byPost.get(c.postId)!, c);
    else loose.push(c);
  }
  return { byPost, unattributed: leftover, loose };
}

function synthetic(grain: PnlGrain, unattributed: Map<string, OrderFact[]>, looseCosts: CostFact[], personaId: string | null): PnlRow[] {
  const rows: PnlRow[] = [];
  const un = [...unattributed.values()].flat();
  if (un.length) {
    const a = acc(UNATTRIBUTED_KEY, 'Unattributed sales (no post in window)', personaId);
    for (const o of un) addOrder(a, o);
    rows.push(toRow(grain, a));
  }
  if (looseCosts.length) {
    const a = acc(OVERHEAD_KEY, grain === 'product' ? 'Content and overhead' : 'Overhead and unposted work', personaId);
    for (const c of looseCosts) addCost(a, c);
    rows.push(toRow(grain, a));
  }
  return rows;
}

const byProfit = (a: PnlRow, b: PnlRow) => b.profitCents - a.profitCents || a.label.localeCompare(b.label);

/** Aggregates loaded facts at one grain. */
export function aggregate(f: Facts, grain: PnlGrain, personaId: string | null = null): PnlRow[] {
  if (grain === 'persona') {
    const m = new Map<string, Acc>();
    for (const [id, p] of f.personas) m.set(id, acc(id, p.name, id));
    const studio = acc(STUDIO_KEY, 'Studio overhead', null);
    for (const o of f.orders) addOrder(m.get(o.personaId)!, o);
    for (const c of f.costs) addCost(c.personaId && m.has(c.personaId) ? m.get(c.personaId)! : studio, c);
    for (const p of f.posts.values()) {
      if (!p.inWindow) continue;
      const a = m.get(p.personaId);
      if (a) {
        a.posts += 1;
        a.views += p.views;
      }
    }
    const rows = [...m.values()].map((a) => toRow('persona', a)).sort(byProfit);
    if (studio.llm + studio.media + studio.credits > 0) rows.push(toRow('persona', studio));
    return rows;
  }

  if (grain === 'product') {
    const m = new Map<string, Acc>();
    const get = (id: string) => {
      let a = m.get(id);
      if (!a) {
        const p = f.products.get(id);
        a = acc(id, p?.name ?? 'Product', p?.personaId ?? null);
        m.set(id, a);
      }
      return a;
    };
    const noProduct: OrderFact[] = [];
    const drivers = new Map<string, Set<string>>();
    for (const o of f.orders) {
      if (!o.productId) {
        noProduct.push(o);
        continue;
      }
      addOrder(get(o.productId), o);
      if (o.postId) drivers.set(o.productId, (drivers.get(o.productId) ?? new Set()).add(o.postId));
    }
    for (const [id, posts] of drivers) {
      const a = get(id);
      a.posts = posts.size;
      a.views = sum([...posts].map((p) => f.posts.get(p)?.views ?? 0));
    }
    const loose: CostFact[] = [];
    for (const c of f.costs) {
      if (c.productId) addCost(get(c.productId), c);
      else loose.push(c);
    }
    const rows = [...m.values()].map((a) => toRow('product', a)).sort(byProfit);
    const un = new Map<string, OrderFact[]>(noProduct.length ? [['all', noProduct]] : []);
    const syn = synthetic('product', un, loose, personaId);
    for (const r of syn) if (r.key === UNATTRIBUTED_KEY) r.label = 'Sales without a product';
    return [...rows, ...syn];
  }

  const { byPost, unattributed, loose } = postLevel(f);
  if (grain === 'post') {
    const rows = [...byPost.values()].map((a) => toRow('post', a)).sort(byProfit);
    return [...rows, ...synthetic('post', unattributed, loose, personaId)];
  }

  // format / platform
  const m = new Map<string, Acc>();
  const keyOf = (a: Acc) => (grain === 'format' ? a.format! : a.platform!);
  for (const a of byPost.values()) {
    const k = keyOf(a);
    let g = m.get(k);
    if (!g) {
      g = grain === 'format' ? acc(k, FORMAT_LABELS[k as PostFormat], personaId, { format: k as PostFormat }) : acc(k, PLATFORM_LABELS[k] ?? k, personaId, { platform: k as Platform });
      m.set(k, g);
    }
    g.revenue += a.revenue;
    g.allocated += a.allocated;
    g.fees += a.fees;
    g.refunds += a.refunds;
    g.llm += a.llm;
    g.media += a.media;
    g.credits += a.credits;
    g.hf += a.hf;
    g.posts += a.posts;
    g.views += a.views;
  }
  let rest = loose;
  if (grain === 'format') {
    // Slot work that hasn't become a post yet still belongs to its format.
    rest = [];
    for (const c of loose) {
      if (!c.slotFormat) {
        rest.push(c);
        continue;
      }
      let g = m.get(c.slotFormat);
      if (!g) {
        g = acc(c.slotFormat, FORMAT_LABELS[c.slotFormat], personaId, { format: c.slotFormat });
        m.set(c.slotFormat, g);
      }
      addCost(g, c);
    }
  }
  const rows = [...m.values()].map((a) => toRow(grain, a)).sort(byProfit);
  return [...rows, ...synthetic(grain, unattributed, rest, personaId)];
}

export function totals(rows: readonly PnlRow[]): PnlTotals {
  return {
    revenueCents: sum(rows.map((r) => r.revenueCents)),
    feesCents: sum(rows.map((r) => r.feesCents)),
    refundsCents: sum(rows.map((r) => r.refundsCents)),
    costCents: sum(rows.map((r) => r.costCents)),
    profitCents: sum(rows.map((r) => r.profitCents)),
    posts: sum(rows.map((r) => r.posts)),
    views: sum(rows.map((r) => r.views)),
  };
}

/** P&L rows at one grain for a window (FR-24.1). */
export async function pnl(db: Db, q: PnlQuery): Promise<PnlRow[]> {
  if (!(q.from < q.to)) throw new Error('pnl: `from` must be before `to`');
  const f = await loadFacts(db, q);
  return aggregate(f, q.grain, q.personaId ?? null);
}

export async function pnlWithTotals(db: Db, q: PnlQuery): Promise<{ rows: PnlRow[]; totals: PnlTotals }> {
  const rows = await pnl(db, q);
  return { rows, totals: totals(rows) };
}

// ───────────────────────────── Weekly series ─────────────────────────────

export interface WeekPoint {
  weekStart: string;
  grossCents: number;
  feesCents: number;
  refundsCents: number;
  costCents: number;
  profitCents: number;
  posts: number;
  views: number;
}

/**
 * Weekly P&L series per persona (and `studio` for studio-level overhead) for the `weeks` full weeks before
 * `before` (a Monday). Used by the forecast, the levers' baselines and the Weekly Profit Report.
 */
export async function weeklySeries(
  db: Db,
  q: { studioId: string; before: Date; weeks: number; personaId?: string | null },
): Promise<{ weeks: string[]; byPersona: Map<string, WeekPoint[]>; studioOverhead: number[] }> {
  const end = mondayOf(q.before);
  const start = new Date(end.getTime() - q.weeks * WEEK_MS);
  const f = await loadFacts(db, { studioId: q.studioId, from: start, to: end, personaId: q.personaId });
  const weeks = Array.from({ length: q.weeks }, (_, i) => isoDate(new Date(start.getTime() + i * WEEK_MS)));
  const idx = (d: Date) => Math.floor((d.getTime() - start.getTime()) / WEEK_MS);
  const empty = (): WeekPoint[] => weeks.map((w) => ({ weekStart: w, grossCents: 0, feesCents: 0, refundsCents: 0, costCents: 0, profitCents: 0, posts: 0, views: 0 }));
  const byPersona = new Map<string, WeekPoint[]>();
  for (const id of f.personas.keys()) byPersona.set(id, empty());
  const studioOverhead = weeks.map(() => 0);
  for (const o of f.orders) {
    const w = byPersona.get(o.personaId)?.[idx(o.at)];
    if (!w) continue;
    w.grossCents += o.grossCents;
    w.feesCents += o.feeCents;
    w.refundsCents += o.refundCents;
  }
  for (const c of f.costs) {
    const i = idx(c.at);
    if (i < 0 || i >= weeks.length) continue;
    const w = c.personaId ? byPersona.get(c.personaId)?.[i] : undefined;
    if (w) w.costCents += costCents(c);
    else studioOverhead[i]! += costCents(c);
  }
  for (const p of f.posts.values()) {
    if (!p.inWindow || !p.publishedAt) continue;
    const w = byPersona.get(p.personaId)?.[idx(p.publishedAt)];
    if (!w) continue;
    w.posts += 1;
    w.views += p.views;
  }
  for (const list of byPersona.values()) {
    for (const w of list) {
      w.costCents = round(w.costCents);
      w.profitCents = round(w.grossCents - w.feesCents - w.refundsCents - w.costCents);
    }
  }
  return { weeks, byPersona, studioOverhead: studioOverhead.map(round) };
}
