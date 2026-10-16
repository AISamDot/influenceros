import { describe, expect, it } from 'vitest';
import { linkStore as linkStoreAction, loadSite, productStoreBoard, productSweep, setCheckoutUrl, siteImage, sitePersona, syncStores, upsellFor } from '../src';
import { linkStore, persona, product, studio } from './helpers';

describe('stores and products: listing pack + checkout URL, API-less first', () => {
  it('links stores to personas by slug, and refuses one store for two personas', async () => {
    const t = await studio();
    const a = await persona(t, { name: 'Ava Home' });
    const b = await persona(t, { name: 'Bo Plans' });
    t.providers.store.stores.push(
      { id: 's1', name: 'Anything', slug: a.slug, domain: null, currency: 'USD' },
      { id: 's2', name: 'Bo Plans Shop', slug: 'bo-shop', domain: null, currency: 'USD' },
      { id: 's3', name: 'Orphan', slug: 'orphan', domain: null, currency: 'USD' },
    );
    expect(await syncStores(t.services, t.studioId)).toEqual({ stores: 3, linked: 2 });
    const rows = await t.db.query<{ persona_id: string; store_id: string }>('SELECT persona_id, store_id FROM store_account ORDER BY store_id');
    expect(rows).toEqual([
      { persona_id: a.id, store_id: 's1' },
      { persona_id: b.id, store_id: 's2' },
    ]);
    await expect(linkStoreAction(t.services, { personaId: b.id, storeId: 's1' })).rejects.toThrow(/one store per persona/);
    await linkStoreAction(t.services, { personaId: b.id, storeId: 's3' });
    expect((await t.db.one<{ store_id: string }>('SELECT store_id FROM store_account WHERE persona_id = $1', [b.id])).store_id).toBe('s3');
  });

  it('an approved product gets a Gate-checked listing pack, waits for the store listing (Owner told once), then goes live', async () => {
    const t = await studio();
    const p = await persona(t);
    await linkStore(t, p.id, p.slug);
    const pr = await product(t, p.id, { name: 'Pantry Planner', status: 'approved' });
    const first = await productSweep(t.services);
    expect(first).toEqual([{ productId: pr.id, from: 'none', to: 'awaiting_listing' }]);
    const listing = await t.db.one<{ gate_verdict: string; fields: { name: string; price_cents: number } }>(`SELECT gate_verdict, fields FROM product_listing WHERE product_id = $1 AND channel = 'lemonsqueezy'`, [pr.id]);
    expect(listing.gate_verdict).toBe('green');
    expect(listing.fields.price_cents).toBe(1700);
    await productSweep(t.services);
    expect((await t.db.query(`SELECT 1 FROM notification WHERE title = 'Create the store listing for Pantry Planner'`)).length).toBe(1);

    // The Owner creates it in Lemon Squeezy; the read-only API finds it by name and the product goes live.
    t.providers.store.products.push({ id: 'lsp_7', name: 'Pantry Planner', priceCents: 1700, currency: 'USD', status: 'published', url: 'https://x.lemonsqueezy.com/buy/7', storeId: 'st_1', variantId: 'v7', checkoutUrl: 'https://x.lemonsqueezy.com/buy/7' });
    expect(await productSweep(t.services)).toEqual([{ productId: pr.id, from: 'awaiting_listing', to: 'linked' }]);
    const row = await t.db.one<{ status: string; store_status: string; checkout_url: string; store_product_id: string; store_variant_id: string; live_at: Date | null }>('SELECT * FROM product WHERE id = $1', [pr.id]);
    expect(row).toMatchObject({ status: 'live', store_status: 'linked', checkout_url: 'https://x.lemonsqueezy.com/buy/7', store_product_id: 'lsp_7', store_variant_id: 'v7' });
    expect(row.live_at).not.toBeNull();
    expect(await productSweep(t.services)).toEqual([]);
  });

  it('free lead magnets go live without a store; the Owner can paste a checkout URL (validated)', async () => {
    const t = await studio();
    const p = await persona(t);
    const lm = await product(t, p.id, { name: 'Free Checklist', rung: 'lead_magnet', price: 0, status: 'approved' });
    const pr = await product(t, p.id, { name: 'Closet Workbook', status: 'approved' });
    await productSweep(t.services);
    expect((await t.db.one<{ status: string; store_status: string }>('SELECT status, store_status FROM product WHERE id = $1', [lm.id]))).toEqual({ status: 'live', store_status: 'free' });
    expect((await t.db.one<{ store_status: string }>('SELECT store_status FROM product WHERE id = $1', [pr.id])).store_status).toBe('awaiting_listing');

    await expect(setCheckoutUrl(t.services, { productId: pr.id, url: 'http://evil.example.com/buy' })).rejects.toThrow(/https Lemon Squeezy link/);
    await expect(setCheckoutUrl(t.services, { productId: pr.id, url: 'javascript:alert(1)' })).rejects.toThrow();
    await setCheckoutUrl(t.services, { productId: pr.id, url: 'https://ava.lemonsqueezy.com/buy/abc#x' });
    expect(await t.db.one('SELECT status, store_status, checkout_url FROM product WHERE id = $1', [pr.id])).toEqual({ status: 'live', store_status: 'linked', checkout_url: 'https://ava.lemonsqueezy.com/buy/abc' });
    const board = await productStoreBoard(t.db, t.studioId, p.id);
    expect(board.map((b) => [b.name, b.store_status])).toEqual([
      ['Free Checklist', 'free'],
      ['Closet Workbook', 'linked'],
    ]);
  });
});

describe('persona sites: public read model', () => {
  it('styles from the bible palette, shows only live products, picks the upsell, hides killed personas', async () => {
    const t = await studio();
    const p = await persona(t);
    await product(t, p.id, { name: 'Free Checklist', rung: 'lead_magnet', price: 0, status: 'approved' });
    await product(t, p.id, { name: 'Entry Workbook', rung: 'entry', status: 'live', checkoutUrl: 'https://a.lemonsqueezy.com/buy/1' });
    await product(t, p.id, { name: 'Core Bundle', rung: 'core_bundle', status: 'live', checkoutUrl: 'https://a.lemonsqueezy.com/buy/2' });
    await product(t, p.id, { name: 'Members Club', rung: 'membership', status: 'live', checkoutUrl: 'https://a.lemonsqueezy.com/buy/3' });
    await product(t, p.id, { name: 'Draft Thing', rung: 'addon', status: 'brief' });
    const site = (await loadSite(t.db, p.slug))!;
    expect(site.colors).toMatchObject({ bg: '#F7F1E8', ink: '#1F1B16', accent: '#C4572E', accent2: '#7F9C7A' });
    expect(site.leadMagnet?.name).toBe('Free Checklist');
    expect(site.products.map((x) => x.name)).toEqual(['Entry Workbook', 'Core Bundle']);
    expect(site.membership?.name).toBe('Members Club');
    expect(site.products[0]!.bullets).toEqual(['Start here', 'Zone map', 'Weekly tracker']);
    expect(upsellFor(site, 'entry-workbook')?.name).toBe('Core Bundle');
    expect(upsellFor(site, 'core-bundle')?.name).toBe('Members Club');
    expect(upsellFor(site, 'members-club')).toBeNull();
    // Nothing studio-internal leaks into the read model.
    expect(JSON.stringify(site)).not.toMatch(/studio_id|budget|cost|autonomy/);

    const k = await persona(t, { state: 'KILLED' });
    expect(await loadSite(t.db, k.slug)).toBeNull();
    expect(await sitePersona(t.db, '../etc')).toBeNull();
  });

  it('serves the portrait only from public or this persona’s own media', async () => {
    const t = await studio();
    const p = await persona(t);
    const other = await persona(t);
    await t.providers.storage.put({ key: `media/${p.id}/portrait.png`, data: new Uint8Array([137, 80, 78, 71]), contentType: 'image/png' });
    await t.providers.storage.put({ key: `media/${other.id}/secret.png`, data: new Uint8Array([1]), contentType: 'image/png' });
    await t.db.query(`UPDATE persona SET portrait_url = $2 WHERE id = $1`, [p.id, `/api/media/media/${p.id}/portrait.png`]);
    const img = await siteImage(t.services, { slug: p.slug, kind: 'portrait' });
    expect(img && 'file' in img ? img.file.contentType : null).toBe('image/png');
    await t.db.query(`UPDATE persona SET portrait_url = $2 WHERE id = $1`, [p.id, `/api/media/media/${other.id}/secret.png`]);
    expect(await siteImage(t.services, { slug: p.slug, kind: 'portrait' })).toBeNull();
    await t.db.query(`UPDATE persona SET portrait_url = 'https://cdn.example.com/p.jpg' WHERE id = $1`, [p.id]);
    expect(await siteImage(t.services, { slug: p.slug, kind: 'portrait' })).toEqual({ redirect: 'https://cdn.example.com/p.jpg' });
  });
});
