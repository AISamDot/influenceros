import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { liveProviders, LemonSqueezyStore, parseLemonSqueezyWebhook, parseResendWebhook, ResendAudience, signSvix, UnsupportedStoreEvent, verifySvix } from '../src';

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };
function fakeFetch(routes: (c: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const c: Call = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(c);
    const r = routes(c);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

describe('Lemon Squeezy live adapter (no network: fetch is faked)', () => {
  it('reads stores and products with variants, creates checkouts and discounts, and keeps the key out of logs', async () => {
    const { f, calls } = fakeFetch((c) => {
      if (c.url.includes('/stores')) return { body: { data: [{ type: 'stores', id: '11', attributes: { name: 'Ava', slug: 'ava', domain: 'ava.lemonsqueezy.com', currency: 'USD' } }], links: {} } };
      if (c.url.includes('/products?')) {
        return {
          body: {
            data: [{ type: 'products', id: '7', attributes: { store_id: 11, name: 'Workbook', status: 'published', price: 1700, buy_now_url: 'https://ava.lemonsqueezy.com/buy/x' }, relationships: { variants: { data: [{ type: 'variants', id: '70' }] } } }],
            included: [{ type: 'variants', id: '70', attributes: { status: 'published' } }],
            links: {},
          },
        };
      }
      if (c.url.endsWith('/checkouts')) return { status: 201, body: { data: { id: 'c1', attributes: { url: 'https://ava.lemonsqueezy.com/checkout/custom/c1' } } } };
      if (c.url.endsWith('/discounts')) return { status: 201, body: { data: { id: 'd1', attributes: { code: 'RESETAB12' } } } };
      return { status: 404, body: { errors: [{ detail: 'not found' }] } };
    });
    const ls = new LemonSqueezyStore({ apiKey: 'ls-test-key-123', webhookSecret: 'whs', fetch: f });
    expect(await ls.listStores()).toEqual([{ id: '11', name: 'Ava', slug: 'ava', domain: 'ava.lemonsqueezy.com', currency: 'USD' }]);
    const [p] = await ls.listProducts({ storeId: '11' });
    expect(p).toMatchObject({ id: '7', storeId: '11', variantId: '70', status: 'published', priceCents: 1700, checkoutUrl: 'https://ava.lemonsqueezy.com/buy/x' });
    expect(calls[1]!.url).toContain('filter[store_id]=11');
    expect(calls[1]!.headers.Authorization).toBe('Bearer ls-test-key-123');
    expect(await ls.createCheckout({ storeId: '11', variantId: '70', customData: { post_id: 'abc' }, discountCode: 'RESETAB12' })).toEqual({ url: 'https://ava.lemonsqueezy.com/checkout/custom/c1' });
    expect(calls.at(-1)!.body).toMatchObject({ data: { attributes: { checkout_data: { custom: { post_id: 'abc' }, discount_code: 'RESETAB12' } }, relationships: { variant: { data: { id: '70' } } } } });
    expect(await ls.createDiscount({ storeId: '11', code: 'RESETAB12', percent: 10 })).toEqual({ id: 'd1', code: 'RESETAB12' });
    expect(await ls.getProduct('99')).toBeNull();
    expect(JSON.stringify({ ls })).not.toContain('ls-test-key-123');
  });

  it('verifies X-Signature (hex HMAC-SHA256) and maps webhook bodies to store events', () => {
    const ls = new LemonSqueezyStore({ apiKey: 'k', webhookSecret: 'signing-secret' });
    const order = JSON.stringify({
      meta: { event_name: 'order_created', custom_data: { post_id: '6f1c', short_link: 'abc2345', coupon: 'RESETAB12', bad_key$: 'x' } },
      data: { type: 'orders', id: '1001', attributes: { store_id: 11, user_email: 'Buyer@Example.com', total: 1870, tax: 170, total_usd: 1870, tax_usd: 170, first_order_item: { product_id: 7, variant_id: 70 } } },
    });
    const sig = createHmac('sha256', 'signing-secret').update(order).digest('hex');
    expect(ls.verifyWebhook(order, sig)).toBe(true);
    expect(ls.verifyWebhook(order, sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a'))).toBe(false);
    expect(ls.verifyWebhook(`${order} `, sig)).toBe(false);
    expect(ls.verifyWebhook(order, 'not-hex')).toBe(false);
    const ev = ls.parseWebhook(order);
    expect(ev).toMatchObject({ type: 'order_created', orderId: '1001', productId: '7', variantId: '70', storeId: '11', amountCents: 1700, discountCode: 'RESETAB12', customData: { post_id: '6f1c', short_link: 'abc2345', coupon: 'RESETAB12' } });
    expect(ev.type === 'order_created' && ev.emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.type === 'order_created' && ev.customData).not.toHaveProperty('bad_key$');

    expect(parseLemonSqueezyWebhook(JSON.stringify({ meta: { event_name: 'order_refunded' }, data: { id: '1001', attributes: { refunded_amount: 900 } } }))).toEqual({ type: 'order_refunded', orderId: '1001', amountCents: 900, storeId: undefined });
    expect(parseLemonSqueezyWebhook(JSON.stringify({ meta: { event_name: 'subscription_cancelled' }, data: { type: 'subscriptions', id: 's1', attributes: { status: 'cancelled', ends_at: '2026-12-01T00:00:00Z' } } }))).toMatchObject({ type: 'subscription_updated', subscriptionId: 's1', status: 'cancelled', endsAt: '2026-12-01T00:00:00Z' });
    expect(parseLemonSqueezyWebhook(JSON.stringify({ meta: { event_name: 'subscription_payment_failed' }, data: { type: 'subscription-invoices', id: 'inv', attributes: { subscription_id: 's1' } } }))).toEqual({ type: 'subscription_payment_failed', subscriptionId: 's1', storeId: undefined });
    expect(() => parseLemonSqueezyWebhook(JSON.stringify({ meta: { event_name: 'license_key_created' }, data: {} }))).toThrow(UnsupportedStoreEvent);
  });
});

describe('Resend audience live adapter', () => {
  it('creates or reuses audiences, upserts contacts (PATCH on conflict) and sends with List-Unsubscribe headers', async () => {
    const { f, calls } = fakeFetch((c) => {
      if (c.method === 'GET' && c.url.endsWith('/audiences')) return { body: { data: [{ id: 'aud_existing', name: 'Ava (ava)' }] } };
      if (c.method === 'POST' && c.url.endsWith('/audiences')) return { body: { id: 'aud_new' } };
      if (c.method === 'POST' && c.url.includes('/contacts')) return { status: 409, body: { name: 'conflict' } };
      if (c.method === 'PATCH') return { body: { id: 'ct_1' } };
      if (c.url.endsWith('/emails')) return { body: { id: 'em_1' } };
      if (c.url.endsWith('/broadcasts')) return { body: { id: 'bc_1' } };
      if (c.url.endsWith('/send')) return { body: { id: 'bc_1' } };
      return { status: 500, body: {} };
    });
    const r = new ResendAudience({ apiKey: 'resend-test-key', fetch: f });
    expect(await r.ensureAudience({ name: 'Ava (ava)' })).toEqual({ audienceId: 'aud_existing' });
    expect(await r.ensureAudience({ name: 'Bo (bo)' })).toEqual({ audienceId: 'aud_new' });
    expect(await r.upsertContact({ audienceId: 'aud_existing', email: 'a@example.com', unsubscribed: true })).toEqual({ contactId: 'ct_1' });
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { unsubscribed: true } });
    await r.send({ from: 'Ava <ava@mail.test>', to: 'a@example.com', subject: 'Hi', html: '<p>x</p>', headers: { 'List-Unsubscribe': '<https://x/u>' }, tags: { persona: 'ava', kind: 'welcome step' } });
    expect(calls.at(-1)!.body).toMatchObject({ to: ['a@example.com'], headers: { 'List-Unsubscribe': '<https://x/u>' }, tags: [{ name: 'persona', value: 'ava' }, { name: 'kind', value: 'welcome_step' }] });
    expect(await r.sendBroadcast({ audienceId: 'aud_existing', from: 'Ava <ava@mail.test>', subject: 's', html: 'h' })).toEqual({ id: 'bc_1' });
    expect(calls.at(-1)!.url).toMatch(/\/broadcasts\/bc_1\/send$/);
    expect(JSON.stringify(r)).not.toContain('resend-test-key');
  });

  it('verifies Svix signatures with a timestamp tolerance; no secret means no webhooks', () => {
    const secret = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;
    const body = JSON.stringify({ type: 'email.bounced', created_at: '2026-10-16T00:00:00Z', data: { email_id: 'em_1', to: ['a@example.com'] } });
    const now = new Date('2026-10-16T00:00:30Z');
    const ts = Math.floor(now.getTime() / 1000) - 10;
    const headers = { 'svix-id': 'msg_1', 'svix-timestamp': String(ts), 'svix-signature': `v1,bogus ${signSvix(secret, body, 'msg_1', ts)}` };
    expect(verifySvix(secret, body, headers, now)).toBe(true);
    expect(verifySvix(secret, `${body}x`, headers, now)).toBe(false);
    expect(verifySvix(secret, body, headers, new Date(now.getTime() + 10 * 60_000))).toBe(false);
    expect(verifySvix(secret, body, { ...headers, 'svix-id': 'msg_2' }, now)).toBe(false);
    expect(new ResendAudience({ apiKey: 'k', webhookSecret: secret, now: () => now }).verifyWebhook(body, headers)).toBe(true);
    expect(new ResendAudience({ apiKey: 'k' }).verifyWebhook(body, headers)).toBe(false);
    expect(parseResendWebhook(body)).toEqual([{ type: 'bounced', emailId: 'em_1', to: 'a@example.com', at: new Date('2026-10-16T00:00:00Z') }]);
    expect(parseResendWebhook(JSON.stringify({ type: 'contact.updated', data: { audience_id: 'aud', email: 'a@example.com', unsubscribed: true } }))).toMatchObject([{ type: 'contact_unsubscribed', audienceId: 'aud', email: 'a@example.com' }]);
    expect(parseResendWebhook(JSON.stringify({ type: 'email.sent', data: {} }))).toEqual([]);
  });
});

describe('liveProviders', () => {
  const env = (live: string[], secrets: Record<string, string>) => ({ isLive: (id: string) => live.includes(id), secret: (n: string) => secrets[n] ?? null });
  it('stays on fakes without keys and switches on with them', () => {
    expect(liveProviders(env([], {}))).toEqual({});
    const out = liveProviders(env(['lemonsqueezy', 'resend'], { 'lemonsqueezy.api_key': 'a', 'lemonsqueezy.webhook_secret': 'b', 'resend.api_key': 'c' }));
    expect(out.store?.name).toBe('lemonsqueezy');
    expect(out.audience?.name).toBe('resend-audience');
    expect(Object.keys(out).sort()).toEqual(['audience', 'store']);
  });

  it('API-less (signing secret, no API key) verifies webhooks with the real secret, never the fake one', async () => {
    const prev = process.env.TROUPE_FAKE_PROVIDERS;
    process.env.TROUPE_FAKE_PROVIDERS = '';
    try {
      const out = liveProviders(env([], { 'lemonsqueezy.webhook_secret': 'whsec_real' }));
      expect(out.store?.name).toBe('lemonsqueezy-webhooks');
      const body = JSON.stringify({ meta: { event_name: 'order_created' }, data: { id: '1', attributes: { total: 1700, tax: 0, first_order_item: { product_id: 5 } } } });
      const real = createHmac('sha256', 'whsec_real').update(body).digest('hex');
      const fake = createHmac('sha256', 'fake-webhook-secret').update(body).digest('hex');
      expect(out.store!.verifyWebhook(body, real)).toBe(true);
      expect(out.store!.verifyWebhook(body, fake)).toBe(false);
      expect(await out.store!.listStores()).toEqual([]);
      await expect(out.store!.createCheckout({ storeId: '1', variantId: '2' })).rejects.toThrow(/API key/);
    } finally {
      process.env.TROUPE_FAKE_PROVIDERS = prev;
    }
    // Forced fakes (tests) stay fake.
    expect(liveProviders(env([], { 'lemonsqueezy.webhook_secret': 'whsec_real' }))).toEqual({});
  });
});
