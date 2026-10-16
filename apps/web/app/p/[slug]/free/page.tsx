import type { Metadata } from 'next';
import { consentWording } from '@ios/commerce';
import { SiteFooter, siteFor, SiteHeader, SitePage, sitePageMetadata, srcParam } from '@/components/site-shell';
import { SubmitButton } from '@/components/submit-button';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  return sitePageMetadata((await params).slug, 'Free guide');
}


/**
 * Lead-magnet opt-in (SITE_PATHS.freebie). EU/EEA/UK/CH and unknown regions get double opt-in (a confirmation email);
 * everyone else gets the guide straight away. The response never says whether an address was already on the list.
 */
export default async function FreePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const src = srcParam(sp.src);
  const { site, base } = await siteFor(slug);
  const lm = site.leadMagnet;
  const sent = sp.sent === '1';
  const error = typeof sp.error === 'string';
  return (
    <SitePage>
      <SiteHeader site={site} small />
      <section className="site-section">
        <p className="site-eyebrow">{lm ? 'Free download' : 'Email list'}</p>
        {/* No approved lead magnet yet: promise only the emails, never a guide that can't be delivered. */}
        <h2 className="site-h2">{lm?.name ?? `Join ${site.persona.name}’s list`}</h2>
        <p className="site-lead">{lm ? lm.summary || 'A short, practical guide you can use today. Enter your email and it’s yours.' : `Short, practical ${site.persona.niche} emails you can use right away. Unsubscribe any time.`}</p>
        {lm?.bullets.length ? (
          <ul className="site-list">
            {lm.bullets.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        ) : null}
        {sent ? (
          <div className="site-alert" role="status">
            <strong>Check your inbox.</strong> If you’re in the EU or UK, tap the confirmation link first; then {lm ? 'the guide arrives' : 'you’re on the list'}.
          </div>
        ) : (
          <form className="site-form" method="post" action="/api/public/subscribe">
            {error ? (
              <div className="site-alert" role="alert" id="optin-error">
                {sp.error === 'consent' ? `Tick the box so we can send you ${lm ? 'the guide' : 'emails'}.` : 'Please enter a valid email address.'}
              </div>
            ) : null}
            <input type="hidden" name="slug" value={slug} />
            {src ? <input type="hidden" name="src" value={src} /> : null}
            <label className="site-label" htmlFor="first_name">
              First name (optional)
            </label>
            <input className="site-input" id="first_name" name="first_name" autoComplete="given-name" maxLength={60} />
            <label className="site-label" htmlFor="email">
              Email
            </label>
            <input
              className="site-input"
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              maxLength={254}
              aria-invalid={error && sp.error !== 'consent' ? true : undefined}
              aria-describedby={error && sp.error !== 'consent' ? 'optin-error' : undefined}
            />
            <div className="site-hp" aria-hidden="true">
              <label htmlFor="website">Leave this empty</label>
              <input id="website" name="website" tabIndex={-1} autoComplete="off" />
            </div>
            <label className="site-check">
              <input type="checkbox" name="consent" value="yes" required aria-invalid={sp.error === 'consent' ? true : undefined} aria-describedby={sp.error === 'consent' ? 'optin-error' : undefined} />
              <span>{consentWording(site.persona.name, lm?.name ?? null)}</span>
            </label>
            <SubmitButton className="site-btn site-btn-primary">
              {lm ? 'Send it to me' : 'Join the list'}
            </SubmitButton>
            <p className="site-note">
              See the <a href={`${base}/privacy`}>privacy notice</a>. One click unsubscribes you from any email.
            </p>
          </form>
        )}
      </section>
      <SiteFooter site={site} base={base} />
    </SitePage>
  );
}
