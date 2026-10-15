import { authorize, personaHostSlug, readCookie } from '@ios/auth/guard';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Request guard, in order:
 * 1. Host allowlist (blocks DNS rebinding): loopback names, plus the Vercel deployment hosts and IOS_ALLOWED_HOSTS
 *    (comma-separated) when deployed.
 * 2. State-changing /api calls must be same-origin (no cross-site form posts to approve a kill, clear a kill switch
 *    or sign in). Server-to-server routes are exempt: the cron tick (Bearer CRON_SECRET) and webhooks (signed).
 * 3. Persona sites (IOS-4, docs/IOS-34-CONTRACTS.md §5.5): on `<slug>.<IOS_STUDIO_DOMAIN>` every path is rewritten
 *    to /p/<slug>/… (public), except /l/*, /api/public/* and Next's own assets, so a persona host can never reach the
 *    dashboard. Locally the same pages live at /p/<slug>.
 * 4. Owner login: every page and API route needs the Owner's signed session cookie, except /login, /api/auth/*,
 *    /api/webhooks/*, /api/cron/*, /api/health and the public site routes (/p/*, /l/*, /api/public/*). Pages without
 *    a session go to /login; API calls get 401. Routes added by other streams are protected automatically.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function allowedHost(host: string | null): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  if (LOOPBACK.has(name) || name.endsWith('.localhost')) return true;
  const extra = [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL, ...(process.env.IOS_ALLOWED_HOSTS ?? '').split(',')]
    .map((h) => h?.trim().toLowerCase())
    .filter(Boolean);
  return extra.includes(name) || extra.includes(host.toLowerCase());
}

const SITE_PASSTHROUGH = ['/l/', '/api/public/', '/_next/', '/favicon.ico'];

export function proxy(req: NextRequest) {
  const host = req.headers.get('host');
  const siteSlug = personaHostSlug(host);
  if (!siteSlug && !allowedHost(host)) return new NextResponse('unknown host', { status: 421 });

  const { pathname, search } = req.nextUrl;
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (mutating && pathname.startsWith('/api/') && !pathname.startsWith('/api/cron/') && !pathname.startsWith('/api/webhooks/')) {
    const site = req.headers.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return new NextResponse('cross-site request refused', { status: 403 });
    const origin = req.headers.get('origin');
    if (origin) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        /* "null" or malformed */
      }
      if (originHost !== host) return new NextResponse('cross-origin request refused', { status: 403 });
    }
  }

  if (siteSlug) {
    const headers = new Headers(req.headers);
    headers.set('x-ios-site', siteSlug);
    if (SITE_PASSTHROUGH.some((p) => pathname.startsWith(p))) {
      headers.set('x-ios-path', pathname);
      return NextResponse.next({ request: { headers } });
    }
    const target = `/p/${siteSlug}${pathname === '/' ? '' : pathname}`;
    headers.set('x-ios-path', target);
    return NextResponse.rewrite(new URL(`${target}${search}`, req.url), { request: { headers } });
  }

  const decision = authorize({ pathname, search, cookie: readCookie(req.headers.get('cookie')), host });
  if (decision.action === 'deny') return NextResponse.json({ error: decision.message }, { status: decision.status });
  // The Location is built on the request's own (allowlisted) Host so the browser stays on the host it used
  // (NextURL rewrites 127.0.0.1 to localhost, and the session cookie belongs to one host). It must be absolute:
  // under `next start` the Node proxy adapter parses Location as a URL and throws on a relative one; for a
  // same-host target it relativizes it again on the way out.
  if (decision.action === 'redirect') {
    const location = new URL(decision.location, `${req.nextUrl.protocol}//${host}`).toString();
    return new NextResponse(null, { status: 303, headers: { Location: location } });
  }

  // Pages read the path so the layout can skip the session-row check on /login (app/layout.tsx).
  const headers = new Headers(req.headers);
  headers.set('x-ios-path', pathname);
  // Only the proxy marks a persona-site request (a client-sent header must never switch the layout to bare).
  headers.delete('x-ios-site');
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
