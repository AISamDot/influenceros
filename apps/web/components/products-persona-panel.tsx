import type { Db } from '@ios/db';
import Link from 'next/link';
import { FILE_LABEL, fileHref, productCards, stageLine } from '@/app/products/_data';

const TONE: Record<string, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  muted: 'bg-surface-3 text-muted',
};

/**
 * Persona page panel for stream H (docs/IOS-34-CONTRACTS.md §4): the Product Builder's status for this persona:
 * builds, QP results, PDFs and what waits for the Owner. A failure here never takes the persona page down.
 */
export async function ProductsPersonaPanel({ db, studioId, personaId }: { db: Db; studioId: string; personaId: string; slug: string }) {
  let rows;
  try {
    rows = await productCards(db, { studioId, personaId });
  } catch {
    return null;
  }
  if (!rows.length) return null;
  return (
    <section className="card p-4" aria-label="Products">
      <div className="flex items-center justify-between gap-2">
        <h2 className="eyebrow">Products · Product Builder</h2>
        <Link href="/products" className="text-[12.5px] text-muted hover:text-fg">
          All products →
        </Link>
      </div>
      <ul className="mt-3 divide-y divide-line">
        {rows.slice(0, 6).map((r) => {
          const stage = stageLine(r);
          const pdfs = r.files.filter((f) => f.kind === 'pdf');
          return (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div className="min-w-0">
                <Link href={`/products#${r.id}`} className="text-[13.5px] font-medium hover:underline">
                  {r.name}
                </Link>
                <div className="text-[12px] text-muted">
                  {r.version ? `v${r.version}` : 'not built'}
                  {r.pages ? ` · ${r.pages} pages` : ''}
                  {r.qp_score !== null ? ` · QP ${Math.round(r.qp_score)}` : ''}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={`pill ${TONE[stage.tone]}`}>{stage.label}</span>
                {pdfs.map((f) => (
                  <a key={f.pageSize} href={fileHref(f)} target="_blank" rel="noreferrer" className="pill border border-line bg-surface text-fg">
                    {FILE_LABEL[f.kind]} {f.pageSize === 'Letter' ? 'Letter' : 'A4'}
                  </a>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
