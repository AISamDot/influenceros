import { createTestStudio, makeTestPersona, type TestStudio } from '@troupe/agents/testing';
import { json } from '@troupe/db';
import type { StoreEvent } from '@troupe/providers';
import { updateCommerceSettings } from '../src';

/** Stream G test fixtures (fake providers, in-memory PGlite). */

export const ADDRESS = 'Test Studio LLC, 1 Market Street, Dubai, UAE';

export const PALETTE_BIBLE = {
  visual_identity: `| Palette | Hex | Used for |
|---|---|---|
| Cream | #F7F1E8 | backgrounds |
| Ink | #1F1B16 | text |
| Terracotta | #C4572E | CTAs |
| Sage | #7F9C7A | accents |`,
};

export async function studio(opts: { address?: boolean; now?: () => Date } = {}): Promise<TestStudio> {
  const t = await createTestStudio(opts.now ? { now: opts.now } : {});
  if (opts.address !== false) await updateCommerceSettings(t.db, t.studioId, { physicalAddress: ADDRESS, senderDomain: 'mail.studio.test' });
  return t;
}

export async function persona(t: TestStudio, opts: { state?: 'SETUP' | 'TESTING' | 'MONETISING' | 'KILLED'; name?: string } = {}) {
  const p = await makeTestPersona(t, { state: opts.state ?? 'TESTING', name: opts.name, niche: 'home organisation' });
  await t.db.query(`INSERT INTO persona_bible (persona_id, version, content, status, created_by) VALUES ($1, 1, $2::jsonb, 'approved', 'test')`, [p.id, json(PALETTE_BIBLE)]);
  return p;
}

export async function product(
  t: TestStudio,
  personaId: string,
  opts: { name?: string; slug?: string; rung?: string; status?: string; price?: number; file?: boolean; checkoutUrl?: string | null; storeProductId?: string } = {},
): Promise<{ id: string; slug: string; name: string }> {
  const name = opts.name ?? 'Kitchen Reset Workbook';
  const slug = opts.slug ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const row = await t.db.one<{ id: string }>(
    `INSERT INTO product (persona_id, name, slug, ladder_rung, status, price_cents, checkout_url, store_product_id, current_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1) RETURNING id`,
    [personaId, name, slug, opts.rung ?? 'entry', opts.status ?? 'approved', opts.price ?? 1700, opts.checkoutUrl ?? null, opts.storeProductId ?? null],
  );
  await t.db.query(`INSERT INTO product_brief (persona_id, product_id, content) VALUES ($1, $2, $3::jsonb)`, [
    personaId,
    row.id,
    json({ name, promise: `Reset your ${slug} in a weekend.`, audience: 'busy renters', outline: ['Start here', 'Zone map', 'Weekly tracker'], format: 'PDF workbook', page_count: 24, bonuses: [], price_cents: opts.price ?? 1700, ladder_rung: opts.rung ?? 'entry', upsell_pairing: 'membership', cta_keyword: 'RESET', validation: [] }),
  ]);
  if (opts.file) {
    const key = `products/${personaId}/${row.id}/v1/a4.pdf`;
    const stored = await t.providers.storage.put({ key, data: '%PDF-1.7 test', contentType: 'application/pdf' });
    await t.db.query(`INSERT INTO product_version (product_id, persona_id, version, file_url, status) VALUES ($1, $2, 1, $3, 'approved')`, [row.id, personaId, stored.url]);
  }
  return { id: row.id, slug, name };
}

export async function post(t: TestStudio, personaId: string, opts: { productId?: string | null; purpose?: 'reach' | 'trust' | 'sell'; status?: string; platform?: string } = {}): Promise<{ id: string; slotId: string }> {
  const slot = await t.db.one<{ id: string }>(
    `INSERT INTO calendar_slot (persona_id, slot_at, format, purpose, title, status, product_id, cta_keyword) VALUES ($1, now(), 'talking', $2, 'A post', 'scheduled', $3, 'RESET') RETURNING id`,
    [personaId, opts.purpose ?? 'sell', opts.productId ?? null],
  );
  const p = await t.db.one<{ id: string }>(
    `INSERT INTO post (persona_id, calendar_slot_id, platform, format, caption, status, published_at) VALUES ($1, $2, $3, 'talking', 'Comment RESET', $4, now()) RETURNING id`,
    [personaId, slot.id, opts.platform ?? 'tiktok', opts.status ?? 'live'],
  );
  await t.db.query(`UPDATE calendar_slot SET post_id = $2 WHERE id = $1`, [slot.id, p.id]);
  return { id: p.id, slotId: slot.id };
}

export async function linkStore(t: TestStudio, personaId: string, slug: string, storeId = 'st_1'): Promise<void> {
  t.providers.store.stores.push({ id: storeId, name: `${slug} store`, slug, domain: `${slug}.lemonsqueezy.com`, currency: 'USD' });
  await t.db.query(`INSERT INTO store_account (persona_id, store_id, store_slug, status) VALUES ($1, $2, $3, 'linked')`, [personaId, storeId, slug]);
}

/** A signed Lemon Squeezy-shaped webhook for the fake store (StoreEvent JSON). */
export function signed(t: TestStudio, ev: StoreEvent): { body: string; sig: string } {
  const body = JSON.stringify(ev);
  return { body, sig: t.providers.store.sign(body) };
}
