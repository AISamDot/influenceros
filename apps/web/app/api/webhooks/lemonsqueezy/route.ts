import { handleStoreWebhook } from '@ios/commerce';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

/** Lemon Squeezy webhooks (orders, refunds, subscriptions), signed with X-Signature. Public route; the signature is the auth. */
export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 512_000) return new Response('too large', { status: 413 });
  const res = await handleStoreWebhook(await getServices(), raw, req.headers.get('x-signature'));
  return Response.json({ outcome: res.outcome }, { status: res.status });
}
