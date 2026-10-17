import { createTestStudio, makeTestPersona } from '@troupe/agents/testing';
import { describe, expect, it } from 'vitest';
import {
  addSignal,
  backlog,
  briefProduct,
  buildListingPack,
  evaluateValidations,
  type LaunchBeat,
  planLaunch,
  POS_WEIGHTS,
  productOpportunityScore,
  runMonetizationCycle,
  sellQueue,
  topicKey,
} from '../src/monetization';
import { loadPersonaContext } from '../src/persona';
import { attachSampleBible } from '../src/sample';
import { gateRules, verdictOf } from '../src/gate';

const NOW = new Date('2026-10-14T10:00:00Z');

describe('Monetization Agent v1', () => {
  it('scores opportunities with the eight PRD factors (weights sum to 100)', () => {
    expect(Object.values(POS_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const all = { demand: 1, willingness: 1, ladderFit: 1, competition: 1, effort: 1, seasonal: 1, complianceRisk: 1, reuse: 1 };
    expect(productOpportunityScore(all)).toBe(100);
    expect(productOpportunityScore({ ...all, demand: 0 })).toBe(75);
    expect(productOpportunityScore({ ...all, complianceRisk: 0, demand: 2 })).toBe(90); // factors clamp to 0–1
    expect(topicKey('Where can I get your budget template??')).toMatchObject({ key: 'budget-template', noun: 'template' });
    expect(topicKey('do you have a meal plan for busy weeks').noun).toBe('meal plan');
  });

  it('turns audience demand into a ranked backlog, validates honestly, then briefs the validated product', async () => {
    const t = await createTestStudio({ now: () => NOW });
    const p = await makeTestPersona(t);
    await attachSampleBible(t.db, p.id);
    // Lead magnet and entry exist, so the cycle goes after audience demand.
    for (const [name, rung, price] of [['Paycheck Plan Starter', 'lead_magnet', 0], ['Zero-Based Budget Sheet', 'entry', 1200]] as const) {
      await t.db.query(`INSERT INTO product (persona_id, name, slug, ladder_rung, status, price_cents) VALUES ($1, $2, $3, $4, 'live', $5)`, [p.id, name, name.toLowerCase().replace(/ /g, '-'), rung, price]);
    }
    const asks = ['Where can I get a sinking funds tracker?', 'Do you have a sinking funds tracker template?', 'need a sinking funds tracker pls', 'is there a tracker for sinking funds?', 'nice video', 'sinking funds tracker link?'];
    for (const [i, text] of asks.entries()) {
      await t.db.query(`INSERT INTO comment (persona_id, platform, text, classification, created_at) VALUES ($1, 'instagram', $2, $3, $4)`, [p.id, text, i === 0 ? 'purchase_intent' : null, new Date(NOW.getTime() - 3_600_000)]);
    }
    await addSignal(t.db, { personaId: p.id, source: 'etsy', text: 'Sinking funds tracker printable', ref: { price: 6.5, reviews: 2400 }, sourceRef: 'etsy-1' });
    // Pin the signal to the test clock: the cycle ingests from the latest signal minus a day, and the database stamps
    // created_at with the wall clock (on any later day the comments above would fall outside that window).
    await t.db.query(`UPDATE demand_signal SET created_at = $2 WHERE persona_id = $1`, [p.id, new Date(NOW.getTime() - 2 * 3_600_000)]);
    const first = await runMonetizationCycle(t.services, p.id, NOW);
    expect(first.signals).toBe(5); // "nice video" is not a demand signal
    expect(first.briefed).toEqual([]);
    expect(first.validating).toHaveLength(1);
    const [top] = await backlog(t.db, p.id);
    expect(top).toMatchObject({ topic_key: 'funds-tracker', status: 'validating' });
    expect(top!.score).toBeGreaterThanOrEqual(60);
    expect(Object.keys(top!.factors).sort()).toEqual(Object.keys(POS_WEIGHTS).sort());
    // Intake is idempotent.
    expect((await runMonetizationCycle(t.services, p.id, NOW)).signals).toBe(0);

    // The validation post's keyword collects real comments: 50 passes the default mark.
    const v = await t.db.one<{ keyword: string }>(`SELECT keyword FROM validation_test`);
    const ctx = await loadPersonaContext(t.db, p.id);
    const queue = await sellQueue(t.db, ctx, new Date('2026-10-19T00:00:00Z'));
    expect(queue[0]).toMatchObject({ kind: 'validation', ctaKeyword: v.keyword });
    for (let i = 0; i < 50; i++) await t.db.query(`INSERT INTO comment (persona_id, platform, text) VALUES ($1, 'tiktok', $2)`, [p.id, `${v.keyword.toLowerCase()} please`]);
    expect(await evaluateValidations(t.services, p.id, NOW)).toEqual([{ opportunityId: top!.id, passed: true }]);
    await t.db.query(`UPDATE validation_test SET passed = NULL`); // let the cycle evaluate it itself
    await t.db.query(`UPDATE product_opportunity SET status = 'validating'`);
    const second = await runMonetizationCycle(t.services, p.id, NOW);
    expect(second.briefed).toHaveLength(1);
    expect(second.listings).toEqual(second.briefed);
    const product = await t.db.one<{ status: string; price_cents: number; cta_keyword: string }>(`SELECT status, price_cents, cta_keyword FROM product WHERE id = $1`, [second.briefed[0]]);
    expect(product.status).toBe('brief');
    expect(product.price_cents).toBeGreaterThanOrEqual(700);
    expect(product.price_cents).toBeLessThanOrEqual(3900);
    expect(product.cta_keyword).toBe('TRACKER');
    expect((await backlog(t.db, p.id))[0]!.status).toBe('briefed');
    await t.db.close();
  });

  it('briefs a lead magnet and an entry product from niche research when a persona has none (FR-20.1)', async () => {
    const t = await createTestStudio({ now: () => NOW });
    const p = await makeTestPersona(t);
    await attachSampleBible(t.db, p.id);
    const res = await runMonetizationCycle(t.services, p.id, NOW);
    expect(res.briefed).toHaveLength(2);
    const products = await t.db.query<{ ladder_rung: string; price_cents: number; status: string }>(`SELECT ladder_rung, price_cents, status FROM product ORDER BY price_cents`);
    expect(products).toEqual([
      { ladder_rung: 'lead_magnet', price_cents: 0, status: 'brief' },
      { ladder_rung: 'entry', price_cents: 1200, status: 'brief' },
    ]);
    const briefs = await t.db.query<{ content: { outline: string[]; promise: string } }>(`SELECT content FROM product_brief`);
    expect(briefs).toHaveLength(2);
    for (const b of briefs) {
      expect(b.content.outline.length).toBeGreaterThanOrEqual(3);
      expect(verdictOf(gateRules({ kind: 'listing', text: b.content.promise }))).toBe('green');
    }
    // Cost attributed to the product; the Owner is told in the Monetization chat (no approval needed for a brief).
    const debit = await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM credit_ledger WHERE ref_type = 'product' AND entry_type = 'debit'`);
    expect(debit.n).toBeGreaterThan(0);
    const msg = await t.db.one<{ author: string; meta: { kind: string; fake: boolean } }>(`SELECT author, meta FROM chat_message ORDER BY created_at LIMIT 1`);
    expect(msg).toMatchObject({ author: 'agent:monetization-agent', meta: { kind: 'notice', fake: true } });
    await t.db.close();
  });

  it('writes listing packs (Lemon Squeezy + Etsy) that pass the Gate', async () => {
    const t = await createTestStudio({ now: () => NOW });
    const p = await makeTestPersona(t);
    await attachSampleBible(t.db, p.id);
    const { productId } = await briefProduct(t.services, { personaId: p.id, rung: 'entry', title: 'Sinking funds tracker' });
    const pack = await buildListingPack(t.services, productId);
    expect(pack.verdict).toBe('green');
    expect(pack.lemonsqueezy).toMatchObject({ status: 'draft', currency: 'USD', price_cents: 1200, pay_what_you_want: false });
    expect(pack.lemonsqueezy.description_html).toMatch(/^<p>/);
    expect(pack.etsy.title.length).toBeLessThanOrEqual(140);
    expect(pack.etsy.tags.length).toBeLessThanOrEqual(13);
    expect(pack.etsy.tags.every((tag) => tag.length <= 20)).toBe(true);
    expect(pack.etsy).toMatchObject({ is_digital: true, type: 'download', who_made: 'i_did' });
    expect(pack.etsy.description).toMatch(/AI tools/);
    const rows = await t.db.query<{ channel: string; gate_verdict: string }>(`SELECT channel, gate_verdict FROM product_listing ORDER BY channel`);
    expect(rows).toEqual([
      { channel: 'etsy', gate_verdict: 'green' },
      { channel: 'lemonsqueezy', gate_verdict: 'green' },
    ]);
    // Idempotent per channel.
    await buildListingPack(t.services, productId);
    expect((await t.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM product_listing`)).n).toBe(2);
    await t.db.close();
  });

  it('plans a launch with real deadlines only and books its beats once v1 is approved', async () => {
    const t = await createTestStudio({ now: () => NOW });
    const p = await makeTestPersona(t);
    await attachSampleBible(t.db, p.id);
    const paid = await briefProduct(t.services, { personaId: p.id, rung: 'entry', title: 'Sinking funds tracker' });
    const launch = await planLaunch(t.services, { productId: paid.productId, startsOn: new Date('2026-10-20T00:00:00Z') });
    expect(launch.beats.map((b) => b.beat)).toEqual(['teaser', 'reveal', 'walkthrough', 'faq', 'last_call']);
    expect(launch.endsOn).toBe('2026-10-26');
    expect(launch.beats.find((b) => b.beat === 'last_call')!.angle).toContain('2026-10-26');
    expect(launch.verdict).toBe('green');
    const row = await t.db.one<{ ends_on: string; plan: { coupon: { valid_until: string } } }>(`SELECT ends_on::text, plan FROM launch WHERE id = $1`, [launch.launchId]);
    expect(row.ends_on).toBe('2026-10-26');
    expect(row.plan.coupon.valid_until).toBe('2026-10-26');

    const free = await briefProduct(t.services, { personaId: p.id, rung: 'lead_magnet', title: 'Payday checklist' });
    const freeLaunch = await planLaunch(t.services, { productId: free.productId, startsOn: new Date('2026-10-20T00:00:00Z') });
    expect(freeLaunch.endsOn).toBeNull();
    expect(freeLaunch.beats.map((b: LaunchBeat) => b.beat)).not.toContain('last_call');

    // No selling a product that doesn't exist: beats reach the calendar only after v1 is approved.
    const ctx = await loadPersonaContext(t.db, p.id);
    const week = new Date('2026-10-19T00:00:00Z');
    expect((await sellQueue(t.db, ctx, week)).filter((i) => i.kind === 'launch')).toHaveLength(0);
    await t.db.query(`UPDATE product SET status = 'approved' WHERE id = $1`, [paid.productId]);
    const beats = (await sellQueue(t.db, ctx, week)).filter((i) => i.kind === 'launch');
    // The teaser (Oct 17) belongs to the week before; this week gets the rest, in date order.
    expect(beats.map((b) => b.beat)).toEqual(['reveal', 'walkthrough', 'faq', 'last_call']);
    await t.db.close();
  });
});
