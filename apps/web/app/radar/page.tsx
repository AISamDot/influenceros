import type { PostFormat } from '@ios/core';
import { FORMAT_LABEL, HOOK_LABEL, type HookType, radarOverview, type RadarOverview } from '@ios/radar';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Flash } from '@/components/flash';
import { Kpi } from '@/components/kpi';
import { RadarFormatBars, RadarSpendMeter } from '@/components/radar-bits';
import { SubmitButton } from '@/components/submit-button';
import { requireOwnerPage } from '@/lib/auth';
import { compact, relative } from '@/lib/format';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Radar' };

/**
 * Growth Radar (stream I, PRD §3.15.9–10): fast-growing public accounts in our niches, outlier posts, trends adopted
 * across accelerating accounts, what breaks out by format, and the Viral Remix briefs built from the winners. Handles,
 * links, tags and sound names are third-party labels rendered as plain text; captions are never shown.
 */
const head = 'px-3 py-2 font-semibold';
const cell = 'px-3 py-2 align-top';
const num = 'px-3 py-2 text-right tabular-nums align-top';
const fmt = (f: string | null) => (f ? (FORMAT_LABEL[f as PostFormat] ?? f) : '—');
const hook = (h: string | null) => (h ? (HOOK_LABEL[h as HookType] ?? h) : '—');
const times = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}×`);
const safeUrl = (u: string | null) => (u && /^https:\/\/(?:www\.)?(?:instagram\.com|tiktok\.com)\//.test(u) ? u : null);

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="card overflow-hidden">
      <div className="px-5 pb-2 pt-4">
        <h2 className="eyebrow">{title}</h2>
        {hint ? <p className="mt-1 text-[12.5px] text-muted">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="px-5 pb-4 text-[12.5px] text-muted">{children}</p>;

function Accounts({ rows }: { rows: RadarOverview['accounts'] }) {
  if (!rows.length) return <Empty>No accounts tracked yet. The first weekly scan finds them from the personas&apos; niches, the generator&apos;s drafts and your seeds.</Empty>;
  return (
    <div className="scroll-x">
      <table className="w-full min-w-[760px] text-[13px]">
        <thead>
          <tr className="border-t border-line text-left text-[11px] uppercase tracking-wide text-muted">
            <th className={`${head} pl-5`}>Account</th>
            <th className={head}>Niche</th>
            <th className={`${head} text-right`}>Followers</th>
            <th className={`${head} text-right`}>Δ / week</th>
            <th className={`${head} text-right`}>Accel.</th>
            <th className={`${head} text-right`}>Growth</th>
            <th className={`${head} pr-5`}>Signals</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id} className="border-t border-line">
              <td className={`${cell} pl-5`}>
                <span className="font-medium">@{a.handle}</span> <span className="text-muted">· {a.platform}</span>
                {a.accelerating ? <span className="pill radar-accel ml-2">accelerating</span> : null}
              </td>
              <td className={cell}>{a.niche}</td>
              <td className={num}>{a.followers === null ? '—' : compact(a.followers)}</td>
              <td className={num}>
                {a.velocity === null ? '—' : `${a.velocity >= 0 ? '+' : ''}${compact(Math.round(a.velocity))}`}
                {a.growth_basis === 'first_pass' && a.velocity !== null ? <span className="text-muted"> est.</span> : null}
              </td>
              <td className={num}>{a.acceleration === null ? '—' : `${a.acceleration >= 0 ? '+' : ''}${compact(Math.round(a.acceleration))}`}</td>
              <td className={num}>{a.growth_score === null ? '—' : Math.round(a.growth_score * 100)}</td>
              <td className={`${cell} pr-5 text-[12px] text-muted`}>{a.breakout.length ? a.breakout.map((b) => b.replace(/_/g, ' ')).join(', ') : a.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Outliers({ rows }: { rows: RadarOverview['outliers'] }) {
  if (!rows.length) return <Empty>No outliers in the last 14 days yet.</Empty>;
  return (
    <div className="scroll-x">
      <table className="w-full min-w-[760px] text-[13px]">
        <thead>
          <tr className="border-t border-line text-left text-[11px] uppercase tracking-wide text-muted">
            <th className={`${head} pl-5`}>Post</th>
            <th className={head}>Format</th>
            <th className={head}>Hook</th>
            <th className={`${head} text-right`}>Outlier</th>
            <th className={`${head} text-right`}>Views ÷ followers</th>
            <th className={`${head} text-right`}>Saves + shares</th>
            <th className={`${head} pr-5 text-right`}>Posted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const url = safeUrl(p.url);
            return (
              <tr key={p.id} className="border-t border-line">
                <td className={`${cell} pl-5`}>
                  {url ? (
                    <a href={url} target="_blank" rel="noreferrer nofollow" className="font-medium underline-offset-2 hover:underline">
                      @{p.handle}
                    </a>
                  ) : (
                    <span className="font-medium">@{p.handle}</span>
                  )}{' '}
                  <span className="text-muted">
                    · {p.platform} · {p.niche}
                  </span>
                </td>
                <td className={cell}>{fmt(p.format)}</td>
                <td className={cell}>{hook(p.hook_type)}</td>
                <td className={num}>
                  <span className={p.tier === 'strong' ? 'font-semibold text-ok' : ''}>{times(p.outlier_score)}</span>
                </td>
                <td className={num}>{times(p.views_per_follower)}</td>
                <td className={num}>{p.depth === null ? '—' : `${(p.depth * 100).toFixed(1)}%`}</td>
                <td className={`${num} pr-5`}>{p.posted_at ? relative(new Date(p.posted_at)) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Trends({ rows }: { rows: RadarOverview['trends'] }) {
  if (!rows.length) return <Empty>No trend has reached two accelerating accounts in the last 14 days.</Empty>;
  return (
    <ul className="divide-y divide-line border-t border-line">
      {rows.map((t) => (
        <li key={t.id} className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-2.5 text-[13px]">
          <span>
            <span className="pill bg-surface-2 text-muted">{t.dimension}</span> <span className="font-medium">{t.label}</span> <span className="text-muted">· {t.niche}</span>
          </span>
          <span className="tabular-nums text-muted">
            {t.adopters} accounts · {t.adoption_velocity.toFixed(1)}/week · avg {t.avg_outlier.toFixed(1)}× · score <b className="text-fg">{t.score.toFixed(1)}</b>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Briefs({ rows }: { rows: RadarOverview['briefs'] }) {
  if (!rows.length) return <Empty>No remix briefs yet. Each week the Winner Finder turns the best fresh outliers into briefs for every active persona.</Empty>;
  return (
    <ul className="divide-y divide-line border-t border-line">
      {rows.map((b) => (
        <li key={b.id} className="px-5 py-2.5 text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`pill ${b.status === 'booked' ? 'bg-ok-soft text-ok' : b.status === 'blocked_repeat' ? 'bg-warn-soft text-warn' : 'bg-surface-3 text-muted'}`}>
              {b.status === 'blocked_repeat' ? 'blocked: repeat' : b.status}
            </span>
            <span className="pill bg-surface-2 text-muted">{b.kind === 'double_down' ? 'double down' : 'remix'}</span>
            <Link href={`/personas/${b.persona_slug}`} className="text-muted hover:text-fg">
              {b.persona_name}
            </Link>
            <span className="text-muted">· {relative(new Date(b.created_at))}</span>
          </div>
          <div className="mt-1 font-medium">{b.title ?? 'Untitled'}</div>
          <div className="text-[12px] text-muted">
            {b.mechanic ? `${b.mechanic} mechanic · ` : ''}
            {fmt(b.format)}
            {b.target_format && b.target_format !== b.format ? ` first (validation), then ${fmt(b.target_format)}` : ''}
            {b.idea_status ? ` · idea ${b.idea_status}` : ''}
          </div>
        </li>
      ))}
    </ul>
  );
}

export default async function Radar({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  await requireOwnerPage();
  const sp = await searchParams;
  const { db, studio } = await studioContext();
  const o = await radarOverview(db, studio.id, new Date());
  const strong = o.outliers.filter((p) => p.tier === 'strong').length;
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow">Growth Radar · Winner Finder · Viral Remix</div>
          <h1 className="font-[family-name:var(--font-display)] text-[44px] leading-none tracking-tight">Radar</h1>
          <p className="mt-2 max-w-2xl text-[14px] text-muted">
            Fast-growing public accounts in our niches, their outlier posts, the trends several of them adopted in the last 14 days, and the remix briefs built from the winners:
            the same mechanic with our persona in our world. Public data only, through Apify, inside the weekly cap.
            {o.lastReport ? ` Last Trend Report: week of ${o.lastReport.week}.` : ' The first Trend Report posts to the Studio chat after the first weekly scan.'}
          </p>
        </div>
        <form action="/api/radar/scan" method="post">
          <SubmitButton className="btn btn-ink">Run this week&apos;s scan</SubmitButton>
        </form>
      </div>
      <Flash error={sp.error} ok={sp.ok} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Tracked accounts" value={o.counts.tracked} hint={`${o.counts.niches} niche${o.counts.niches === 1 ? '' : 's'} · ${compact(o.counts.posts)} posts scored`} />
        <Kpi label="Accelerating" value={o.counts.accelerating} tone={o.counts.accelerating ? 'ok' : undefined} hint="growing and speeding up" />
        <Kpi label="Outliers, 14 days" value={o.outliers.length} hint={`${strong} strong (≥ 10×)`} />
        <Kpi label="Trends" value={o.trends.length} hint="≥ 2 accelerating accounts" />
      </div>

      <section className="card grid gap-4 p-5 md:grid-cols-[1fr_auto] md:items-end">
        <RadarSpendMeter usedUsd={o.spend.usedUsd} capUsd={o.spend.capUsd} runs={o.spend.runs7d} capped={o.spend.capped7d} />
        <form action="/api/radar/cap" method="post" className="flex items-end gap-2">
          <label className="text-[12px] text-muted">
            Weekly Apify cap (USD)
            <input name="cap" type="number" min={0} max={500} step={1} defaultValue={o.spend.capUsd} className="input mt-1 block w-28" />
          </label>
          <SubmitButton className="btn">Save cap</SubmitButton>
        </form>
      </section>

      <Section
        title="What breaks out, by format"
        hint="Share of each niche's outlier posts per format (talking, text overlay, voiceover, static, carousel and the optional formats), with the median lift over each creator's own median. The Format Plan reads these."
      >
        {o.benchmarks.length ? (
          <div className="grid gap-4 px-5 pb-5 md:grid-cols-2">
            {o.benchmarks.map((b) => (
              <RadarFormatBars key={b.niche} benchmark={b} />
            ))}
          </div>
        ) : (
          <Empty>No benchmarks yet.</Empty>
        )}
      </Section>

      <Section title="Trends" hint="A hook, format, topic or sound adopted by several accelerating accounts in 14 days, scored by adoption velocity × average outlier score.">
        <Trends rows={o.trends} />
      </Section>

      <Section title="Remix briefs" hint="Winners rebuilt for our personas: structure only (never lines, footage or anyone's likeness), checked against each persona's history, booked into the calendar as ideas.">
        <Briefs rows={o.briefs} />
      </Section>

      <Section title="Growing accounts" hint="Velocity is followers gained per week from the weekly snapshots (an estimate on the first pass); acceleration is the change in velocity.">
        <Accounts rows={o.accounts} />
      </Section>

      <Section title="Outliers" hint="Views ÷ the creator's median over their last 20 posts (likes for stills and carousels). ≥ 5× is an outlier, ≥ 10× strong.">
        <Outliers rows={o.outliers} />
      </Section>
    </div>
  );
}
