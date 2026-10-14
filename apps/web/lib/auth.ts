import { authSecret, isDeployed, readCookie, SESSION_COOKIE, sessionActive, sessionCookie, verifySession } from '@ios/auth';
import { getDb } from '@ios/db';
import { cookies } from 'next/headers';

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

/** For stream A's API routes: null when the Owner's session is valid, else a 401 response. */
export async function requireOwner(req: Request): Promise<Response | null> {
  if (process.env.IOS_AUTH === 'off' && !isDeployed()) return null;
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
  const configured = process.env.IOS_PUBLIC_URL?.trim();
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
