import { isValidMediaKey } from '@ios/providers';
// Relative imports so the route can be exercised directly in tests.
import { requireOwner } from '../../../../../lib/auth';
import { getServices } from '../../../../../lib/services';

export const dynamic = 'force-dynamic';

const PRODUCT_KEY = /^(?:products\/[0-9a-f-]{36}\/|public\/[a-z0-9-]+\/products\/)/;

/**
 * Owner-only download of a built product file (PDFs, covers, template exports) from media storage. Only product
 * keys are served here; everything else is stream E's /api/media.
 */
export async function GET(req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const key = (await params).key.map((k) => decodeURIComponent(k)).join('/');
  if (!isValidMediaKey(key) || !PRODUCT_KEY.test(key)) return Response.json({ error: 'not found' }, { status: 404 });
  const obj = await (await getServices()).providers.storage.get(key);
  if (!obj) return Response.json({ error: 'not found' }, { status: 404 });
  const name = key.split('/').pop()!;
  return new Response(new Uint8Array(obj.data), {
    headers: {
      'Content-Type': obj.contentType,
      'Content-Disposition': `inline; filename="${name.replace(/[^\w.-]/g, '_')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(obj.contentType.includes('svg') ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" } : {}),
    },
  });
}
