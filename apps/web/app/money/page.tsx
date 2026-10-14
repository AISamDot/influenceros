import { creditPeriod, ledgerSummary } from '@ios/core';
import { StubHeader } from '@/components/stub';
import { money, usd } from '@/lib/format';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Money' };

export default async function Money() {
  const { db, studio } = await studioContext();
  const period = creditPeriod(new Date());
  const [ledger, revenue] = await Promise.all([
    ledgerSummary(db, studio.id, period),
    db.query<{ name: string; orders: number; gross: number; fees: number }>(
      `SELECT p.name, count(o.id)::int AS orders, COALESCE(sum(o.amount_cents),0)::int AS gross, COALESCE(sum(o.fee_cents),0)::int AS fees
         FROM persona p LEFT JOIN orders o ON o.persona_id = p.id AND o.ordered_at >= date_trunc('month', now())
        WHERE p.studio_id = $1 GROUP BY p.name ORDER BY gross DESC`,
      [studio.id],
    ),
  ]);
  const caps = studio.resolved.caps;
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <StubHeader title="Money" milestone="IOS-4" lead={`P&L, credits and the budget ledger. Showing ${period}: store revenue and every metered provider debit.`} />
      <section className="card overflow-hidden">
        <h2 className="px-5 pb-2 pt-5 font-[family-name:var(--font-display)] text-[24px] leading-none">Revenue this month</h2>
        <table className="w-full text-[13px]">
          <tbody>
            {revenue.map((r) => (
              <tr key={r.name} className="border-t border-line">
                <td className="px-5 py-2 font-medium">{r.name}</td>
                <td className="px-2 py-2 text-right text-muted">{r.orders} orders</td>
                <td className="px-2 py-2 text-right tabular-nums">{usd(r.gross)}</td>
                <td className="px-5 py-2 text-right tabular-nums text-muted">fees {usd(r.fees)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card overflow-hidden">
        <h2 className="px-5 pb-1 pt-5 font-[family-name:var(--font-display)] text-[24px] leading-none">Credit ledger</h2>
        <p className="px-5 pb-2 text-[12px] text-muted">
          Studio caps: ${caps.llm_usd_month} LLM · {caps.hf_credits_month.toLocaleString()} Higgsfield credits per month.
        </p>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-t border-line text-left text-[11px] uppercase tracking-wide text-muted">
              <th className="px-5 py-2 font-semibold">Scope</th>
              <th className="px-2 py-2 font-semibold">Unit</th>
              <th className="px-2 py-2 text-right font-semibold">Spent</th>
              <th className="px-5 py-2 text-right font-semibold">Granted</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((l) => (
              <tr key={`${l.persona_id}-${l.unit}`} className="border-t border-line">
                <td className="px-5 py-2 font-medium">{l.name ?? 'Studio'}</td>
                <td className="px-2 py-2 text-muted">{l.unit.replace('_', ' ')}</td>
                <td className="px-2 py-2 text-right tabular-nums">{money(Number(l.debits ?? 0), l.unit)}</td>
                <td className="px-5 py-2 text-right tabular-nums text-muted">{l.grants ? money(Number(l.grants), l.unit) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
