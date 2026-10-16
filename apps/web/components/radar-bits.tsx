import type { FormatBenchmark } from '@ios/agents';
import type { PostFormat } from '@ios/core';
import { FORMAT_LABEL } from '@ios/radar';

/** Small presentational pieces for the Radar page and panels (stream I). Server components, no client state. */

export function RadarSpendMeter({ usedUsd, capUsd, runs, capped }: { usedUsd: number; capUsd: number; runs: number; capped: number }) {
  const pct = capUsd > 0 ? Math.min(100, Math.round((usedUsd / capUsd) * 100)) : 100;
  const tone = pct >= 90 ? 'radar-meter-hot' : pct >= 60 ? 'radar-meter-warm' : '';
  return (
    <div>
      <div className="eyebrow">Apify spend, last 7 days</div>
      <div className="mt-1 text-[22px] font-semibold tabular-nums">
        ${usedUsd.toFixed(2)} <span className="text-[14px] font-normal text-muted">of ${capUsd.toFixed(2)}</span>
      </div>
      <div className="radar-meter mt-2" role="meter" aria-valuemin={0} aria-valuemax={capUsd} aria-valuenow={usedUsd} aria-label="Apify spend against the weekly cap">
        <span className={tone} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1.5 text-[12px] text-muted">
        {runs} scraper run{runs === 1 ? '' : 's'} this week{capped ? `, ${capped} held back by the cap (they resume as spend rolls out of the 7-day window)` : ''}. Agents can propose a higher cap; only you change it.
      </p>
    </div>
  );
}

export function RadarFormatBars({ benchmark: b }: { benchmark: FormatBenchmark }) {
  const rows = (Object.entries(b.formatShare) as Array<[PostFormat, number]>).sort((a, c) => c[1] - a[1]);
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[14px] font-semibold">{b.niche}</h3>
        <span className="text-[11.5px] text-muted">
          {b.sample.posts} posts · {b.sample.accounts} accounts · {b.confidence} confidence{b.postsPerWeek !== null ? ` · fast growers post ~${b.postsPerWeek}/week` : ''}
        </span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {rows.map(([f, share]) => (
          <li key={f} className="grid grid-cols-[9.5rem_1fr_4.5rem] items-center gap-2 text-[12.5px]">
            <span className="truncate">{FORMAT_LABEL[f] ?? f}</span>
            <span className="radar-bar" aria-hidden>
              <span style={{ width: `${Math.max(2, Math.round(share * 100))}%` }} />
            </span>
            <span className="text-right tabular-nums text-muted">
              {Math.round(share * 100)}%{b.formatLift[f] !== undefined ? ` · ${b.formatLift[f]}×` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
