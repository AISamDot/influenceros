import { creditPeriod, ledgerSummary } from '@ios/core';
import { type Forecast, forecastStudio, isSyntheticRow, latestForecast, listLeverActions, type PnlGrain, type PnlRow, type PnlTotals, periodRange, pnlWithTotals, rankActions } from '@ios/profit';
import Link from 'next/link';
import { Kpi } from '@/components/kpi';
import { ForecastFan } from '@/components/money-forecast';
import { ActionList, Band, Impact, LEVER_LABEL, money } from '@/components/profit-bits';
import { Empty } from '@/components/stub';
import { compact, money as unitMoney, shortDate } from '@/lib/format';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Money' };

const PERIODS = [
  { key: 'mtd', label: 'Month to date' },
  { key: 'last_7_days', label: '7 days' },
  { key: 'last_30_days', label: '30 days' },
  { key: 'last_90_days', label: '90 days' },
] as const;
const GRAINS: Array<{ key: PnlGrain; label: string }> = [
  { key: 'persona', label: 'Persona' },
  { key: 'post', label: 'Post' },
  { key: 'format', label: 'Format' },
  { key: 'product', label: 'Product' },
  { key: 'platform', label: 'Platform' },
];
type PeriodKey = (typeof PERIODS)[number]['key'];

function Tabs<T extends string>({ items, active, href, label }: { items: ReadonlyArray<{ key: T; label: string }>; active: T; href: (k: T) => string; label: string }) {
  return (
    <nav className="no-scrollbar flex max-w-full gap-1 overflow-x-auto rounded-full bg-surface-2 p-1" aria-label={label}>
      {items.map((i) => (
        <Link
          key={i.key}
          href={href(i.key)}
          aria-current={i.key === active ? 'page' : undefined}
          className={`shrink-0 rounded-full px-3 py-1 text-[12.5px] font-medium transition ${i.key === active ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg'}`}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

const perPost = (cents: number, posts: number) => (posts ? money(cents / posts) : '—');

function PnlTable({ rows, totals, grain }: { rows: PnlRow[]; totals: PnlTotals; grain: PnlGrain }) {
  const head = 'px-3 py-2 text-right font-semibold';
  const num = 'px-3 py-2 text-right tabular-nums';
  return (
    <div className="scroll-x">
      <table className="w-full min-w-[780px] text-[13px]">
        <thead>
          <tr className="border-t border-line text-left text-[11px] uppercase tracking-wide text-muted">
            <th className="px-5 py-2 font-semibold">{GRAINS.find((g) => g.key === grain)?.label}</th>
            <th className={head}>Sales</th>
            <th className={head}>Fees + refunds</th>
            <th className={head}>Cost</th>
            <th className={head}>Profit</th>
            <th className={head}>Posts</th>
            <th className={head} title="Net revenue (after fees and refunds) per post">
              Net / post
            </th>
            <th className={head}>Cost / post</th>
            <th className="px-5 py-2 text-right font-semibold" title="Sales per 1,000 views">
              RPM
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const synthetic = isSyntheticRow(r);
            return (
              <tr key={r.key} className={`border-t border-line ${synthetic ? 'text-muted' : ''}`}>
                <td className="max-w-[300px] px-5 py-2">
                  <span className={`block truncate ${synthetic ? 'italic' : 'font-medium'}`} title={r.label}>
                    {r.label}
                  </span>
                  {r.allocatedRevenueCents ? <span className="block text-[11px] text-muted">incl. {money(r.allocatedRevenueCents)} spread by views</span> : null}
                  {r.costBreakdown.hfCredits > 0 ? <span className="block text-[11px] text-muted">{Math.round(r.costBreakdown.hfCredits).toLocaleString('en-US')} Higgsfield credits</span> : null}
                </td>
                <td className={num}>{money(r.revenueCents)}</td>
                <td className={`${num} text-muted`}>{money(r.feesCents + r.refundsCents)}</td>
                <td className={num}>{money(r.costCents)}</td>
                <td className={`${num} font-semibold ${r.profitCents < 0 ? 'text-danger' : r.profitCents > 0 ? 'text-ok' : ''}`}>{money(r.profitCents)}</td>
                <td className={`${num} text-muted`}>{r.posts || '—'}</td>
                <td className={num}>{r.posts ? money(r.revenuePerPostCents) : '—'}</td>
                <td className={num}>{r.posts ? money(r.costPerPostCents) : '—'}</td>
                <td className="px-5 py-2 text-right tabular-nums text-muted">{r.views ? money(r.rpmCents) : '—'}</td>
              </tr>
            );
          })}
          <tr className="border-t-2 border-line-strong font-semibold">
            <td className="px-5 py-2.5">Total</td>
            <td className={num}>{money(totals.revenueCents)}</td>
            <td className={num}>{money(totals.feesCents + totals.refundsCents)}</td>
            <td className={num}>{money(totals.costCents)}</td>
            <td className={`${num} ${totals.profitCents < 0 ? 'text-danger' : 'text-ok'}`}>{money(totals.profitCents)}</td>
            <td className={num}>{totals.posts}</td>
            <td className={num}>{perPost(totals.revenueCents - totals.feesCents - totals.refundsCents, totals.posts)}</td>
            <td className={num}>{perPost(totals.costCents, totals.posts)}</td>
            <td className="px-5 py-2.5 text-right tabular-nums">{totals.views ? money((totals.revenueCents / totals.views) * 1000) : '—'}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function changeText(before: Record<string, unknown>, after: Record<string, unknown>): string {
  if ('postsPerWeek' in after) return `${String(before.postsPerWeek)} → ${String(after.postsPerWeek)} posts a week`;
  if ('tier' in after) return `${String(after.agent)}: ${String(before.tier)} → ${String(after.tier)}`;
  if ('formatMix' in after) {
    const b = before.formatMix as Record<string, number>;
    const a = after.formatMix as Record<string, number>;
    const up = Object.keys(a).find((k) => a[k]! > (b[k] ?? 0));
    const down = Object.keys(a).find((k) => a[k]! < (b[k] ?? 0));
    const label = (k: string) => k.replace('activity_text', 'activity + text');
    return up && down ? `1 slot: ${label(down)} → ${label(up)}` : 'mix updated';
  }
  return `${Object.keys(after).length} budgets set`;
}

export default async function Money({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const period: PeriodKey = PERIODS.some((p) => p.key === sp.period) ? (sp.period as PeriodKey) : 'mtd';
  const grain: PnlGrain = GRAINS.some((g) => g.key === sp.grain) ? (sp.grain as PnlGrain) : 'persona';
  const href = (p: PeriodKey, g: PnlGrain) => `/money?period=${p}&grain=${g}`;

  const { db, studio } = await studioContext();
  const now = new Date();
  const range = periodRange(period, now);
  const [pnl, stored, levers, actions, ledger, personas, allocation] = await Promise.all([
    pnlWithTotals(db, { studioId: studio.id, ...range, grain }),
    latestForecast(db, studio.id, null),
    listLeverActions(db, studio.id, { limit: 30 }),
    rankActions(db, studio.id, now, { limit: 6 }),
    ledgerSummary(db, studio.id, creditPeriod(now)),
    db.query<{ id: string; name: string }>('SELECT id, name FROM persona WHERE studio_id = $1 ORDER BY name', [studio.id]),
    db.query<{ persona_id: string | null; credits: number; llm_usd: number; clips: number; week_start: string }>(
      `SELECT persona_id, credits, llm_usd, clips, to_char(week_start, 'YYYY-MM-DD') AS week_start FROM budget_allocation
        WHERE studio_id = $1 AND week_start = (SELECT max(week_start) FROM budget_allocation WHERE studio_id = $1)
        ORDER BY persona_id NULLS LAST, credits DESC`,
      [studio.id],
    ),
  ]);
  const names = new Map(personas.map((p) => [p.id, p.name]));

  // The weekly cycle stores a 1,000-run forecast; without a recent one, run a quick fresh one for the page.
  let forecast: Forecast | null = stored;
  let personaForecasts: Array<Pick<Forecast, 'personaId' | 'totalCents' | 'negativeWeeks'>>;
  if (!stored || now.getTime() - stored.generatedAt.getTime() > 8 * 86_400_000) {
    const f = await forecastStudio(db, { studioId: studio.id, now, runs: 400 });
    forecast = f.studio;
    personaForecasts = f.personas;
  } else {
    personaForecasts = (
      await db.query<{ persona_id: string; total: Forecast['totalCents']; negative_weeks: number }>(
        `SELECT persona_id, total, negative_weeks FROM profit_forecast WHERE studio_id = $1 AND persona_id IS NOT NULL
          AND week_start = (SELECT max(week_start) FROM profit_forecast WHERE studio_id = $1)`,
        [studio.id],
      )
    ).map((r) => ({ personaId: r.persona_id, totalCents: r.total, negativeWeeks: r.negative_weeks }));
  }
  const caps = studio.resolved.caps;
  const t = pnl.totals;
  const margin = t.revenueCents > 0 ? Math.round((t.profitCents / t.revenueCents) * 100) : null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-[44px] leading-none tracking-tight">Money</h1>
        <p className="mt-2 max-w-2xl text-muted">
          Profit from the ledger: every sale, fee and refund against every LLM, media and Higgsfield-credit debit. The Profit Engine pulls cadence, format, credit and model levers on
          its own and logs each one here.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs label="Period" items={PERIODS} active={period} href={(p) => href(p, grain)} />
        <span className="text-[12px] text-muted">
          {shortDate(range.from)} – {shortDate(range.to)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="Sales" value={money(t.revenueCents)} hint={`${compact(t.views)} views · ${t.posts} posts`} />
        <Kpi label="Fees + refunds" value={money(t.feesCents + t.refundsCents)} hint="deducted before payout" />
        <Kpi label="Costs" value={money(t.costCents)} hint="LLM, media, credits" />
        <Kpi label="Profit" value={money(t.profitCents)} hint={margin === null ? 'no sales yet' : `${margin}% margin`} tone={t.profitCents < 0 ? 'danger' : 'ok'} />
        <div className="col-span-2 lg:col-span-1">
          <Kpi label="Forecast · 90 days" value={forecast ? money(forecast.totalCents.median) : '—'} hint={forecast ? <>P10–P90 <Band band={forecast.totalCents} /></> : 'not enough data'} />
        </div>
      </div>

      <section className="card overflow-hidden" aria-labelledby="pnl-title">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-3 pt-5">
          <h2 id="pnl-title" className="font-[family-name:var(--font-display)] text-[24px] leading-none">
            P&amp;L
          </h2>
          <Tabs label="Break down by" items={GRAINS} active={grain} href={(g) => href(period, g)} />
        </div>
        {pnl.rows.length ? (
          <PnlTable rows={pnl.rows} totals={t} grain={grain} />
        ) : (
          <div className="px-5 pb-5">
            <Empty>No sales or spend in this period yet.</Empty>
          </div>
        )}
        <p className="border-t border-line px-5 py-2.5 text-[11.5px] text-muted">
          Sales are attributed by source post, coupon and short link; a persona&apos;s other sales are spread over its posts by views. Higgsfield credits are costed at the Profit
          Engine&apos;s credit price.
        </p>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section className="card min-w-0 p-5" aria-labelledby="forecast-title">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="forecast-title" className="font-[family-name:var(--font-display)] text-[24px] leading-none">
              90-day forecast
            </h2>
            {forecast ? <span className="text-[11.5px] text-muted">updated {shortDate(forecast.generatedAt)}</span> : null}
          </div>
          <p className="mt-1 text-[12.5px] text-muted">Monte Carlo on each persona&apos;s recent weeks. A persona forecast to lose money 4+ weeks in a row becomes a kill proposal for you.</p>
          <div className="mt-3">{forecast ? <ForecastFan forecast={forecast} /> : <Empty>The forecast starts once there is a week of data.</Empty>}</div>
          {personaForecasts.length ? (
            <ul className="mt-4 divide-y divide-line border-t border-line">
              {[...personaForecasts]
                .sort((a, b) => b.totalCents.median - a.totalCents.median)
                .map((p) => (
                  <li key={p.personaId} className="flex items-center gap-3 py-2 text-[13px]">
                    <span className="min-w-0 flex-1 truncate font-medium">{names.get(p.personaId ?? '') ?? 'Persona'}</span>
                    {p.negativeWeeks >= 4 ? <span className="pill bg-danger-soft text-danger">Loss {p.negativeWeeks} wks</span> : null}
                    <span className={`w-24 text-right font-semibold tabular-nums ${p.totalCents.median < 0 ? 'text-danger' : ''}`}>{money(p.totalCents.median)}</span>
                    <span className="hidden w-36 text-right text-[11.5px] text-muted sm:block">
                      <Band band={p.totalCents} />
                    </span>
                  </li>
                ))}
            </ul>
          ) : null}
        </section>

        <section className="card min-w-0 p-5" aria-labelledby="actions-title">
          <h2 id="actions-title" className="font-[family-name:var(--font-display)] text-[24px] leading-none">
            How to make more profit
          </h2>
          <p className="mb-4 mt-1 text-[12.5px] text-muted">Ranked by expected monthly impact. Levers run on their own; the ones marked for you wait in Approvals or Settings.</p>
          <ActionList actions={actions} names={names} empty="Nothing to suggest yet: the studio needs a few weeks of posts and sales." />
        </section>
      </div>

      <section className="card overflow-hidden" aria-labelledby="levers-title">
        <div className="px-5 pb-2 pt-5">
          <h2 id="levers-title" className="font-[family-name:var(--font-display)] text-[24px] leading-none">
            Lever log
          </h2>
          <p className="mt-1 text-[12.5px] text-muted">Every automatic change, with its expected impact and, after the review window, what it actually did.</p>
        </div>
        {levers.length ? (
          <div className="scroll-x">
            <table className="w-full min-w-[780px] text-[13px]">
              <thead>
                <tr className="border-t border-line text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-5 py-2 font-semibold">When</th>
                  <th className="px-3 py-2 font-semibold">Lever</th>
                  <th className="px-3 py-2 font-semibold">Change</th>
                  <th className="px-3 py-2 font-semibold">Why</th>
                  <th className="px-3 py-2 text-right font-semibold">Impact</th>
                  <th className="px-5 py-2 text-right font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {levers.map((l) => (
                  <tr key={l.id} className="border-t border-line align-top">
                    <td className="whitespace-nowrap px-5 py-2.5 text-muted">{shortDate(l.createdAt)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <span className="font-medium">{LEVER_LABEL[l.lever]}</span>
                      <span className="block text-[11.5px] text-muted">{l.personaId ? names.get(l.personaId) : 'Studio'}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{changeText(l.before, l.after)}</td>
                    <td className="max-w-[380px] px-3 py-2.5 text-[12px] leading-snug text-muted">{l.rationale}</td>
                    <td className="px-3 py-2.5 text-[12.5px]">
                      <Impact cents={l.expectedImpactCents} measured={l.measuredImpactCents} />
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <span className={`pill ${l.status === 'measured' ? 'bg-ok-soft text-ok' : l.status === 'reverted' ? 'bg-warn-soft text-warn' : 'bg-surface-2 text-muted'}`}>
                        {l.status === 'applied' ? 'Measuring' : l.status === 'measured' ? 'Measured' : 'Reverted'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-5 pb-5">
            <Empty>No levers pulled yet. The weekly cycle runs every Monday morning (UTC).</Empty>
          </div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card min-w-0 overflow-hidden" aria-labelledby="credits-title">
          <h2 id="credits-title" className="px-5 pb-1 pt-5 font-[family-name:var(--font-display)] text-[24px] leading-none">
            Credits and spend · {creditPeriod(now)}
          </h2>
          <p className="px-5 pb-2 text-[12px] text-muted">
            Studio caps: ${caps.llm_usd_month} LLM · {caps.hf_credits_month.toLocaleString('en-US')} Higgsfield credits a month. Raising a cap is your call in Settings.
          </p>
          {ledger.length ? (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-t border-line text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-5 py-2 font-semibold">Scope</th>
                  <th className="px-2 py-2 font-semibold">Unit</th>
                  <th className="px-2 py-2 text-right font-semibold">Spent</th>
                  <th className="px-5 py-2 text-right font-semibold">Granted</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((l) => (
                  <tr key={`${l.persona_id}-${l.unit}`} className="border-t border-line">
                    <td className="px-5 py-2 font-medium">{l.name ?? 'Studio'}</td>
                    <td className="px-2 py-2 text-muted">{l.unit.replace('_', ' ')}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{unitMoney(Number(l.debits ?? 0), l.unit)}</td>
                    <td className="px-5 py-2 text-right tabular-nums text-muted">{l.grants ? unitMoney(Number(l.grants), l.unit) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="px-5 pb-5">
              <Empty>No metered spend this month yet.</Empty>
            </div>
          )}
        </section>

        <section className="card min-w-0 overflow-hidden" aria-labelledby="alloc-title">
          <h2 id="alloc-title" className="px-5 pb-1 pt-5 font-[family-name:var(--font-display)] text-[24px] leading-none">
            Weekly credit allocation
          </h2>
          <p className="px-5 pb-2 text-[12px] text-muted">
            {allocation[0] ? `Week of ${shortDate(new Date(`${allocation[0].week_start}T00:00:00Z`))}. ` : ''}
            70% by profit per credit, 20% spread for testing, 10% studio reserve.
          </p>
          {allocation.length ? (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-t border-line text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-5 py-2 font-semibold">Scope</th>
                  <th className="px-2 py-2 text-right font-semibold">Credits</th>
                  <th className="px-2 py-2 text-right font-semibold">≈ clips</th>
                  <th className="px-5 py-2 text-right font-semibold">LLM</th>
                </tr>
              </thead>
              <tbody>
                {allocation.map((a) => (
                  <tr key={a.persona_id ?? 'reserve'} className="border-t border-line">
                    <td className="px-5 py-2 font-medium">{a.persona_id ? (names.get(a.persona_id) ?? 'Persona') : 'Studio reserve'}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{Number(a.credits).toLocaleString('en-US')}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-muted">{a.persona_id ? a.clips : '—'}</td>
                    <td className="px-5 py-2 text-right tabular-nums">${Number(a.llm_usd).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="px-5 pb-5">
              <Empty>The first allocation is written by the next weekly cycle.</Empty>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
