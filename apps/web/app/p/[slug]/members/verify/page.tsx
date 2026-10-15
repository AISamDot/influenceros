import { SiteFooter, SiteHeader, SitePage, siteFor } from '@/components/site-shell';

export const dynamic = 'force-dynamic';

/** The sign-in link opens this page; a button (POST) signs in, so link scanners can't use up the one-time link. */
export default async function VerifyPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { site, base } = await siteFor(slug);
  const token = typeof sp.t === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(sp.t) ? sp.t : null;
  return (
    <SitePage>
      <SiteHeader site={site} small />
      <section className="site-section">
        {token ? (
          <form method="post" action="/api/public/members/verify" className="site-form">
            <h2 className="site-h2">Open the members area</h2>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="t" value={token} />
            <button type="submit" className="site-btn site-btn-primary">
              Sign me in
            </button>
          </form>
        ) : (
          <>
            <h2 className="site-h2">That link doesn’t work.</h2>
            <a className="site-btn site-btn-primary" href={`${base}/members`}>
              Get a new sign-in link
            </a>
          </>
        )}
      </section>
      <SiteFooter site={site} base={base} />
    </SitePage>
  );
}
