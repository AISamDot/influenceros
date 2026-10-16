import type { StudioServices } from '@ios/agents';
import type { Db } from '@ios/db';
import { storeFor } from './store';
import { newCode, UUID_RE } from './util';

/**
 * Attribution end to end (FR-13.2): every post that is about to go out gets a short link (and sell posts with a paid
 * product a coupon code); /l/<code> counts the click and lands on the persona's site with `?src=<code>`; the buy
 * button passes the post id, short link and coupon into the Lemon Squeezy checkout as custom data; the order webhook
 * attributes the order (custom data post_id, then coupon, then short link), and the Profit Engine's P&L reads
 * `orders.source_post_id` / `coupon_id` / `short_link_id`.
 */

export const COUPON_PERCENT = 10;
export const COUPON_DAYS = 30;
const POST_STATUSES = ['awaiting_approval', 'scheduled', 'publishing', 'live'];

interface PostRow {
  id: string;
  persona_id: string;
  persona_slug: string;
  purpose: string | null;
  product_id: string | null;
  product_slug: string | null;
  product_rung: string | null;
  product_price: number | null;
  product_status: string | null;
  cta_keyword: string | null;
  has_link: boolean;
  has_coupon: boolean;
}

async function uniqueCode(db: Db): Promise<string> {
  for (let i = 0; i < 8; i += 1) {
    const code = newCode(7);
    if (!(await db.maybeOne('SELECT 1 FROM short_link WHERE slug = $1', [code]))) return code;
  }
  throw new Error('could not allocate a short link code');
}

async function uniqueCoupon(db: Db, base: string): Promise<string> {
  const stem = (base.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'POST').slice(0, 8);
  for (let i = 0; i < 8; i += 1) {
    const code = `${stem}${newCode(4).toUpperCase()}`;
    if (!(await db.maybeOne('SELECT 1 FROM coupon WHERE code = $1', [code]))) return code;
  }
  throw new Error('could not allocate a coupon code');
}

/** Where a post's link lands: its sell product's page when that product sells, else the lead-magnet page. */
function targetFor(p: PostRow): { path: string; productId: string | null } {
  const sells = p.product_id && p.product_status === 'live' && p.product_rung !== 'lead_magnet' && Number(p.product_price) > 0;
  return sells ? { path: `/shop/${p.product_slug}`, productId: p.product_id } : { path: '/free', productId: p.product_id && p.product_rung === 'lead_magnet' ? p.product_id : null };
}

/**
 * Creates the missing short links (every post) and coupons (sell posts of a paid product) for posts that are about
 * to go out or are live. Coupons are created in the persona's store when it's linked; otherwise they wait as
 * 'pending_store' and a later sweep creates them. Idempotent (one link and one coupon per post).
 */
export async function sweepPostLinks(services: StudioServices, opts: { studioId?: string; now?: Date; limit?: number } = {}): Promise<{ links: number; coupons: number }> {
  const { db } = services;
  const now = opts.now ?? services.now();
  const posts = await db.query<PostRow>(
    `SELECT po.id, po.persona_id, pe.slug AS persona_slug, s.purpose, pr.id AS product_id, pr.slug AS product_slug, pr.ladder_rung AS product_rung,
            pr.price_cents AS product_price, pr.status AS product_status, COALESCE(s.cta_keyword, pr.cta_keyword) AS cta_keyword,
            EXISTS (SELECT 1 FROM short_link sl WHERE sl.post_id = po.id) AS has_link,
            EXISTS (SELECT 1 FROM coupon c WHERE c.source_post_id = po.id) AS has_coupon
       FROM post po
       JOIN persona pe ON pe.id = po.persona_id
       LEFT JOIN calendar_slot s ON s.id = po.calendar_slot_id
       LEFT JOIN product pr ON pr.id = s.product_id
      WHERE po.status = ANY($1::text[]) AND ($2::uuid IS NULL OR pe.studio_id = $2)
        AND (NOT EXISTS (SELECT 1 FROM short_link sl WHERE sl.post_id = po.id)
             OR (s.purpose = 'sell' AND pr.status = 'live' AND pr.price_cents > 0 AND pr.ladder_rung <> 'lead_magnet'
                 AND NOT EXISTS (SELECT 1 FROM coupon c WHERE c.source_post_id = po.id)))
      ORDER BY po.created_at LIMIT $3`,
    [POST_STATUSES, opts.studioId ?? null, opts.limit ?? 200],
  );
  let links = 0;
  let coupons = 0;
  for (const p of posts) {
    const target = targetFor(p);
    if (!p.has_link) {
      const code = await uniqueCode(db);
      const inserted = await db.maybeOne(
        `INSERT INTO short_link (persona_id, slug, target_url, target_path, product_id, post_id) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING RETURNING id`,
        [p.persona_id, code, target.path, target.path, target.productId, p.id],
      );
      if (inserted) links += 1;
    }
    if (!p.has_coupon && p.purpose === 'sell' && target.path.startsWith('/shop/') && target.productId) {
      const code = await uniqueCoupon(db, p.cta_keyword ?? p.product_slug ?? 'POST');
      const validUntil = new Date(now.getTime() + COUPON_DAYS * 86_400_000);
      const inserted = await db.maybeOne<{ id: string }>(
        `INSERT INTO coupon (persona_id, code, discount_pct, product_id, source_post_id, valid_until, status) VALUES ($1, $2, $3, $4, $5, $6, 'pending_store')
         ON CONFLICT DO NOTHING RETURNING id`,
        [p.persona_id, code, COUPON_PERCENT, target.productId, p.id, validUntil],
      );
      if (inserted) {
        coupons += 1;
        await pushCoupon(services, inserted.id);
      }
    }
  }
  // Retry coupons that are waiting for a linked store.
  const pending = await db.query<{ id: string }>(
    `SELECT c.id FROM coupon c JOIN persona pe ON pe.id = c.persona_id
      WHERE c.status = 'pending_store' AND (c.valid_until IS NULL OR c.valid_until > $1) AND ($2::uuid IS NULL OR pe.studio_id = $2)
        AND EXISTS (SELECT 1 FROM store_account sa WHERE sa.persona_id = c.persona_id AND sa.status = 'linked')
      LIMIT 50`,
    [now, opts.studioId ?? null],
  );
  for (const c of pending) await pushCoupon(services, c.id);
  return { links, coupons };
}

/** Creates the coupon in the persona's Lemon Squeezy store (when linked). */
async function pushCoupon(services: StudioServices, couponId: string): Promise<void> {
  const { db } = services;
  const c = await db.one<{ persona_id: string; code: string; discount_pct: number; valid_until: Date | null; store_product_id: string | null; status: string }>(
    `SELECT c.persona_id, c.code, c.discount_pct, c.valid_until, pr.store_product_id, c.status FROM coupon c LEFT JOIN product pr ON pr.id = c.product_id WHERE c.id = $1`,
    [couponId],
  );
  if (c.status !== 'pending_store') return;
  const store = await storeFor(db, c.persona_id);
  if (!store) return;
  try {
    const d = await services.providers.store.createDiscount({
      storeId: store.storeId,
      code: c.code,
      percent: Number(c.discount_pct),
      productIds: c.store_product_id ? [c.store_product_id] : undefined,
      expiresAt: c.valid_until ? new Date(c.valid_until) : null,
    });
    await db.query(`UPDATE coupon SET store_discount_id = $2, status = 'active' WHERE id = $1`, [couponId, d.id]);
  } catch {
    // Stays pending; the next sweep retries.
  }
}

/** A click on /l/<code>. Returns the site path to land on, or null (unknown code, or a code of another persona's host). */
export async function resolveShortLink(services: Pick<StudioServices, 'db' | 'now'>, args: { code: string; hostSlug?: string | null }): Promise<{ slug: string; path: string; code: string } | null> {
  const { db } = services;
  if (!/^[a-z2-9]{4,16}$/.test(args.code)) return null;
  const sl = await db.maybeOne<{ id: string; slug: string; target_path: string | null; target_url: string; persona_slug: string; state: string }>(
    `SELECT sl.id, sl.slug, sl.target_path, sl.target_url, pe.slug AS persona_slug, pe.state FROM short_link sl JOIN persona pe ON pe.id = sl.persona_id WHERE sl.slug = $1`,
    [args.code],
  );
  if (!sl || ['PROPOSED', 'ARCHIVED', 'KILLED', 'RETIRED'].includes(sl.state)) return null;
  if (args.hostSlug && args.hostSlug !== sl.persona_slug) return null;
  const now = services.now();
  await db.query(`UPDATE short_link SET clicks = clicks + 1, last_click_at = $2 WHERE id = $1`, [sl.id, now]);
  await db.query(
    `INSERT INTO commerce_click_day (short_link_id, day, clicks) VALUES ($1, $2::date, 1)
     ON CONFLICT (short_link_id, day) DO UPDATE SET clicks = commerce_click_day.clicks + 1`,
    [sl.id, now.toISOString().slice(0, 10)],
  );
  const base = sl.target_path ?? (sl.target_url.startsWith('/') ? sl.target_url : '/');
  const path = `${base}${base.includes('?') ? '&' : '?'}src=${sl.slug}`;
  return { slug: sl.persona_slug, path, code: sl.slug };
}

export interface Attribution {
  sourcePostId: string | null;
  couponId: string | null;
  shortLinkId: string | null;
  method: 'custom_data' | 'coupon' | 'short_link' | 'none';
}

/** Attribution for an order: checkout custom data `post_id`, then the coupon, then the short link (all within the persona). */
export async function attributeOrder(db: Db, args: { personaId: string; customData?: Readonly<Record<string, string>>; discountCode?: string | null }): Promise<Attribution> {
  const custom = args.customData ?? {};
  let customPost: string | null = null;
  if (custom.post_id && UUID_RE.test(custom.post_id)) {
    const p = await db.maybeOne<{ id: string }>('SELECT id FROM post WHERE id = $1 AND persona_id = $2', [custom.post_id, args.personaId]);
    customPost = p?.id ?? null;
  }
  const code = (args.discountCode ?? custom.coupon ?? '').trim().toUpperCase();
  const coupon = code
    ? await db.maybeOne<{ id: string; source_post_id: string | null }>('SELECT id, source_post_id FROM coupon WHERE upper(code) = $1 AND persona_id = $2', [code, args.personaId])
    : null;
  const link = custom.short_link && /^[a-z2-9]{4,16}$/.test(custom.short_link)
    ? await db.maybeOne<{ id: string; post_id: string | null }>('SELECT id, post_id FROM short_link WHERE slug = $1 AND persona_id = $2', [custom.short_link, args.personaId])
    : null;
  if (customPost) return { sourcePostId: customPost, couponId: coupon?.id ?? null, shortLinkId: link?.id ?? null, method: 'custom_data' };
  if (coupon?.source_post_id) return { sourcePostId: coupon.source_post_id, couponId: coupon.id, shortLinkId: link?.id ?? null, method: 'coupon' };
  if (link?.post_id) return { sourcePostId: link.post_id, couponId: coupon?.id ?? null, shortLinkId: link.id, method: 'short_link' };
  return { sourcePostId: null, couponId: coupon?.id ?? null, shortLinkId: link?.id ?? null, method: coupon || link ? (coupon ? 'coupon' : 'short_link') : 'none' };
}

/** The checkout attribution a visitor carries from a short link (`src`): the post, the code and the post's coupon. */
export async function sourceFor(db: Db, personaId: string, src: string | null | undefined): Promise<{ postId: string | null; code: string | null; coupon: string | null }> {
  if (!src || !/^[a-z2-9]{4,16}$/.test(src)) return { postId: null, code: null, coupon: null };
  const sl = await db.maybeOne<{ slug: string; post_id: string | null; coupon: string | null }>(
    `SELECT sl.slug, sl.post_id, (SELECT c.code FROM coupon c WHERE c.source_post_id = sl.post_id AND c.status = 'active' AND (c.valid_until IS NULL OR c.valid_until > now()) LIMIT 1) AS coupon
       FROM short_link sl WHERE sl.slug = $1 AND sl.persona_id = $2`,
    [src, personaId],
  );
  return sl ? { postId: sl.post_id, code: sl.slug, coupon: sl.coupon } : { postId: null, code: null, coupon: null };
}

export interface PostAttributionRow {
  post_id: string;
  platform: string;
  caption: string | null;
  url: string | null;
  code: string | null;
  coupon: string | null;
  clicks: number;
  subscribers: number;
  orders: number;
  revenue_cents: number;
  refunds_cents: number;
}

/** Per-post funnel for a persona: clicks → subscribers → orders → revenue (same attribution rule as the P&L). */
export async function postAttribution(db: Db, personaId: string, opts: { since?: Date; limit?: number } = {}): Promise<PostAttributionRow[]> {
  return db.query<PostAttributionRow>(
    `WITH o AS (
       SELECT COALESCE(o.source_post_id, c.source_post_id, sl.post_id) AS post_id, o.amount_cents,
              COALESCE((SELECT SUM(r.amount_cents) FROM refund r WHERE r.order_id = o.id AND r.status IN ('approved','refunded')), 0) AS refunded
         FROM orders o LEFT JOIN coupon c ON c.id = o.coupon_id LEFT JOIN short_link sl ON sl.id = o.short_link_id
        WHERE o.persona_id = $1 AND ($2::timestamptz IS NULL OR o.ordered_at >= $2))
     SELECT po.id AS post_id, po.platform, po.caption, po.url, sl.slug AS code, c.code AS coupon, COALESCE(sl.clicks, 0)::int AS clicks,
            (SELECT count(*) FROM subscriber s WHERE s.source_post_id = po.id)::int AS subscribers,
            (SELECT count(*) FROM o WHERE o.post_id = po.id)::int AS orders,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM o WHERE o.post_id = po.id)::int AS revenue_cents,
            (SELECT COALESCE(SUM(refunded), 0) FROM o WHERE o.post_id = po.id)::int AS refunds_cents
       FROM post po LEFT JOIN short_link sl ON sl.post_id = po.id LEFT JOIN coupon c ON c.source_post_id = po.id
      WHERE po.persona_id = $1 AND (sl.id IS NOT NULL OR EXISTS (SELECT 1 FROM o WHERE o.post_id = po.id))
      ORDER BY revenue_cents DESC, clicks DESC, po.created_at DESC
      LIMIT $3`,
    [personaId, opts.since ?? null, opts.limit ?? 50],
  );
}
