import { getPersona, NotFoundError } from '@ios/core';
import { notFound } from 'next/navigation';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

/**
 * Public persona site, link-in-bio page (IOS-4 stream G owns app/p/**, docs/IOS-34-CONTRACTS.md §5.5). Served at
 * /p/<slug> locally and at https://<slug>.<IOS_STUDIO_DOMAIN>/ in production (the proxy rewrites the host).
 * Contract stub: name and niche only. Never shows studio data, other personas or anything Owner-only.
 */
export default async function PersonaSite({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { db, studio } = await studioContext();
  let p;
  try {
    p = await getPersona(db, slug);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  if (p.slug !== slug || p.studio_id !== studio.id || ['PROPOSED', 'KILLED', 'RETIRED'].includes(p.state)) notFound();
  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '48px 16px', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 32, margin: 0 }}>{p.name}</h1>
      <p style={{ opacity: 0.7 }}>{p.niche}</p>
    </main>
  );
}
