import { requireOwner } from '@/lib/auth';
import { getServices } from '@/lib/services';
import { keyFrom, serveMedia } from '../serve';

export const dynamic = 'force-dynamic';

/** GET /api/media/<key>: any stored media file, Owner session only (renders, voice tracks, covers, product files). */
export async function GET(req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const { key } = await params;
  return serveMedia(req, (await getServices()).providers.storage, keyFrom(key), { public: false });
}
