import { ingestEvents } from '@ios/distribution';
import { getServices } from '@/lib/services';
import { fakeWebhooksRefused } from '@/lib/webhook-guard';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 1_000_000;

/**
 * Zernio webhooks (public: /api/webhooks/*): comments, DMs and post status. The body is verified with the HMAC
 * signature (zernio.webhook_secret) before anything is read; without the secret the live adapter refuses every
 * webhook and the community worker polls instead. Comment and DM text is stored as untrusted data and handled by the
 * community worker (fenced, Gate-checked); post status is re-verified with Zernio rather than trusted.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > MAX_BYTES) return Response.json({ error: 'too large' }, { status: 413 });
  const services = await getServices();
  const publisher = services.providers.publish;
  // The fake publisher's secret is public: never accept fake-signed webhooks on a deployed or reachable server.
  if (fakeWebhooksRefused(publisher.name, req)) return Response.json({ error: 'webhooks are not configured' }, { status: 404 });
  const signature = req.headers.get('x-zernio-signature') ?? req.headers.get('x-webhook-signature') ?? req.headers.get('x-signature') ?? '';
  if (!publisher.verifyWebhook(raw, signature)) return Response.json({ error: 'bad signature' }, { status: 401 });
  let events;
  try {
    events = publisher.parseWebhook(raw);
  } catch {
    return Response.json({ error: 'malformed body' }, { status: 400 });
  }
  const result = await ingestEvents(services, events);
  return Response.json({ ok: true, ...result });
}
