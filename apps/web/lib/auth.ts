import { troupeEnv } from '@troupe/env';
import { authSecret, isDeployed, readCookie, SESSION_COOKIE, sessionActive, sessionCookie, verifySession } from '@troupe/auth';
import { getDb } from '@troupe/db';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * Server-side session checks. The proxy already verified the cookie's signature and expiry on every protected
 * request; these also check the session row, so a signed-out or revoked session stops working at once.
 */
export async function currentSession(): Promise<{ sid: string } | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const claims = verifySession(token, authSecret());
  if (!claims) return null;
  return (await sessionActive(await getDb(), claims.sid)) ? { sid: claims.sid } : null;
}

/** Local development with TROUPE_AUTH=off: never honoured when deployed (Vercel or TROUPE_DEPLOYED=1). */
export const authOff = (): boolean => troupeEnv('AUTH') === 'off' && !isDeployed();

/** For every non-public API route: null when the Owner's session is valid, else a 401 response. */
export async function requireOwner(req: Request): Promise<Response | null> {
  if (authOff()) return null;
  const claims = verifySession(readCookie(req.headers.get('cookie')), authSecret());
  if (claims && (await sessionActive(await getDb(), claims.sid))) return null;
  return Response.json({ error: 'sign in first' }, { status: 401 });
}

/** https (directly or behind Vercel's proxy) → Secure cookies. */
export function isHttps(req: Request): boolean {
  return new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
}

/** The origin links in emails point at (the Host header is allowlisted by the proxy). */
export function publicOrigin(req: Request): string {
  const configured = troupeEnv('PUBLIC_URL')?.trim();
  if (configured) return configured.replace(/\/$/, '');
  const host = req.headers.get('host') ?? new URL(req.url).host;
  return `${isHttps(req) ? 'https' : 'http'}://${host}`;
}

export function clientIp(req: Request): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || null;
}

/** 303 to `location`, setting (or clearing) the session cookie. */
export function redirectWithSession(location: string, token: string | null, req: Request): Response {
  return new Response(null, { status: 303, headers: { Location: location, 'Set-Cookie': sessionCookie(token, { secure: isHttps(req) }) } });
}

/**
 * For every page except /login: checks the session row (sign-out and revocation), not only the cookie signature the
 * proxy checks. The root layout is not re-rendered on client-side navigation, so each page calls this itself.
 */
export async function requireOwnerPage(): Promise<void> {
  if (authOff()) return;
  if (await currentSession().catch(() => null)) return;
  const path = (await headers()).get('x-troupe-path') ?? '/';
  redirect(path && path !== '/' && path.startsWith('/') && !path.startsWith('//') ? `/login?next=${encodeURIComponent(path)}` : '/login');
}
