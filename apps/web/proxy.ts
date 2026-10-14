import { authorize, readCookie } from '@ios/auth/guard';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Request guard, in order:
 * 1. Host allowlist (blocks DNS rebinding): loopback names, plus the Vercel deployment hosts and IOS_ALLOWED_HOSTS
 *    (comma-separated) when deployed.
 * 2. State-changing /api calls must be same-origin (no cross-site form posts to approve a kill, clear a kill switch
 *    or sign in). Server-to-server routes are exempt: the cron tick (Bearer CRON_SECRET) and webhooks (signed).
 * 3. Owner login: every page and API route needs the Owner's signed session cookie, except /login, /api/auth/*,
 *    /api/webhooks/*, /api/cron/* and /api/health. Pages without a session go to /login; API calls get 401.
 *    Routes added by other streams are protected automatically.
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

export function proxy(req: NextRequest) {
  const host = req.headers.get('host');
  if (!allowedHost(host)) return new NextResponse('unknown host', { status: 421 });

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

  const decision = authorize({ pathname, search, cookie: readCookie(req.headers.get('cookie')), host });
  if (decision.action === 'deny') return NextResponse.json({ error: decision.message }, { status: decision.status });
  // A relative Location keeps the browser on the host it used (NextURL rewrites 127.0.0.1 to localhost, and the
  // session cookie belongs to one host).
  if (decision.action === 'redirect') return new NextResponse(null, { status: 303, headers: { Location: decision.location } });

  // Pages read the path so the layout can skip the session-row check on /login (app/layout.tsx).
  const headers = new Headers(req.headers);
  headers.set('x-ios-path', pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
