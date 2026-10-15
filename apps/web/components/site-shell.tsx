import { loadSite, siteBase, type SiteData, type SiteProduct } from '@ios/commerce';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { studioContext } from '@/lib/server';

/**
 * Shared pieces of the public persona sites (stream G). Public pages never read the Owner session or show studio
 * data: they get the site read model from @ios/commerce, which only returns public fields.
 */

/** The site for a slug (404 for unknown or hidden personas) and the path prefix of its pages on this host. */
export async function siteFor(slug: string): Promise<{ site: SiteData; base: string }> {
  const h = await headers();
  const { db, studio } = await studioContext();
  const site = await loadSite(db, slug, studio.id);
  if (!site) notFound();
  return { site, base: siteBase(slug, h.get('x-ios-site') === slug) };
}

export function money(cents: number, currency = 'USD'): string {
  if (!cents) return 'Free';
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: cents % 100 ? 2 : 0 });
}

export function SitePage({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <main className={`site-wrap${wide ? ' site-wide' : ''}`}>{children}</main>;
}

export function SiteHeader({ site, small }: { site: SiteData; small?: boolean }) {
  const p = site.persona;
  return (
    <header className="site-head">
      {small ? null : p.hasPortrait ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="site-portrait" src={`/api/public/site/${p.slug}/portrait`} alt={p.name} width={96} height={96} />
      ) : (
        <div className="site-monogram" aria-hidden="true">
          {p.name.slice(0, 1)}
        </div>
      )}
      <h1 className="site-name" style={small ? { fontSize: 28 } : undefined}>
        {p.name}
      </h1>
      {small ? null : <p className="site-niche">{p.niche}</p>}
    </header>
  );
}

export function SiteFooter({ site, base }: { site: SiteData; base: string }) {
  return (
    <footer className="site-foot">
      <a href={`${base}/`}>{site.persona.name}</a> · <a href={`${base}/privacy`}>Privacy</a> · <a href={`${base}/members`}>Members</a>
    </footer>
  );
}

export function ProductCard({ product, base, slug, src, cta }: { product: SiteProduct; base: string; slug: string; src?: string | null; cta?: string }) {
  return (
    <article className="site-card">
      {product.hasCover ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="site-cover" src={`/api/public/site/${slug}/cover/${product.slug}`} alt={`${product.name} cover`} />
      ) : null}
      <p className="site-eyebrow">{product.rung === 'membership' ? 'Monthly membership' : 'Digital download'}</p>
      <h2 className="site-h2">{product.name}</h2>
      {product.summary ? <p className="site-lead">{product.summary}</p> : null}
      <p className="site-price">
        {money(product.priceCents, product.currency)}
        {product.rung === 'membership' ? ' / month' : ''}
      </p>
      <div className="site-links" style={{ marginTop: 14 }}>
        <a className="site-btn site-btn-primary" href={`/api/public/checkout?slug=${slug}&product=${product.slug}${src ? `&src=${src}` : ''}`}>
          {cta ?? (product.rung === 'membership' ? 'Join' : 'Get it')}
        </a>
        <a className="site-btn" href={`${base}/shop/${product.slug}${src ? `?src=${src}` : ''}`}>
          What’s inside
        </a>
      </div>
    </article>
  );
}

/** A short-link code from the query string (only well-formed codes). */
export const srcParam = (v: string | string[] | undefined): string | null => (typeof v === 'string' && /^[a-z2-9]{4,16}$/.test(v) ? v : null);
