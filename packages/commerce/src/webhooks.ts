import type { StudioServices } from '@ios/agents';
import type { Db } from '@ios/db';
import { json } from '@ios/db';
import type { StoreEvent } from '@ios/providers';
import { unsubscribeSubscriber } from './audience';
import { attributeOrder } from './attribution';
import { UnsupportedStoreEvent } from './live/lemonsqueezy';
import { applySubscriptionEvent, type CommunityGate, UnknownSubscription } from './membership';
import { emailHash, sha256, UUID_RE } from './util';

/**
 * Signed webhooks. Lemon Squeezy: orders (attributed to the post), refunds, subscriptions (membership). Resend:
 * delivery, opens, clicks, bounces, complaints and unsubscribes. A bad signature is refused (401). A replayed
 * event is acknowledged and skipped (one row per event in commerce_webhook_event). Processing runs in one
 * transaction with the event row, so a failure rolls back and the vendor's retry processes it again.
 */

export interface WebhookResult {
  readonly status: 200 | 400 | 401 | 404 | 503;
  /** 'retry_later' (503): an update arrived before its subscription; nothing was stored, so the vendor's retry applies it. */
  readonly outcome: 'processed' | 'duplicate' | 'ignored' | 'invalid_signature' | 'bad_payload' | 'retry_later' | 'not_configured';
  readonly detail?: string;
}

/** Lemon Squeezy's fee (5% + 50¢) when the webhook doesn't carry it. */
export const estimateFeeCents = (amountCents: number): number => (amountCents > 0 ? Math.round(amountCents * 0.05) + 50 : 0);

async function claimEvent(db: Db, provider: 'lemonsqueezy' | 'resend', key: string, type: string, status: 'processed' | 'ignored', error?: string): Promise<boolean> {
  const row = await db.maybeOne(
    `INSERT INTO commerce_webhook_event (provider, event_key, event_type, status, error) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (provider, event_key) DO NOTHING RETURNING id`,
    [provider, key, type.slice(0, 60), status, error?.slice(0, 300) ?? null],
  );
  return Boolean(row);
}

interface Resolved {
  personaId: string | null;
  productId: string | null;
}

/** Which persona and product an event belongs to: the store, then the store product, then checkout custom data. */
async function resolveStoreEvent(db: Db, ev: { storeId?: string; productId?: string; customData?: Readonly<Record<string, string>> }): Promise<Resolved> {
  const byStore = ev.storeId ? await db.maybeOne<{ persona_id: string }>(`SELECT persona_id FROM store_account WHERE store_id = $1`, [ev.storeId]) : null;
  let personaId = byStore?.persona_id ?? null;
  let productId: string | null = null;
  if (ev.productId) {
    const p = await db.maybeOne<{ id: string; persona_id: string }>(
      `SELECT id, persona_id FROM product WHERE store_product_id = $1 AND ($2::uuid IS NULL OR persona_id = $2) ORDER BY created_at LIMIT 1`,
      [ev.productId, personaId],
    );
    if (p) {
      productId = p.id;
      personaId ??= p.persona_id;
    }
  }
  const custom = ev.customData ?? {};
  if (!productId && custom.product_id && UUID_RE.test(custom.product_id)) {
    const p = await db.maybeOne<{ id: string; persona_id: string }>(`SELECT id, persona_id FROM product WHERE id = $1 AND ($2::uuid IS NULL OR persona_id = $2)`, [custom.product_id, personaId]);
    if (p) {
      productId = p.id;
      personaId ??= p.persona_id;
    }
  }
  if (!personaId && custom.persona_id && UUID_RE.test(custom.persona_id)) {
    const p = await db.maybeOne<{ id: string }>(`SELECT id FROM persona WHERE id = $1`, [custom.persona_id]);
    personaId = p?.id ?? null;
  }
  return { personaId, productId };
}

async function processOrder(services: StudioServices, ev: Extract<StoreEvent, { type: 'order_created' }>): Promise<'processed' | 'ignored'> {
  const { db } = services;
  const { personaId, productId } = await resolveStoreEvent(db, ev);
  if (!personaId) return 'ignored';
  const attr = await attributeOrder(db, { personaId, customData: ev.customData, discountCode: ev.discountCode });
  const hash = ev.email ? emailHash(ev.email) : ev.emailHash || null;
  const inserted = await db.maybeOne<{ id: string }>(
    `INSERT INTO orders (persona_id, product_id, store_order_id, customer_email_hash, amount_cents, fee_cents, currency, coupon_id, short_link_id, source_post_id,
                         status, ordered_at, store_id, store_product_id, variant_id, discount_code, attribution)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'paid', $11, $12, $13, $14, $15, $16)
     ON CONFLICT (store_order_id) DO NOTHING RETURNING id`,
    [
      personaId,
      productId,
      ev.orderId,
      hash,
      ev.amountCents,
      ev.feeCents ?? estimateFeeCents(ev.amountCents),
      ev.currency || 'USD',
      attr.couponId,
      attr.shortLinkId,
      attr.sourcePostId,
      services.now(),
      ev.storeId ?? null,
      ev.productId || null,
      ev.variantId ?? null,
      ev.discountCode ?? null,
      attr.method,
    ],
  );
  if (!inserted) return 'processed';
  if (attr.couponId) await db.query(`UPDATE coupon SET uses = uses + 1 WHERE id = $1`, [attr.couponId]);
  // Email tagging (FR-10.3): a buyer who is on the list is tagged with the product (no new consent is implied).
  if (hash) {
    const slug = productId ? (await db.one<{ slug: string }>('SELECT slug FROM product WHERE id = $1', [productId])).slug : 'unknown';
    await db.query(
      `UPDATE subscriber SET tags = (SELECT jsonb_agg(DISTINCT t) FROM jsonb_array_elements_text(tags || $3::jsonb) t), updated_at = now()
        WHERE persona_id = $1 AND email_hash = $2`,
      [personaId, hash, json([`buyer:${slug}`])],
    );
  }
  return 'processed';
}

async function processRefund(services: StudioServices, ev: Extract<StoreEvent, { type: 'order_refunded' }>): Promise<'processed' | 'ignored'> {
  const { db } = services;
  const o = await db.maybeOne<{ id: string; persona_id: string; amount_cents: number }>('SELECT id, persona_id, amount_cents FROM orders WHERE store_order_id = $1', [ev.orderId]);
  if (!o) return 'ignored';
  const amount = Math.max(0, Math.min(Number(o.amount_cents), Math.round(ev.amountCents)));
  await db.query(
    `INSERT INTO refund (order_id, persona_id, amount_cents, reason, status, store_ref) VALUES ($1, $2, $3, 'store refund', 'refunded', $4)
     ON CONFLICT (store_ref) WHERE store_ref IS NOT NULL DO UPDATE SET amount_cents = GREATEST(refund.amount_cents, EXCLUDED.amount_cents), status = 'refunded'`,
    [o.id, o.persona_id, amount, `ls:${ev.orderId}`],
  );
  const total = (await db.one<{ t: number }>(`SELECT COALESCE(SUM(amount_cents), 0)::int AS t FROM refund WHERE order_id = $1 AND status IN ('approved','refunded')`, [o.id])).t;
  await db.query(`UPDATE orders SET status = $2 WHERE id = $1`, [o.id, total >= Number(o.amount_cents) ? 'refunded' : 'partially_refunded']);
  return 'processed';
}

/** Lemon Squeezy webhook (`X-Signature` header). */
export async function handleStoreWebhook(services: StudioServices, rawBody: string, signature: string | null, opts: { gate?: CommunityGate | null } = {}): Promise<WebhookResult> {
  if (!signature || !services.providers.store.verifyWebhook(rawBody, signature)) return { status: 401, outcome: 'invalid_signature' };
  const key = sha256(rawBody);
  let ev: StoreEvent;
  try {
    ev = services.providers.store.parseWebhook(rawBody);
  } catch (err) {
    if (err instanceof UnsupportedStoreEvent) {
      await claimEvent(services.db, 'lemonsqueezy', key, 'unsupported', 'ignored', err.message);
      return { status: 200, outcome: 'ignored', detail: err.message };
    }
    return { status: 400, outcome: 'bad_payload' };
  }
  return services.db.transaction(async (tx): Promise<WebhookResult> => {
    const s: StudioServices = { ...services, db: tx };
    if (!(await claimEvent(tx, 'lemonsqueezy', key, ev.type, 'processed'))) return { status: 200 as const, outcome: 'duplicate' as const };
    let outcome: 'processed' | 'ignored';
    if (ev.type === 'order_created') outcome = await processOrder(s, ev);
    else if (ev.type === 'order_refunded') outcome = await processRefund(s, ev);
    else {
      const resolved =
        ev.type === 'subscription_created'
          ? await resolveStoreEvent(tx, ev)
          : { personaId: null, productId: null };
      const attr = ev.type === 'subscription_created' && resolved.personaId ? await attributeOrder(tx, { personaId: resolved.personaId, customData: ev.customData }) : null;
      const id = await applySubscriptionEvent(s, ev, { ...resolved, sourcePostId: attr?.sourcePostId ?? null, gate: opts.gate ?? null });
      outcome = id ? 'processed' : 'ignored';
    }
    if (outcome === 'ignored') await tx.query(`UPDATE commerce_webhook_event SET status = 'ignored', error = 'unknown store, product or subscription' WHERE provider = 'lemonsqueezy' AND event_key = $1`, [key]);
    return { status: 200 as const, outcome };
  }).catch((err: unknown): WebhookResult => {
    // Rolled back (the event row too), so the vendor's retry is processed in full.
    if (err instanceof UnknownSubscription) return { status: 503, outcome: 'retry_later', detail: err.message };
    throw err;
  });
}

/** Resend webhook (Svix headers). */
export async function handleEmailWebhook(services: StudioServices, rawBody: string, headers: Readonly<Record<string, string | null | undefined>>): Promise<WebhookResult> {
  const { db } = services;
  if (!services.providers.audience.verifyWebhook(rawBody, headers)) return { status: 401, outcome: 'invalid_signature' };
  let events;
  try {
    events = services.providers.audience.parseWebhook(rawBody);
  } catch {
    return { status: 400, outcome: 'bad_payload' };
  }
  const key = headers['svix-id'] || sha256(rawBody);
  return db.transaction(async (tx) => {
    const s: StudioServices = { ...services, db: tx };
    if (!(await claimEvent(tx, 'resend', key, events[0]?.type ?? 'none', 'processed'))) return { status: 200 as const, outcome: 'duplicate' as const };
    let handled = 0;
    for (const e of events) {
      if (e.type === 'contact_unsubscribed') {
        const sub = await tx.maybeOne<{ id: string }>(
          `SELECT s.id FROM subscriber s JOIN email_list l ON l.persona_id = s.persona_id WHERE l.audience_id = $1 AND s.email = $2`,
          [e.audienceId, e.email.trim().toLowerCase()],
        );
        if (sub) {
          await unsubscribeSubscriber(s, sub.id, 'webhook');
          handled += 1;
        }
        continue;
      }
      const msg = await tx.maybeOne<{ id: string; persona_id: string; subscriber_id: string | null; sequence_id: string | null }>(
        `SELECT id, persona_id, subscriber_id, sequence_id FROM email_message WHERE provider_id = $1`,
        [e.emailId],
      );
      if (!msg) continue;
      if (msg.subscriber_id && e.type === 'complained') {
        await unsubscribeSubscriber(s, msg.subscriber_id, 'complaint', 'complaint');
        handled += 1;
        continue;
      }
      await tx.query(`INSERT INTO email_event (persona_id, subscriber_id, sequence_id, type, message_id, meta) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [
        msg.persona_id,
        msg.subscriber_id,
        msg.sequence_id,
        e.type,
        msg.id,
        json(e.type === 'clicked' && e.link ? { link: e.link.slice(0, 300) } : {}),
      ]);
      if (msg.subscriber_id && e.type === 'bounced') {
        await tx.query(`UPDATE subscriber SET status = 'bounced', updated_at = now() WHERE id = $1 AND status IN ('active','pending')`, [msg.subscriber_id]);
        await tx.query(`UPDATE email_enrollment SET status = 'stopped', updated_at = now() WHERE subscriber_id = $1 AND status = 'active'`, [msg.subscriber_id]);
        await tx.query(`INSERT INTO consent_record (persona_id, subscriber_id, kind, source) VALUES ($1, $2, 'bounced', 'webhook')`, [msg.persona_id, msg.subscriber_id]);
      }
      handled += 1;
    }
    return { status: 200 as const, outcome: handled ? ('processed' as const) : ('ignored' as const) };
  });
}
