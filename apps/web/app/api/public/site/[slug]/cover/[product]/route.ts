import { siteImage } from '@ios/commerce';
import { fileResponse, SLUG_RE } from '@/components/site-http';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

/** A live product's cover image for the persona's site. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string; product: string }> }) {
  const { slug, product } = await params;
  if (!SLUG_RE.test(slug) || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(product)) return new Response('not found', { status: 404 });
  const img = await siteImage(await getServices(), { slug, kind: 'cover', productSlug: product });
  if (!img) return new Response('not found', { status: 404 });
  if ('redirect' in img) return new Response(null, { status: 302, headers: { Location: img.redirect } });
  return fileResponse(img.file, 'inline');
}
