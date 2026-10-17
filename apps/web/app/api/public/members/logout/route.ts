import { endMemberSession, MEMBER_COOKIE } from '@troupe/commerce';
import { getDb } from '@troupe/db';
import { baseFor, cookie, formFields, readCookieValue, seeOther, SLUG_RE } from '@/components/site-http';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const f = await formFields(req);
  const slug = f.slug ?? '';
  await endMemberSession(await getDb(), readCookieValue(req, MEMBER_COOKIE));
  const path = SLUG_RE.test(slug) ? `${baseFor(req, slug)}/members` : '/';
  return seeOther(path, { 'Set-Cookie': cookie(req, MEMBER_COOKIE, null, 0) });
}
