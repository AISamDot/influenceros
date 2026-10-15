import { confirmSubscription } from '@ios/commerce';
import { baseFor, formFields, seeOther, SLUG_RE } from '@/components/site-http';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

/** Double opt-in confirmation (button on /confirm). Idempotent. */
export async function POST(req: Request) {
  const f = await formFields(req);
  const slug = SLUG_RE.test(f.slug ?? '') ? f.slug! : null;
  const res = await confirmSubscription(await getServices(), f.t ?? '');
  const target = res.slug ?? slug;
  if (!target) return new Response('not found', { status: 404 });
  return seeOther(`${baseFor(req, target)}/confirm?${res.ok ? 'done=1' : 'error=1'}`);
}
