import type { OpportunityEvidence } from '@troupe/agents';
import type { DraftRow } from '@troupe/generator';
import Link from 'next/link';

/**
 * Persona Generator step 1 "Opportunity" (stream I, docs/IOS-5-CONTRACTS.md §5.5): the Growth Radar evidence behind
 * the ranked niches: accelerating accounts, trends, format gaps and monetisation patterns from the studio's own scans
 * (flag 'S'). Read-only: the base merged it into each option's evidence and kept it in `draft.state.radar`. Our words
 * and numbers only (never a scraped caption). Returns null on any error.
 */
const SIGNAL: Record<OpportunityEvidence['signal'], string> = { trend: 'Trend', gap: 'Gap', demand: 'Demand', competition: 'Competition' };

export async function RadarGeneratorPanel({ draft }: { draft: DraftRow; studioId: string }) {
  try {
    const radar = draft.state?.radar ?? null;
    const evidence = (radar?.evidence ?? []).slice(0, 8);
    const niches = new Set((draft.state?.opportunity?.options ?? []).map((o) => o.niche.toLowerCase()));
    return (
      <section className="card p-4" aria-label="Growth Radar evidence">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="eyebrow">Growth Radar evidence</h3>
          <Link href="/radar" className="text-[12px] text-muted hover:text-fg">
            Open Radar
          </Link>
        </div>
        {evidence.length ? (
          <ul className="mt-2 space-y-1.5 text-[12.5px]">
            {evidence.map((e, i) => (
              <li key={`${e.niche}-${e.signal}-${i}`} className="flex gap-2">
                <span className="pill shrink-0 bg-surface-2 text-muted">S · {SIGNAL[e.signal] ?? e.signal}</span>
                <span>
                  <b className={niches.has(e.niche.toLowerCase()) ? '' : 'text-muted'}>{e.niche}</b>: {e.detail} <span className="text-muted">({e.source})</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[12.5px] text-muted">
            No Radar data for these niches yet. The weekly scan picks up the niches of active drafts, so evidence appears here after the next run.
          </p>
        )}
        {radar?.at ? <p className="mt-2 text-[11.5px] text-muted">As of {new Date(radar.at).toISOString().slice(0, 10)}.</p> : null}
      </section>
    );
  } catch {
    return null;
  }
}
