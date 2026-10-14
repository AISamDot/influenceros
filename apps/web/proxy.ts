import { type NextRequest, NextResponse } from 'next/server';

/**
 * Request guard until real auth lands (IOS-5):
 * - Host allowlist (blocks DNS rebinding): loopback names, plus the Vercel deployment hosts and IOS_ALLOWED_HOSTS
 *   (comma-separated) when deployed.
 * - State-changing /api calls must be same-origin: a page the Owner visits can't post a cross-site form to
 *   clear a kill switch, approve a card or write in a chat. The cron tick is exempt (server-to-server, Bearer).
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

  const { pathname } = req.nextUrl;
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (mutating && pathname.startsWith('/api/') && pathname !== '/api/cron/tick') {
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
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
