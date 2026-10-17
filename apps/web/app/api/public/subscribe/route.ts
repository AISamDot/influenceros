import { PublicInputError, subscribe } from '@troupe/commerce';
import { baseFor, clientIpOf, formFields, regionOf, seeOther, SLUG_RE } from '@/components/site-http';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

/**
 * Lead-magnet sign-up (form post from /free). Same-origin is enforced by the proxy; rate limited, honeypot, and the
 * same response whether or not the address was already on the list.
 */
export async function POST(req: Request) {
  const f = await formFields(req);
  const slug = f.slug ?? '';
  if (!SLUG_RE.test(slug)) return new Response('not found', { status: 404 });
  const base = baseFor(req, slug);
  if (f.consent !== 'yes' && !f.website) return seeOther(`${base}/free?error=consent`);
  try {
    const services = await getServices();
    await subscribe(services, {
      slug,
      email: f.email ?? '',
      firstName: f.first_name,
      region: regionOf(req),
      ip: clientIpOf(req),
      src: f.src,
      honeypot: f.website,
      source: 'site',
    });
  } catch (err) {
    if (err instanceof PublicInputError) return err.message === 'unknown site' ? new Response('not found', { status: 404 }) : seeOther(`${base}/free?error=email`);
    throw err;
  }
  return seeOther(`${base}/free?sent=1`);
}
