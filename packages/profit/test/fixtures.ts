import { type Db, json } from '@ios/db';
import type { Platform, PostFormat } from '@ios/core';

/** Ledger and commerce fixtures for Profit Engine tests (rows inserted directly, at chosen times). */

export const NOW = new Date('2026-10-14T12:00:00Z'); // a Wednesday
export const MONDAY = new Date('2026-10-12T00:00:00Z');
export const DAY = 86_400_000;
export const daysAgo = (n: number, from = NOW) => new Date(from.getTime() - n * DAY);

export async function addPost(
  db: Db,
  personaId: string,
  o: { format?: PostFormat; platform?: Platform; at: Date; views?: number; title?: string; purpose?: 'reach' | 'trust' | 'sell' },
): Promise<{ postId: string; slotId: string }> {
  const format = o.format ?? 'talking';
  const slot = await db.one<{ id: string }>(
    `INSERT INTO calendar_slot (persona_id, slot_at, format, purpose, title, status) VALUES ($1, $2, $3, $4, $5, 'live') RETURNING id`,
    [personaId, o.at, format, o.purpose ?? 'reach', o.title ?? `${format} post`],
  );
  const post = await db.one<{ id: string }>(
    `INSERT INTO post (persona_id, calendar_slot_id, platform, format, caption, status, scheduled_at, published_at)
     VALUES ($1, $2, $3, $4, $5, 'live', $6, $6) RETURNING id`,
    [personaId, slot.id, o.platform ?? 'tiktok', format, o.title ?? 'caption', o.at],
  );
  await db.query('UPDATE calendar_slot SET post_id = $2 WHERE id = $1', [slot.id, post.id]);
  if (o.views !== undefined) {
    await db.query(
      `INSERT INTO metric_snapshot (persona_id, post_id, platform, captured_on, views) VALUES ($1, $2, $3, $4, $5)`,
      [personaId, post.id, o.platform ?? 'tiktok', o.at.toISOString().slice(0, 10), o.views],
    );
  }
  return { postId: post.id, slotId: slot.id };
}

export async function addSlot(db: Db, personaId: string, o: { format: PostFormat; at: Date }): Promise<string> {
  const r = await db.one<{ id: string }>(
    `INSERT INTO calendar_slot (persona_id, slot_at, format, purpose, title) VALUES ($1, $2, $3, 'reach', 'planned') RETURNING id`,
    [personaId, o.at, o.format],
  );
  return r.id;
}

export async function addProduct(db: Db, personaId: string, o: { name?: string; priceCents?: number; status?: string } = {}): Promise<string> {
  const name = o.name ?? 'Planner';
  const r = await db.one<{ id: string }>(
    `INSERT INTO product (persona_id, name, slug, ladder_rung, status, price_cents) VALUES ($1, $2, $3, 'entry', $4, $5) RETURNING id`,
    [personaId, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${Math.random().toString(36).slice(2, 7)}`, o.status ?? 'live', o.priceCents ?? 1200],
  );
  return r.id;
}

export async function addOrder(
  db: Db,
  personaId: string,
  o: { amount: number; fee?: number; at: Date; postId?: string; productId?: string; couponId?: string; shortLinkId?: string; status?: string },
): Promise<string> {
  const r = await db.one<{ id: string }>(
    `INSERT INTO orders (persona_id, product_id, amount_cents, fee_cents, coupon_id, short_link_id, source_post_id, status, ordered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [personaId, o.productId ?? null, o.amount, o.fee ?? 0, o.couponId ?? null, o.shortLinkId ?? null, o.postId ?? null, o.status ?? 'paid', o.at],
  );
  return r.id;
}

export async function addDebit(
  db: Db,
  studioId: string,
  personaId: string | null,
  o: { unit?: 'llm_usd' | 'hf_credits' | 'media_usd'; amount: number; at: Date; refType?: string; refId?: string; agent?: string; entryType?: 'debit' | 'hold' | 'grant' },
): Promise<void> {
  await db.query(
    `INSERT INTO credit_ledger (studio_id, persona_id, unit, entry_type, amount, period, provider, operation, ref_type, ref_id, meta, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'test', 'test', $7, $8, $9::jsonb, $10)`,
    [studioId, personaId, o.unit ?? 'llm_usd', o.entryType ?? 'debit', o.amount, o.at.toISOString().slice(0, 7), o.refType ?? null, o.refId ?? null, json({ agent: o.agent ?? 'test' }), o.at],
  );
}

/**
 * A steady weekly history for `weeks` full weeks before `before` (a Monday): `posts` posts, `gross` sales and `cost`
 * spend each week (cents), all attributed to the persona. Growth multiplies gross week over week.
 */
export async function addWeeklyHistory(
  db: Db,
  studioId: string,
  personaId: string,
  o: { weeks: number; before?: Date; gross: number; cost: number; posts?: number; growth?: number; format?: PostFormat; views?: number },
): Promise<void> {
  const before = o.before ?? MONDAY;
  for (let w = o.weeks; w >= 1; w--) {
    const weekStart = new Date(before.getTime() - w * 7 * DAY);
    const g = Math.round(o.gross * (o.growth ?? 1) ** (o.weeks - w));
    for (let i = 0; i < (o.posts ?? 2); i++) {
      await addPost(db, personaId, { at: new Date(weekStart.getTime() + (1 + i) * DAY + 10 * 3_600_000), views: o.views ?? 1000, format: o.format });
    }
    if (g > 0) await addOrder(db, personaId, { amount: g, fee: Math.round(g * 0.05), at: new Date(weekStart.getTime() + 2 * DAY + 3_600_000) });
    if (o.cost > 0) await addDebit(db, studioId, personaId, { amount: o.cost / 100, at: new Date(weekStart.getTime() + 3 * DAY), refType: 'persona', refId: personaId });
  }
}
