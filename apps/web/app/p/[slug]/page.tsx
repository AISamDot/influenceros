import { ProductCard, SiteFooter, SiteHeader, SitePage, siteFor, srcParam } from '@/components/site-shell';

export const dynamic = 'force-dynamic';

/**
 * Public persona site, link-in-bio page (IOS-4 stream G, docs/IOS-34-CONTRACTS.md §5.5). Served at /p/<slug> locally
 * and at https://<slug>.<IOS_STUDIO_DOMAIN>/ in production (the proxy rewrites the host). It is every account's
 * profile link: the free guide first, then live products and the membership. Never shows studio data.
 */
export default async function PersonaSite({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const src = srcParam((await searchParams).src);
  const { site, base } = await siteFor(slug);
  const q = src ? `?src=${src}` : '';
  return (
    <SitePage>
      <SiteHeader site={site} />
      <nav className="site-links" aria-label="Links">
        <a className="site-btn site-btn-primary" href={`${base}/free${q}`}>
          {site.leadMagnet ? `Free: ${site.leadMagnet.name}` : 'Get my free guide'}
        </a>
        {site.products.map((p) => (
          <a key={p.id} className="site-btn" href={`${base}/shop/${p.slug}${q}`}>
            {p.name}
          </a>
        ))}
        {site.membership ? (
          <a className="site-btn" href={`${base}/shop/${site.membership.slug}${q}`}>
            Join the {site.membership.name}
          </a>
        ) : null}
      </nav>
      {site.products.length ? (
        <section className="site-section" aria-labelledby="shop">
          <p id="shop" className="site-eyebrow">
            Resources
          </p>
          {site.products.slice(0, 3).map((p) => (
            <ProductCard key={p.id} product={p} base={base} slug={slug} src={src} />
          ))}
        </section>
      ) : null}
      <SiteFooter site={site} base={base} />
    </SitePage>
  );
}
