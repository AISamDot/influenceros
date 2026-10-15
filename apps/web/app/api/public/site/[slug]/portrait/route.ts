import { siteImage } from '@ios/commerce';
import { fileResponse, SLUG_RE } from '@/components/site-http';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

/** The persona's public portrait (profile picture) for its site. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG_RE.test(slug)) return new Response('not found', { status: 404 });
  const img = await siteImage(await getServices(), { slug, kind: 'portrait' });
  if (!img) return new Response('not found', { status: 404 });
  if ('redirect' in img) return new Response(null, { status: 302, headers: { Location: img.redirect } });
  return fileResponse(img.file, 'inline');
}
