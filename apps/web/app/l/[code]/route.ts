import { resolveShortLink } from '@ios/commerce';
import { cookie, hostSlug } from '@/components/site-http';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

/**
 * Short links (`/l/<code>`, per post): counts the click and lands on the persona's site with `?src=<code>`; the
 * `ios_src` cookie carries the attribution to the checkout for 30 days. On a persona host only its own codes resolve.
 */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const host = hostSlug(req);
  const hit = await resolveShortLink(await getServices(), { code: code.toLowerCase(), hostSlug: host });
  if (!hit) return new Response('This link has expired.', { status: 404 });
  const location = host ? hit.path : `/p/${hit.slug}${hit.path}`;
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store', 'Set-Cookie': cookie(req, 'ios_src', hit.code, 30 * 86_400), 'Referrer-Policy': 'no-referrer' },
  });
}
