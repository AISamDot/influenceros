import { RESERVED_SUBDOMAINS as SHARED_RESERVED } from '@ios/agents';
import { signSession } from '@ios/auth';
import { RESERVED_SUBDOMAINS } from '@ios/auth/guard';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { proxy } from '../proxy';

const SECRET = 'proxy-test-secret-0123456789abcdef0123456789';
const BASE = 'http://127.0.0.1:3100';

const req = (path: string, init: { method?: string; cookie?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: { host: '127.0.0.1:3100', ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers ?? {}) },
  });

describe('proxy: every route needs the Owner session', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_SECRET', SECRET);
    vi.stubEnv('IOS_AUTH', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('refuses unauthenticated requests: pages redirect to /login, API calls get 401', async () => {
    const page = proxy(req('/approvals'));
    expect(page.status).toBe(303);
    expect(page.headers.get('location')).toBe(`${BASE}/login?next=%2Fapprovals`);
    for (const path of ['/api/approvals', '/api/chat/00000000-0000-4000-8000-000000000000/messages', '/api/profit/report', '/api/knowledge/search']) {
      const r = proxy(req(path));
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'sign in first' });
    }
    const post = proxy(req('/api/approvals/x', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } }));
    expect(post.status).toBe(401);
  });

  it('lets the Owner through with a valid session, and keeps the public routes public', () => {
    const token = signSession({ sid: '11111111-1111-4111-8111-111111111111', exp: Date.now() + 60_000 }, SECRET);
    const ok = proxy(req('/approvals', { cookie: `ios_session=${token}` }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-middleware-request-x-ios-path')).toBe('/approvals');
    for (const path of ['/login', '/login/verify?token=x', '/api/health', '/api/cron/tick', '/api/webhooks/lemonsqueezy', '/api/auth/password']) {
      expect(proxy(req(path)).status).toBe(200);
    }
  });

  it('still refuses unknown hosts and cross-site writes, signed in or not', () => {
    const token = signSession({ sid: '11111111-1111-4111-8111-111111111111', exp: Date.now() + 60_000 }, SECRET);
    expect(proxy(req('/', { headers: { host: 'evil.example.com' } })).status).toBe(421);
    const cross = proxy(req('/api/approvals/x', { method: 'POST', cookie: `ios_session=${token}`, headers: { 'sec-fetch-site': 'cross-site' } }));
    expect(cross.status).toBe(403);
    const login = proxy(req('/api/auth/password', { method: 'POST', headers: { origin: 'https://evil.example.com' } }));
    expect(login.status).toBe(403);
  });
});

describe('proxy: public persona sites (IOS-4, docs/IOS-34-CONTRACTS.md §5.5)', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_SECRET', SECRET);
    vi.stubEnv('IOS_AUTH', '');
    vi.stubEnv('IOS_STUDIO_DOMAIN', 'studio.example');
  });
  afterEach(() => vi.unstubAllEnvs());

  const site = (path: string, init: { method?: string; host?: string; headers?: Record<string, string> } = {}) =>
    new NextRequest(`https://${init.host ?? 'rosa.studio.example'}${path}`, {
      method: init.method ?? 'GET',
      headers: { host: init.host ?? 'rosa.studio.example', ...(init.headers ?? {}) },
    });

  it('keeps /p/*, /l/* and /api/public/* public on the dashboard host, and the rest protected', () => {
    for (const path of ['/p/rosa', '/p/rosa/free', '/l/abc123', '/api/public/optin']) expect(proxy(req(path)).status).toBe(200);
    expect(proxy(req('/settings/accounts')).status).toBe(303);
    expect(proxy(req('/api/media/x.mp4')).status).toBe(401);
  });

  it('rewrites a persona host to its /p/<slug> pages and never reaches the dashboard', () => {
    const home = proxy(site('/'));
    expect(home.headers.get('x-middleware-rewrite')).toBe('https://rosa.studio.example/p/rosa');
    expect(home.headers.get('x-middleware-request-x-ios-site')).toBe('rosa');
    expect(proxy(site('/free?src=tt')).headers.get('x-middleware-rewrite')).toBe('https://rosa.studio.example/p/rosa/free?src=tt');
    // Dashboard paths stay inside the persona's site (404 there), never the Owner's pages or APIs.
    expect(proxy(site('/approvals')).headers.get('x-middleware-rewrite')).toBe('https://rosa.studio.example/p/rosa/approvals');
    expect(proxy(site('/api/approvals')).headers.get('x-middleware-rewrite')).toBe('https://rosa.studio.example/p/rosa/api/approvals');
    expect(proxy(site('/p/dot')).headers.get('x-middleware-rewrite')).toBe('https://rosa.studio.example/p/rosa/p/dot');
    // Short links and the site's own endpoints pass through.
    expect(proxy(site('/l/abc123')).headers.get('x-middleware-rewrite')).toBeNull();
    expect(proxy(site('/api/public/optin', { method: 'POST', headers: { origin: 'https://rosa.studio.example' } })).status).toBe(200);
    expect(proxy(site('/api/public/optin', { method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('refuses reserved and nested subdomains, and strips a client-sent site header', () => {
    expect(proxy(site('/', { host: 'www.studio.example' })).status).toBe(421);
    expect(proxy(site('/', { host: 'a.rosa.studio.example' })).status).toBe(421);
    const spoof = proxy(req('/approvals', { headers: { 'x-ios-site': 'rosa' } }));
    expect(spoof.status).toBe(303);
    const token = signSession({ sid: '11111111-1111-4111-8111-111111111111', exp: Date.now() + 60_000 }, SECRET);
    const ok = proxy(req('/approvals', { cookie: `ios_session=${token}`, headers: { 'x-ios-site': 'rosa' } }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-middleware-request-x-ios-site')).toBeNull();
  });

  it('keeps the reserved-subdomain lists of the guard and the shared contracts in sync', () => {
    expect([...RESERVED_SUBDOMAINS].sort()).toEqual([...SHARED_RESERVED].sort());
  });
});
