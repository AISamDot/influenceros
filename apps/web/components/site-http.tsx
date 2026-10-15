import { siteBase } from '@ios/commerce';

/** Helpers for the public site endpoints (stream G): form fields, the page base on this host, redirects, cookies. */

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export async function formFields(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get('content-type') ?? '';
  if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
    const fd = await req.formData().catch(() => null);
    if (!fd) return {};
    return Object.fromEntries([...fd.entries()].map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 2000) : '']));
  }
  if (ct.includes('application/json')) {
    const v = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string').map(([k, x]) => [k, String(x).slice(0, 2000)]));
  }
  return {};
}

/** The path prefix of a persona's pages on the host that served this request ('' on the persona's own host). */
export function baseFor(req: Request, slug: string): string {
  return siteBase(slug, req.headers.get('x-ios-site') === slug);
}

/** The persona slug of this host, if it is a persona host (set only by the proxy). */
export const hostSlug = (req: Request): string | null => req.headers.get('x-ios-site');

/** 303 to a same-host path. */
export function seeOther(path: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: path.startsWith('/') && !path.startsWith('//') ? path : '/', ...headers } });
}

export const isHttps = (req: Request): boolean => new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';

/** Host-only, HttpOnly cookie (no Domain attribute: never shared across persona subdomains). */
export function cookie(req: Request, name: string, value: string | null, maxAgeS: number): string {
  const parts = [`${name}=${value ?? ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${value ? maxAgeS : 0}`];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

export function readCookieValue(req: Request, name: string): string | null {
  const raw = req.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=') || null;
  }
  return null;
}

export const clientIpOf = (req: Request): string | null =>
  req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || null;

/** ISO country from the edge (Vercel, Cloudflare); null when unknown (→ double opt-in). */
export const regionOf = (req: Request): string | null => req.headers.get('x-vercel-ip-country') || req.headers.get('cf-ipcountry') || null;

export function fileResponse(file: { data: Uint8Array; contentType: string; filename: string }, disposition: 'attachment' | 'inline' = 'attachment'): Response {
  return new Response(file.data as BodyInit, {
    headers: {
      'Content-Type': file.contentType,
      'Content-Disposition': `${disposition}; filename="${file.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
