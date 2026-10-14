import type { ReactNode } from 'react';
import { IconCheck, IconX } from './icons';

/** A status line on the sign-in pages. */
export function AuthNotice({ tone, children }: { tone: 'ok' | 'error'; children: ReactNode }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-[13.5px] ${tone === 'error' ? 'border-danger/40 bg-danger-soft text-danger' : 'border-ok/40 bg-ok-soft text-ok'}`}
    >
      {tone === 'error' ? <IconX size={15} className="mt-0.5 shrink-0" /> : <IconCheck size={15} className="mt-0.5 shrink-0" />}
      <span>{children}</span>
    </div>
  );
}
