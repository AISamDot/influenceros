import { isDeployed, studioDomain, troupeEnv } from '@troupe/env';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The request guard (no database, no heavy imports: apps/web/proxy.ts runs it on every request).
 * The session cookie carries `{sid, exp}` signed with HMAC-SHA256 over AUTH_SECRET; the proxy checks the signature
 * and expiry, and the server also checks the session row (sign-out, `pnpm owner sessions revoke`) on pages and
 * stream A's API routes.
 */
export const SESSION_COOKIE = 'ios_session';
export const SESSION_TTL_MS = 14 * 24 * 3_600_000;

export interface SessionClaims {
  sid: string;
  /** Expiry, ms since epoch. */
  exp: number;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const mac = (payload: string, secret: string) => createHmac('sha256', secret).update(payload).digest();

export function signSession(claims: SessionClaims, secret: string): string {
  const payload = b64url(JSON.stringify({ v: 1, sid: claims.sid, exp: claims.exp }));
  return `${payload}.${b64url(mac(payload, secret))}`;
}

export function verifySession(token: string | null | undefined, secret: string | null, now: number = Date.now()): SessionClaims | null {
  if (!token || !secret || token.length > 512) return null;
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const expected = mac(payload, secret);
  let got: Buffer;
  try {
    got = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { v?: number; sid?: unknown; exp?: unknown };
    if (c.v !== 1 || typeof c.sid !== 'string' || typeof c.exp !== 'number' || c.exp <= now) return null;
    return { sid: c.sid, exp: c.exp };
  } catch {
    return null;
  }
}

/**
 * Public persona-site routes (IOS-4 stream G, docs/IOS-34-CONTRACTS.md §5.5): site pages under /p/<slug>/…, short
 * links /l/<code>, and the site's own endpoints under /api/public/… (opt-in, unsubscribe, member magic links, public
 * media). They never carry the Owner session and never reach the dashboard.
 */
export const PUBLIC_SITE_PREFIXES = ['/p/', '/l/', '/api/public/'] as const;

/** Routes anyone may reach. Everything else, including new routes from other streams, needs the Owner session. */
export function isPublicPath(pathname: string): boolean {
  if (pathname === '/login' || pathname.startsWith('/login/')) return true;
  if (pathname === '/api/health') return true;
  if (PUBLIC_SITE_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  return ['/api/auth/', '/api/webhooks/', '/api/cron/'].some((p) => pathname.startsWith(p));
}

/** Subdomains of the studio domain that are never persona sites (keep in sync with @troupe/agents RESERVED_SUBDOMAINS). */
export const RESERVED_SUBDOMAINS: readonly string[] = ['www', 'app', 'api', 'admin', 'studio', 'mail', 'email', 'l', 'go', 'dashboard'];
const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/**
 * The persona slug when `host` is `<slug>.<TROUPE_STUDIO_DOMAIN>` (a persona site), else null. Only one label deep;
 * reserved names (www, app, api, …) are never personas.
 */
export function personaHostSlug(host: string | null | undefined, env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const domain = studioDomain(env);
  if (!domain || !host) return null;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  if (!name.endsWith(`.${domain}`)) return null;
  const sub = name.slice(0, -(domain.length + 1));
  if (!SUBDOMAIN_RE.test(sub) || RESERVED_SUBDOMAINS.includes(sub)) return null;
  return sub;
}

export { isDeployed };

/** Walks up to the folder holding pnpm-workspace.yaml (no @troupe/db import here: the proxy stays light). */
function repoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(/*turbopackIgnore: true*/ join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

let cachedLocal: string | null = null;

/**
 * The signing secret. AUTH_SECRET (32+ characters) wins. Deployed without it → null (every protected route fails
 * closed). On the Mac a random secret is created once in .data/auth-secret (git-ignored, mode 600).
 */
export function authSecret(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const s = env.AUTH_SECRET?.trim();
  if (s && s.length >= 32) return s;
  if (isDeployed(env)) return null;
  if (cachedLocal) return cachedLocal;
  const file = troupeEnv('AUTH_SECRET_FILE', env) ?? join(repoRoot(), '.data', 'auth-secret');
  try {
    // Local development only (deployed servers return above): ignore for output tracing.
    if (existsSync(/*turbopackIgnore: true*/ file)) {
      const v = readFileSync(/*turbopackIgnore: true*/ file, 'utf8').trim();
      if (v.length >= 32) return (cachedLocal = v);
    }
    mkdirSync(/*turbopackIgnore: true*/ dirname(file), { recursive: true });
    const v = randomBytes(32).toString('hex');
    writeFileSync(/*turbopackIgnore: true*/ file, `${v}\n`, { mode: 0o600 });
    chmodSync(/*turbopackIgnore: true*/ file, 0o600);
    return (cachedLocal = v);
  } catch {
    return null;
  }
}

export type AuthDecision =
  | { action: 'allow'; session: SessionClaims | null }
  | { action: 'redirect'; location: string }
  | { action: 'deny'; status: 401 | 503; message: string };

/**
 * The proxy's decision for one request. Public paths pass; with a valid session everything passes; otherwise API
 * calls get 401 and pages go to /login?next=… . Without a signing secret (deployed, AUTH_SECRET unset) protected
 * routes fail closed with 503.
 * `TROUPE_AUTH=off` turns the check off only on a loopback host and never when deployed (local development).
 */
export function authorize(
  req: { pathname: string; search?: string; cookie: string | null | undefined; host: string | null },
  opts: { env?: Readonly<Record<string, string | undefined>>; now?: number; secret?: string | null } = {},
): AuthDecision {
  const env = opts.env ?? process.env;
  if (isPublicPath(req.pathname)) return { action: 'allow', session: null };
  const hostname = (req.host ?? '').replace(/:\d+$/, '').toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');
  if (troupeEnv('AUTH', env) === 'off' && loopback && !isDeployed(env)) return { action: 'allow', session: null };
  const secret = opts.secret !== undefined ? opts.secret : authSecret(env);
  const isApi = req.pathname.startsWith('/api/');
  if (!secret) {
    return isApi ? { action: 'deny', status: 503, message: 'sign-in is not configured (AUTH_SECRET)' } : { action: 'redirect', location: '/login?error=config' };
  }
  const session = verifySession(req.cookie, secret, opts.now);
  if (session) return { action: 'allow', session };
  if (isApi) return { action: 'deny', status: 401, message: 'sign in first' };
  const next = `${req.pathname}${req.search ?? ''}`;
  return { action: 'redirect', location: next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}` };
}

/**
 * A same-origin path, or null. Browsers strip tab/newline and treat `\` as `/` when parsing a Location, so any
 * control character, whitespace or backslash is refused; the value is then resolved against a dummy origin and
 * must stay on it. Returns the normalised path, search and hash.
 */
export function sameOriginPath(v: unknown): string | null {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || /[\x00-\x20\x7f\\]/.test(v)) return null;
  try {
    const u = new URL(v, 'http://x');
    return u.origin === 'http://x' ? `${u.pathname}${u.search}${u.hash}` : null;
  } catch {
    return null;
  }
}

/**
 * The sign-in page shows only these fixed messages, picked by code (`/login?error=<code>`): free text in the URL
 * could put anything into the official sign-in alert.
 */
export const LOGIN_ERRORS = {
  config: 'Sign-in is not configured on this server: set AUTH_SECRET (32+ random characters).',
  bad_password: 'Wrong password.',
  throttled: 'Too many attempts: try again in 15 minutes.',
  link_throttled: 'Too many sign-in links requested: try again in 15 minutes.',
  link_invalid: 'This sign-in link is invalid, used or expired: request a new one.',
  signed_out: 'Your session ended. Sign in again.',
} as const;
export type LoginErrorCode = keyof typeof LOGIN_ERRORS;
export const loginErrorMessage = (code: unknown): string | null =>
  typeof code === 'string' && Object.prototype.hasOwnProperty.call(LOGIN_ERRORS, code) ? LOGIN_ERRORS[code as LoginErrorCode] : null;

/** Same-origin path only, for ?next= (no open redirects). */
export function safeNext(v: unknown, fallback = '/'): string {
  const p = sameOriginPath(v);
  return p && !p.startsWith('/login') ? p : fallback;
}

/** The Set-Cookie value for a new session (or a clearing one when `token` is null). */
export function sessionCookie(token: string | null, opts: { secure: boolean; maxAgeMs?: number }): string {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', ...(opts.secure ? ['Secure'] : [])];
  if (token === null) return `${SESSION_COOKIE}=; ${attrs.join('; ')}; Max-Age=0`;
  return `${SESSION_COOKIE}=${token}; ${attrs.join('; ')}; Max-Age=${Math.floor((opts.maxAgeMs ?? SESSION_TTL_MS) / 1000)}`;
}

/** Reads one cookie from a Cookie header. */
export function readCookie(header: string | null | undefined, name: string = SESSION_COOKIE): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}
