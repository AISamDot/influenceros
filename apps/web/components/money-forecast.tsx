import type { Forecast } from '@ios/profit';
import { money } from './profit-bits';

const SHORT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Weekly profit fan chart: the P10–P90 band and the median line over the 13 forecast weeks. */
export function ForecastFan({ forecast, height = 168 }: { forecast: Forecast; height?: number }) {
  const w = 600;
  const h = height;
  const padL = 52;
  const padR = 8;
  const padT = 10;
  const padB = 22;
  const weeks = forecast.weekly;
  if (!weeks.length) return null;
  const lo = Math.min(0, ...weeks.map((x) => x.p10));
  const hi = Math.max(0, ...weeks.map((x) => x.p90));
  const span = hi - lo || 1;
  const x = (i: number) => padL + (weeks.length === 1 ? 0 : (i / (weeks.length - 1)) * (w - padL - padR));
  const y = (v: number) => padT + (1 - (v - lo) / span) * (h - padT - padB);
  const band = [...weeks.map((p, i) => `${x(i).toFixed(1)},${y(p.p90).toFixed(1)}`), ...weeks.map((p, i) => `${x(weeks.length - 1 - i).toFixed(1)},${y(weeks[weeks.length - 1 - i]!.p10).toFixed(1)}`)].join(' ');
  const median = weeks.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.median).toFixed(1)}`).join(' ');
  const ticks = [hi, (hi + lo) / 2, lo];
  const first = weeks[0]!;
  const last = weeks.at(-1)!;
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label={`Weekly profit forecast, median ${money(first.median)} next week to ${money(last.median)} in week ${weeks.length}`}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={padL} x2={w - padR} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth="1" />
            <text x={padL - 6} y={y(v) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--muted)" className="tabular-nums">
              {money(v)}
            </text>
          </g>
        ))}
        {lo < 0 && hi > 0 ? <line x1={padL} x2={w - padR} y1={y(0)} y2={y(0)} stroke="var(--line-strong)" strokeDasharray="3 3" strokeWidth="1" /> : null}
        <polygon points={band} fill="var(--accent)" opacity="0.14" />
        <path d={median} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {weeks.map((p, i) => (
          <circle key={p.weekStart} cx={x(i)} cy={y(p.median)} r="2.4" fill={p.median < 0 ? 'var(--danger)' : 'var(--accent)'}>
            <title>{`Week of ${SHORT.format(new Date(`${p.weekStart}T00:00:00Z`))}: median ${money(p.median)} (P10 ${money(p.p10)}, P90 ${money(p.p90)})`}</title>
          </circle>
        ))}
        <text x={padL} y={h - 6} fontSize="10.5" fill="var(--muted)">
          {SHORT.format(new Date(`${first.weekStart}T00:00:00Z`))}
        </text>
        <text x={w - padR} y={h - 6} fontSize="10.5" fill="var(--muted)" textAnchor="end">
          {SHORT.format(new Date(`${last.weekStart}T00:00:00Z`))}
        </text>
      </svg>
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
