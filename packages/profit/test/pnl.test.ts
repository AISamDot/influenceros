import { OWNER } from '@ios/core';
import { createTestStudio, makeTestPersona, type TestStudio } from '@ios/agents/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { aggregate, loadFacts, pnl, pnlWithTotals, totals, updateProfitSettings, weeklySeries } from '../src';
import { addDebit, addOrder, addPost, addProduct, addSlot, daysAgo, MONDAY, NOW } from './fixtures';

let t: TestStudio | null = null;
afterEach(async () => {
  await t?.db.close();
  t = null;
});

/**
 * Persona A: two posts (talking/tiktok 1,000 views; carousel/instagram 3,000 views), four orders (direct, coupon,
 * unattributed, short link + refund), slot/post/product/persona costs. Persona B: one unattributed order, overhead.
 * Studio overhead $2. Plus rows outside the window, a hold and a grant that must not count.
 */
async function seed(s: TestStudio) {
  const a = await makeTestPersona(s, { name: 'Ada' });
  const b = await makeTestPersona(s, { name: 'Bo' });
  const p1 = await addPost(s.db, a.id, { format: 'talking', platform: 'tiktok', at: daysAgo(5), views: 1000, title: 'Hook one' });
  const p2 = await addPost(s.db, a.id, { format: 'carousel', platform: 'instagram', at: daysAgo(3), views: 3000, title: 'Carousel two' });
  const unposted = await addSlot(s.db, a.id, { format: 'voiceover', at: daysAgo(-1) });
  const product = await addProduct(s.db, a.id, { name: 'Budget Planner' });
  const coupon = await s.db.one<{ id: string }>(`INSERT INTO coupon (persona_id, code, discount_pct, source_post_id) VALUES ($1, 'ADA10', 10, $2) RETURNING id`, [a.id, p2.postId]);
  const link = await s.db.one<{ id: string }>(`INSERT INTO short_link (persona_id, slug, target_url, post_id) VALUES ($1, 'ada-1', 'https://x.test', $2) RETURNING id`, [a.id, p1.postId]);

  await addOrder(s.db, a.id, { amount: 2000, fee: 150, at: daysAgo(4), postId: p1.postId, productId: product });
  await addOrder(s.db, a.id, { amount: 1000, fee: 100, at: daysAgo(2), couponId: coupon.id });
  await addOrder(s.db, a.id, { amount: 800, fee: 90, at: daysAgo(2), productId: product });
  const refunded = await addOrder(s.db, a.id, { amount: 1200, fee: 110, at: daysAgo(1), shortLinkId: link.id });
  await s.db.query(`INSERT INTO refund (order_id, persona_id, amount_cents, status) VALUES ($1, $2, 1200, 'refunded')`, [refunded, a.id]);
  await addOrder(s.db, b.id, { amount: 500, fee: 75, at: daysAgo(2) });
  await addOrder(s.db, a.id, { amount: 9999, fee: 0, at: daysAgo(60) }); // outside the window

  await addDebit(s.db, s.studioId, a.id, { amount: 0.5, at: daysAgo(6), refType: 'calendar_slot', refId: p1.slotId });
  await addDebit(s.db, s.studioId, a.id, { unit: 'hf_credits', amount: 10, at: daysAgo(6), refType: 'calendar_slot', refId: p1.slotId });
  await addDebit(s.db, s.studioId, a.id, { unit: 'media_usd', amount: 0.2, at: daysAgo(3), refType: 'post', refId: p2.postId });
  await addDebit(s.db, s.studioId, a.id, { amount: 0.3, at: daysAgo(1), refType: 'calendar_slot', refId: unposted });
  await addDebit(s.db, s.studioId, a.id, { amount: 1, at: daysAgo(2), refType: 'chat_thread', refId: a.id });
  await addDebit(s.db, s.studioId, a.id, { amount: 0.4, at: daysAgo(2), refType: 'product', refId: product });
  await addDebit(s.db, s.studioId, b.id, { amount: 0.1, at: daysAgo(2), refType: 'persona', refId: b.id });
  await addDebit(s.db, s.studioId, null, { amount: 2, at: daysAgo(2), refType: 'studio', refId: s.studioId });
  await addDebit(s.db, s.studioId, a.id, { amount: 50, at: daysAgo(60) }); // outside
  await addDebit(s.db, s.studioId, a.id, { amount: 5, at: daysAgo(1), entryType: 'hold' }); // not spend
  await addDebit(s.db, s.studioId, a.id, { amount: 5, at: daysAgo(1), entryType: 'grant' }); // not spend
  return { a, b, p1, p2, product };
}

const window = { from: new Date('2026-10-01T00:00:00Z'), to: NOW };

describe('P&L read models', () => {
  it('builds persona P&L from orders, refunds and ledger debits (credits at the credit price)', async () => {
    t = await createTestStudio();
    const { a, b } = await seed(t);
    const { rows, totals: tot } = await pnlWithTotals(t.db, { studioId: t.studioId, ...window, grain: 'persona' });
    const ada = rows.find((r) => r.key === a.id)!;
    expect(ada).toMatchObject({ label: 'Ada', revenueCents: 5000, feesCents: 450, refundsCents: 1200, costCents: 284, profitCents: 3066, posts: 2, views: 4000 });
    expect(ada.costBreakdown).toEqual({ llmCents: 220, mediaCents: 20, creditsCents: 44, hfCredits: 10 });
    expect(ada.revenuePerPostCents).toBe(1675); // net per post
    expect(ada.costPerPostCents).toBe(142);
    expect(ada.rpmCents).toBe(1250);
    expect(rows.find((r) => r.key === b.id)).toMatchObject({ revenueCents: 500, feesCents: 75, costCents: 10, profitCents: 415, posts: 0 });
    expect(rows.find((r) => r.key === 'studio')).toMatchObject({ costCents: 200, profitCents: -200, personaId: null });
    expect(tot.profitCents).toBe(3281);
  });

  it('attributes revenue to posts (source post, coupon, short link) and spreads unattributed sales by views', async () => {
    t = await createTestStudio();
    const { p1, p2 } = await seed(t);
    const rows = await pnl(t.db, { studioId: t.studioId, ...window, grain: 'post' });
    const r1 = rows.find((r) => r.key === p1.postId)!;
    const r2 = rows.find((r) => r.key === p2.postId)!;
    // p1: direct $20 + short-link $12 (refunded) + 25% of the $8 unattributed order.
    expect(r1).toMatchObject({ label: 'Hook one', format: 'talking', platform: 'tiktok', revenueCents: 3400, allocatedRevenueCents: 200, refundsCents: 1200, costCents: 94, posts: 1, views: 1000 });
    expect(r2).toMatchObject({ format: 'carousel', revenueCents: 1600, allocatedRevenueCents: 600, costCents: 20 });
    expect(rows.find((r) => r.key === 'unattributed')).toMatchObject({ revenueCents: 500, profitCents: 425 }); // Bo has no posts
    expect(rows.find((r) => r.key === 'overhead')).toMatchObject({ costCents: 380 });
  });

  it('sums to the same totals at every grain, and splits by format, platform and product', async () => {
    t = await createTestStudio();
    const { product } = await seed(t);
    const facts = await loadFacts(t.db, { studioId: t.studioId, ...window });
    const persona = totals(aggregate(facts, 'persona'));
    for (const grain of ['post', 'format', 'platform', 'product'] as const) {
      const tot = totals(aggregate(facts, grain));
      expect(Math.abs(tot.profitCents - persona.profitCents), grain).toBeLessThanOrEqual(2);
      expect(Math.abs(tot.revenueCents - persona.revenueCents), grain).toBeLessThanOrEqual(2);
      expect(Math.abs(tot.costCents - persona.costCents), grain).toBeLessThanOrEqual(2);
    }
    const formats = aggregate(facts, 'format');
    expect(formats.find((r) => r.key === 'voiceover')).toMatchObject({ costCents: 30, posts: 0 }); // unposted slot work
    expect(formats.find((r) => r.key === 'talking')).toMatchObject({ posts: 1, views: 1000 });
    const platforms = aggregate(facts, 'platform');
    expect(platforms.map((r) => r.key)).toEqual(expect.arrayContaining(['tiktok', 'instagram']));
    const products = aggregate(facts, 'product');
    expect(products.find((r) => r.key === product)).toMatchObject({ label: 'Budget Planner', revenueCents: 2800, feesCents: 240, costCents: 40, profitCents: 2520, posts: 1 });
    expect(products.find((r) => r.key === 'unattributed')).toMatchObject({ label: 'Sales without a product', revenueCents: 2700 });
  });

  it('filters to one persona and converts credits at the Owner-set price', async () => {
    t = await createTestStudio();
    const { a } = await seed(t);
    await updateProfitSettings(t.db, t.studioId, { creditPriceCents: 5 }, OWNER);
    const rows = await pnl(t.db, { studioId: t.studioId, ...window, grain: 'persona', personaId: a.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.costBreakdown.creditsCents).toBe(50);
    await expect(updateProfitSettings(t.db, t.studioId, { creditPriceCents: 1 }, { type: 'agent', id: 'profit-engine' })).rejects.toThrow(/only the Owner/);
  });

  it('buckets a weekly series per persona', async () => {
    t = await createTestStudio();
    const { a } = await seed(t);
    const s = await weeklySeries(t.db, { studioId: t.studioId, before: MONDAY, weeks: 2 });
    expect(s.weeks).toEqual(['2026-09-28', '2026-10-05']);
    const ada = s.byPersona.get(a.id)!;
    // Only what happened before Monday 12 Oct counts: the $20 order (Oct 10), both posts (Oct 9 and 11) and their
    // slot and post costs (Oct 8 and 11).
    expect(ada[1]).toMatchObject({ grossCents: 2000, feesCents: 150, posts: 2, costCents: 114, profitCents: 1736 });
    expect(ada[0]).toMatchObject({ grossCents: 0, posts: 0, costCents: 0 });
  });
});
