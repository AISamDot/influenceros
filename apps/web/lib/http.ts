import { sameOriginPath } from '@ios/auth/guard';

/** Small helpers shared by the API routes. */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isFormPost = (req: Request) => {
  const ct = req.headers.get('content-type') ?? '';
  return ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data');
};
export const isJson = (req: Request) => (req.headers.get('content-type') ?? '').includes('application/json');

/** Same-origin path only (no open redirects; control characters, whitespace and backslashes refused). */
export function safePath(v: unknown, fallback: string): string {
  return sameOriginPath(v) ?? fallback;
}

/** 303 to a same-origin path. A relative Location keeps the browser on the host it used (127.0.0.1 vs localhost). */
export function redirectTo(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: path } });
}

/** Where a native form post returns to: the referring dashboard page (same host only), or `fallback`. */
export function backTo(req: Request, fallback: string, params: Record<string, string> = {}): Response {
  let target = new URL(fallback, 'http://x');
  const ref = req.headers.get('referer');
  if (ref) {
    try {
      const r = new URL(ref);
      if (r.host === req.headers.get('host')) target = r;
    } catch {
      /* ignore a malformed referer */
    }
  }
  target.searchParams.delete('error');
  target.searchParams.delete('ok');
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  return redirectTo(`${target.pathname}${target.search}`);
}
