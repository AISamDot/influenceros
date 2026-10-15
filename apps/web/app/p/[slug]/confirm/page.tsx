import { SiteFooter, SiteHeader, SitePage, siteFor } from '@/components/site-shell';

export const dynamic = 'force-dynamic';

/**
 * Double opt-in confirmation. The email link opens this page; the visitor confirms with a button (a POST), so link
 * scanners that prefetch email links can't confirm on someone's behalf.
 */
export default async function ConfirmPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { site, base } = await siteFor(slug);
  const token = typeof sp.t === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(sp.t) ? sp.t : null;
  return (
    <SitePage>
      <SiteHeader site={site} small />
      <section className="site-section">
        {sp.done === '1' ? (
          <>
            <h2 className="site-h2">You’re in.</h2>
            <p className="site-lead">Your first email is on its way with the download link.</p>
          </>
        ) : sp.error === '1' || !token ? (
          <>
            <h2 className="site-h2">That link has expired.</h2>
            <p className="site-lead">Sign up again and we’ll send a fresh confirmation link.</p>
            <a className="site-btn site-btn-primary" href={`${base}/free`}>
              Sign up again
            </a>
          </>
        ) : (
          <form method="post" action="/api/public/confirm" className="site-form">
            <h2 className="site-h2">Confirm your email</h2>
            <p className="site-lead">One tap and you’re on {site.persona.name}’s list.</p>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="t" value={token} />
            <button type="submit" className="site-btn site-btn-primary">
              Yes, sign me up
            </button>
          </form>
        )}
      </section>
      <SiteFooter site={site} base={base} />
    </SitePage>
  );
}
