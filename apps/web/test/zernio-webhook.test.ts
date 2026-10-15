import type { Db } from '@ios/db';
import { createTestDb } from '@ios/db/testing';
import { FakeZernio } from '@ios/providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST } from '../app/api/webhooks/zernio/route';

// Stream F: the public Zernio webhook verifies the signature before reading the body, then stores events.
let db: Db;
let personaId: string;
beforeAll(async () => {
  db = await createTestDb();
  (globalThis as Record<symbol, unknown>)[Symbol.for('influencer-os.db')] = Promise.resolve(db);
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('influencer-os.services')];
  const studio = (await db.one<{ id: string }>(`INSERT INTO studio (slug, name) VALUES ('t', 'T') RETURNING id`)).id;
  personaId = (await db.one<{ id: string }>(`INSERT INTO persona (studio_id, slug, name, niche, state) VALUES ($1, 'maya', 'Maya', 'money', 'TESTING') RETURNING id`, [studio])).id;
  await db.query(`INSERT INTO post (persona_id, platform, format, caption, status, external_id) VALUES ($1, 'instagram', 'talking', 'x', 'live', 'ext_w')`, [personaId]);
});
afterAll(async () => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('influencer-os.db')];
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('influencer-os.services')];
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
