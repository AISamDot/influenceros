import type { GateCheck, QcCheck } from '@ios/agents';
import { IconCheck, IconFlag, IconX } from './icons';
import { VERDICT_STYLE } from './pipeline-card';

const SEVERITY: Record<string, string> = { blocker: 'text-danger', major: 'text-warn', minor: 'text-muted' };

/** One QC report's checks: failures first, each with its severity. */
export function QcChecks({ checks }: { checks: readonly QcCheck[] }) {
  const sorted = [...checks].sort((a, b) => Number(a.pass) - Number(b.pass));
  return (
    <ul className="divide-y divide-line text-[12.5px]">
      {sorted.map((c, i) => (
        <li key={`${c.check}-${i}`} className="flex items-start gap-2 py-1.5">
          {c.pass ? <IconCheck size={13} className="mt-0.5 shrink-0 text-ok" /> : <IconX size={13} className={`mt-0.5 shrink-0 ${SEVERITY[c.severity]}`} />}
          <span className="w-[118px] shrink-0 font-medium">{c.check.replace(/_/g, ' ')}</span>
          <span className={`min-w-0 flex-1 ${c.pass ? 'text-muted' : ''}`}>
            {c.message}
            {c.location ? <span className="text-muted"> · {c.location}</span> : null}
          </span>
          {!c.pass ? <span className={`shrink-0 text-[10.5px] font-semibold uppercase ${SEVERITY[c.severity]}`}>{c.severity}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** Gate checks: reds and ambers first, with the offending text and the compliant fix. */
export function GateChecks({ checks }: { checks: readonly GateCheck[] }) {
  const rank = { red: 0, amber: 1, green: 2 } as const;
  const sorted = [...checks].sort((a, b) => rank[a.verdict] - rank[b.verdict]);
  return (
    <ul className="divide-y divide-line text-[12.5px]">
      {sorted.map((c, i) => (
        <li key={`${c.rule}-${i}`} className="py-1.5">
          <div className="flex items-start gap-2">
            {c.verdict === 'green' ? <IconCheck size={13} className="mt-0.5 shrink-0 text-ok" /> : <IconFlag size={13} className={`mt-0.5 shrink-0 ${c.verdict === 'red' ? 'text-danger' : 'text-warn'}`} />}
            <span className="w-[150px] shrink-0 font-medium">{c.rule.replace(/_/g, ' ')}</span>
            <span className={`min-w-0 flex-1 ${c.verdict === 'green' ? 'text-muted' : ''}`}>{c.message}</span>
            {c.verdict !== 'green' ? <span className={`shrink-0 rounded-full px-1.5 py-px text-[9.5px] font-bold uppercase ${VERDICT_STYLE[c.verdict]}`}>{c.verdict}</span> : null}
          </div>
          {c.span ? <p className="ml-[21px] mt-1 rounded-md bg-surface-2 px-2 py-1 text-[12px] italic">“{c.span}”</p> : null}
          {c.fix ? <p className="ml-[21px] mt-1 text-[12px] text-muted">Fix: {c.fix}</p> : null}
        </li>
      ))}
    </ul>
  );
}
