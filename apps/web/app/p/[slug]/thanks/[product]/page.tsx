import { upsellFor } from '@ios/commerce';
import { ProductCard, SiteFooter, SiteHeader, SitePage, siteFor } from '@/components/site-shell';

export const dynamic = 'force-dynamic';

/**
 * Thank-you page (the Lemon Squeezy checkout redirect): confirms the order and offers the next rung of the ladder
 * (the upsell; Lemon Squeezy has no native checkout add-ons).
 */
export default async function ThanksPage({ params }: { params: Promise<{ slug: string; product: string }> }) {
  const { slug, product } = await params;
  const { site, base } = await siteFor(slug);
  const bought = [...site.products, ...(site.membership ? [site.membership] : [])].find((p) => p.slug === product);
  const next = upsellFor(site, product);
  return (
    <SitePage>
      <SiteHeader site={site} small />
      <section className="site-section">
        <p className="site-eyebrow">Thank you</p>
        <h2 className="site-h2">{bought ? `${bought.name} is yours.` : 'Thank you for your order.'}</h2>
        <p className="site-lead">
          {bought?.rung === 'membership'
            ? 'Your receipt is on its way. Sign in to the members area with the email you used at checkout.'
            : 'Your receipt and download link are on their way from Lemon Squeezy. Check your inbox (and the promotions tab).'}
        </p>
        {bought?.rung === 'membership' ? (
          <div className="site-links">
            <a className="site-btn site-btn-primary" href={`${base}/members`}>
              Open the members area
            </a>
          </div>
        ) : null}
      </section>
      {next ? (
        <section className="site-section" aria-labelledby="next">
          <p id="next" className="site-eyebrow">
            Next step
          </p>
          <ProductCard product={next} base={base} slug={slug} cta={next.rung === 'membership' ? 'Join' : 'Add it'} />
        </section>
      ) : null}
      <SiteFooter site={site} base={base} />
    </SitePage>
  );
}
