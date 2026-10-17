import type { Forecast } from '@troupe/profit';
import { money } from './profit-bits';

const SHORT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * Weekly profit fan chart: the P10–P90 band and the median line over the 13 forecast weeks. The plot stretches to
 * the container (non-scaling strokes and dots) and the axis and date labels are HTML, so they stay readable at
 * phone width instead of shrinking with a fixed-aspect SVG.
 */
export function ForecastFan({ forecast, height = 168 }: { forecast: Forecast; height?: number }) {
  const w = 600;
  const h = height - 22;
  const padT = 10;
  const padB = 4;
  const weeks = forecast.weekly;
  if (!weeks.length) return null;
  const lo = Math.min(0, ...weeks.map((x) => x.p10));
  const hi = Math.max(0, ...weeks.map((x) => x.p90));
  const span = hi - lo || 1;
  const x = (i: number) => (weeks.length === 1 ? 0 : (i / (weeks.length - 1)) * w);
  const y = (v: number) => padT + (1 - (v - lo) / span) * (h - padT - padB);
  const band = [...weeks.map((p, i) => `${x(i).toFixed(1)},${y(p.p90).toFixed(1)}`), ...weeks.map((p, i) => `${x(weeks.length - 1 - i).toFixed(1)},${y(weeks[weeks.length - 1 - i]!.p10).toFixed(1)}`)].join(' ');
  const median = weeks.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.median).toFixed(1)}`).join(' ');
  const ticks = [hi, (hi + lo) / 2, lo];
  const first = weeks[0]!;
  const last = weeks.at(-1)!;
  return (
    <figure className="m-0">
      <div className="flex gap-1.5" role="img" aria-label={`Weekly profit forecast, median ${money(first.median)} next week to ${money(last.median)} in week ${weeks.length}`}>
        <div className="relative w-[52px] shrink-0" style={{ height: h }} aria-hidden="true">
          {ticks.map((v) => (
            <span key={v} className="absolute right-0 -translate-y-1/2 text-[10.5px] tabular-nums text-muted" style={{ top: y(v) }}>
              {money(v)}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" className="block overflow-visible" aria-hidden="true">
            {ticks.map((v) => (
              <line key={v} x1={0} x2={w} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            ))}
            {lo < 0 && hi > 0 ? <line x1={0} x2={w} y1={y(0)} y2={y(0)} stroke="var(--line-strong)" strokeDasharray="3 3" strokeWidth="1" vectorEffect="non-scaling-stroke" /> : null}
            <polygon points={band} fill="var(--accent)" opacity="0.14" />
            <path d={median} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            {weeks.map((p, i) => (
              // A zero-length round-capped line stays a round dot however the plot is stretched.
              <line key={p.weekStart} x1={x(i)} x2={x(i)} y1={y(p.median)} y2={y(p.median)} stroke={p.median < 0 ? 'var(--danger)' : 'var(--accent)'} strokeWidth="5" strokeLinecap="round" vectorEffect="non-scaling-stroke">
                <title>{`Week of ${SHORT.format(new Date(`${p.weekStart}T00:00:00Z`))}: median ${money(p.median)} (P10 ${money(p.p10)}, P90 ${money(p.p90)})`}</title>
              </line>
            ))}
          </svg>
          <div className="mt-1 flex justify-between text-[10.5px] text-muted" aria-hidden="true">
            <span>{SHORT.format(new Date(`${first.weekStart}T00:00:00Z`))}</span>
            <span>{SHORT.format(new Date(`${last.weekStart}T00:00:00Z`))}</span>
          </div>
        </div>
      </div>
      <figcaption className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded bg-accent" /> median weekly profit
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-accent/15" /> P10–P90
        </span>
        <span>{forecast.runs.toLocaleString('en-US')} simulated runs</span>
      </figcaption>
    </figure>
  );
}
