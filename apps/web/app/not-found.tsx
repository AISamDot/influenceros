import Link from 'next/link';
import { PublicNotFound, publicSiteHome } from '@/components/public-fallback';

export default async function NotFound() {
  // A hidden or unknown persona site 404s in its layout and lands here: show the public page, not the studio card.
  const home = await publicSiteHome();
  if (home) return <PublicNotFound home={home} standalone />;
  return (
    <div className="card mx-auto mt-16 max-w-md p-8 text-center">
      <h1 className="font-[family-name:var(--font-display)] text-4xl">Not here</h1>
      <p className="mt-2 text-muted">That page or persona doesn&apos;t exist.</p>
      <Link href="/" className="btn btn-ink mt-5">
        Back to the studio
      </Link>
    </div>
  );
}
