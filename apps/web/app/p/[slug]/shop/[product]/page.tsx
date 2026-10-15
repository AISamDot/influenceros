import { notFound } from 'next/navigation';
import { money, SiteFooter, SiteHeader, SitePage, siteFor, srcParam } from '@/components/site-shell';

export const dynamic = 'force-dynamic';

/** Product page: what's inside and the buy button (Lemon Squeezy checkout with the post's attribution). */
export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; product: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, product } = await params;
  const sp = await searchParams;
  const src = srcParam(sp.src);
  const { site, base } = await siteFor(slug);
  const p = [...site.products, ...(site.membership ? [site.membership] : [])].find((x) => x.slug === product);
  if (!p) notFound();
  const monthly = p.rung === 'membership';
  return (
    <SitePage>
      <SiteHeader site={site} small />
      <article className="site-section">
        {p.hasCover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="site-cover" src={`/api/public/site/${slug}/cover/${p.slug}`} alt={`${p.name} cover`} />
        ) : null}
        <p className="site-eyebrow">{monthly ? 'Monthly membership' : 'Digital download'}</p>
        <h2 className="site-h2">{p.name}</h2>
        {p.summary ? <p className="site-lead">{p.summary}</p> : null}
        {p.audience ? <p>For {p.audience}.</p> : null}
        {p.bullets.length ? (
          <>
            <p className="site-eyebrow" style={{ marginTop: 20 }}>
              {monthly ? 'Every month' : 'Inside'}
            </p>
            <ul className="site-list">
              {p.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </>
        ) : null}
        {sp.unavailable === '1' ? (
          <div className="site-alert" role="alert">
            Checkout isn’t available right now. Please try again in a few minutes.
          </div>
        ) : null}
        <div className="site-links">
          <a className="site-btn site-btn-primary" href={`/api/public/checkout?slug=${slug}&product=${p.slug}${src ? `&src=${src}` : ''}`}>
            {monthly ? 'Join' : 'Get it'} · {money(p.priceCents, p.currency)}
            {monthly ? '/month' : ''}
          </a>
        </div>
        <p className="site-note">
          Secure checkout by Lemon Squeezy (merchant of record: they handle payment and tax).{monthly ? ' Cancel any time.' : ' Instant download after purchase.'}
        </p>
      </article>
      <SiteFooter site={site} base={base} />
    </SitePage>
  );
}
