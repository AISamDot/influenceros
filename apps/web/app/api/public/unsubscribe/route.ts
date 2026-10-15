import { unsubscribe } from '@ios/commerce';
import { baseFor, formFields, seeOther, SLUG_RE } from '@/components/site-http';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

/**
 * Unsubscribe. Two callers: the button on /unsubscribe (form: slug, t) and mail clients' RFC 8058 one-click POST
 * (`?t=` in the List-Unsubscribe URL, body `List-Unsubscribe=One-Click`). Idempotent.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const f = await formFields(req);
  const token = url.searchParams.get('t') ?? f.t ?? '';
  const oneClick = f['List-Unsubscribe'] === 'One-Click' || (url.searchParams.has('t') && !f.slug);
  const res = await unsubscribe(await getServices(), token, oneClick ? 'one_click' : 'link');
  if (oneClick) return new Response(res.ok ? 'unsubscribed' : 'unknown link', { status: res.ok ? 200 : 404 });
  const slug = res.slug ?? (SLUG_RE.test(f.slug ?? '') ? f.slug! : null);
  if (!slug) return new Response('not found', { status: 404 });
  return seeOther(`${baseFor(req, slug)}/unsubscribe?${res.ok ? 'done=1' : `t=invalid`}`);
}
