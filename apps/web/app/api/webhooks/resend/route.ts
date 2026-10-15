import { handleEmailWebhook } from '@ios/commerce';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

/** Resend webhooks (delivered, opened, clicked, bounced, complained, contact unsubscribed), Svix-signed. */
export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 512_000) return new Response('too large', { status: 413 });
  const headers = { 'svix-id': req.headers.get('svix-id'), 'svix-timestamp': req.headers.get('svix-timestamp'), 'svix-signature': req.headers.get('svix-signature') };
  const res = await handleEmailWebhook(await getServices(), raw, headers);
  return Response.json({ outcome: res.outcome }, { status: res.status });
}
