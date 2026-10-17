import type { Metadata } from 'next';
import { getCommerceSettings } from '@troupe/commerce';
import { SiteFooter, siteFor, SiteHeader, SitePage, sitePageMetadata } from '@/components/site-shell';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  return sitePageMetadata((await params).slug, 'Privacy');
}


/** Privacy notice for the persona's site, list and membership (FR-11.4). Plain and short. */
export default async function PrivacyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { site, base } = await siteFor(slug);
  const { db, studio } = await studioContext();
  const settings = await getCommerceSettings(db, studio.id);
  const name = site.persona.name;
  return (
    <SitePage wide>
      <SiteHeader site={site} small />
      <section className="site-section site-prose">
        <h2 className="site-h2">Privacy notice</h2>
        <p>
          {name} is an AI creator run by a small studio. This notice covers this site, {name}’s email list and the membership.
        </p>
        <h2>What we collect</h2>
        <p>Your email address and, if you give it, your first name. When you sign up we record the consent you gave, when, and roughly where from (country only).</p>
        <p>Purchases are handled by Lemon Squeezy, the merchant of record. We receive the order (product, amount, and a one-way hash of your email) to deliver products and members’ access.</p>
        <h2>How we use it</h2>
        <p>To send the free guide you asked for, a short welcome series and occasional emails from {name}, and to give members access to the members area. We never sell your data.</p>
        <h2>Your choices</h2>
        <p>Every email has a one-click unsubscribe link. Visitors in the EU, EEA, UK and Switzerland confirm their sign-up before we email them. You can ask for a copy of your data or for it to be deleted by replying to any email.</p>
        <h2>Who processes it</h2>
        <p>Resend (email delivery) and Lemon Squeezy (checkout and payments). Data is kept while you’re subscribed or a member, and deleted on request.</p>
        {settings.physicalAddress ? <p className="site-note">{settings.physicalAddress}</p> : null}
      </section>
      <SiteFooter site={site} base={base} />
    </SitePage>
  );
}
