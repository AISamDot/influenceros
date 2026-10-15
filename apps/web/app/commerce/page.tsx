import { getCommerceSettings, listingPack, listStats, membershipStats, postAttribution, productStoreBoard, type ProductStoreRow } from '@ios/commerce';
import { personaSiteUrl } from '@ios/agents';
import type { StoreInfo } from '@ios/providers';
import { CommerceStoreBadge } from '@/components/commerce-bits';
import { Flash } from '@/components/flash';
import { Kpi } from '@/components/kpi';
import { Empty } from '@/components/stub';
import { SubmitButton } from '@/components/submit-button';
import { requireOwnerPage } from '@/lib/auth';
import { compact, relative, usd } from '@/lib/format';
import { studioContext } from '@/lib/server';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Commerce' };

const RUNG: Record<string, string> = {
  lead_magnet: 'Lead magnet',
  entry: 'Entry',
  addon: 'Add-on',
  core_bundle: 'Core bundle',
  upsell: 'Upsell',
  product_2_3: 'Product 2/3',
  marketplace: 'Marketplace',
  membership: 'Membership',
  course: 'Course',
};

function Section({ id, title, lead, children, action }: { id: string; title: string; lead?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="card overflow-hidden" aria-labelledby={id}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pb-3 pt-5">
        <div>
          <h2 id={id} className="text-[15px] font-semibold">
            {title}
          </h2>
          {lead ? <p className="mt-0.5 max-w-3xl text-[12.5px] text-muted">{lead}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function ProductRow({ p, pack }: { p: ProductStoreRow; pack: Record<string, unknown> | null }) {
  const needsUrl = p.store_status !== 'free' && ['approved', 'live'].includes(p.status);
  return (
    <tr className="border-t border-line align-top">
      <td className="px-5 py-2.5">
        <div className="font-medium">{p.name}</div>
        <div className="text-[11.5px] text-muted">
          {p.persona_name} · {RUNG[p.ladder_rung] ?? p.ladder_rung} · {p.price_cents ? usd(p.price_cents, { cents: true }) : 'free'}
        </div>
      </td>
      <td className="px-3 py-2.5 text-[12.5px] capitalize text-muted">{p.status.replace('_', ' ')}</td>
      <td className="px-3 py-2.5">
        <CommerceStoreBadge status={p.store_status} />
        {p.listing_verdict === 'red' ? <div className="mt-1 text-[11.5px] text-danger">Listing pack blocked by the Gate</div> : null}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">{p.orders || '—'}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{p.revenue_cents ? usd(p.revenue_cents) : '—'}</td>
      <td className="min-w-[280px] px-5 py-2.5">
        {needsUrl ? (
          <form method="post" action="/api/commerce" className="flex gap-2">
            <input type="hidden" name="action" value="checkout_url" />
            <input type="hidden" name="product_id" value={p.id} />
            <input
              name="url"
              type="url"
              defaultValue={p.checkout_url ?? ''}
              placeholder="https://…lemonsqueezy.com/buy/…"
              aria-label={`Checkout URL for ${p.name}`}
              className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12.5px]"
            />
            <SubmitButton className="btn btn-sm">Save</SubmitButton>
          </form>
        ) : (
          <span className="text-[12px] text-muted">{p.store_status === 'free' ? 'Delivered by email' : 'After approval'}</span>
        )}
        {pack && p.store_status !== 'linked' && p.store_status !== 'free' ? (
          <details className="mt-2 text-[12px]">
            <summary className="cursor-pointer text-muted">Listing pack (create the store product from this)</summary>
            <dl className="mt-2 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1">
              {['name', 'slug', 'price_cents', 'summary'].map((k) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k.replace('_', ' ')}</dt>
                  <dd className="break-words">{String(pack[k] ?? '')}</dd>
                </div>
              ))}
              <dt className="text-muted">files</dt>
              <dd>{Array.isArray(pack.files) ? (pack.files as Array<{ name: string }>).map((f) => f.name).join(', ') : ''}</dd>
              <dt className="text-muted">redirect</dt>
              <dd>Thank-you page: /thanks/{String(pack.slug ?? p.slug)}</dd>
            </dl>
          </details>
        ) : null}
      </td>
    </tr>
  );
}

export default async function CommercePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwnerPage();
  const sp = await searchParams;
  const { db, studio } = await studioContext();
  const services = await getServices().catch(() => null);
  const now = new Date();
  const since30 = new Date(now.getTime() - 30 * 86_400_000);
  const [settings, personas, products, totals, orders] = await Promise.all([
    getCommerceSettings(db, studio.id),
    db.query<{ id: string; name: string; slug: string; state: string; store_id: string | null; store_name: string | null }>(
      `SELECT p.id, p.name, p.slug, p.state, sa.store_id, sa.store_name FROM persona p LEFT JOIN store_account sa ON sa.persona_id = p.id AND sa.status = 'linked'
        WHERE p.studio_id = $1 AND p.state NOT IN ('PROPOSED','KILLED','RETIRED') ORDER BY p.name`,
      [studio.id],
    ),
    productStoreBoard(db, studio.id),
    db.one<{ sales: number; orders: number; attributed: number }>(
      `SELECT COALESCE(SUM(o.amount_cents) FILTER (WHERE o.status <> 'refunded'), 0)::int AS sales, count(o.id)::int AS orders,
              count(o.id) FILTER (WHERE o.attribution <> 'none')::int AS attributed
         FROM orders o JOIN persona p ON p.id = o.persona_id WHERE p.studio_id = $1 AND o.ordered_at >= $2`,
      [studio.id, since30],
    ),
    db.query<{ id: string; persona: string; product: string | null; amount_cents: number; status: string; attribution: string; ordered_at: Date }>(
      `SELECT o.id, p.name AS persona, pr.name AS product, o.amount_cents, o.status, o.attribution, o.ordered_at
         FROM orders o JOIN persona p ON p.id = o.persona_id LEFT JOIN product pr ON pr.id = o.product_id
        WHERE p.studio_id = $1 ORDER BY o.ordered_at DESC LIMIT 12`,
      [studio.id],
    ),
  ]);
  const perPersona = await Promise.all(
    personas.map(async (p) => ({ p, list: await listStats(db, p.id), members: await membershipStats(db, p.id, now), posts: await postAttribution(db, p.id, { since: since30, limit: 5 }) })),
  );
  const packs = new Map(await Promise.all(products.filter((p) => p.store_status === 'awaiting_listing' || p.store_status === 'listing_pack').map(async (p) => [p.id, await listingPack(db, p.id)] as const)));
  let stores: StoreInfo[] = [];
  let storeError: string | null = null;
  try {
    stores = services ? await services.providers.store.listStores() : [];
  } catch (err) {
    storeError = (err as Error).message.slice(0, 160);
  }
  const subscribers = perPersona.reduce((s, x) => s + x.list.active, 0);
  const members = perPersona.reduce((s, x) => s + x.members.members, 0);
  const mrr = perPersona.reduce((s, x) => s + x.members.mrrCents, 0);
  const waiting = products.filter((p) => p.store_status === 'awaiting_listing').length;
  const live = products.filter((p) => p.status === 'live').length;
  const storeMode = services?.providers.store.name.startsWith('fake') ? 'fake' : 'live';
  const mailMode = services?.providers.audience.name.startsWith('fake') ? 'fake' : 'live';
  const topPosts = perPersona
    .flatMap((x) => x.posts.map((r) => ({ ...r, persona: x.p.name })))
    .sort((a, b) => b.revenue_cents - a.revenue_cents || b.clicks - a.clicks)
    .slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-[44px] leading-none tracking-tight">Commerce</h1>
        <p className="mt-2 max-w-2xl text-muted">
          Stores, products, email lists and members for every persona. A product goes live once its checkout URL is stored: matched from the store automatically, or pasted
          here after you create the listing from its pack (Lemon Squeezy’s products API is read-only).
        </p>
      </div>
      <Flash error={typeof sp.error === 'string' ? sp.error : undefined} ok={typeof sp.ok === 'string' ? sp.ok : undefined} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="Sales · 30 days" value={usd(totals.sales)} hint={`${totals.orders} orders · ${totals.attributed} attributed to posts`} />
        <Kpi label="Subscribers" value={compact(subscribers)} hint="active, all lists" />
        <Kpi label="Members" value={compact(members)} hint={`${usd(mrr)} MRR`} />
        <Kpi label="Products live" value={live} hint={`${products.length} in the ladder`} />
        <Kpi label="Waiting on you" value={waiting} hint="store listings to create" tone={waiting ? 'danger' : undefined} />
      </div>

      <Section
        id="settings"
        title="Email and store settings"
        lead={`Store: ${storeMode === 'live' ? 'Lemon Squeezy (live)' : 'fake mode (no Lemon Squeezy keys)'} · Email: ${mailMode === 'live' ? 'Resend (live)' : 'fake mode (no Resend key)'}. Marketing email never sends without the physical address (CAN-SPAM).`}
      >
        <form method="post" action="/api/commerce" className="grid gap-3 px-5 pb-5 sm:grid-cols-[1fr_260px_auto] sm:items-end">
          <input type="hidden" name="action" value="settings" />
          <label className="grid gap-1 text-[12.5px]">
            <span className="font-medium">Physical postal address (email footer)</span>
            <input name="physical_address" defaultValue={settings.physicalAddress ?? ''} placeholder="Studio name, street, city, country" className="rounded-lg border border-line bg-surface px-3 py-2 text-[13px]" />
          </label>
          <label className="grid gap-1 text-[12.5px]">
            <span className="font-medium">Sender domain</span>
            <input name="sender_domain" defaultValue={settings.senderDomain ?? ''} placeholder="mail.yourstudio.com" className="rounded-lg border border-line bg-surface px-3 py-2 text-[13px]" />
          </label>
          <SubmitButton className="btn">Save</SubmitButton>
        </form>
        {!settings.physicalAddress ? <p className="border-t border-line bg-warn-soft px-5 py-2.5 text-[12.5px] text-warn">Add the physical address: welcome emails and broadcasts are waiting for it.</p> : null}
      </Section>

      <Section
        id="stores"
        title="Stores"
        lead="One Lemon Squeezy store per persona. The hourly sync links a store whose slug matches the persona’s; link the rest here."
        action={
          <form method="post" action="/api/commerce">
            <input type="hidden" name="action" value="sync" />
            <SubmitButton className="btn btn-sm">Sync stores and products</SubmitButton>
          </form>
        }
      >
        {storeError ? <p className="px-5 pb-3 text-[12.5px] text-danger">Couldn’t read the stores: {storeError}</p> : null}
        {personas.length ? (
          <div className="scroll-x">
            <table className="w-full min-w-[720px] text-[13px]">
              <thead>
                <tr className="border-t border-line text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-5 py-2 font-semibold">Persona</th>
                  <th className="px-3 py-2 font-semibold">Site</th>
                  <th className="px-3 py-2 font-semibold">Store</th>
                  <th className="px-5 py-2 font-semibold">Link</th>
                </tr>
              </thead>
              <tbody>
                {personas.map((p) => (
                  <tr key={p.id} className="border-t border-line">
                    <td className="px-5 py-2.5 font-medium">{p.name}</td>
                    <td className="px-3 py-2.5">
                      <a className="text-accent underline-offset-2 hover:underline" href={personaSiteUrl(p.slug, '/')} target="_blank" rel="noreferrer">
                        {personaSiteUrl(p.slug, '/').replace(/^https?:\/\//, '')}
                      </a>
                    </td>
                    <td className="px-3 py-2.5 text-muted">{p.store_id ? `${p.store_name ?? 'Store'} (#${p.store_id})` : 'Not linked'}</td>
                    <td className="px-5 py-2.5">
                      <form method="post" action="/api/commerce" className="flex gap-2">
                        <input type="hidden" name="action" value="link_store" />
                        <input type="hidden" name="persona_id" value={p.id} />
                        <select name="store_id" defaultValue={p.store_id ?? ''} aria-label={`Store for ${p.name}`} className="rounded-lg border border-line bg-surface px-2 py-1.5 text-[12.5px]">
                          <option value="">Not linked</option>
                          {stores.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name} ({s.slug})
                            </option>
                          ))}
                        </select>
                        <SubmitButton className="btn btn-sm">Link</SubmitButton>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-5 pb-5">
            <Empty>No personas with a site yet.</Empty>
          </div>
        )}
      </Section>

      <Section id="products" title="Products" lead="Listing pack → store listing → checkout URL → live. Free lead magnets are delivered by email and need no store.">
        {products.length ? (
          <div className="scroll-x">
            <table className="w-full min-w-[980px] text-[13px]">
              <thead>
                <tr className="border-t border-line text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-5 py-2 font-semibold">Product</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">Store</th>
                  <th className="px-3 py-2 text-right font-semibold">Orders</th>
                  <th className="px-3 py-2 text-right font-semibold">Sales</th>
                  <th className="px-5 py-2 font-semibold">Checkout URL</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <ProductRow key={p.id} p={p} pack={packs.get(p.id) ?? null} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-5 pb-5">
            <Empty>No products yet. The Monetization Agent briefs them; the Product Builder makes v1.</Empty>
          </div>
        )}
      </Section>

      <Section id="lists" title="Email lists and members" lead="One list per persona. EU sign-ups confirm first; every email has one-click unsubscribe and the address footer.">
        <div className="scroll-x">
          <table className="w-full min-w-[820px] text-[13px]">
            <thead>
              <tr className="border-t border-line text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="px-5 py-2 font-semibold">Persona</th>
                <th className="px-3 py-2 text-right font-semibold">Active</th>
                <th className="px-3 py-2 text-right font-semibold">Pending</th>
                <th className="px-3 py-2 text-right font-semibold">Unsub · bounced</th>
                <th className="px-3 py-2 text-right font-semibold">Sent 7d</th>
                <th className="px-3 py-2 font-semibold">Welcome sequence</th>
                <th className="px-3 py-2 text-right font-semibold">Members</th>
                <th className="px-5 py-2 text-right font-semibold">MRR</th>
              </tr>
            </thead>
            <tbody>
              {perPersona.map(({ p, list, members: m }) => (
                <tr key={p.id} className="border-t border-line">
                  <td className="px-5 py-2.5 font-medium">{p.name}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{list.active}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted">{list.pending}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted">
                    {list.unsubscribed} · {list.bounced}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{list.sent7d}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className={list.sequence?.status === 'active' ? '' : 'text-warn'}>
                        {list.sequence ? `v${list.sequence.version} · ${list.sequence.status}${list.sequence.verdict ? ` · Gate ${list.sequence.verdict}` : ''}` : 'Not written yet'}
                      </span>
                      <form method="post" action="/api/commerce">
                        <input type="hidden" name="action" value="write_welcome" />
                        <input type="hidden" name="persona_id" value={p.id} />
                        <SubmitButton className="btn btn-sm">{list.sequence ? 'Rewrite' : 'Write'}</SubmitButton>
                      </form>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{m.members}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums">{m.mrrCents ? usd(m.mrrCents) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section id="attribution" title="Posts that sell · 30 days" lead="Short-link clicks, sign-ups and orders per post (checkout data, then coupon, then short link).">
          {topPosts.length ? (
            <ul className="divide-y divide-line border-t border-line">
              {topPosts.map((r) => (
                <li key={r.post_id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-[13px]">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{r.caption?.slice(0, 80) || 'Post'}</div>
                    <div className="text-[11.5px] text-muted">
                      {r.persona} · {r.platform} · {r.code ? `/l/${r.code}` : 'no link'}
                      {r.coupon ? ` · ${r.coupon}` : ''}
                    </div>
                  </div>
                  <div className="shrink-0 text-right tabular-nums">
                    <div className="font-semibold">{usd(r.revenue_cents)}</div>
                    <div className="text-[11.5px] text-muted">
                      {r.clicks} clicks · {r.subscribers} subs · {r.orders} orders
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-5 pb-5">
              <Empty>Short links and coupons are created for every post that’s about to go out.</Empty>
            </div>
          )}
        </Section>
        <Section id="orders" title="Recent orders">
          {orders.length ? (
            <ul className="divide-y divide-line border-t border-line">
              {orders.map((o) => (
                <li key={o.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-[13px]">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{o.product ?? 'Unknown product'}</div>
                    <div className="text-[11.5px] text-muted">
                      {o.persona} · {o.attribution === 'none' ? 'unattributed' : `via ${o.attribution.replace('_', ' ')}`} · {relative(new Date(o.ordered_at), now)}
                    </div>
                  </div>
                  <div className={`shrink-0 tabular-nums ${o.status === 'paid' ? '' : 'text-danger'}`}>
                    {usd(o.amount_cents, { cents: true })}
                    {o.status !== 'paid' ? ` · ${o.status.replace('_', ' ')}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-5 pb-5">
              <Empty>No orders yet. Lemon Squeezy webhooks land at /api/webhooks/lemonsqueezy.</Empty>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
