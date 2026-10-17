/* eslint-disable @next/next/no-img-element */
import { type BudgetStatus, localDayKey, personaPage } from '@troupe/core';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AutonomyBadge, KillFlag, LifecycleBadge } from '@/components/badges';
import { ChatPanel } from '@/components/chat-panel';
import { Flash } from '@/components/flash';
import { CommercePersonaPanel } from '@/components/commerce-persona-panel';
import { DistributionPersonaPanel } from '@/components/distribution-persona-panel';
import { FormatsPersonaPanel } from '@/components/formats-persona-panel';
import { FormatIcon, PlatformMark } from '@/components/icons';
import { MediaPersonaPanel } from '@/components/media-persona-panel';
import { PersonaArchiveBanner, PersonaArchivePanel } from '@/components/persona-archive-panel';
import { ProductionPersonaPanel } from '@/components/production-persona-panel';
import { ProductsPersonaPanel } from '@/components/products-persona-panel';
import { StoriesPersonaPanel } from '@/components/stories-persona-panel';
import { WorldPersonaPanel } from '@/components/world-persona-panel';
import { Profile } from '@/components/profile';
import { Sparkline } from '@/components/sparkline';
import { compact, daysSince, FORMAT_LABEL, localTime, money, shortDate, usd, weekday, zoneLabel } from '@/lib/format';
import { loadChat, studioContext } from '@/lib/server';
import { requireOwnerPage } from '@/lib/auth';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ tab?: string; ok?: string; error?: string }> };

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  return { title: slug.charAt(0).toUpperCase() + slug.slice(1) };
}

const PURPOSE: Record<string, { label: string; cls: string }> = {
  reach: { label: 'Reach', cls: 'bg-[#e3effc] text-[#1d5fa8] dark:bg-[#132a42] dark:text-[#8cc2ff]' },
  trust: { label: 'Trust', cls: 'bg-ok-soft text-ok' },
  sell: { label: 'Sell', cls: 'bg-warn-soft text-warn' },
};

function Meter({ label, s }: { label: string; s: BudgetStatus }) {
  const sc = s.persona;
  if (!sc || sc.limit === null) return null;
  const pct = Math.min(100, sc.ratio * 100);
  const tone = pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warn' : 'bg-ink';
  return (
    <div>
      <div className="flex justify-between text-[12px]">
        <span className="text-muted">{label}</span>
        <span className="font-medium tabular-nums">
          {money(sc.used, s.unit)} / {money(sc.limit, s.unit)}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Stat({ label, value, values, color }: { label: string; value: string; values?: number[]; color?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface px-3.5 py-3">
      <div className="eyebrow">{label}</div>
      <div className="mt-0.5 text-[22px] font-semibold tabular-nums tracking-tight">{value}</div>
      {values ? <Sparkline values={values} color={color} height={28} /> : null}
    </div>
  );
}

export default async function PersonaPage({ params, searchParams }: Props) {
  await requireOwnerPage();
  const [{ slug }, { tab, ok, error }] = await Promise.all([params, searchParams]);
  const { db, studio } = await studioContext();
  const page = await personaPage(db, slug);
  if (!page) notFound();
  const { card, bible, week, posts, products, plan, community, budget } = page;
  const p = card.persona;
  const accent = p.accent_color ?? 'var(--accent)';
  const chat = await loadChat(db, studio.id, 'persona', p.id);
  const todayKey = localDayKey(new Date(), page.card.persona.timezone);
  const profileTab = tab === 'profile';
  const day = daysSince(p.launched_at);

  return (
    <div className="space-y-6">
      <Link href="/" className="text-[13px] text-muted hover:text-fg">
        ← Studio
      </Link>
      <Flash ok={ok} error={error} />
      <PersonaArchiveBanner p={p} />

      {/* Hero */}
      <section className="card relative overflow-hidden p-5 sm:p-6">
        <div className="pointer-events-none absolute inset-0 opacity-[0.10]" style={{ background: `radial-gradient(80% 120% at 0% 0%, ${accent}, transparent 60%)` }} />
        <div className="relative grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
          <img src={p.portrait_url ?? ''} alt={`${p.name} portrait`} className="aspect-[4/5] w-full max-w-[220px] rounded-[20px] object-cover shadow-lift" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <LifecycleBadge state={p.state} />
              <AutonomyBadge level={p.autonomy} />
              {day !== null ? <span className="text-[12px] text-muted">day {day}</span> : null}
              {card.killProposed ? (
                <Link href="/approvals">
                  <KillFlag />
                </Link>
              ) : null}
            </div>
            <h1 className="mt-2 font-[family-name:var(--font-display)] text-[48px] leading-[0.95] tracking-tight sm:text-[60px]">{p.name}</h1>
            <p className="mt-2 text-[15px] font-medium">{p.niche}</p>
            <p className="text-[13.5px] text-muted">{p.sub_niche}</p>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
              {card.accounts.map((a) => (
                <span key={a.platform} className="flex items-center gap-1.5 text-[13px] text-muted">
                  <PlatformMark platform={a.platform} />@{a.handle}
                </span>
              ))}
            </div>
            <div className="mt-5 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
              <Stat label="Views 7d" value={compact(card.totals.views7d)} values={card.series.views} color={accent} />
              <Stat label="Followers" value={compact(card.totals.followers)} values={card.series.followers} color={accent} />
              <Stat label="Revenue 7d" value={usd(card.totals.revenue7dCents)} values={card.series.revenueCents} color="var(--ok)" />
              <Stat label="Email list" value={compact(community.subscribers)} />
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Meter label="LLM spend this month" s={budget.llm} />
              <Meter label="Higgsfield credits this month" s={budget.credits} />
            </div>
          </div>
        </div>

        {/* Look pack */}
        <div className="relative mt-6">
          <div className="eyebrow mb-2">Look pack</div>
          <div className="scroll-x no-scrollbar -mx-1 flex gap-3 px-1 pb-1">
            {p.look_pack.map((l) => (
              <figure key={l.label} className="w-[132px] shrink-0">
                <img src={l.url} alt={l.label} className="aspect-[4/5] w-full rounded-[14px] object-cover" />
                <figcaption className="mt-1.5 text-[12px] font-medium text-muted">{l.label}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* Tabs */}
      <nav className="flex gap-1 border-b border-line" aria-label="Persona sections">
        {[
          { href: `/personas/${p.slug}`, label: 'Overview', on: !profileTab },
          { href: `/personas/${p.slug}?tab=profile`, label: 'Profile', on: profileTab },
        ].map((t) => (
          <Link
            key={t.label}
            href={t.href}
            aria-current={t.on ? 'page' : undefined}
            className={`-mb-px border-b-2 px-4 py-2.5 text-[14px] font-medium ${t.on ? 'border-ink text-fg' : 'border-transparent text-muted hover:text-fg'}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {profileTab ? (
        bible ? (
          <Profile content={bible.content} version={bible.version} approvedAt={bible.approved_at} approvedBy={bible.approved_by} />
        ) : (
          <p className="text-muted">No bible yet.</p>
        )
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0 space-y-6">
            {/* Week calendar */}
            <section id="calendar" className="card p-4 sm:p-5">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-[family-name:var(--font-display)] text-[26px] leading-none">This week</h2>
                <span className="text-[12px] text-muted">
                  {week.days.reduce((a, d) => a + d.slots.length, 0)} posts · week of {shortDate(new Date(week.start))} · times in {card.persona.timezone || 'UTC'} ({zoneLabel(new Date(), card.persona.timezone)})
                </span>
              </div>
              <div className="scroll-x -mx-1 px-1 pb-1">
                <div className="grid min-w-[840px] grid-cols-7 gap-2">
                  {week.days.map((d) => (
                    <div key={d.date} className={`rounded-2xl p-1.5 ${d.date === todayKey ? 'bg-accent-soft' : 'bg-surface-2'}`}>
                      <div className="flex items-baseline justify-between px-1 pb-1.5">
                        <span className={`text-[12px] font-semibold ${d.date === todayKey ? 'text-accent' : ''}`}>{weekday(new Date(`${d.date}T12:00:00Z`))}</span>
                        <span className="text-[11px] text-muted">{shortDate(new Date(`${d.date}T12:00:00Z`))}</span>
                      </div>
                      <div className="space-y-1.5">
                        {d.slots.map((s) => (
                          <div key={s.id} className="overflow-hidden rounded-xl border border-line bg-surface">
                            <div className="relative">
                              <img src={s.thumbnail_url ?? ''} alt={s.title} className="aspect-[9/12] w-full object-cover" />
                              <span className="absolute left-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm" title={FORMAT_LABEL[s.format]}>
                                <FormatIcon format={s.format} size={13} />
                              </span>
                              {s.status === 'live' ? <span className="absolute right-1.5 top-1.5 rounded-full bg-ok px-1.5 py-0.5 text-[9.5px] font-bold uppercase text-on-ok">Live</span> : null}
                            </div>
                            <div className="space-y-1 p-1.5">
                              <div className="flex items-center justify-between gap-1">
                                <span className="text-[11px] font-semibold tabular-nums">{localTime(new Date(s.slot_at), card.persona.timezone)}</span>
                                <span className={`rounded-full px-1.5 py-px text-[9.5px] font-bold uppercase ${PURPOSE[s.purpose]?.cls ?? ''}`}>{PURPOSE[s.purpose]?.label}</span>
                              </div>
                              <p className="line-clamp-2 text-[11.5px] leading-snug">{s.title}</p>
                            </div>
                          </div>
                        ))}
                        {d.slots.length === 0 ? <p className="px-1 py-3 text-center text-[11px] text-faint">Rest day</p> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* Recent posts */}
            <section className="card overflow-hidden">
              <h2 className="px-5 pb-2 pt-5 font-[family-name:var(--font-display)] text-[26px] leading-none">Recent posts</h2>
              <div className="scroll-x">
                <table className="w-full min-w-[640px] text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
                      <th className="px-5 py-2 font-semibold">Post</th>
                      <th className="px-2 py-2 font-semibold">Where</th>
                      <th className="px-2 py-2 text-right font-semibold">Views</th>
                      <th className="px-2 py-2 text-right font-semibold">Likes</th>
                      <th className="px-2 py-2 text-right font-semibold">Saves</th>
                      <th className="px-5 py-2 text-right font-semibold">Shares</th>
                    </tr>
                  </thead>
                  <tbody>
                    {posts.map((po) => (
                      <tr key={po.id} className="border-b border-line last:border-0">
                        <td className="px-5 py-2">
                          <div className="flex items-center gap-3">
                            <img src={po.thumbnail_url ?? ''} alt="" className="h-12 w-[27px] shrink-0 rounded-md object-cover" />
                            <div className="min-w-0">
                              <div className="line-clamp-1 font-medium">{po.caption?.split(' · ')[0]}</div>
                              <div className="flex items-center gap-1 text-[11.5px] text-muted">
                                <FormatIcon format={po.format} size={12} /> {FORMAT_LABEL[po.format]} · {po.published_at ? shortDate(new Date(po.published_at)) : '—'}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-2 py-2">
                          <PlatformMark platform={po.platform} />
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{compact(po.views)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{compact(po.likes)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{compact(po.saves)}</td>
                        <td className="px-5 py-2 text-right tabular-nums">{compact(po.shares)}</td>
                      </tr>
                    ))}
                    {posts.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-5 py-4 text-muted">
                          No posts yet.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Product shelf */}
            <section>
              <h2 className="mb-3 font-[family-name:var(--font-display)] text-[26px] leading-none">Product shelf</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {products.map((pr) => (
                  <article key={pr.id} className="card overflow-hidden">
                    <img src={pr.cover_url ?? ''} alt="" className="aspect-[4/3] w-full object-cover" />
                    <div className="p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{pr.ladder_rung.replace('_', ' ')}</div>
                      <h3 className="mt-0.5 line-clamp-2 text-[13.5px] font-semibold leading-snug">{pr.name}</h3>
                      <div className="mt-2 flex items-center justify-between text-[12.5px]">
                        <span className="font-semibold">{pr.price_cents ? usd(pr.price_cents) : 'Free'}</span>
                        {pr.status === 'live' ? (
                          <span className="text-muted">{pr.orders} sold · {usd(pr.revenue_cents)}</span>
                        ) : (
                          <span className="pill bg-accent-soft text-accent">{pr.status.replace('_', ' ')}</span>
                        )}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <div className="grid gap-6 lg:grid-cols-2">
              {/* Plan */}
              <section className="card p-5">
                <h2 className="font-[family-name:var(--font-display)] text-[26px] leading-none">6–12 month plan</h2>
                <p className="mt-1 text-[12px] text-muted">Draft stub. The Persona Manager owns and updates it from IOS-2.</p>
                <ol className="mt-4 space-y-3 border-l border-line pl-4">
                  {((plan?.content.milestones as Array<{ month: string; goal: string }> | undefined) ?? []).map((m) => (
                    <li key={m.month} className="relative">
                      <span className="absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-surface" style={{ background: accent }} />
                      <div className="text-[12px] font-semibold text-muted">{m.month}</div>
                      <div className="text-[13.5px]">{m.goal}</div>
                    </li>
                  ))}
                </ol>
              </section>
              {/* Community */}
              <section className="card p-5">
                <h2 className="font-[family-name:var(--font-display)] text-[26px] leading-none">Community</h2>
                <div className="mt-4 grid grid-cols-2 gap-2.5">
                  <Stat label="Email subscribers" value={compact(community.subscribers)} />
                  <Stat label="Members" value={compact(community.members)} />
                  <Stat label="Comments 7d" value={compact(community.comments7d)} />
                  <Stat label="Open escalations" value={String(community.openEscalations)} />
                </div>
              </section>
            </div>

            {/* IOS-3/4 panels: each stream fills only its own component (docs/IOS-34-CONTRACTS.md §4). */}
            <MediaPersonaPanel db={db} studioId={studio.id} personaId={p.id} slug={p.slug} />
            <DistributionPersonaPanel db={db} studioId={studio.id} personaId={p.id} slug={p.slug} />
            <CommercePersonaPanel db={db} studioId={studio.id} personaId={p.id} slug={p.slug} />
            <ProductsPersonaPanel db={db} studioId={studio.id} personaId={p.id} slug={p.slug} />
            {/* IOS-5 panels: each stream fills only its own component (docs/IOS-5-CONTRACTS.md §4). */}
            <FormatsPersonaPanel db={db} studioId={studio.id} personaId={p.id} slug={p.slug} />
            <StoriesPersonaPanel db={db} studioId={studio.id} personaId={p.id} slug={p.slug} />
            <WorldPersonaPanel db={db} studioId={studio.id} personaId={p.id} slug={p.slug} />
            <ProductionPersonaPanel db={db} studioId={studio.id} personaId={p.id} slug={p.slug} />
            <PersonaArchivePanel p={p} />
          </div>

          <div id="chat" className="min-w-0 scroll-mt-20">
            <ChatPanel
              threadId={chat.thread.id}
              title={`${p.name.split(' ')[0]}'s manager`}
              subtitle="Numbers-first · speaks as a manager, not in persona voice"
              initial={chat.initial}
            mode={chat.mode}
              avatar={p.portrait_url}
              placeholder={`Tell ${p.name.split(' ')[0]}'s manager what to change…`}
              className="h-[560px] xl:sticky xl:top-20 xl:h-[calc(100dvh-7rem)]"
            />
          </div>
        </div>
      )}
    </div>
  );
}
