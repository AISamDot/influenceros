import { createTestDb } from '@ios/db/testing';
import { FakeResend } from '@ios/providers';
import { describe, expect, it } from 'vitest';
import {
  AuthError,
  authorize,
  hashPassword,
  issueLoginLink,
  isPublicPath,
  loginErrorMessage,
  loginWithMagicToken,
  loginWithPassword,
  readCookie,
  requestMagicLink,
  revokeSession,
  safeNext,
  sessionActive,
  sessionCookie,
  setOwnerPassword,
  signSession,
  verifyPassword,
  verifySession,
} from '../src';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const HOST = '127.0.0.1:3100';

describe('request guard (proxy)', () => {
  it('refuses unauthenticated requests: API → 401, pages → /login?next=…', () => {
    const env = {};
    expect(authorize({ pathname: '/api/approvals', cookie: null, host: HOST }, { env, secret: SECRET })).toEqual({ action: 'deny', status: 401, message: 'sign in first' });
    expect(authorize({ pathname: '/api/profit/report', cookie: 'garbage', host: HOST }, { env, secret: SECRET })).toMatchObject({ action: 'deny', status: 401 });
    expect(authorize({ pathname: '/approvals', search: '?x=1', cookie: null, host: HOST }, { env, secret: SECRET })).toEqual({
      action: 'redirect',
      location: '/login?next=%2Fapprovals%3Fx%3D1',
    });
    expect(authorize({ pathname: '/', cookie: null, host: HOST }, { env, secret: SECRET })).toEqual({ action: 'redirect', location: '/login' });
  });

  it('lets public routes through: login, auth API, webhooks, cron (own secret), health', () => {
    for (const p of ['/login', '/login/verify', '/api/auth/password', '/api/webhooks/lemonsqueezy', '/api/cron/tick', '/api/health']) {
      expect(isPublicPath(p)).toBe(true);
      expect(authorize({ pathname: p, cookie: null, host: HOST }, { secret: SECRET })).toMatchObject({ action: 'allow' });
    }
    for (const p of ['/', '/chat', '/api/chat/x/messages', '/api/healthz', '/loginx', '/api/authx', '/money', '/api/knowledge/search']) {
      expect(isPublicPath(p)).toBe(false);
    }
  });

  it('accepts a valid signed session; rejects tampered, expired or foreign-key tokens', () => {
    const now = Date.now();
    const token = signSession({ sid: '7f9c2b1e-0000-4000-8000-000000000001', exp: now + 60_000 }, SECRET);
    expect(authorize({ pathname: '/chat', cookie: token, host: HOST }, { secret: SECRET, now })).toMatchObject({ action: 'allow', session: { sid: '7f9c2b1e-0000-4000-8000-000000000001' } });
    expect(verifySession(token, 'another-secret-0123456789abcdef0123456789', now)).toBeNull();
    expect(verifySession(token, SECRET, now + 120_000)).toBeNull();
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, sid: 'x', exp: now + 1e9 })).toString('base64url');
    expect(verifySession(`${forged}.${sig}`, SECRET, now)).toBeNull();
    expect(verifySession(`${payload}.${sig}.x`, SECRET, now)).toBeNull();
  });

  it('fails closed when deployed without AUTH_SECRET; IOS_AUTH=off works only on loopback, never deployed', () => {
    const deployed = { VERCEL: '1' };
    expect(authorize({ pathname: '/api/chat/x', cookie: null, host: 'app.example.com' }, { env: deployed })).toMatchObject({ action: 'deny', status: 503 });
    expect(authorize({ pathname: '/chat', cookie: null, host: 'app.example.com' }, { env: deployed })).toEqual({ action: 'redirect', location: '/login?error=config' });
    expect(authorize({ pathname: '/chat', cookie: null, host: HOST }, { env: { IOS_AUTH: 'off' }, secret: SECRET })).toMatchObject({ action: 'allow' });
    expect(authorize({ pathname: '/chat', cookie: null, host: 'evil.example.com' }, { env: { IOS_AUTH: 'off' }, secret: SECRET })).toMatchObject({ action: 'redirect' });
    expect(authorize({ pathname: '/chat', cookie: null, host: 'localhost' }, { env: { IOS_AUTH: 'off', VERCEL: '1', AUTH_SECRET: SECRET } })).toMatchObject({ action: 'redirect' });
  });

  it('cookies are HttpOnly, SameSite=Lax, Secure on https; ?next= never leaves the site', () => {
    expect(sessionCookie('tok', { secure: true })).toMatch(/^ios_session=tok; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=1209600$/);
    expect(sessionCookie(null, { secure: false })).toMatch(/Max-Age=0$/);
    expect(readCookie('a=1; ios_session=abc.def; b=2')).toBe('abc.def');
    expect(safeNext('//evil.com')).toBe('/');
    expect(safeNext('https://evil.com')).toBe('/');
    expect(safeNext('/login?next=/x')).toBe('/');
    expect(safeNext('/approvals')).toBe('/approvals');
    // Browsers strip tab/newline and read "\\" as "/" in a Location: "/\t/evil.com" would leave the site.
    for (const v of ['/\t/evil.com', '/\n/evil.com', '/\\evil.com', '/ /evil.com', '/\x00x']) expect(safeNext(v)).toBe('/');
    expect(safeNext('/pipeline?persona=a#top')).toBe('/pipeline?persona=a#top');
  });
});

describe('Owner sign-in', () => {
  it('password: scrypt hash, throttled failures, session rows that sign-out revokes', async () => {
    const db = await createTestDb();
    const stored = await hashPassword('correct horse battery');
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
    await expect(hashPassword('short')).rejects.toThrow(/12 characters/);

    await expect(loginWithPassword(db, { password: 'anything at all', secret: SECRET })).rejects.toMatchObject({ status: 401 });
    await setOwnerPassword(db, 'correct horse battery');
    const s = await loginWithPassword(db, { password: 'correct horse battery', secret: SECRET, userAgent: 'test' });
    expect(verifySession(s.token, SECRET)?.sid).toBe(s.sid);
    expect(await sessionActive(db, s.sid)).toBe(true);
    await revokeSession(db, s.sid);
    expect(await sessionActive(db, s.sid)).toBe(false);

    // Changing the password signs out every session.
    const s2 = await loginWithPassword(db, { password: 'correct horse battery', secret: SECRET });
    await setOwnerPassword(db, 'a new long password');
    expect(await sessionActive(db, s2.sid)).toBe(false);

    for (let i = 0; i < 10; i++) await expect(loginWithPassword(db, { password: `nope-${i}`, secret: SECRET, ipHash: 'attacker' })).rejects.toBeInstanceOf(AuthError);
    await expect(loginWithPassword(db, { password: 'a new long password', secret: SECRET, ipHash: 'attacker' })).rejects.toMatchObject({ status: 429 });
    // Throttled per client: another client's failures don't lock the Owner out.
    expect(await loginWithPassword(db, { password: 'a new long password', secret: SECRET, ipHash: 'owner-mac' })).toHaveProperty('sid');
    await db.close();
  });

  it("magic link: sent only to OWNER_EMAIL (same answer otherwise), single use, expires", async () => {
    const db = await createTestDb();
    const email = new FakeResend();
    const base = { ownerEmail: 'Hossam@Example.com', from: 'Influencer OS <login@example.com>', baseUrl: 'http://127.0.0.1:3100' };
    expect(await requestMagicLink(db, email, { ...base, email: 'someone@else.com' })).toEqual({ sent: false, link: null });
    expect(email.calls).toHaveLength(0);
    const r = await requestMagicLink(db, email, { ...base, email: ' hossam@example.com ' });
    expect(r.sent).toBe(true);
    const sent = email.callsTo('send')[0]!.args as { to: string; html: string };
    expect(sent.to).toBe('hossam@example.com');
    const token = new URL(r.link!).searchParams.get('token')!;
    expect(sent.html).toContain(token);
    // Only the hash is stored.
    expect((await db.one<{ token_hash: string }>('SELECT token_hash FROM auth_token')).token_hash).not.toContain(token);

    const s = await loginWithMagicToken(db, { token, secret: SECRET });
    expect(await sessionActive(db, s.sid)).toBe(true);
    await expect(loginWithMagicToken(db, { token, secret: SECRET })).rejects.toMatchObject({ status: 401 });

    const late = await requestMagicLink(db, email, { ...base, email: 'hossam@example.com' });
    const lateToken = new URL(late.link!).searchParams.get('token')!;
    await expect(loginWithMagicToken(db, { token: lateToken, secret: SECRET, now: new Date(Date.now() + 16 * 60_000) })).rejects.toMatchObject({ status: 401 });

    // No owner email configured: nothing is ever sent.
    expect(await requestMagicLink(db, email, { ...base, ownerEmail: null, email: 'hossam@example.com' })).toEqual({ sent: false, link: null });
    // Five requests for other addresses in 15 minutes from one client, then no more from that client; they never
    // block the Owner's own link (which has its own limit).
    for (let i = 0; i < 5; i++) await requestMagicLink(db, email, { ...base, email: 'x@y.z', ipHash: 'attacker' });
    await expect(requestMagicLink(db, email, { ...base, email: 'x@y.z', ipHash: 'attacker' })).rejects.toMatchObject({ status: 429 });
    expect((await requestMagicLink(db, email, { ...base, email: 'hossam@example.com', ipHash: 'owner-mac' })).sent).toBe(true);
    // A deep link survives email sign-in; an off-site next is dropped.
    expect(await issueLoginLink(db, { baseUrl: 'http://localhost:3000', next: '/approvals' })).toMatch(/&next=%2Fapprovals$/);
    expect(await issueLoginLink(db, { baseUrl: 'http://localhost:3000', next: '/\t/evil.com' })).not.toMatch(/next=/);
    // The sign-in alert shows fixed messages only.
    expect(loginErrorMessage('bad_password')).toBe('Wrong password.');
    expect(loginErrorMessage('Your session expired. Reset at evil.example')).toBeNull();
    // CLI recovery: a one-time link without email.
    const cli = await issueLoginLink(db, { baseUrl: 'http://localhost:3000' });
    expect(await sessionActive(db, (await loginWithMagicToken(db, { token: new URL(cli).searchParams.get('token')!, secret: SECRET })).sid)).toBe(true);
    await db.close();
  });
});
