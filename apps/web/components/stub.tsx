import type { ReactNode } from 'react';

export function StubHeader({ title, lead, milestone }: { title: string; lead: string; milestone: string }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="font-[family-name:var(--font-display)] text-[44px] leading-none tracking-tight">{title}</h1>
        <span className="pill border border-dashed border-line-strong text-muted">Stub · full view in {milestone}</span>
      </div>
      <p className="mt-2 max-w-2xl text-muted">{lead}</p>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-line-strong p-4 text-center text-[12.5px] text-muted">{children}</p>;
}
