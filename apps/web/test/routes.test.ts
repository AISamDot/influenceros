import { createSession } from '@ios/auth';
import { findThread, payloadHash, proposeKill, STUDIO_MANAGER } from '@ios/core';
import type { Db } from '@ios/db';
import { createTestDb } from '@ios/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as decideRoute } from '../app/api/approvals/[id]/route';
import { POST as chatRoute } from '../app/api/chat/[threadId]/messages/route';

const SECRET = 'route-test-secret-0123456789abcdef0123456789';
const BASE = 'http://127.0.0.1:3100';
let db: Db;
let studioId: string;
let cookie: string;

// The routes use the process-wide DB and services singletons: point them at a fresh in-memory test database.
beforeAll(async () => {
  vi.stubEnv('AUTH_SECRET', SECRET);
  vi.stubEnv('IOS_AUTH', '');
  db = await createTestDb();
  (globalThis as Record<symbol, unknown>)[Symbol.for('influencer-os.db')] = Promise.resolve(db);
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('influencer-os.services')];
  studioId = (await db.one<{ id: string }>(`INSERT INTO studio (slug, name) VALUES ('t', 'T') RETURNING id`)).id;
  cookie = `ios_session=${(await createSession(db, { method: 'password', secret: SECRET })).token}`;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('influencer-os.db')];
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('influencer-os.services')];
  await db.close();
});

let n = 0;
async function killProposal() {
  n += 1;
  const { id } = await db.one<{ id: string }>(
    `INSERT INTO persona (studio_id, slug, name, niche, state) VALUES ($1, $2, $3, 'x', 'TESTING') RETURNING id`,
    [studioId, `p${n}`, `Mara Lane ${n}`],
  );
  const { approval } = await proposeKill(db, { personaId: id, rationale: 'below day-30 checkpoint', proposedBy: STUDIO_MANAGER });
  return { personaId: id, name: `Mara Lane ${n}`, approval };
}
const state = async (id: string) => (await db.one<{ state: string }>('SELECT state FROM persona WHERE id = $1', [id])).state;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('approvals API: kills need the typed name and the payload hash on both paths', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));

  it('JSON path', async () => {
    const k = await killProposal();
    const call = (body: Record<string, unknown>, withCookie = true) =>
      decideRoute(
        new Request(`${BASE}/api/approvals/${k.approval.id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(withCookie ? { cookie } : {}) },
          body: JSON.stringify(body),
        }),
        ctx(k.approval.id),
      );
    const hash = payloadHash(k.approval.payload);
    expect((await call({ decision: 'approve', payloadHash: hash, confirm: k.name }, false)).status).toBe(401);
    let r = await call({ decision: 'approve', payloadHash: hash });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/type Mara Lane \d+ exactly/);
    r = await call({ decision: 'approve', confirm: k.name });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/payload hash/);
    expect(await state(k.personaId)).toBe('TESTING');
    r = await call({ decision: 'approve', payloadHash: hash, confirm: k.name });
    expect(r.status).toBe(200);
    expect((await r.json()).approval).toMatchObject({ status: 'approved', decided_by: 'owner:hossam' });
    expect(await state(k.personaId)).toBe('KILLED');
  });

  it('form path', async () => {
    const k = await killProposal();
    const call = (fields: Record<string, string>) =>
      decideRoute(
        new Request(`${BASE}/api/approvals/${k.approval.id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, host: '127.0.0.1:3100', referer: `${BASE}/approvals` },
          body: new URLSearchParams(fields).toString(),
        }),
        ctx(k.approval.id),
      );
    let r = await call({ decision: 'approve', payload_hash: payloadHash(k.approval.payload), confirm: 'mara' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toMatch(/^\/approvals\?error=type/);
    r = await call({ decision: 'approve', confirm: k.name });
    expect(r.headers.get('location')).toMatch(/error=.*payload/);
    expect(await state(k.personaId)).toBe('TESTING');
    r = await call({ decision: 'approve', payload_hash: payloadHash(k.approval.payload), confirm: k.name });
    expect(r.headers.get('location')).toBe('/approvals?ok=approved');
    expect(await state(k.personaId)).toBe('KILLED');
  });
});

describe('chat API', () => {
  it('streams the Studio Manager reply as text/plain and saves it under x-message-id', async () => {
    const thread = await findThread(db, studioId, 'studio');
    const res = await chatRoute(
      new Request(`${BASE}/api/chat/${thread.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ body: 'How are we doing?' }),
      }),
      { params: Promise.resolve({ threadId: thread.id }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    expect(res.headers.get('x-agent-mode')).toBe('fake');
    const id = res.headers.get('x-message-id')!;
    const reader = res.body!.getReader();
    let text = '';
    let chunks = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks += 1;
      text += new TextDecoder().decode(value);
    }
    expect(chunks).toBeGreaterThan(1);
    expect(text).toMatch(/Studio, last 7 days/);
    const saved = await db.one<{ body: string; author: string }>('SELECT body, author FROM chat_message WHERE id = $1', [id]);
    expect(saved).toEqual({ body: text, author: 'agent:studio-manager' });

    const anon = await chatRoute(
      new Request(`${BASE}/api/chat/${thread.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"body":"hi"}' }),
      { params: Promise.resolve({ threadId: thread.id }) },
    );
    expect(anon.status).toBe(401);
  });
});
