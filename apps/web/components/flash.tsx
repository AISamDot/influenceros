import { IconCheck, IconX } from './icons';

/** Result banner for native form posts and server actions (?error=… / ?ok=…). */
export function Flash({ error, ok }: { error?: string; ok?: string }) {
  if (!error && !ok) return null;
  return (
    <div
      role={error ? 'alert' : 'status'}
      className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-[13.5px] ${error ? 'border-danger/40 bg-danger-soft text-danger' : 'border-ok/40 bg-ok-soft text-ok'}`}
    >
      {error ? <IconX size={15} className="mt-0.5 shrink-0" /> : <IconCheck size={15} className="mt-0.5 shrink-0" />}
      <span>{error ? `Couldn't apply that: ${error}` : ok}</span>
    </div>
  );
}
