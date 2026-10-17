/* eslint-disable @next/next/no-img-element */
import type { PersonaCard as Card } from '@troupe/core';
import Link from 'next/link';
import { compact, daysSince, FORMAT_LABEL, localTime, localWeekday, usd, zoneLabel } from '@/lib/format';
import { AutonomyBadge, KillFlag, LifecycleBadge } from './badges';
import { FormatIcon, IconChat, PlatformMark } from './icons';
import { Sparkline } from './sparkline';

function Metric({ label, value, values, color }: { label: string; value: string; values: number[]; color: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-surface-2 px-2.5 pb-1.5 pt-2">
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-[10.5px] font-medium uppercase tracking-wide text-muted">{label}</span>
      </div>
      <div className="mt-0.5 text-[15px] font-semibold tabular-nums tracking-tight">{value}</div>
      <Sparkline values={values} color={color} height={26} />
    </div>
  );
}

export function PersonaCard({ card }: { card: Card }) {
  const { persona: p, series, next, accounts, totals } = card;
  const accent = p.accent_color ?? 'var(--accent)';
  const day = daysSince(p.launched_at);
  return (
    <article
      className={`card group relative flex flex-col overflow-hidden transition hover:-translate-y-0.5 hover:shadow-lift ${card.killProposed ? 'ring-2 ring-danger/60' : ''}`}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 opacity-[0.13]" style={{ background: `linear-gradient(180deg, ${accent}, transparent)` }} />
      {card.killProposed ? (
        <Link href="/approvals" className="relative flex items-center gap-2 bg-danger-soft px-4 py-2 text-[12px] font-medium text-danger">
          <KillFlag />
          <span className="truncate">Waiting for your approval · keeps posting until you decide</span>
        </Link>
      ) : null}
      <div className="relative flex gap-4 p-4 pb-3">
        <Link href={`/personas/${p.slug}`} className="shrink-0" aria-label={`Open ${p.name}`}>
          <img src={p.portrait_url ?? ''} alt={`${p.name} portrait`} className="h-[124px] w-[100px] rounded-[14px] object-cover shadow-card" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <Link href={`/personas/${p.slug}`} className="min-w-0">
              <h2 className="truncate font-[family-name:var(--font-display)] text-[28px] leading-[1.05] tracking-tight">{p.name}</h2>
            </Link>
          </div>
          <p className="mt-0.5 truncate text-[13px] font-medium">{p.niche}</p>
          <p className="line-clamp-2 text-[12px] leading-snug text-muted">{p.sub_niche}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <LifecycleBadge state={p.state} />
            <AutonomyBadge level={p.autonomy} />
            {day !== null ? <span className="text-[11.5px] text-muted">day {day}</span> : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {accounts.map((a) => (
              <span key={a.platform} className="flex items-center gap-1 text-[12px] text-muted">
                <PlatformMark platform={a.platform} />@{a.handle}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 px-4">
        <Metric label="Views 7d" value={compact(totals.views7d)} values={series.views} color={accent} />
        <Metric label="Followers" value={compact(totals.followers)} values={series.followers} color={accent} />
        <Metric label="Revenue 7d" value={usd(totals.revenue7dCents)} values={series.revenueCents} color="var(--ok)" />
      </div>

      <div className="mt-3 px-4">
        <div className="eyebrow mb-1.5">Next up{next[0] ? ` · ${zoneLabel(new Date(next[0].slot_at), p.timezone)}` : ''}</div>
        <div className="grid grid-cols-3 gap-2">
          {next.map((s) => (
            <Link href={`/personas/${p.slug}#calendar`} key={s.id} className="group/t block" title={`${s.title} · ${FORMAT_LABEL[s.format]}`}>
              <span className="relative block overflow-hidden rounded-[10px] bg-surface-3">
                <img src={s.thumbnail_url ?? ''} alt={s.title} className="aspect-[9/14] w-full object-cover transition group-hover/t:scale-[1.03]" />
                <span className="absolute left-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm">
                  <FormatIcon format={s.format} size={13} />
                </span>
              </span>
              <span className="mt-1 block text-[11px] font-medium tabular-nums text-muted">
                {localWeekday(new Date(s.slot_at), p.timezone)} {localTime(new Date(s.slot_at), p.timezone)}
              </span>
            </Link>
          ))}
          {next.length === 0 ? <p className="col-span-3 text-[12px] text-muted">Nothing scheduled.</p> : null}
        </div>
      </div>

      <div className="min-h-4 flex-1" />
      <div className="flex items-center gap-2 border-t border-line px-4 py-3">
        <Link href={`/personas/${p.slug}`} className="btn btn-sm">
          Open
        </Link>
        <Link href={`/personas/${p.slug}#chat`} className="btn btn-sm btn-ink">
          <IconChat size={13} /> Chat
        </Link>
        <span className="ml-auto text-[11.5px] text-muted">{p.timezone.split('/').pop()?.replace('_', ' ')}</span>
      </div>
    </article>
  );
}
