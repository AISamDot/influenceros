import type { PersonaRow } from '@ios/core';
import { archivePersonaAction, restorePersonaAction } from '@/app/generator/actions';
import { STATE_LABEL, shortDate } from '@/lib/format';
import { SubmitButton } from './submit-button';

const escapePattern = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

/** Archived: a banner with Restore. Otherwise the "Archive persona" panel (soft archive; typed name once launched). */
export function PersonaArchiveBanner({ p }: { p: PersonaRow }) {
  if (p.state !== 'ARCHIVED') return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-line-strong bg-surface-2 px-4 py-3 text-[13.5px]">
      <span className="min-w-0 flex-1">
        <b>Archived</b>
        {p.archived_from_state ? ` from ${STATE_LABEL[p.archived_from_state]?.toLowerCase() ?? p.archived_from_state}` : ''}
        {p.archived_at ? ` on ${shortDate(new Date(p.archived_at))}` : ''}. Nothing runs; everything is kept.{p.archive_reason ? ` (${p.archive_reason})` : ''}
      </span>
      <form action={restorePersonaAction}>
        <input type="hidden" name="persona_id" value={p.id} />
        <SubmitButton className="btn btn-sm btn-ink">Restore</SubmitButton>
      </form>
    </div>
  );
}

export function PersonaArchivePanel({ p }: { p: PersonaRow }) {
  if (['ARCHIVED', 'KILLED', 'RETIRED'].includes(p.state)) return null;
  const launched = !((p.state === 'PROPOSED' || p.state === 'SETUP') && !p.launched_at);
  return (
    <section className="card p-4 text-[13px]" aria-label="Archive">
      <div className="eyebrow">Archive</div>
      <p className="mt-1 text-muted">
        Parks {p.name}: nothing plans, scripts or publishes; every bible version, product, post and thread is kept, and Restore brings it back to {STATE_LABEL[p.state]?.toLowerCase()}. Killing
        stays a separate decision with its own approval.
      </p>
      <details className="mt-3">
        <summary className="btn btn-sm cursor-pointer list-none [&::-webkit-details-marker]:hidden">Archive {p.name}…</summary>
        <form action={archivePersonaAction} className="mt-3 space-y-2 sm:w-96">
          <input type="hidden" name="persona_id" value={p.id} />
          <input type="hidden" name="back" value={`/personas/${p.slug}`} />
          {launched ? (
            <label className="block text-[12.5px]">
              {p.name} has launched. Type <b>{p.name}</b> to confirm.
              <input name="confirm" required pattern={escapePattern(p.name)} title={`Type ${p.name} exactly`} autoComplete="off" className="input mt-1" placeholder={p.name} />
            </label>
          ) : null}
          <input name="reason" maxLength={300} className="input" placeholder="Why (optional)" />
          <SubmitButton className="btn btn-sm btn-ink">Archive</SubmitButton>
        </form>
      </details>
    </section>
  );
}
