'use client';

import { useEffect, useState } from 'react';

/** "Auto-approves in 17h 42m" with a progress bar over the whole window. */
export function Countdown({ from, to, label = 'Auto-approves in' }: { from: string; to: string; label?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  const left = Math.max(0, end - now);
  const pct = Math.min(100, Math.max(0, ((now - start) / Math.max(1, end - start)) * 100));
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  const text = left === 0 ? 'due now: approves on the next tick' : h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s).padStart(2, '0')}s`;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="text-muted">{left === 0 ? 'Auto-approve' : label}</span>
        <span className="font-semibold tabular-nums" suppressHydrationWarning>
          {text}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div className="h-full rounded-full bg-accent transition-[width] duration-1000" style={{ width: `${pct}%` }} suppressHydrationWarning />
      </div>
    </div>
  );
}
