import type { StudioServices } from '@ios/agents';
import { buildListingPack } from '@ios/content';
import { audit, notify, OWNER, SYSTEM, type Actor } from '@ios/core';
import type { Db } from '@ios/db';
import type { StoreInfo, StoreProduct } from '@ios/providers';
import { asRecord, asString } from './util';

/**
 * Lemon Squeezy stores and products (FR-10.1). The products API is read-only, so the studio prefers an API-less
 * path: every approved product gets a listing pack (Gate-checked, from @ios/content), and goes live as soon as a
 * checkout URL is stored for it, either matched from the store's own products (read API) or pasted by the Owner.
 * Free lead magnets need no store: they are delivered by email. Status per product: none → listing_pack →
 * awaiting_listing (the Owner creates the store listing from the pack: the one unavoidable manual step) → linked.
 */

export type StoreStatus = 'none' | 'listing_pack' | 'awaiting_listing' | 'linked' | 'free';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Links each Lemon Squeezy store to its persona (by store slug = persona slug, or the persona's name in the store name). */
export async function syncStores(services: StudioServices, studioId: string): Promise<{ stores: number; linked: number }> {
  const { db } = services;
  const stores = await services.providers.store.listStores();
  const personas = await db.query<{ id: string; slug: string; name: string }>(`SELECT id, slug, name FROM persona WHERE studio_id = $1`, [studioId]);
  const existing = await db.query<{ persona_id: string; store_id: string | null }>(
    `SELECT sa.persona_id, sa.store_id FROM store_account sa JOIN persona p ON p.id = sa.persona_id WHERE p.studio_id = $1`,
    [studioId],
  );
  let linked = 0;
  for (const s of stores) {
    const already = existing.find((e) => e.store_id === s.id);
    const persona =
      (already && personas.find((p) => p.id === already.persona_id)) ??
      personas.find((p) => p.slug === s.slug) ??
      personas.find((p) => norm(s.name).includes(norm(p.name)) && !existing.some((e) => e.persona_id === p.id && e.store_id && e.store_id !== s.id));
    if (!persona) continue;
    await upsertStoreAccount(db, persona.id, s);
    linked += 1;
  }
  return { stores: stores.length, linked };
}

async function upsertStoreAccount(db: Db, personaId: string, s: StoreInfo): Promise<void> {
  await db.query(
    `INSERT INTO store_account (persona_id, store_id, store_name, store_slug, store_domain, currency, status, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'linked', now())
     ON CONFLICT (persona_id) DO UPDATE SET store_id = EXCLUDED.store_id, store_name = EXCLUDED.store_name, store_slug = EXCLUDED.store_slug,
       store_domain = EXCLUDED.store_domain, currency = EXCLUDED.currency, status = 'linked', synced_at = now(), updated_at = now()`,
    [personaId, s.id, s.name, s.slug, s.domain, s.currency],
  );
}

/** Owner action: link (or unlink with null) a persona to a store id from the store listing. */
export async function linkStore(services: StudioServices, args: { personaId: string; storeId: string | null; actor?: Actor }): Promise<void> {
  const { db } = services;
  if (!args.storeId) {
    await db.query(`UPDATE store_account SET store_id = NULL, status = 'unlinked', updated_at = now() WHERE persona_id = $1`, [args.personaId]);
  } else {
    const store = (await services.providers.store.listStores()).find((s) => s.id === args.storeId);
    if (!store) throw new Error('that store is not in the Lemon Squeezy account');
    const taken = await db.maybeOne<{ persona_id: string }>('SELECT persona_id FROM store_account WHERE store_id = $1', [store.id]);
    if (taken && taken.persona_id !== args.personaId) throw new Error('that store is already linked to another persona (one store per persona)');
    await upsertStoreAccount(db, args.personaId, store);
  }
  await audit(db, { personaId: args.personaId, actor: args.actor ?? OWNER, action: 'store.link', entityType: 'persona', entityId: args.personaId, data: { storeId: args.storeId } });
}

export async function storeFor(db: Db, personaId: string): Promise<{ storeId: string; domain: string | null } | null> {
  const r = await db.maybeOne<{ store_id: string | null; store_domain: string | null }>(
    `SELECT store_id, store_domain FROM store_account WHERE persona_id = $1 AND status = 'linked'`,
    [personaId],
  );
  return r?.store_id ? { storeId: r.store_id, domain: r.store_domain } : null;
}

interface SweepProduct {
  id: string;
  persona_id: string;
  studio_id: string;
  persona_name: string;
  name: string;
  slug: string;
  ladder_rung: string;
  status: string;
  price_cents: number;
  checkout_url: string | null;
  store_status: StoreStatus;
  store_product_id: string | null;
  has_listing: boolean;
}

function matchStoreProduct(p: Pick<SweepProduct, 'name' | 'slug' | 'store_product_id'>, list: readonly StoreProduct[], listingName: string | null): StoreProduct | null {
  const published = list.filter((s) => s.status === 'published');
  return (
    (p.store_product_id ? published.find((s) => s.id === p.store_product_id) : undefined) ??
    published.find((s) => norm(s.name) === norm(p.name)) ??
    (listingName ? published.find((s) => norm(s.name) === norm(listingName)) : undefined) ??
    published.find((s) => s.url && norm(s.url).endsWith(norm(p.slug))) ??
    null
  );
}

/**
 * Moves approved products toward live (idempotent; runs on a schedule). Listing packs are built once; store
 * products are matched through the read-only API; a product goes live once a checkout URL is stored.
 */
export async function productSweep(services: StudioServices, opts: { studioId?: string; now?: Date } = {}): Promise<Array<{ productId: string; from: StoreStatus; to: StoreStatus }>> {
  const { db } = services;
  const now = opts.now ?? services.now();
  const rows = await db.query<SweepProduct>(
    `SELECT pr.id, pr.persona_id, pe.studio_id, pe.name AS persona_name, pr.name, pr.slug, pr.ladder_rung, pr.status, pr.price_cents, pr.checkout_url,
            pr.store_status, pr.store_product_id,
            EXISTS (SELECT 1 FROM product_listing l WHERE l.product_id = pr.id AND l.channel = 'lemonsqueezy') AS has_listing
       FROM product pr JOIN persona pe ON pe.id = pr.persona_id
      WHERE pr.status IN ('approved','live') AND pe.state NOT IN ('KILLED','RETIRED','ARCHIVED') AND ($1::uuid IS NULL OR pe.studio_id = $1)
        AND (pr.store_status <> 'linked' AND pr.store_status <> 'free' OR pr.status <> 'live')
      ORDER BY pr.created_at`,
    [opts.studioId ?? null],
  );
  const catalog = new Map<string, StoreProduct[]>();
  const changes: Array<{ productId: string; from: StoreStatus; to: StoreStatus }> = [];
  for (const p of rows) {
    const from = p.store_status;
    let to: StoreStatus = from;
    if (p.ladder_rung === 'lead_magnet' || Number(p.price_cents) === 0) {
      to = 'free';
    } else if (p.checkout_url) {
      to = 'linked';
    } else {
      let listingName: string | null = null;
      if (!p.has_listing) {
        const pack = await buildListingPack(services, p.id);
        listingName = pack.lemonsqueezy.name;
        to = 'listing_pack';
      } else {
        const l = await db.maybeOne<{ fields: Record<string, unknown> }>(`SELECT fields FROM product_listing WHERE product_id = $1 AND channel = 'lemonsqueezy'`, [p.id]);
        listingName = asString(asRecord(l?.fields).name) || null;
      }
      const store = await storeFor(db, p.persona_id);
      if (store) {
        if (!catalog.has(store.storeId)) catalog.set(store.storeId, await services.providers.store.listProducts({ storeId: store.storeId }).catch(() => []));
        const match = matchStoreProduct(p, catalog.get(store.storeId)!, listingName);
        if (match && (match.checkoutUrl || match.url)) {
          await db.query(
            `UPDATE product SET store_product_id = $2, store_id = $3, store_variant_id = $4, checkout_url = $5 WHERE id = $1`,
            [p.id, match.id, match.storeId ?? store.storeId, match.variantId ?? null, match.checkoutUrl ?? match.url],
          );
          to = 'linked';
        }
      }
      if (to !== 'linked') to = 'awaiting_listing';
    }
    const goLive = (to === 'linked' || to === 'free') && p.status === 'approved';
    await db.query(
      `UPDATE product SET store_status = $2, store_checked_at = $3, status = CASE WHEN $4 THEN 'live' ELSE status END,
              live_at = CASE WHEN $4 THEN COALESCE(live_at, $3) ELSE live_at END WHERE id = $1`,
      [p.id, to, now, goLive],
    );
    if (goLive) await audit(db, { studioId: p.studio_id, personaId: p.persona_id, actor: SYSTEM, action: 'product.live', entityType: 'product', entityId: p.id, data: { storeStatus: to } });
    if (to === 'awaiting_listing' && from !== 'awaiting_listing') {
      await notify(db, {
        studioId: p.studio_id,
        personaId: p.persona_id,
        kind: 'system',
        title: `Create the store listing for ${p.name}`,
        body: `${p.persona_name}'s listing pack is ready. Lemon Squeezy's products API is read-only, so create the product from the pack (about 5 minutes) or paste its checkout URL on Commerce. It goes live as soon as the URL is stored.`,
        link: '/commerce',
      });
    }
    if (to !== from || goLive) changes.push({ productId: p.id, from, to });
  }
  return changes;
}

/** Owner action: store a product's checkout URL (Lemon Squeezy buy link). The product goes live if it was approved. */
export async function setCheckoutUrl(services: StudioServices, args: { productId: string; url: string | null; actor?: Actor }): Promise<void> {
  const { db } = services;
  const p = await db.one<{ id: string; persona_id: string; status: string }>('SELECT id, persona_id, status FROM product WHERE id = $1', [args.productId]);
  if (!args.url) {
    await db.query(`UPDATE product SET checkout_url = NULL, store_status = CASE WHEN store_status = 'linked' THEN 'awaiting_listing' ELSE store_status END WHERE id = $1`, [p.id]);
  } else {
    let u: URL;
    try {
      u = new URL(args.url.trim());
    } catch {
      throw new Error('checkout URL must be a full https:// link');
    }
    const store = await storeFor(db, p.persona_id);
    const okHost = u.hostname.endsWith('.lemonsqueezy.com') || u.hostname === 'lemonsqueezy.com' || (store?.domain ? u.hostname === store.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : false);
    if (u.protocol !== 'https:' || !okHost) throw new Error('checkout URL must be an https Lemon Squeezy link (or the store’s own domain)');
    u.hash = '';
    await db.query(
      `UPDATE product SET checkout_url = $2, store_status = 'linked', store_checked_at = now(),
              status = CASE WHEN status = 'approved' THEN 'live' ELSE status END,
              live_at = CASE WHEN status IN ('approved','live') THEN COALESCE(live_at, now()) ELSE live_at END
        WHERE id = $1`,
      [p.id, u.toString()],
    );
  }
  await audit(db, { personaId: p.persona_id, actor: args.actor ?? OWNER, action: 'product.checkout_url', entityType: 'product', entityId: p.id, data: { set: Boolean(args.url) } });
}

export interface ProductStoreRow {
  id: string;
  persona_id: string;
  persona_name: string;
  persona_slug: string;
  name: string;
  slug: string;
  ladder_rung: string;
  status: string;
  price_cents: number;
  store_status: StoreStatus;
  checkout_url: string | null;
  store_product_id: string | null;
  listing_verdict: string | null;
  orders: number;
  revenue_cents: number;
}

/** Products with their listing-pack / checkout-URL status (dashboard). */
export async function productStoreBoard(db: Db, studioId: string, personaId?: string | null): Promise<ProductStoreRow[]> {
  return db.query<ProductStoreRow>(
    `SELECT pr.id, pr.persona_id, pe.name AS persona_name, pe.slug AS persona_slug, pr.name, pr.slug, pr.ladder_rung, pr.status, pr.price_cents,
            pr.store_status, pr.checkout_url, pr.store_product_id,
            (SELECT gate_verdict FROM product_listing l WHERE l.product_id = pr.id AND l.channel = 'lemonsqueezy') AS listing_verdict,
            (SELECT count(*) FROM orders o WHERE o.product_id = pr.id)::int AS orders,
            (SELECT COALESCE(SUM(o.amount_cents), 0) FROM orders o WHERE o.product_id = pr.id AND o.status <> 'refunded')::int AS revenue_cents
       FROM product pr JOIN persona pe ON pe.id = pr.persona_id
      WHERE pe.studio_id = $1 AND ($2::uuid IS NULL OR pe.id = $2) AND pr.status <> 'retired'
      ORDER BY pe.name, CASE pr.status WHEN 'live' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, pr.created_at`,
    [studioId, personaId ?? null],
  );
}

/** The listing pack fields (for the Owner to create the store product). */
export async function listingPack(db: Db, productId: string): Promise<Record<string, unknown> | null> {
  const r = await db.maybeOne<{ fields: Record<string, unknown> }>(`SELECT fields FROM product_listing WHERE product_id = $1 AND channel = 'lemonsqueezy'`, [productId]);
  return r?.fields ?? null;
}

/** Storage key of a product's deliverable (preferred page size first), from product_version.files or file_url. */
export async function productFileKey(db: Db, productId: string, prefer: 'A4' | 'Letter' = 'A4'): Promise<{ key: string; version: number } | null> {
  const r = await db.maybeOne<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(pv) AS row FROM product_version pv JOIN product pr ON pr.id = pv.product_id
      WHERE pv.product_id = $1 AND pv.status IN ('approved','live')
      ORDER BY (pv.version = pr.current_version) DESC, pv.version DESC LIMIT 1`,
    [productId],
  );
  if (!r) return null;
  const row = r.row;
  const version = Number(row.version);
  const files = Array.isArray(row.files) ? (row.files as Array<Record<string, unknown>>) : [];
  const pdfs = files.filter((f) => f.kind === 'pdf' && typeof f.storageKey === 'string');
  const pick = pdfs.find((f) => f.pageSize === prefer) ?? pdfs[0];
  if (pick) return { key: String(pick.storageKey), version };
  const url = typeof row.file_url === 'string' ? row.file_url : '';
  const m = /^\/api\/(?:public\/)?media\/(.+)$/.exec(url);
  return m ? { key: decodeURIComponent(m[1]!), version } : null;
}
