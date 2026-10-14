/* eslint-disable @next/next/no-img-element */
import { BOARD_COLUMNS, type BoardItem, columnOf, pipelineBoard } from '@ios/content';
import { PUBLISHING_STATES } from '@ios/core';
import Link from 'next/link';
import { Empty } from '@/components/stub';
import { Flash } from '@/components/flash';
import { Kpi } from '@/components/kpi';
import { PipelineCard } from '@/components/pipeline-card';
import { SubmitButton } from '@/components/submit-button';
import { shortDate } from '@/lib/format';
import { studioContext } from '@/lib/server';
import { requireOwnerPage } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Pipeline' };

const DAY = 86_400_000;
const VIEWS = [
  { key: 'upcoming', label: 'Next 7 days' },
  { key: 'this', label: 'This week' },
  { key: 'next', label: 'Next week' },
] as const;
type View = (typeof VIEWS)[number]['key'];

function monday(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x;
}

function range(view: View, now: Date): { from: Date; to: Date } {
  if (view === 'this') return { from: monday(now), to: new Date(monday(now).getTime() + 7 * DAY) };
  if (view === 'next') return { from: new Date(monday(now).getTime() + 7 * DAY), to: new Date(monday(now).getTime() + 14 * DAY) };
  return { from: new Date(now.getTime() - DAY), to: new Date(now.getTime() + 8 * DAY) };
}

type SP = { view?: string; persona?: string; error?: string; ok?: string };

export default async function Pipeline({ searchParams }: { searchParams: Promise<SP> }) {
  await requireOwnerPage();
  const sp = await searchParams;
  const view: View = VIEWS.some((v) => v.key === sp.view) ? (sp.view as View) : 'upcoming';
  const { db, studio } = await studioContext();
  const personas = await db.query<{ id: string; slug: string; name: string; portrait_url: string | null; state: string }>(
    `SELECT id, slug, name, portrait_url, state FROM persona WHERE studio_id = $1 AND state NOT IN ('KILLED','RETIRED','PROPOSED') ORDER BY name`,
    [studio.id],
  );
  const selected = personas.find((p) => p.slug === sp.persona) ?? null;
  // Only publishing personas get weeks planned; personas in SETUP have their launch posts already on the calendar.
  const plannable = (selected ? [selected] : personas).some((p) => (PUBLISHING_STATES as readonly string[]).includes(p.state));
  const now = new Date();
  const { from, to } = range(view, now);
  const items = await pipelineBoard(db, studio.id, { from, to, personaId: selected?.id ?? null });
  const byColumn = new Map<string, BoardItem[]>();
  for (const i of items) {
    const col = columnOf(i.stage);
    if (!col) continue;
    byColumn.set(col, [...(byColumn.get(col) ?? []), i]);
  }
  const count = (...cols: string[]) => cols.reduce((a, c) => a + (byColumn.get(c)?.length ?? 0), 0);
  const gate = { green: 0, amber: 0, red: 0 };
  for (const i of items) if (i.gateVerdict) gate[i.gateVerdict] += 1;
  const href = (o: { view?: View; persona?: string | null }) => {
    const q = new URLSearchParams();
    const v = o.view ?? view;
    const p = o.persona === undefined ? selected?.slug : o.persona;
    if (v !== 'upcoming') q.set('view', v);
    if (p) q.set('persona', p);
    const s = q.toString();
    return `/pipeline${s ? `?${s}` : ''}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow">Content pipeline</div>
          <h1 className="font-[family-name:var(--font-display)] text-[44px] leading-none tracking-tight">Pipeline</h1>
          <p className="mt-2 max-w-2xl text-muted">
            Idea → script → QC → Gate → queued for media. Every post is planned, written, checked and queued automatically; this board shows where each one is
            and why anything stopped.
          </p>
        </div>
        <form action="/api/pipeline" method="post" className="flex flex-col items-end gap-1">
          <input type="hidden" name="action" value="plan_week" />
          <input type="hidden" name="week" value={view === 'this' ? 'this' : 'next'} />
          {selected ? <input type="hidden" name="persona_id" value={selected.id} /> : null}
          {plannable ? (
            <>
              <SubmitButton className="btn btn-ink">Plan {view === 'this' ? 'this' : 'next'} week now</SubmitButton>
              <span className="text-[11.5px] text-muted">Runs on its own every day; this just does it now.</span>
            </>
          ) : (
            <span className="max-w-[260px] text-right text-[12px] text-muted">
              {selected ? `${selected.name} is in ${selected.state}` : 'No persona is publishing yet'}: weeks are planned once publishing starts. The launch posts are already on the calendar.
            </span>
          )}
        </form>
      </div>
      <Flash error={sp.error} ok={sp.ok ? `Done: ${sp.ok}.` : undefined} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-full border border-line bg-surface p-0.5">
          {VIEWS.map((v) => (
            <Link key={v.key} href={href({ view: v.key })} className={`rounded-full px-3 py-1 text-[12.5px] font-medium ${v.key === view ? 'bg-ink text-on-ink' : 'text-muted hover:text-fg'}`}>
              {v.label}
            </Link>
          ))}
        </div>
        <div className="scroll-x no-scrollbar flex gap-1.5">
          <Link href={href({ persona: null })} className={`pill border ${!selected ? 'border-ink bg-ink text-on-ink' : 'border-line text-muted'}`}>
            All personas
          </Link>
          {personas.map((p) => (
            <Link key={p.id} href={href({ persona: p.slug })} className={`pill flex items-center gap-1.5 border ${selected?.id === p.id ? 'border-ink bg-ink text-on-ink' : 'border-line text-muted'}`}>
              <img src={p.portrait_url ?? ''} alt="" className="size-4 rounded-full object-cover" />
              {p.name.split(' ')[0]}
            </Link>
          ))}
        </div>
        <span className="ml-auto text-[12px] text-muted">
          {shortDate(from)} – {shortDate(new Date(to.getTime() - 1))} · times in each persona&apos;s zone
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Planned" value={items.length} hint={`${count('idea')} waiting for a script`} />
        <Kpi label="In QC and Gate" value={count('script', 'q1', 'gate')} hint={`Gate: ${gate.green} green · ${gate.amber} amber · ${gate.red} red`} />
        <Kpi label="Queued for media" value={count('media_queued', 'media')} hint="voice, render and final QC (IOS-3)" tone="ok" />
        <Kpi label="Blocked" value={count('blocked')} hint={count('blocked') ? 'QC blockers and Gate reds never ship' : 'nothing stopped'} tone={count('blocked') ? 'danger' : undefined} />
      </div>

      {items.length === 0 ? (
        <Empty>Nothing planned in this window yet. The calendar plans every active persona automatically; “Plan now” does it immediately.</Empty>
      ) : (
        <div className="scroll-x pb-2">
          <div className="grid min-w-[1720px] grid-cols-9 gap-3">
            {BOARD_COLUMNS.map((col) => {
              const list = byColumn.get(col.key) ?? [];
              return (
                <section key={col.key} aria-label={col.label} className={`rounded-2xl p-2 ${col.key === 'blocked' && list.length ? 'bg-danger-soft' : 'bg-surface-2'}`}>
                  <div className="flex items-baseline justify-between px-1 pb-2">
                    <span className="text-[12.5px] font-semibold">{col.label}</span>
                    <span className="text-[11px] tabular-nums text-muted">{list.length}</span>
                  </div>
                  {col.later && !list.length ? <p className="px-1 text-[11px] text-faint">Voice, Q2, render, Q3/Q4 and the final Gate arrive with IOS-3.</p> : null}
                  <div className="space-y-2">
                    {list.slice(0, 14).map((i) => (
                      <PipelineCard key={i.slotId} item={i} />
                    ))}
                    {list.length > 14 ? <div className="px-1 text-[11px] text-muted">+{list.length - 14} more</div> : null}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
