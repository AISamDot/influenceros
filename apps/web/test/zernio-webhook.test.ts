import { createHmac } from 'node:crypto';
import type { Db } from '@troupe/db';
import { createTestDb } from '@troupe/db/testing';
import { FAKE_WEBHOOK_SECRET, FakeZernio } from '@troupe/providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as LS_POST } from '../app/api/webhooks/lemonsqueezy/route';
import { POST as RESEND_POST } from '../app/api/webhooks/resend/route';
import { POST } from '../app/api/webhooks/zernio/route';
import { fakeWebhooksRefused } from '../lib/webhook-guard';

// Stream F: the public Zernio webhook verifies the signature before reading the body, then stores events.
let db: Db;
let personaId: string;
beforeAll(async () => {
  db = await createTestDb();
  (globalThis as Record<symbol, unknown>)[Symbol.for('troupe-house.db')] = Promise.resolve(db);
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('troupe-house.services')];
  const studio = (await db.one<{ id: string }>(`INSERT INTO studio (slug, name) VALUES ('t', 'T') RETURNING id`)).id;
  personaId = (await db.one<{ id: string }>(`INSERT INTO persona (studio_id, slug, name, niche, state) VALUES ($1, 'maya', 'Maya', 'money', 'TESTING') RETURNING id`, [studio])).id;
  await db.query(`INSERT INTO post (persona_id, platform, format, caption, status, external_id) VALUES ($1, 'instagram', 'talking', 'x', 'live', 'ext_w')`, [personaId]);
});
afterAll(async () => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('troupe-house.db')];
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('troupe-house.services')];
  await db.close();
});

const body = JSON.stringify({ type: 'comment', platform: 'instagram', accountRef: 'a', externalPostId: 'ext_w', comment: { id: 'wh1', authorRef: 'u', text: 'BUDGET', at: '2026-10-20T10:00:00Z' } });
const req = (sig: string) => new Request('http://127.0.0.1:3100/api/webhooks/zernio', { method: 'POST', body, headers: { 'x-zernio-signature': sig, 'content-type': 'application/json' } });

describe('Zernio webhook', () => {
  it('refuses a bad signature and stores nothing', async () => {
    const res = await POST(req('00'));
    expect(res.status).toBe(401);
    expect((await db.query(`SELECT 1 FROM comment`)).length).toBe(0);
  });

  it('stores a signed comment once and queues the community worker', async () => {
    const sig = new FakeZernio().sign(body);
    expect((await POST(req(sig))).status).toBe(200);
    expect((await POST(req(sig))).status).toBe(200);
    expect((await db.query(`SELECT 1 FROM comment WHERE external_id = 'wh1'`)).length).toBe(1);
    expect((await db.query(`SELECT 1 FROM job WHERE kind = 'community.handle' AND persona_id = $1`, [personaId])).length).toBe(1);
  });
});

describe('fake-provider webhooks (public secret) are never accepted on a reachable server', () => {
  it('only a loopback, non-deployed host may use fake-signed webhooks', () => {
    const r = (host: string, extra: Record<string, string> = {}) => new Request(`http://${host}/api/webhooks/x`, { method: 'POST', headers: { host, ...extra } });
    expect(fakeWebhooksRefused('fake-lemonsqueezy', r('127.0.0.1:3100'), {})).toBe(false);
    expect(fakeWebhooksRefused('fake-lemonsqueezy', r('localhost:3100'), {})).toBe(false);
    expect(fakeWebhooksRefused('fake-lemonsqueezy', r('localhost:3100'), { VERCEL: '1' })).toBe(true);
    expect(fakeWebhooksRefused('fake-lemonsqueezy', r('abc.ngrok.app'), {})).toBe(true);
    expect(fakeWebhooksRefused('fake-lemonsqueezy', r('192.168.1.5:3100'), {})).toBe(true);
    expect(fakeWebhooksRefused('fake-lemonsqueezy', r('localhost:3100', { 'x-forwarded-host': 'abc.ngrok.app' }), {})).toBe(true);
    expect(fakeWebhooksRefused('lemonsqueezy', r('abc.ngrok.app'), { VERCEL: '1' })).toBe(false);
  });

  it('a forged Lemon Squeezy / Resend / Zernio event signed with the fake secret through a tunnel gets 404', async () => {
    const forged = JSON.stringify({ type: 'subscription_created', subscriptionId: 'evil', productId: 'x', email: 'attacker@example.com', customData: { persona_id: personaId } });
    const sig = createHmac('sha256', FAKE_WEBHOOK_SECRET).update(forged).digest('hex');
    const tunnel = (path: string, headers: Record<string, string>) => new Request(`https://abc.ngrok.app${path}`, { method: 'POST', body: forged, headers: { host: 'abc.ngrok.app', ...headers } });
    expect((await LS_POST(tunnel('/api/webhooks/lemonsqueezy', { 'x-signature': sig }))).status).toBe(404);
    expect((await RESEND_POST(tunnel('/api/webhooks/resend', { 'svix-signature': sig, 'svix-id': 'x' }))).status).toBe(404);
    expect((await POST(tunnel('/api/webhooks/zernio', { 'x-zernio-signature': sig }))).status).toBe(404);
    expect((await db.query(`SELECT 1 FROM membership`)).length).toBe(0);
  });
});
