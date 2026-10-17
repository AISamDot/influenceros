import type { ForecastBand, LeverAction, ProfitAction } from '@troupe/profit';
import type { ReactNode } from 'react';

/** Small shared pieces for the Profit card and the Money page (stream D). */

export function money(cents: number): string {
  const v = Math.round(cents / 100);
  return `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US')}`;
}

/** Unit economics (per post, RPM): cents precision below $10, so a $0.12 script doesn't read as "$0". */
export function centsMoney(cents: number): string {
  if (Math.abs(cents) >= 1000) return money(cents);
  const v = Math.abs(cents) / 100;
  return `${cents < 0 ? '−' : ''}$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function signedMoney(cents: number): string {
  const v = Math.round(cents / 100);
  return `${v < 0 ? '−' : '+'}$${Math.abs(v).toLocaleString('en-US')}`;
}

export const LEVER_LABEL: Record<string, string> = {
  cadence: 'Cadence',
  format_mix: 'Format mix',
  credit_reallocation: 'Credits',
  model_routing: 'Model routing',
  kill_candidate: 'Kill candidate',
  cap_raise: 'Cap raise',
  price_test: 'Price test',
  product: 'Product',
  other: 'Other',
};

export function LeverChip({ kind }: { kind: string }) {
  return <span className="pill shrink-0 border border-line bg-surface-2 text-muted">{LEVER_LABEL[kind] ?? kind}</span>;
}

export function Band({ band, label = '90-day range' }: { band: ForecastBand; label?: string }) {
  return (
    <span className="tabular-nums" title={`${label}: P10 ${money(band.p10)} · median ${money(band.median)} · P90 ${money(band.p90)}`}>
      {money(band.p10)} – {money(band.p90)}
    </span>
  );
}

export function Impact({ cents, measured }: { cents: number; measured?: number | null }) {
  return (
    <span className="whitespace-nowrap text-right tabular-nums">
      <span className={cents >= 0 ? 'text-ok' : 'text-danger'}>{signedMoney(cents)}</span>
      <span className="text-muted">/mo</span>
      {measured !== undefined && measured !== null ? (
        <span className="block text-[11px] text-muted">
          measured <span className={measured >= 0 ? 'text-ok' : 'text-danger'}>{signedMoney(measured)}</span>
        </span>
      ) : null}
    </span>
  );
}

export function ActionList({ actions, names, empty }: { actions: readonly ProfitAction[]; names: ReadonlyMap<string, string>; empty: ReactNode }) {
  if (!actions.length) return <p className="text-[12.5px] text-muted">{empty}</p>;
  return (
    <ol className="space-y-2.5">
      {actions.map((a) => (
        <li key={`${a.rank}-${a.title}`} className="flex gap-3">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-2 text-[11.5px] font-semibold tabular-nums text-muted">{a.rank}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[13px] font-medium leading-snug">{a.title}</span>
              {a.requiresOwner ? <span className="pill bg-warn-soft text-warn">Needs you</span> : null}
            </div>
            <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted" title={a.rationale}>
              {a.personaId && names.get(a.personaId) && !a.title.includes(names.get(a.personaId)!) ? `${names.get(a.personaId)}: ` : ''}
              {a.rationale}
            </p>
          </div>
          <div className="shrink-0 text-[12.5px] font-semibold">
            <Impact cents={a.expectedImpactCents} />
          </div>
        </li>
      ))}
    </ol>
  );
}

export function LeverLine({ lever, name }: { lever: LeverAction; name: string | null }) {
  return (
    <li className="flex items-start gap-2.5">
      <LeverChip kind={lever.lever} />
      <p className="min-w-0 flex-1 line-clamp-2 text-[12px] leading-snug text-muted" title={lever.rationale}>
        {name && !lever.rationale.startsWith(name) ? <span className="font-medium text-fg">{name}: </span> : null}
        {lever.rationale}
      </p>
      <span className="shrink-0 text-[12px] font-semibold">
        <Impact cents={lever.expectedImpactCents} />
      </span>
    </li>
  );
}
