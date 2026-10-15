import { listStats, membershipStats, productStoreBoard, storeFor } from '@ios/commerce';
import { personaSiteUrl, SITE_PATHS } from '@ios/agents';
import type { Db } from '@ios/db';
import Link from 'next/link';
import { usd } from '@/lib/format';
import { CommerceStoreBadge } from './commerce-bits';

/**
 * Persona page panel for stream G: site URLs, store link, product store status, email list, members and sales.
 * A failure here never takes the persona page down (returns null).
 */
export async function CommercePersonaPanel({ db, personaId, slug }: { db: Db; studioId: string; personaId: string; slug: string }) {
  try {
    const now = new Date();
    const [store, list, members, products, sales] = await Promise.all([
      storeFor(db, personaId),
      listStats(db, personaId),
      membershipStats(db, personaId, now),
      db.query<{ studio_id: string }>('SELECT studio_id FROM persona WHERE id = $1', [personaId]).then((r) => (r[0] ? productStoreBoard(db, r[0].studio_id, personaId) : [])),
      db.one<{ cents: number; orders: number; attributed: number }>(
        `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE status <> 'refunded'), 0)::int AS cents, count(*)::int AS orders, count(*) FILTER (WHERE attribution <> 'none')::int AS attributed
           FROM orders WHERE persona_id = $1 AND ordered_at > now() - interval '30 days'`,
        [personaId],
      ),
    ]);
    const home = personaSiteUrl(slug, SITE_PATHS.home);
    return (
      <section className="card p-5" aria-labelledby="commerce-panel">
        <div className="flex items-center justify-between gap-3">
          <h2 id="commerce-panel" className="text-[15px] font-semibold">
            Site, store and audience
          </h2>
          <Link href="/commerce" className="text-[12.5px] text-accent underline-offset-2 hover:underline">
            Commerce
          </Link>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-4">
          <div>
            <dt className="eyebrow">Sales · 30d</dt>
            <dd className="font-semibold tabular-nums">{usd(sales.cents)}</dd>
            <dd className="text-[11.5px] text-muted">
              {sales.orders} orders · {sales.attributed} from posts
            </dd>
          </div>
          <div>
            <dt className="eyebrow">Subscribers</dt>
            <dd className="font-semibold tabular-nums">{list.active}</dd>
            <dd className="text-[11.5px] text-muted">{list.pending} pending confirm</dd>
          </div>
          <div>
            <dt className="eyebrow">Members</dt>
            <dd className="font-semibold tabular-nums">{members.members}</dd>
            <dd className="text-[11.5px] text-muted">{members.mrrCents ? `${usd(members.mrrCents)} MRR` : 'no membership yet'}</dd>
          </div>
          <div>
            <dt className="eyebrow">Store</dt>
            <dd className="font-semibold">{store ? `#${store.storeId}` : 'Not linked'}</dd>
            <dd className="text-[11.5px] text-muted">{list.sequence ? `Welcome v${list.sequence.version} ${list.sequence.status}` : 'Welcome emails not written'}</dd>
          </div>
        </dl>
        <p className="mt-3 truncate text-[12.5px]">
          <a href={home} target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">
            {home.replace(/^https?:\/\//, '')}
          </a>{' '}
          <span className="text-muted">· link in bio</span>
        </p>
        {products.length ? (
          <ul className="mt-3 divide-y divide-line border-t border-line text-[13px]">
            {products.slice(0, 6).map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 truncate">{p.name}</span>
                <CommerceStoreBadge status={p.store_status} />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    );
  } catch {
    return null;
  }
}
