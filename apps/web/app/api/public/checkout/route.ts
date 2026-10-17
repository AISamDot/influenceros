import { checkoutUrlFor } from '@troupe/commerce';
import { baseFor, readCookieValue, seeOther, SLUG_RE } from '@/components/site-http';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

const PRODUCT_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

/**
 * The buy button: redirects to the Lemon Squeezy checkout with the attribution (post, short link, coupon) from
 * `?src=` or the `ios_src` cookie set by the short link.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') ?? '';
  const product = url.searchParams.get('product') ?? '';
  if (!SLUG_RE.test(slug) || !PRODUCT_RE.test(product)) return new Response('not found', { status: 404 });
  const src = url.searchParams.get('src') ?? readCookieValue(req, 'ios_src');
  const target = await checkoutUrlFor(await getServices(), { slug, productSlug: product, src });
  if (!target) return seeOther(`${baseFor(req, slug)}/shop/${product}?unavailable=1`);
  return new Response(null, { status: 303, headers: { Location: target, 'Cache-Control': 'no-store' } });
}
