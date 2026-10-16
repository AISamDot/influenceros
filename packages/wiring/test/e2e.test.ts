import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_RENDER_JOB, PUBLISH_PREPARE_JOB } from '@ios/agents';
import { createTestStudio, makeTestPersona, type TestStudio } from '@ios/agents/testing';
import { handleStoreWebhook } from '@ios/commerce';
import { attachSampleBible, planWeek, processSlot } from '@ios/content';
import { decide, OWNER, payloadHash, STUDIO_MANAGER } from '@ios/core';
import { json } from '@ios/db';
import { enqueueDuePosts, personaScorecard, pullMetrics } from '@ios/distribution';
import { FakeFaceMatcher, FakeOcr, FakeToolkit, setMediaDeps } from '@ios/media';
import { createWorker, pnlWithTotals, profitCard, runWeeklyCycle } from '@ios/profit';
import { createFakeProviders, type PostMetrics } from '@ios/providers';
import { afterEach, describe, expect, it } from 'vitest';
import { allJobs } from '../src';

/**
 * IOS-3/4 integrator E2E on fakes (docs/IOS-34-CONTRACTS.md §7): a slot rendered (E) → published (F) → metric
 * windows (F) → an attributed order (G) → the persona's P&L, scorecard and Profit card (D) → a 4-week negative
 * forecast creates one kill proposal that only the Owner can approve.
 */

const H = 3_600_000;
const DAY = 24 * H;
const clock = { now: new Date('2026-10-14T10:00:00Z') };

let t: TestStudio | null = null;
afterEach(async () => {
  await t?.db.close();
  t = null;
});

const metrics = (views: number): PostMetrics => ({
  views,
  watchTimeS: views * 7,
  likes: Math.round(views * 0.05),
  comments: Math.round(views * 0.004),
  saves: Math.round(views * 0.01),
  shares: Math.round(views * 0.006),
  follows: Math.round(views * 0.003),
  profileVisits: Math.round(views * 0.02),
  linkClicks: Math.round(views * 0.002),
});

describe('IOS-3/4 end to end (fakes)', () => {
  it('slot → render → publish → metrics → attributed order → P&L / scorecard / Profit card → Owner-only kill proposal', async () => {
    const providers = createFakeProviders();
    t = await createTestStudio({ now: () => clock.now, providers });
    const { db, studioId, services } = t;
    setMediaDeps(services, { toolkit: new FakeToolkit(), ocr: new FakeOcr(), face: new FakeFaceMatcher(), workRoot: mkdtempSync(join(tmpdir(), 'ios-e2e-')) });
    const worker = createWorker({ services, handlers: allJobs(), workerId: 'e2e' });

    const p = await makeTestPersona(t, { name: 'Nora Vale', state: 'MONETISING', autonomy: 'L0' });
    await attachSampleBible(db, p.id);
    await db.query('UPDATE persona SET launched_at = $2, created_at = $2 WHERE id = $1', [p.id, new Date(clock.now.getTime() - 60 * DAY)]);
    for (const platform of ['tiktok', 'instagram']) {
      await db.query(`INSERT INTO account (persona_id, platform, handle, status, ai_label_ok, token_ref) VALUES ($1, $2, $3, 'active', true, $4)`, [p.id, platform, `nora_${platform}`, `zr_nora_${platform}`]);
    }

    // B → E: a talking slot goes through the content pipeline and is rendered by the composed media.render handler.
    const { slotIds } = await planWeek(services, p.id, new Date('2026-10-19T00:00:00Z'));
    const slot = await db.one<{ id: string; slot_at: Date }>(`SELECT id, slot_at FROM calendar_slot WHERE id = ANY($1::uuid[]) AND format = 'talking' ORDER BY slot_at LIMIT 1`, [slotIds]);
    expect((await processSlot(services, slot.id)).status).toBe('media_queued');
    await worker.drain();
    const jobs = await db.query<{ kind: string; status: string }>(`SELECT kind, status FROM job WHERE kind IN ($1, $2)`, [MEDIA_RENDER_JOB, PUBLISH_PREPARE_JOB]);
    expect(jobs.filter((j) => j.kind === MEDIA_RENDER_JOB).map((j) => j.status)).toEqual(['succeeded']);
    expect(jobs.filter((j) => j.kind === PUBLISH_PREPARE_JOB).map((j) => j.status)).toEqual(['succeeded']);
    expect((await db.one<{ thumbnail_url: string | null }>('SELECT thumbnail_url FROM calendar_slot WHERE id = $1', [slot.id])).thumbnail_url).toBeTruthy();

    // F: one post per platform, AI flag on, waiting for the Owner (L0); approve, then publish at the slot time.
    const posts = await db.query<{ id: string; platform: string; status: string; ai_flag: boolean; approval_id: string }>(
      `SELECT id, platform, status, ai_flag, approval_id FROM post WHERE calendar_slot_id = $1 ORDER BY platform`,
      [slot.id],
    );
    expect(posts.map((x) => [x.platform, x.status, x.ai_flag])).toEqual([
      ['instagram', 'awaiting_approval', true],
      ['tiktok', 'awaiting_approval', true],
    ]);
    for (const x of posts) await decide(db, { approvalId: x.approval_id, decision: 'approve', actor: OWNER });
    // Each platform has its own posting time; publish once the later one is due.
    const last = await db.one<{ at: Date }>(`SELECT max(scheduled_at) AS at FROM post WHERE calendar_slot_id = $1`, [slot.id]);
    clock.now = new Date(new Date(last.at ?? slot.slot_at).getTime() + 5 * 60_000);
    expect(await enqueueDuePosts(services, clock.now)).toHaveLength(2);
    await worker.drain();
    const live = await db.query<{ id: string; platform: string; status: string; url: string; external_id: string; published_at: Date }>(
      `SELECT id, platform, status, url, external_id, published_at FROM post WHERE calendar_slot_id = $1 ORDER BY platform`,
      [slot.id],
    );
    expect(live.every((x) => x.status === 'live' && /^https:\/\//.test(x.url))).toBe(true);
    expect(providers.publish.callsTo('publish').every((c) => (c.args as { aiLabel: boolean }).aiLabel === true)).toBe(true);
    expect((await db.one<{ status: string }>('SELECT status FROM calendar_slot WHERE id = $1', [slot.id])).status).toBe('live');
    const tiktok = live.find((x) => x.platform === 'tiktok')!;

    // F: metric windows land at 1h / 24h / 72h / 7d.
    const published = new Date(tiktok.published_at).getTime();
    for (const [offset, views] of [
      [1.2 * H, 800],
      [25 * H, 5_000],
      [73 * H, 9_000],
      [7 * DAY + 2 * H, 12_000],
    ] as const) {
      for (const x of live) providers.publish.metrics.set(x.external_id, metrics(x.platform === 'tiktok' ? views : views / 2));
      clock.now = new Date(published + offset);
      expect((await pullMetrics(services, { now: clock.now })).captured).toBe(2);
    }
    const windows = await db.query<{ window: string }>(`SELECT "window" FROM metric_snapshot WHERE post_id = $1 ORDER BY created_at`, [tiktok.id]);
    expect(windows.map((w) => w.window)).toEqual(['1h', '24h', '72h', '7d']);

    // G: a signed Lemon Squeezy order with the post in checkout custom data is attributed to the post.
    const product = await db.one<{ id: string }>(
      `INSERT INTO product (persona_id, name, slug, ladder_rung, status, price_cents, store_product_id, current_version) VALUES ($1, 'Budget Reset Workbook', 'budget-reset', 'entry', 'live', 1700, 'lsp_e2e', 1) RETURNING id`,
      [p.id],
    );
    providers.store.stores.push({ id: 'st_e2e', name: 'Nora store', slug: p.slug, domain: `${p.slug}.lemonsqueezy.com`, currency: 'USD' });
    await db.query(`INSERT INTO store_account (persona_id, store_id, store_slug, status) VALUES ($1, 'st_e2e', $2, 'linked')`, [p.id, p.slug]);
    const body = JSON.stringify({ type: 'order_created', orderId: 'ord_e2e', productId: 'lsp_e2e', storeId: 'st_e2e', amountCents: 1700, currency: 'USD', emailHash: 'h', customData: { post_id: tiktok.id } });
    expect(await handleStoreWebhook(services, body, providers.store.sign(body))).toMatchObject({ status: 200, outcome: 'processed' });
    expect(await db.one('SELECT product_id, source_post_id, attribution FROM orders')).toEqual({ product_id: product.id, source_post_id: tiktok.id, attribution: 'custom_data' });

    // D: the post's P&L carries the views and the sale; the scorecard and the Profit card read the same data.
    const range = { studioId, from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z'), personaId: p.id };
    const byPost = await pnlWithTotals(db, { ...range, grain: 'post' });
    const row = byPost.rows.find((r) => r.key === tiktok.id)!;
    expect(row.views).toBe(12_000);
    expect(row.revenueCents).toBe(1700);
    const card = await personaScorecard(services, p.id, 30, clock.now);
    expect(card).toMatchObject({ posts: 2, views: 18_000 });

    // A persona that sells but still loses money every week: six weeks of spend, then the weekly cycle.
    for (let w = 1; w <= 6; w++) {
      const at = new Date(clock.now.getTime() - w * 7 * DAY);
      await db.query(
        `INSERT INTO credit_ledger (studio_id, persona_id, unit, entry_type, amount, period, provider, operation, ref_type, ref_id, meta, created_at)
         VALUES ($1, $2, 'llm_usd', 'debit', 60, $3, 'test', 'test', 'persona', $2, $4::jsonb, $5)`,
        [studioId, p.id, at.toISOString().slice(0, 7), json({ agent: 'test' }), at],
      );
    }
    const cycle = await runWeeklyCycle(services, studioId, clock.now);
    expect(cycle.killProposals).toBe(1);
    const profit = await profitCard(db, studioId, clock.now);
    expect(profit.month).toBe('2026-10');
    expect(profit.forecastCents.p10).toBeLessThanOrEqual(profit.forecastCents.p90);

    const kill = await db.one<{ id: string; status: string; payload: unknown }>(`SELECT id, status, payload FROM approval WHERE kind = 'persona_kill' AND persona_id = $1`, [p.id]);
    expect(kill.status).toBe('pending');
    // Only the Owner decides it, with the typed name and the payload hash; agents and timers never do.
    await expect(decide(db, { approvalId: kill.id, decision: 'approve', actor: STUDIO_MANAGER })).rejects.toThrow(/only the Owner/);
    await expect(decide(db, { approvalId: kill.id, decision: 'approve', actor: OWNER })).rejects.toThrow(/payload hash/);
    clock.now = new Date(clock.now.getTime() + 30 * DAY);
    await worker.drain();
    expect((await db.one<{ status: string }>('SELECT status FROM approval WHERE id = $1', [kill.id])).status).toBe('pending');
    const approved = await decide(db, { approvalId: kill.id, decision: 'approve', actor: OWNER, confirmName: 'Nora Vale', payloadHash: payloadHash(kill.payload) });
    expect(approved.status).toBe('approved');
  }, 120_000);
});
