import { manuscriptsDir } from '@troupe/products';
import Link from 'next/link';
import { Flash } from '@/components/flash';
import { SubmitButton } from '@/components/submit-button';
import { requireOwnerPage } from '@/lib/auth';
import { relative, usd } from '@/lib/format';
import { studioContext } from '@/lib/server';
import { FILE_LABEL, fileHref, productCards, type ProductCardRow, stageLine } from './_data';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Products' };

const TONE: Record<string, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  muted: 'bg-surface-3 text-muted',
};

function ProductCard({ r }: { r: ProductCardRow }) {
  const stage = stageLine(r);
  const failing = (r.qp_checks ?? []).filter((c) => !c.pass);
  return (
    <article id={r.id} className="products-card card scroll-mt-20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`pill ${TONE[stage.tone]}`}>{stage.label}</span>
            <span className="pill bg-surface-2 text-muted">{r.ladder_rung.replace('_', ' ')}</span>
            <span className="pill bg-surface-2 text-muted">{r.price_cents ? usd(r.price_cents) : 'free'}</span>
            {r.source === 'manuscript' ? <span className="pill bg-surface-2 text-muted">manuscript</span> : null}
          </div>
          <h3 className="mt-2 text-[16px] font-semibold leading-snug">{r.name}</h3>
          <p className="mt-0.5 text-[12.5px] text-muted">
            {r.version ? `v${r.version}` : 'not built yet'}
            {r.pages ? ` · ${r.pages} pages` : ''}
            {r.qp_score !== null ? ` · QP ${Math.round(r.qp_score)}/100${r.qp_pass ? '' : ' (fail)'}` : ''}
            {r.fix_loops ? ` · ${r.fix_loops} fix loop${r.fix_loops > 1 ? 's' : ''}` : ''}
            {r.updated_at ? ` · ${relative(new Date(r.updated_at))}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {r.approval_id ? (
            <Link href={`/approvals#approval-${r.approval_id}`} className="btn btn-ink">
              Review v1
            </Link>
          ) : null}
          {r.status !== 'retired' && r.buildable && !r.job_status ? (
            <form action={`/api/products/${r.id}/build`} method="post">
              <SubmitButton className="btn">{r.version ? 'Rebuild' : 'Build now'}</SubmitButton>
            </form>
          ) : null}
        </div>
      </div>
      {r.files.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {r.files.map((f) => (
            <a key={`${f.kind}-${f.pageSize ?? f.label}`} href={fileHref(f)} target="_blank" rel="noreferrer" className="pill border border-line bg-surface text-fg hover:border-line-strong">
              {FILE_LABEL[f.kind] ?? f.kind}
              {f.pageSize ? ` · ${f.pageSize === 'Letter' ? 'US Letter' : 'A4'}` : ''}
              {f.bytes ? <span className="text-muted"> · {Math.max(1, Math.round(f.bytes / 1024))} KB</span> : null}
            </a>
          ))}
        </div>
      ) : null}
      {r.block_reason ? <p className="mt-3 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{r.block_reason}</p> : null}
      {!r.block_reason && failing.length ? (
        <ul className="mt-3 space-y-0.5 text-[12px] text-muted">
          {failing.map((c) => (
            <li key={c.check + c.message}>
              <b className={c.severity === 'minor' ? '' : 'text-danger'}>{c.check}</b> ({c.severity}): {c.message}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

export default async function Products({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  await requireOwnerPage();
  const sp = await searchParams;
  const { db, studio } = await studioContext();
  const rows = await productCards(db, { studioId: studio.id });
  const byPersona = new Map<string, ProductCardRow[]>();
  for (const r of rows) byPersona.set(r.persona_name, [...(byPersona.get(r.persona_name) ?? []), r]);
  const waiting = rows.filter((r) => r.status === 'awaiting_approval').length;
  const blocked = rows.filter((r) => r.build_status === 'blocked').length;

  return (
    <div className="space-y-6">
      <div>
        <div className="eyebrow">Product Builder</div>
        <h1 className="font-[family-name:var(--font-display)] text-[40px] leading-none tracking-tight">Products</h1>
        <p className="mt-2 max-w-2xl text-[14px] text-muted">
          Briefs and manuscripts become styled PDFs (A4 and US Letter) in each persona&apos;s colours, pass product QC and the Gate, then wait for your v1 approval.
          {` ${rows.length} products · ${waiting} waiting for you · ${blocked} blocked.`}
        </p>
      </div>
      <Flash error={sp.error} ok={sp.ok} />

      <section className="card p-4 text-[13px] text-muted">
        <b className="text-fg">Ready-written manuscripts:</b> drop a markdown file into <code className="text-fg">{manuscriptsDir()}/&lt;persona-slug&gt;/</code>. It is imported within a few minutes and rendered through the same pipeline. Use{' '}
        <code className="text-fg">## Section</code>, <code className="text-fg">### Rule: Name</code>, <code className="text-fg">- [ ] item</code>, <code className="text-fg">Fill in: prompt</code> and{' '}
        <code className="text-fg">### Tracker: Title</code>; front matter sets the title, price and the sections QC checks.
      </section>

      {rows.length === 0 ? <p className="text-[13px] text-muted">No products yet. The Monetization Agent briefs a lead magnet and an entry product for every persona.</p> : null}
      {[...byPersona].map(([persona, list]) => (
        <section key={persona} className="space-y-3">
          <h2 className="eyebrow">
            <Link href={`/personas/${list[0]!.persona_slug}`}>{persona}</Link> · {list.length}
          </h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {list.map((r) => (
              <ProductCard key={r.id} r={r} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
