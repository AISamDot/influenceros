import { MEMBER_COOKIE, MEMBER_SESSION_DAYS, verifyMemberLink } from '@troupe/commerce';
import { baseFor, cookie, formFields, seeOther, SLUG_RE } from '@/components/site-http';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

/** Exchanges the one-time sign-in link for the member session cookie (host-only, HttpOnly). */
export async function POST(req: Request) {
  const f = await formFields(req);
  const slug = f.slug ?? '';
  if (!SLUG_RE.test(slug)) return new Response('not found', { status: 404 });
  const base = baseFor(req, slug);
  const res = await verifyMemberLink(await getServices(), { slug, token: f.t ?? '' });
  if (!res) return seeOther(`${base}/members?error=1`);
  return seeOther(`${base}/members`, { 'Set-Cookie': cookie(req, MEMBER_COOKIE, res.session, MEMBER_SESSION_DAYS * 86_400) });
}
