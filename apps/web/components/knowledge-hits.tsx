import type { KnowledgeHit } from '@ios/agents';

/** Retrieval results as content agents see them: kind, similarity, text and citations. */
export function KnowledgeHits({ hits }: { hits: readonly KnowledgeHit[] }) {
  if (!hits.length) return <p className="mt-4 text-[13px] text-muted">Nothing relevant yet. Build or refresh this niche&apos;s Field Brain.</p>;
  return (
    <ol className="mt-4 space-y-3">
      {hits.map((h) => (
        <li key={h.id} className="rounded-xl border border-line p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[14px] font-semibold">{h.title}</span>
            <span className="flex items-center gap-1.5 text-[11.5px] text-muted">
              <span className="pill bg-surface-2">{h.kind === 'node' ? 'Field Brain' : 'News'}</span>
              <span className="tabular-nums">{Math.round(h.score * 100)}% match</span>
              {h.lastVerifiedAt ? <span>· verified {h.lastVerifiedAt.toISOString().slice(0, 10)}</span> : <span>· unverified seed</span>}
            </span>
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">{h.text}</p>
          {h.citations.length ? (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {h.citations.map((c) => (
                <li key={c.url}>
                  <a href={c.url} target="_blank" rel="noopener noreferrer" className="pill border border-line text-[11.5px] hover:bg-surface-2" title={c.quote ?? c.url}>
                    {(c.title ?? c.url).slice(0, 60)}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-1.5 font-mono text-[10.5px] text-faint">evidence id {h.id}</div>
        </li>
      ))}
    </ol>
  );
}
