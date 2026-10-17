import { MEMBER_COOKIE, memberFile } from '@troupe/commerce';
import { fileResponse, readCookieValue, SLUG_RE } from '@/components/site-http';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

/** A monthly drop file, for a signed-in member with access. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') ?? '';
  const drop = url.searchParams.get('drop') ?? '';
  if (!SLUG_RE.test(slug)) return new Response('not found', { status: 404 });
  const file = await memberFile(await getServices(), { slug, session: readCookieValue(req, MEMBER_COOKIE), dropId: drop });
  if (!file) return new Response('Sign in to the members area to download this.', { status: 403 });
  return fileResponse(file);
}
