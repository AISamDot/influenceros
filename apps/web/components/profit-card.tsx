import type { Db } from '@ios/db';
import { profitCard, type ProfitCardData } from '@ios/profit';
import Link from 'next/link';
import { ActionList, Band, LeverLine, money } from './profit-bits';

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' });

/**
 * Profit card on the Studio wall (PRD §3.11 outputs): this month's profit vs forecast, top three levers pulled, top
 * three opportunities. Data from @ios/profit; a failure here never takes the wall down.
 */
export async function ProfitCard({ db, studioId }: { db: Db; studioId: string }) {
  let data: ProfitCardData;
  let names: Map<string, string>;
  try {
    [data, names] = await Promise.all([
      profitCard(db, studioId),
      db.query<{ id: string; name: string }>('SELECT id, name FROM persona WHERE studio_id = $1', [studioId]).then((r) => new Map(r.map((p) => [p.id, p.name]))),
    ]);
  } catch (err) {
    console.error('[profit-card]', err);
    return null;
  }
  const f = data.forecastCents;
  const month = MONTH.format(new Date(`${data.month}-01T00:00:00Z`));
  // Progress toward the median forecast (only meaningful when it's positive).
  const pct = f.median > 0 ? Math.max(0, Math.min(100, (data.profitCents / f.median) * 100)) : 0;
  const ahead = data.profitCents >= 0 && f.median > 0;

  return (
    <section className="card overflow-hidden" aria-labelledby="profit-card-title">
      <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,1.2fr)]">
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h2 id="profit-card-title" className="eyebrow">
              Profit · {month}
            </h2>
            <Link href="/money" className="text-[12px] font-medium text-muted hover:text-fg">
              Money →
            </Link>
          </div>
          <div className={`mt-1 font-[family-name:var(--font-display)] text-[44px] leading-none tracking-tight tabular-nums ${data.profitCents < 0 ? 'text-danger' : ''}`}>
            {money(data.profitCents)}
          </div>
          <p className="mt-1.5 text-[12.5px] text-muted">
            so far · forecast <span className="font-semibold text-fg tabular-nums">{money(f.median)}</span> for the month
          </p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-3" role="img" aria-label={`${Math.round(pct)}% of the month's forecast profit`}>
            <div className={`h-full rounded-full ${ahead ? 'bg-ok' : 'bg-warn'}`} style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1.5 text-[11.5px] text-muted">
            P10–P90 <Band band={f} label="Month forecast" />
          </p>
        </div>

        <div className="min-w-0 lg:border-l lg:border-line lg:pl-5">
          <div className="eyebrow mb-2">Levers pulled</div>
          {data.topLevers.length ? (
            <ul className="space-y-2.5">
              {data.topLevers.map((l) => (
                <LeverLine key={l.id} lever={l} name={l.personaId ? (names.get(l.personaId) ?? null) : null} />
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-muted">None yet. Cadence, format mix, credits and model routing move on their own once personas have a few weeks of posts and sales.</p>
          )}
        </div>

        <div className="min-w-0 lg:border-l lg:border-line lg:pl-5">
          <div className="eyebrow mb-2">Make more profit</div>
          <ActionList actions={data.opportunities} names={names} empty="Nothing to suggest yet." />
        </div>
      </div>
    </section>
  );
}
