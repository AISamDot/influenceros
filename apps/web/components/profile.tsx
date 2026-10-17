import type { ReactNode } from 'react';

/** Renders the deep persona profile (Persona Bible, PRD Appendix A) from its JSONB content. */
const SECTIONS: Array<{ key: string; title: string; group: string; wide?: boolean }> = [
  { key: 'identity', title: 'Identity and AI label', group: 'Character' },
  { key: 'character_lore', title: 'Character lore', group: 'Character' },
  { key: 'worldview', title: 'Worldview and values', group: 'Character' },
  { key: 'expertise_map', title: 'Expertise map', group: 'Thinking' },
  { key: 'signature_frameworks', title: 'Signature frameworks', group: 'Thinking', wide: true },
  { key: 'positions_on_debates', title: 'Positions on debates', group: 'Thinking', wide: true },
  { key: 'news_beats', title: 'News beats and stance rules', group: 'Thinking' },
  { key: 'audience', title: 'Audience', group: 'Audience', wide: true },
  { key: 'voice', title: 'Voice', group: 'Voice and look' },
  { key: 'look', title: 'Look', group: 'Voice and look' },
  { key: 'content_dna', title: 'Content DNA', group: 'Content', wide: true },
  { key: 'engagement_style', title: 'Engagement style', group: 'Content', wide: true },
  { key: 'products', title: 'Products', group: 'Business' },
  { key: 'community', title: 'Community', group: 'Business' },
  { key: 'compliance', title: 'Compliance', group: 'Business' },
  { key: 'metrics', title: 'Metrics', group: 'Business' },
];

const label = (k: string) => k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function isPlainList(v: unknown[]): v is Array<string | number> {
  return v.every((x) => typeof x === 'string' || typeof x === 'number');
}

function Value({ v, depth = 0 }: { v: unknown; depth?: number }): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="text-faint">—</span>;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return <span>{String(v)}</span>;
  if (Array.isArray(v)) {
    if (isPlainList(v)) {
      const short = v.every((x) => String(x).length <= 34);
      return short ? (
        <div className="flex flex-wrap gap-1.5">
          {v.map((x, i) => (
            <span key={i} className="rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-[12.5px]">
              {String(x)}
            </span>
          ))}
        </div>
      ) : (
        <ul className="space-y-1">
          {v.map((x, i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-[7px] size-1 shrink-0 rounded-full bg-faint" />
              <span>{String(x)}</span>
            </li>
          ))}
        </ul>
      );
    }
    return (
      <div className={`grid gap-2 ${depth === 0 ? 'sm:grid-cols-2' : ''}`}>
        {v.map((x, i) => (
          <div key={i} className="rounded-xl border border-line bg-surface-2/60 p-3">
            <Value v={x} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }
  const entries = Object.entries(v as Record<string, unknown>);
  // A titled item ({name|debate|q|month…}) reads better with its title on top.
  const titleKey = ['name', 'debate', 'q', 'rung', 'keyword', 'month'].find((k) => typeof (v as Record<string, unknown>)[k] === 'string');
  return (
    <dl className="space-y-2">
      {titleKey ? <div className="text-[13.5px] font-semibold">{String((v as Record<string, unknown>)[titleKey])}</div> : null}
      {entries
        .filter(([k]) => k !== titleKey)
        .map(([k, val]) => (
          <div key={k}>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label(k)}</dt>
            <dd className="mt-0.5 text-[13.5px] leading-relaxed">
              {k === 'steps' && Array.isArray(val) ? (
                <ol className="space-y-1">
                  {val.map((s, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-ink text-[10.5px] font-bold text-on-ink">{i + 1}</span>
                      <span>{String(s)}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <Value v={val} depth={depth + 1} />
              )}
            </dd>
          </div>
        ))}
    </dl>
  );
}

/** Who approved a bible version, in words (persona creative decisions are delegated to the Studio Manager). */
export function approverLabel(approvedBy: string | null | undefined): string {
  if (!approvedBy) return 'Approved';
  if (approvedBy.startsWith('owner:')) return 'Approved by you';
  if (approvedBy === 'agent:studio-manager') return 'Approved by the Studio Manager';
  if (approvedBy === 'agent:persona-manager') return 'Approved by the persona manager';
  return `Approved by ${approvedBy.replace(/^(agent|system):/, '').replace(/-/g, ' ')}`;
}

export function Profile({ content, version, approvedAt, approvedBy }: { content: Record<string, unknown>; version: number; approvedAt: Date | null; approvedBy?: string | null }) {
  const groups = [...new Set(SECTIONS.map((s) => s.group))];
  const extra = Object.keys(content).filter((k) => !SECTIONS.some((s) => s.key === k));
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
        <span className="pill bg-ok-soft text-ok">Bible v{version}</span>
        {approvedAt ? (
          <span>
            {approverLabel(approvedBy)} {new Date(approvedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
        ) : null}
        <span>· Edit by chatting with the persona manager (TH-2)</span>
      </div>
      {groups.map((g) => (
        <section key={g}>
          <h2 className="eyebrow mb-3">{g}</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {SECTIONS.filter((s) => s.group === g).map((s) => (
              <article key={s.key} className={`card p-5 ${s.wide ? 'lg:col-span-2' : ''}`}>
                <h3 className="mb-3 font-[family-name:var(--font-display)] text-[24px] leading-none">{s.title}</h3>
                <Value v={content[s.key]} />
              </article>
            ))}
          </div>
        </section>
      ))}
      {extra.length ? (
        <section className="card p-5">
          <Value v={Object.fromEntries(extra.map((k) => [k, content[k]]))} />
        </section>
      ) : null}
    </div>
  );
}
