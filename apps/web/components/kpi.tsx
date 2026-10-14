import type { ReactNode } from 'react';

export function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'danger' | 'ok' }) {
  return (
    <div className="card px-4 py-3.5">
      <div className="eyebrow">{label}</div>
      <div className={`mt-1 text-[26px] font-semibold tabular-nums tracking-tight ${tone === 'danger' ? 'text-danger' : tone === 'ok' ? 'text-ok' : ''}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-[12px] text-muted">{hint}</div> : null}
    </div>
  );
}
