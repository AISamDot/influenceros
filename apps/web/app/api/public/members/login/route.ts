import { requestMemberLink } from '@troupe/commerce';
import { baseFor, clientIpOf, formFields, seeOther, SLUG_RE } from '@/components/site-http';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

/** Sends a members sign-in link. Same response whether or not the email has a membership (no enumeration). */
export async function POST(req: Request) {
  const f = await formFields(req);
  const slug = f.slug ?? '';
  if (!SLUG_RE.test(slug)) return new Response('not found', { status: 404 });
  await requestMemberLink(await getServices(), { slug, email: f.email ?? '', ip: clientIpOf(req) });
  return seeOther(`${baseFor(req, slug)}/members?sent=1`);
}
