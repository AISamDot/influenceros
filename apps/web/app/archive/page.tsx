/* eslint-disable @next/next/no-img-element */
import { portraitUri } from '@ios/core';
import { archiveOverview, STEPS } from '@ios/generator';
import Link from 'next/link';
import { LifecycleBadge } from '@/components/badges';
import { Flash } from '@/components/flash';
import { SubmitButton } from '@/components/submit-button';
import { requireOwnerPage } from '@/lib/auth';
import { relative, STATE_LABEL } from '@/lib/format';
import { getServices } from '@/lib/services';
import { studioContext } from '@/lib/server';
import { restoreArchived, restoreDraftAction, restorePersonaAction } from '../generator/actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Archive' };

/**
 * The archive (Owner decision, 16 Oct): archived persona documents (the 14 Oct launch five), personas parked from the
 * studio, and archived drafts. Nothing here is deleted; every Restore goes back through the Owner.
 */
export default async function ArchivePage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  await requireOwnerPage();
  const sp = await searchParams;
  const { studio } = await studioContext();
  const o = await archiveOverview(await getServices(), studio.id);
  const labels = [...new Set(o.files.map((f) => f.label))];

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div>
        <div className="eyebrow">Everything kept · restore any time</div>
        <h1 className="font-[family-name:var(--font-display)] text-[44px] leading-none tracking-tight sm:text-[52px]">Archive</h1>
        <p className="mt-2 max-w-2xl text-[14px] text-muted">
          Restoring an archived persona imports its documents exactly (bible, product ladder, launch plan, Field Brain seed) as <b>proposed</b>; its launch then waits for you in
          the Persona Generator&rsquo;s review step. A persona archived from the studio comes back to the state it left.
        </p>
        <p className="mt-1.5 max-w-2xl text-[13px] text-muted">
          The product manuscripts (&ldquo;Kept&rdquo; below) stay as files: products come back as names, rungs and prices, and v1 is built from the manuscript (
          <code className="text-[12px]">pnpm products import &lt;file&gt; --persona &lt;slug&gt;</code>), not from a new brief.
        </p>
      </div>
      <Flash error={sp.error} ok={sp.ok} />

      {labels.map((label) => (
        <section key={label} className="space-y-3">
          <h2 className="eyebrow">Archived {label} · {o.files.filter((f) => f.label === label).length} personas</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {o.files
              .filter((f) => f.label === label)
              .map((f) => (
                <article key={`${label}-${f.slug}`} className="card flex min-w-0 gap-4 p-4">
                  <img src={portraitUri(f.name, f.hue)} alt="" className="h-[96px] w-[78px] shrink-0 rounded-[12px] object-cover" />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-[family-name:var(--font-display)] text-[24px] leading-tight">{f.name}</h3>
                    <p className="text-[12.5px] text-muted">
                      <span className="capitalize">{f.niche}</span>
                      {f.subNiche ? ` · ${f.subNiche}` : ''} · bible {f.bibleLabel ?? 'v1'} · {f.products} products
                    </p>
                    {f.productDocs.length ? <p className="mt-1 break-words text-[11.5px] text-faint">Kept as files: {f.productDocs.join(', ')}</p> : null}
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      {f.inStudio ? (
                        f.inStudio.state === 'ARCHIVED' ? (
                          <form action={restorePersonaAction}>
                            <input type="hidden" name="persona_id" value={f.inStudio.id} />
                            <SubmitButton className="btn btn-sm btn-ink">Restore</SubmitButton>
                          </form>
                        ) : (
                          <>
                            <LifecycleBadge state={f.inStudio.state} />
                            {f.inStudio.state === 'PROPOSED' && f.inStudio.draftId ? (
                              <Link href={`/generator/${f.inStudio.draftId}?step=7`} className="btn btn-sm btn-ink">
                                Review and launch →
                              </Link>
                            ) : (
                              <span className="text-[12px] text-muted">in the studio</span>
                            )}
                          </>
                        )
                      ) : (
                        <form action={restoreArchived}>
                          <input type="hidden" name="slug" value={f.slug} />
                          <input type="hidden" name="label" value={label} />
                          <SubmitButton className="btn btn-sm btn-ink">Restore for review</SubmitButton>
                        </form>
                      )}
                    </div>
                  </div>
                </article>
              ))}
          </div>
        </section>
      ))}
      {labels.length === 0 ? <p className="text-[13px] text-muted">No archived persona documents.</p> : null}

      <section className="space-y-3">
        <h2 className="eyebrow">Archived from the studio · {o.parked.length}</h2>
        {o.parked.length === 0 ? <p className="text-[13px] text-muted">None. Archive a persona from its page; everything is kept.</p> : null}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {o.parked.map((p) => (
            <article key={p.id} className="card flex min-w-0 gap-4 p-4">
              <img src={p.portrait_url ?? portraitUri(p.name, 210)} alt="" className="h-[96px] w-[78px] shrink-0 rounded-[12px] object-cover grayscale" />
              <div className="min-w-0 flex-1">
                <Link href={`/personas/${p.slug}`} className="block truncate font-[family-name:var(--font-display)] text-[24px] leading-tight hover:underline">
                  {p.name}
                </Link>
                <p className="text-[12.5px] text-muted">
                  <span className="capitalize">{p.niche}</span> · was {STATE_LABEL[p.from] ?? p.from} · archived {relative(new Date(p.archived_at))}
                </p>
                <p className="text-[12px] text-muted">
                  {p.bible_versions} bible version{p.bible_versions === 1 ? '' : 's'} · {p.products} products{p.reason ? ` · ${p.reason}` : ''}
                </p>
                <form action={restorePersonaAction} className="mt-2.5">
                  <input type="hidden" name="persona_id" value={p.id} />
                  <SubmitButton className="btn btn-sm btn-ink">Restore to {STATE_LABEL[p.from]?.toLowerCase() ?? p.from}</SubmitButton>
                </form>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="eyebrow">Archived drafts · {o.drafts.length}</h2>
        {o.drafts.length === 0 ? <p className="text-[13px] text-muted">None.</p> : null}
        <div className="card divide-y divide-line">
          {o.drafts.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]">
              <Link href={`/generator/${d.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
                {d.title}
              </Link>
              <span className="text-muted">
                step {d.current_step} · {STEPS[d.current_step - 1]?.title} · {d.archived_at ? relative(new Date(d.archived_at)) : ''}
              </span>
              <form action={restoreDraftAction}>
                <input type="hidden" name="draft_id" value={d.id} />
                <SubmitButton className="btn btn-sm">Restore</SubmitButton>
              </form>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
