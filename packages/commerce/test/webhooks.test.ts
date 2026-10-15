import { pnl } from '@ios/profit';
import { describe, expect, it } from 'vitest';
import { checkoutUrlFor, handleStoreWebhook, resolveShortLink, sweepPostLinks } from '../src';
import { linkStore, persona, post, product, signed, studio } from './helpers';

describe('Lemon Squeezy webhooks: orders, refunds, replays', () => {
  it('a signed order is attributed to the post by checkout custom data; a bad signature is refused; a replay is idempotent', async () => {
    const t = await studio();
    const p = await persona(t);
    const pr = await product(t, p.id, { status: 'live', storeProductId: 'lsp_1' });
    await linkStore(t, p.id, p.slug);
    const po = await post(t, p.id, { productId: pr.id });
    const { body, sig } = signed(t, {
      type: 'order_created',
      orderId: 'ord_1',
      productId: 'lsp_1',
      storeId: 'st_1',
      amountCents: 1700,
      currency: 'USD',
      emailHash: 'h',
      customData: { post_id: po.id },
    });

    expect((await handleStoreWebhook(t.services, body, 'deadbeef')).status).toBe(401);
    expect((await handleStoreWebhook(t.services, body, null)).status).toBe(401);
    expect((await t.db.query('SELECT 1 FROM orders')).length).toBe(0);

    const r = await handleStoreWebhook(t.services, body, sig);
    expect(r).toMatchObject({ status: 200, outcome: 'processed' });
    const o = await t.db.one<{ persona_id: string; product_id: string; source_post_id: string; attribution: string; fee_cents: number; amount_cents: number }>('SELECT * FROM orders');
    expect(o).toMatchObject({ persona_id: p.id, product_id: pr.id, source_post_id: po.id, attribution: 'custom_data', amount_cents: 1700, fee_cents: 135 });

    expect(await handleStoreWebhook(t.services, body, sig)).toMatchObject({ status: 200, outcome: 'duplicate' });
    expect((await t.db.query('SELECT 1 FROM orders')).length).toBe(1);
  });

  it('attributes by coupon, then by short link, and refunds update the order and the P&L', async () => {
    const t = await studio();
    const p = await persona(t);
    const pr = await product(t, p.id, { status: 'live', storeProductId: 'lsp_2' });
    await linkStore(t, p.id, p.slug);
    const a = await post(t, p.id, { productId: pr.id });
    const b = await post(t, p.id, { productId: pr.id, purpose: 'reach' });
    await sweepPostLinks(t.services);
    const coupon = await t.db.one<{ code: string; status: string }>('SELECT code, status FROM coupon WHERE source_post_id = $1', [a.id]);
    expect(coupon.status).toBe('active');
    const linkB = await t.db.one<{ slug: string }>('SELECT slug FROM short_link WHERE post_id = $1', [b.id]);

    const ev1 = signed(t, { type: 'order_created', orderId: 'o1', productId: 'lsp_2', storeId: 'st_1', amountCents: 1700, currency: 'USD', emailHash: 'x', discountCode: coupon.code.toLowerCase() });
    const ev2 = signed(t, { type: 'order_created', orderId: 'o2', productId: 'lsp_2', storeId: 'st_1', amountCents: 2000, currency: 'USD', emailHash: 'y', customData: { short_link: linkB.slug } });
    await handleStoreWebhook(t.services, ev1.body, ev1.sig);
    await handleStoreWebhook(t.services, ev2.body, ev2.sig);
    const rows = await t.db.query<{ store_order_id: string; source_post_id: string; attribution: string }>('SELECT store_order_id, source_post_id, attribution FROM orders ORDER BY store_order_id');
    expect(rows).toEqual([
      { store_order_id: 'o1', source_post_id: a.id, attribution: 'coupon' },
      { store_order_id: 'o2', source_post_id: b.id, attribution: 'short_link' },
    ]);
    expect((await t.db.one<{ uses: number }>('SELECT uses FROM coupon WHERE code = $1', [coupon.code])).uses).toBe(1);

    const partial = signed(t, { type: 'order_refunded', orderId: 'o2', amountCents: 500 });
    await handleStoreWebhook(t.services, partial.body, partial.sig);
    expect((await t.db.one<{ status: string }>(`SELECT status FROM orders WHERE store_order_id = 'o2'`)).status).toBe('partially_refunded');
    const full = signed(t, { type: 'order_refunded', orderId: 'o2', amountCents: 2000 });
    await handleStoreWebhook(t.services, full.body, full.sig);
    expect((await t.db.one<{ status: string }>(`SELECT status FROM orders WHERE store_order_id = 'o2'`)).status).toBe('refunded');
    expect((await t.db.query<{ amount_cents: number }>('SELECT amount_cents FROM refund')).map((r) => r.amount_cents)).toEqual([2000]);

    const now = new Date();
    const rowsByPost = await pnl(t.db, { studioId: t.studioId, from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + 60_000), grain: 'post' });
    const ra = rowsByPost.find((r) => r.key === a.id)!;
    const rb = rowsByPost.find((r) => r.key === b.id)!;
    expect(ra.revenueCents).toBeGreaterThanOrEqual(1700);
    expect(rb.refundsCents).toBe(2000);
  });

  it('unknown stores are acknowledged and ignored, unsupported events too', async () => {
    const t = await studio();
    const ev = signed(t, { type: 'order_created', orderId: 'ox', productId: 'nope', storeId: 'st_unknown', amountCents: 100, currency: 'USD', emailHash: '' });
    expect(await handleStoreWebhook(t.services, ev.body, ev.sig)).toMatchObject({ status: 200, outcome: 'ignored' });
    expect((await t.db.query('SELECT 1 FROM orders')).length).toBe(0);
    const bad = '{not json';
    expect((await handleStoreWebhook(t.services, bad, t.providers.store.sign(bad))).status).toBe(400);
  });
});

describe('attribution end to end: post → short link → checkout → order → P&L', () => {
  it('carries the post, short link and coupon from the click into checkout custom data and back on the order', async () => {
    const t = await studio();
    const p = await persona(t);
    const pr = await product(t, p.id, { status: 'live', checkoutUrl: 'https://studio.lemonsqueezy.com/buy/abc-123', storeProductId: 'lsp_9' });
    await linkStore(t, p.id, p.slug);
    const po = await post(t, p.id, { productId: pr.id });
    expect(await sweepPostLinks(t.services)).toEqual({ links: 1, coupons: 1 });
    expect(await sweepPostLinks(t.services)).toEqual({ links: 0, coupons: 0 });
    const link = await t.db.one<{ slug: string; target_path: string }>('SELECT slug, target_path FROM short_link WHERE post_id = $1', [po.id]);
    expect(link.target_path).toBe(`/shop/${pr.slug}`);

    // Click: counted, lands on the product page with ?src.
    const hit = await resolveShortLink(t.services, { code: link.slug });
    expect(hit).toEqual({ slug: p.slug, path: `/shop/${pr.slug}?src=${link.slug}`, code: link.slug });
    expect(await resolveShortLink(t.services, { code: link.slug, hostSlug: 'someone-else' })).toBeNull();
    expect((await t.db.one<{ clicks: number }>('SELECT clicks FROM short_link WHERE slug = $1', [link.slug])).clicks).toBe(1);

    // Buy: the stored checkout URL gets the attribution as prefill params.
    const url = new URL((await checkoutUrlFor(t.services, { slug: p.slug, productSlug: pr.slug, src: link.slug }))!);
    expect(url.origin).toBe('https://studio.lemonsqueezy.com');
    expect(url.searchParams.get('checkout[custom][post_id]')).toBe(po.id);
    expect(url.searchParams.get('checkout[custom][short_link]')).toBe(link.slug);
    const coupon = url.searchParams.get('checkout[discount_code]');
    expect(coupon).toMatch(/^RESET[A-Z2-9]{4}$/);

    // The order comes back with that custom data.
    const custom = Object.fromEntries([...url.searchParams].filter(([k]) => k.startsWith('checkout[custom]')).map(([k, v]) => [k.slice(17, -1), v]));
    const ev = signed(t, { type: 'order_created', orderId: 'e2e', productId: 'lsp_9', storeId: 'st_1', amountCents: 1530, currency: 'USD', emailHash: 'z', customData: custom, discountCode: coupon });
    await handleStoreWebhook(t.services, ev.body, ev.sig);
    const o = await t.db.one<{ source_post_id: string; coupon_id: string | null; short_link_id: string | null; attribution: string }>(`SELECT * FROM orders WHERE store_order_id = 'e2e'`);
    expect(o.source_post_id).toBe(po.id);
    expect(o.coupon_id).not.toBeNull();
    expect(o.short_link_id).not.toBeNull();
    expect(o.attribution).toBe('custom_data');

    const now = new Date();
    const rows = await pnl(t.db, { studioId: t.studioId, from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + 60_000), grain: 'post' });
    expect(rows.find((r) => r.key === po.id)?.revenueCents).toBe(1530);
    const personaRow = (await pnl(t.db, { studioId: t.studioId, from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + 60_000), grain: 'persona' })).find((r) => r.key === p.id)!;
    expect(personaRow.revenueCents).toBe(1530);
  });

  it('API checkout for a linked variant without a stored URL; no checkout for lead magnets or unknown products', async () => {
    const t = await studio();
    const p = await persona(t);
    const pr = await product(t, p.id, { status: 'live' });
    await linkStore(t, p.id, p.slug);
    await t.db.query(`UPDATE product SET store_variant_id = 'var_1', store_id = 'st_1' WHERE id = $1`, [pr.id]);
    const url = await checkoutUrlFor(t.services, { slug: p.slug, productSlug: pr.slug });
    expect(url).toMatch(/^https:\/\/fake\.lemonsqueezy\.local\/checkout\//);
    expect(t.providers.store.callsTo('createCheckout')[0]!.args).toMatchObject({ storeId: 'st_1', variantId: 'var_1', customData: { product_id: pr.id, persona_id: p.id } });
    const lm = await product(t, p.id, { name: 'Free Checklist', rung: 'lead_magnet', status: 'live', price: 0, checkoutUrl: 'https://x.lemonsqueezy.com/buy/1' });
    expect(await checkoutUrlFor(t.services, { slug: p.slug, productSlug: lm.slug })).toBeNull();
    expect(await checkoutUrlFor(t.services, { slug: p.slug, productSlug: 'nope' })).toBeNull();
  });
});
