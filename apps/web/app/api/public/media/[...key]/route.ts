import { isPublicMediaKey } from '@troupe/providers';
import { keyFrom, serveMedia } from '@/app/api/media/serve';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

/** GET /api/public/media/<key>: only `public/…` keys (persona sites, lead-magnet covers), no session needed. */
export async function GET(req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const { key: parts } = await params;
  const key = keyFrom(parts);
  if (!isPublicMediaKey(key)) return new Response('not found', { status: 404 });
  return serveMedia(req, (await getServices()).providers.storage, key, { public: true });
}
