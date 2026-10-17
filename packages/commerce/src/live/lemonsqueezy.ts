import { createHmac, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';
import type { StoreEvent, StoreInfo, StoreProduct, StoreProvider } from '@troupe/providers';
import { asNumber, asRecord, asString, emailHash } from '../util';

/**
 * Live Lemon Squeezy adapter (JSON:API at https://api.lemonsqueezy.com/v1). The products API is read-only: products
 * are created by the Owner from a listing pack, then this adapter reads stores, products and variants, creates
 * checkouts (custom data for attribution) and per-post discount codes, and verifies webhooks (X-Signature = hex
 * HMAC-SHA256 of the raw body with the webhook signing secret). Keys stay inside this object.
 */
export const LEMONSQUEEZY_API = 'https://api.lemonsqueezy.com/v1';

/** A webhook the studio doesn't act on (e.g. license keys, affiliate events). The route acknowledges it. */
export class UnsupportedStoreEvent extends Error {
  override readonly name = 'UnsupportedStoreEvent';
}

type JsonApiResource = { type: string; id: string; attributes: Record<string, unknown>; relationships?: Record<string, { data?: unknown }> };

export class LemonSqueezyStore implements StoreProvider {
  readonly name = 'lemonsqueezy';
  readonly #apiKey: string;
  readonly #secret: string;
  readonly #fetch: typeof fetch;

  constructor(opts: { apiKey: string; webhookSecret: string; fetch?: typeof fetch }) {
    if (!opts.apiKey) throw new Error('LemonSqueezyStore needs an API key');
    if (!opts.webhookSecret) throw new Error('LemonSqueezyStore needs a webhook signing secret');
    this.#apiKey = opts.apiKey;
    this.#secret = opts.webhookSecret;
    this.#fetch = opts.fetch ?? fetch;
  }

  async #call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ data: unknown; included?: unknown[]; links?: Record<string, unknown> }> {
    const url = path.startsWith('http') ? path : `${LEMONSQUEEZY_API}${path}`;
    if (!url.startsWith(`${LEMONSQUEEZY_API}/`)) throw new Error('lemonsqueezy: refusing a URL outside the API');
    const res = await this.#fetch(url, {
      method,
      headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json', Authorization: `Bearer ${this.#apiKey}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: unknown; included?: unknown[]; links?: Record<string, unknown>; errors?: Array<{ detail?: string; title?: string }> };
    if (!res.ok) throw new Error(`lemonsqueezy: ${res.status} ${json.errors?.[0]?.detail ?? json.errors?.[0]?.title ?? ''}`.trim());
    return { data: json.data, included: json.included, links: json.links };
  }

  /** All pages of a list endpoint (at most 10 pages of 100). */
  async #list(path: string): Promise<{ data: JsonApiResource[]; included: JsonApiResource[] }> {
    const data: JsonApiResource[] = [];
    const included: JsonApiResource[] = [];
    let next: string | null = `${path}${path.includes('?') ? '&' : '?'}page[size]=100`;
    for (let i = 0; next && i < 10; i += 1) {
      const page = await this.#call('GET', next);
      data.push(...((page.data as JsonApiResource[]) ?? []));
      included.push(...((page.included as JsonApiResource[]) ?? []));
      const n = page.links?.next;
      next = typeof n === 'string' && n ? n : null;
    }
    return { data, included };
  }

  async listStores(): Promise<StoreInfo[]> {
    const { data } = await this.#list('/stores');
    return data.map((s) => ({
      id: String(s.id),
      name: asString(s.attributes.name),
      slug: asString(s.attributes.slug),
      domain: asString(s.attributes.domain) || null,
      currency: asString(s.attributes.currency, 'USD'),
    }));
  }

  async listProducts(req: { storeId?: string } = {}): Promise<StoreProduct[]> {
    const filter = req.storeId ? `&filter[store_id]=${encodeURIComponent(req.storeId)}` : '';
    const { data, included } = await this.#list(`/products?include=variants${filter}`);
    return data.map((p) => toProduct(p, included));
  }

  async getProduct(id: string): Promise<StoreProduct | null> {
    if (!/^\d+$/.test(id)) return null;
    try {
      const page = await this.#call('GET', `/products/${id}?include=variants`);
      const data = asRecord(page.data);
      if (!data.id || !data.attributes) return null;
      return toProduct(data as unknown as JsonApiResource, (page.included as JsonApiResource[]) ?? []);
    } catch (err) {
      if (/: 404\b/.test((err as Error).message)) return null;
      throw err;
    }
  }

  async createCheckout(req: { storeId: string; variantId: string; customData?: Readonly<Record<string, string>>; discountCode?: string }): Promise<{ url: string }> {
    const page = await this.#call('POST', '/checkouts', {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: { custom: req.customData ?? {}, ...(req.discountCode ? { discount_code: req.discountCode } : {}) },
          product_options: { enabled_variants: [Number(req.variantId)] },
        },
        relationships: {
          store: { data: { type: 'stores', id: String(req.storeId) } },
          variant: { data: { type: 'variants', id: String(req.variantId) } },
        },
      },
    });
    const url = asString(asRecord(asRecord(page.data).attributes).url);
    if (!url) throw new Error('lemonsqueezy: checkout without a URL');
    return { url };
  }

  async createDiscount(req: { storeId: string; code: string; percent: number; productIds?: readonly string[]; expiresAt?: Date | null }): Promise<{ id: string; code: string }> {
    const page = await this.#call('POST', '/discounts', {
      data: {
        type: 'discounts',
        attributes: {
          name: `Post code ${req.code}`,
          code: req.code,
          amount: Math.max(1, Math.min(100, Math.round(req.percent))),
          amount_type: 'percent',
          ...(req.expiresAt ? { expires_at: req.expiresAt.toISOString() } : {}),
        },
        relationships: { store: { data: { type: 'stores', id: String(req.storeId) } } },
      },
    });
    const d = asRecord(page.data);
    return { id: asString(d.id), code: asString(asRecord(d.attributes).code, req.code) };
  }

  sign(rawBody: string): string {
    return createHmac('sha256', this.#secret).update(rawBody).digest('hex');
  }

  verifyWebhook(rawBody: string, signature: string): boolean {
    if (!/^[0-9a-f]{64}$/i.test(signature ?? '')) return false;
    const expected = Buffer.from(this.sign(rawBody), 'hex');
    const got = Buffer.from(signature, 'hex');
    return expected.length === got.length && timingSafeEqual(expected, got);
  }

  parseWebhook(rawBody: string): StoreEvent {
    return parseLemonSqueezyWebhook(rawBody);
  }

  toJSON(): string {
    return '[LemonSqueezyStore]';
  }
  [inspect.custom](): string {
    return '[LemonSqueezyStore]';
  }
}

/**
 * API-less mode (the Owner pastes checkout links, no API key) with the webhook signing secret set: webhooks are verified
 * with the real secret, so orders and subscriptions still reach the P&L and the members area. Everything that needs
 * the API is unavailable (lists are empty; checkouts and discount codes throw and callers keep their fallbacks).
 */
export class LemonSqueezyWebhooks implements StoreProvider {
  readonly name = 'lemonsqueezy-webhooks';
  readonly #secret: string;
  constructor(opts: { webhookSecret: string }) {
    if (!opts.webhookSecret) throw new Error('LemonSqueezyWebhooks needs a webhook signing secret');
    this.#secret = opts.webhookSecret;
  }
  async listStores(): Promise<StoreInfo[]> {
    return [];
  }
  async listProducts(): Promise<StoreProduct[]> {
    return [];
  }
  async getProduct(): Promise<StoreProduct | null> {
    return null;
  }
  async createCheckout(): Promise<{ url: string }> {
    throw new Error('lemonsqueezy: checkouts need the API key (paste the product checkout link instead)');
  }
  async createDiscount(): Promise<{ id: string; code: string }> {
    throw new Error('lemonsqueezy: discount codes need the API key');
  }
  verifyWebhook(rawBody: string, signature: string): boolean {
    if (!/^[0-9a-f]{64}$/i.test(signature ?? '')) return false;
    const expected = createHmac('sha256', this.#secret).update(rawBody).digest();
    const got = Buffer.from(signature, 'hex');
    return expected.length === got.length && timingSafeEqual(expected, got);
  }
  parseWebhook(rawBody: string): StoreEvent {
    return parseLemonSqueezyWebhook(rawBody);
  }
  toJSON(): string {
    return '[LemonSqueezyWebhooks]';
  }
  [inspect.custom](): string {
    return '[LemonSqueezyWebhooks]';
  }
}

function toProduct(p: JsonApiResource, included: readonly JsonApiResource[]): StoreProduct {
  const a = p.attributes;
  const rel = asRecord(p.relationships?.variants);
  const variantRefs = Array.isArray(rel.data) ? (rel.data as Array<{ id: string }>) : [];
  const variants = included.filter((v) => v.type === 'variants' && variantRefs.some((r) => String(r.id) === String(v.id)));
  const variant = variants.find((v) => asString(v.attributes.status) !== 'draft') ?? variants[0];
  return {
    id: String(p.id),
    name: asString(a.name),
    priceCents: asNumber(a.price),
    currency: 'USD',
    status: asString(a.status) === 'published' ? 'published' : 'draft',
    url: asString(a.buy_now_url),
    storeId: a.store_id !== undefined ? String(a.store_id) : undefined,
    variantId: variant ? String(variant.id) : variantRefs[0] ? String(variantRefs[0].id) : undefined,
    checkoutUrl: asString(a.buy_now_url) || undefined,
  };
}

const SUB_STATUS = ['on_trial', 'active', 'paused', 'past_due', 'unpaid', 'cancelled', 'expired'] as const;
type SubStatus = (typeof SUB_STATUS)[number];
const subStatus = (v: unknown): SubStatus => (SUB_STATUS.includes(v as SubStatus) ? (v as SubStatus) : 'active');

function customData(meta: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(asRecord(meta.custom_data))) {
    if (/^[a-z_]{1,40}$/.test(k) && (typeof v === 'string' || typeof v === 'number')) out[k] = String(v).slice(0, 200);
  }
  return out;
}

/**
 * Maps a Lemon Squeezy webhook body to a StoreEvent. Amounts are in cents; the order's net-of-tax total is the sale
 * (Lemon Squeezy is the merchant of record and remits the tax). Lemon Squeezy doesn't send its fee: the handler
 * estimates it (5% + 50¢). The discount code travels in custom data (`coupon`), because order webhooks don't carry it.
 */
export function parseLemonSqueezyWebhook(rawBody: string): StoreEvent {
  const body = asRecord(JSON.parse(rawBody));
  const meta = asRecord(body.meta);
  const event = asString(meta.event_name);
  const data = asRecord(body.data);
  const a = asRecord(data.attributes);
  const id = asString(data.id);
  const custom = customData(meta);
  const email = asString(a.user_email) || undefined;
  const storeId = a.store_id !== undefined ? String(a.store_id) : undefined;

  switch (event) {
    case 'order_created': {
      const item = asRecord(a.first_order_item);
      const totalUsd = a.total_usd !== undefined ? asNumber(a.total_usd) : asNumber(a.total);
      const taxUsd = a.tax_usd !== undefined ? asNumber(a.tax_usd) : asNumber(a.tax);
      return {
        type: 'order_created',
        orderId: id,
        productId: asString(item.product_id),
        variantId: item.variant_id !== undefined ? String(item.variant_id) : undefined,
        amountCents: Math.max(0, Math.round(totalUsd - taxUsd)),
        currency: 'USD',
        emailHash: email ? emailHash(email) : '',
        email,
        storeId,
        discountCode: custom.coupon ?? null,
        customData: custom,
      };
    }
    case 'order_refunded':
      return { type: 'order_refunded', orderId: id, amountCents: Math.round(asNumber(a.refunded_amount_usd, asNumber(a.refunded_amount))), storeId };
    case 'subscription_created':
      return {
        type: 'subscription_created',
        subscriptionId: id,
        productId: asString(a.product_id),
        variantId: a.variant_id !== undefined ? String(a.variant_id) : undefined,
        storeId,
        email,
        emailHash: email ? emailHash(email) : undefined,
        status: subStatus(a.status) === 'on_trial' ? 'on_trial' : 'active',
        customData: custom,
      };
    case 'subscription_updated':
    case 'subscription_cancelled':
    case 'subscription_expired':
    case 'subscription_resumed':
    case 'subscription_paused':
    case 'subscription_unpaused':
    case 'subscription_payment_success':
    case 'subscription_payment_recovered': {
      // Payment events carry a subscription invoice; its subscription id is in the attributes.
      const invoice = data.type === 'subscription-invoices';
      const subscriptionId = invoice ? asString(a.subscription_id) : id;
      // An invoice says a payment went through; it carries no subscription status or end date.
      if (invoice) return { type: 'subscription_updated', subscriptionId, status: 'active', endsAt: null, storeId, source: 'invoice', updatedAt: asString(a.updated_at) || null };
      return { type: 'subscription_updated', subscriptionId, status: subStatus(a.status), endsAt: asString(a.ends_at) || null, storeId, source: 'subscription', updatedAt: asString(a.updated_at) || null };
    }
    case 'subscription_payment_failed':
      return { type: 'subscription_payment_failed', subscriptionId: data.type === 'subscription-invoices' ? asString(a.subscription_id) : id, storeId };
    default:
      throw new UnsupportedStoreEvent(`unsupported Lemon Squeezy event: ${event || 'unknown'}`);
  }
}
