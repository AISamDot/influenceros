import { handleStoreWebhook } from '@ios/commerce';
import { getServices } from '@/lib/services';
import { fakeWebhooksRefused } from '@/lib/webhook-guard';

export const dynamic = 'force-dynamic';

/** Lemon Squeezy webhooks (orders, refunds, subscriptions), signed with X-Signature. Public route; the signature is the auth. */
export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 512_000) return new Response('too large', { status: 413 });
  const services = await getServices();
  // No real signing secret (API-less setup keeps the fake store, whose secret is public): webhooks are off here.
  if (fakeWebhooksRefused(services.providers.store.name, req)) return Response.json({ outcome: 'not_configured' }, { status: 404 });
  const res = await handleStoreWebhook(services, raw, req.headers.get('x-signature'));
  return Response.json({ outcome: res.outcome }, { status: res.status });
}
