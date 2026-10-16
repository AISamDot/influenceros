import { PublicNotFound, publicSiteHome } from '@/components/public-fallback';

/** Unknown product or page on a persona site: the site's own 404, in its palette (the layout still renders). */
export default async function SiteNotFound() {
  return <PublicNotFound home={(await publicSiteHome()) ?? '/'} />;
}
