import { SiteFooter, SiteHeader, SitePage, siteFor } from '@/components/site-shell';

export const dynamic = 'force-dynamic';

/** Unsubscribe page (footer link). Mail clients use the one-click List-Unsubscribe endpoint instead. */
export default async function UnsubscribePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { site, base } = await siteFor(slug);
  const token = typeof sp.t === 'string' && /^[A-Za-z0-9_-]{10,100}$/.test(sp.t) ? sp.t : null;
  return (
    <SitePage>
      <SiteHeader site={site} small />
      <section className="site-section">
        {sp.done === '1' ? (
          <>
            <h2 className="site-h2">You’re unsubscribed.</h2>
            <p className="site-lead">You won’t get any more emails from {site.persona.name}. Changed your mind? You can sign up again any time.</p>
          </>
        ) : token ? (
          <form method="post" action="/api/public/unsubscribe" className="site-form">
            <h2 className="site-h2">Unsubscribe?</h2>
            <p className="site-lead">You’ll stop getting emails from {site.persona.name}.</p>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="t" value={token} />
            <button type="submit" className="site-btn site-btn-primary">
              Unsubscribe me
            </button>
          </form>
        ) : (
          <>
            <h2 className="site-h2">That link doesn’t work.</h2>
            <p className="site-lead">Use the unsubscribe link at the bottom of any email from {site.persona.name}.</p>
          </>
        )}
      </section>
      <SiteFooter site={site} base={base} />
    </SitePage>
  );
}
