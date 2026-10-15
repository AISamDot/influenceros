import { MEMBER_COOKIE, memberDrops, memberFilePath, memberFromSession } from '@ios/commerce';
import { cookies } from 'next/headers';
import { SiteFooter, SiteHeader, SitePage, siteFor } from '@/components/site-shell';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

/**
 * Members area: the monthly drops for members with access (Lemon Squeezy subscription). Sign-in is a magic link
 * (cookie ios_member, host-only, HttpOnly; never the Owner's session).
 */
export default async function MembersPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { site, base } = await siteFor(slug);
  const { db } = await studioContext();
  const session = (await cookies()).get(MEMBER_COOKIE)?.value;
  const member = await memberFromSession(db, { slug, session, now: new Date() });
  const drops = member ? await memberDrops(db, member.personaId) : [];
  return (
    <SitePage>
      <SiteHeader site={site} small />
      <section className="site-section">
        <p className="site-eyebrow">Members</p>
        {member ? (
          <>
            <h2 className="site-h2">Your monthly drops</h2>
            {drops.length ? (
              drops.map((d) => (
                <article key={d.id} className="site-card">
                  <p className="site-eyebrow">{new Date(`${d.month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</p>
                  <h3 className="site-h2" style={{ fontSize: 24 }}>
                    {d.title}
                  </h3>
                  {d.summary ? <p>{d.summary}</p> : null}
                  <a className="site-btn site-btn-primary" href={`${memberFilePath(d.id)}&slug=${slug}`}>
                    Download
                  </a>
                </article>
              ))
            ) : (
              <p className="site-lead">This month’s pack is being finished. You’ll get an email the moment it’s here.</p>
            )}
            <form method="post" action="/api/public/members/logout" style={{ marginTop: 24 }}>
              <input type="hidden" name="slug" value={slug} />
              <button type="submit" className="site-btn">
                Sign out
              </button>
            </form>
          </>
        ) : sp.sent === '1' ? (
          <div className="site-alert" role="status">
            <strong>Check your inbox.</strong> If that email has a membership, a sign-in link is on its way. It works once, for 20 minutes.
          </div>
        ) : (
          <>
            <h2 className="site-h2">Sign in</h2>
            <p className="site-lead">Enter the email you used at checkout and we’ll send you a sign-in link.</p>
            {sp.error === '1' ? (
              <div className="site-alert" role="alert">
                That sign-in link has expired or was already used. Ask for a new one.
              </div>
            ) : null}
            <form className="site-form" method="post" action="/api/public/members/login">
              <input type="hidden" name="slug" value={slug} />
              <label className="site-label" htmlFor="email">
                Email
              </label>
              <input className="site-input" id="email" name="email" type="email" required autoComplete="email" maxLength={254} />
              <button className="site-btn site-btn-primary" type="submit">
                Send my sign-in link
              </button>
            </form>
            {site.membership ? (
              <p className="site-note">
                Not a member yet? <a href={`${base}/shop/${site.membership.slug}`}>Join the {site.membership.name}</a>.
              </p>
            ) : null}
          </>
        )}
      </section>
      <SiteFooter site={site} base={base} />
    </SitePage>
  );
}
