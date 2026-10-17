import type { Briefing } from '@troupe/agents';

/** One persona's morning briefing: scored stories, why they matter, the take, and the fast-reaction ideas. */
export function NewsBriefing({ briefing }: { briefing: Briefing }) {
  if (!briefing.items.length) return <p className="text-[13px] text-muted">Quiet day: nothing scored above the bar.</p>;
  return (
    <div className="space-y-3">
      <ol className="space-y-2.5">
        {briefing.items.map((i) => (
          <li key={i.newsItemId} className="text-[13px]">
            <a href={i.url} target="_blank" rel="noopener noreferrer" className="font-semibold hover:underline">
              {i.title}
            </a>
            <span className="ml-1.5 text-[11.5px] tabular-nums text-muted">{i.score}</span>
            <p className="mt-0.5 text-muted">{i.whyItMatters}</p>
            <p className="mt-0.5 italic">{i.take}</p>
          </li>
        ))}
      </ol>
      {briefing.reactionIdeas.length ? (
        <div className="rounded-xl bg-accent-soft/60 p-3">
          <div className="eyebrow mb-1">Fast reactions</div>
          <ul className="space-y-1 text-[13px]">
            {briefing.reactionIdeas.map((r) => (
              <li key={`${r.newsItemId}-${r.title}`}>
                <span className="font-medium">{r.title}</span>
                <span className="text-muted"> · until {r.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
