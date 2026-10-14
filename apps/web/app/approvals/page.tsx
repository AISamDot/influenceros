/* eslint-disable @next/next/no-img-element */
import { type ApprovalRow, listPendingApprovals } from '@ios/core';
import Link from 'next/link';
import { Countdown } from '@/components/countdown';
import { IconCheck, IconClock, IconFlag, IconX } from '@/components/icons';
import { relative } from '@/lib/format';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Approvals' };

type Row = ApprovalRow & { persona_name: string | null; persona_slug: string | null; portrait_url: string | null };

const KIND_LABEL: Record<string, string> = {
  persona_kill: 'Kill persona',
  persona_retire: 'Retire persona',
  spend_over_cap: 'Spend above cap',
  plan_upgrade: 'Plan upgrade',
  disclosure_change: 'Disclosure text',
  legal_text_change: 'Legal text',
  persona_launch: 'Persona launch',
  product_v1: 'Product v1',
  post: 'Post',
};

function Decide({ id, approveLabel = 'Approve', rejectLabel = 'Reject', danger }: { id: string; approveLabel?: string; rejectLabel?: string; danger?: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      <form action={`/api/approvals/${id}`} method="post">
        <input type="hidden" name="decision" value="approve" />
        <button className={`btn ${danger ? 'btn-danger' : 'btn-ink'}`}>
          <IconCheck size={14} /> {approveLabel}
        </button>
      </form>
      <form action={`/api/approvals/${id}`} method="post">
        <input type="hidden" name="decision" value="reject" />
        <button className="btn">
          <IconX size={14} /> {rejectLabel}
        </button>
      </form>
    </div>
  );
}

function Who({ a }: { a: Row }) {
  return a.persona_slug ? (
    <Link href={`/personas/${a.persona_slug}`} className="flex items-center gap-2">
      <img src={a.portrait_url ?? ''} alt="" className="size-7 rounded-full object-cover" />
      <span className="text-[13px] font-medium">{a.persona_name}</span>
    </Link>
  ) : (
    <span className="text-[13px] font-medium">Studio</span>
  );
}

function Evidence({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries((payload.evidence ?? {}) as Record<string, unknown>);
  if (!entries.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {entries.map(([k, v]) => (
        <span key={k} className="pill bg-surface-2 font-medium text-muted">
          {k.replace(/_/g, ' ')}: <span className="text-fg">{String(v)}</span>
        </span>
      ))}
    </div>
  );
}

export default async function Approvals() {
  const { db, studio } = await studioContext();
  const pending = (await listPendingApprovals(db, studio.id)) as Row[];
  const kills = pending.filter((a) => a.kind === 'persona_kill' || a.kind === 'persona_retire');
  const explicit = pending.filter((a) => !kills.includes(a) && a.mode === 'explicit');
  const timed = pending.filter((a) => a.mode !== 'explicit');
  const recent = await db.query<Row>(
    `SELECT a.*, p.name AS persona_name, p.slug AS persona_slug, p.portrait_url FROM approval a LEFT JOIN persona p ON p.id = a.persona_id
      WHERE a.studio_id = $1 AND a.status <> 'pending' ORDER BY a.decided_at DESC NULLS LAST LIMIT 8`,
    [studio.id],
  );

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-[44px] leading-none tracking-tight">Approvals</h1>
        <p className="mt-2 text-muted">Kill proposals come first and never time out: a persona keeps running until you decide.</p>
      </div>

      <section className="space-y-3">
        <h2 className="eyebrow flex items-center gap-1.5 !text-danger">
          <IconFlag size={13} /> Kill and retire proposals · {kills.length}
        </h2>
        {kills.length === 0 ? <p className="text-[13px] text-muted">No kill proposals.</p> : null}
        {kills.map((a) => (
          <article key={a.id} className="card overflow-hidden">
            <div className="h-1 bg-danger" />
            <div className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Who a={a} />
                <span className="pill bg-danger-soft text-danger">
                  <IconClock size={12} /> No timeout · waits for you
                </span>
              </div>
              <h3 className="mt-3 text-[20px] font-semibold tracking-tight">{a.title}</h3>
              <p className="mt-1 text-[14px] leading-relaxed text-muted">{a.summary}</p>
              <Evidence payload={a.payload} />
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                <span className="text-[12px] text-muted">
                  Proposed by {a.proposed_by.replace('agent:', '')} · {relative(new Date(a.created_at))}
                </span>
                <Decide id={a.id} approveLabel="Approve kill" rejectLabel="Keep running" danger />
              </div>
            </div>
          </article>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="eyebrow">Needs your approval · {explicit.length}</h2>
        {explicit.length === 0 ? <p className="text-[13px] text-muted">Nothing else needs you.</p> : null}
        {explicit.map((a) => (
          <article key={a.id} className="card flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
            {typeof a.payload.thumbnail_url === 'string' ? <img src={a.payload.thumbnail_url} alt="" className="h-24 w-[54px] shrink-0 rounded-lg object-cover" /> : null}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="pill bg-warn-soft text-warn">{KIND_LABEL[a.kind]}</span>
                <Who a={a} />
              </div>
              <h3 className="mt-2 text-[15px] font-semibold">{a.title}</h3>
              {a.summary ? <p className="mt-0.5 text-[13px] text-muted">{a.summary}</p> : null}
            </div>
            <Decide id={a.id} />
          </article>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="eyebrow">Auto-approving cards · {timed.length}</h2>
        <p className="-mt-1 text-[12.5px] text-muted">
          Launches and product v1s approve themselves after 24 h; L1 posts publish after the veto window. Switch either off in Settings.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          {timed.map((a) => (
            <article key={a.id} className="card flex flex-col gap-3 p-4">
              <div className="flex gap-3">
                {typeof a.payload.thumbnail_url === 'string' ? <img src={a.payload.thumbnail_url} alt="" className="h-20 w-[45px] shrink-0 rounded-lg object-cover" /> : null}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="pill bg-accent-soft text-accent">{KIND_LABEL[a.kind]}</span>
                    <Who a={a} />
                  </div>
                  <h3 className="mt-2 text-[14.5px] font-semibold leading-snug">{a.title}</h3>
                  {a.summary ? <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted">{a.summary}</p> : null}
                </div>
              </div>
              {a.auto_approve_at ? (
                <Countdown
                  from={new Date(a.created_at).toISOString()}
                  to={new Date(a.auto_approve_at).toISOString()}
                  label={a.mode === 'veto_window' ? 'Publishes unless vetoed in' : 'Auto-approves in'}
                />
              ) : null}
              <Decide id={a.id} approveLabel={a.mode === 'veto_window' ? 'Approve now' : 'Approve'} rejectLabel={a.mode === 'veto_window' ? 'Veto' : 'Reject'} />
            </article>
          ))}
        </div>
        {timed.length === 0 ? <p className="text-[13px] text-muted">No timed cards.</p> : null}
      </section>

      <section className="space-y-2">
        <h2 className="eyebrow">Recent decisions</h2>
        <div className="card divide-y divide-line">
          {recent.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className={`pill ${a.status === 'rejected' ? 'bg-danger-soft text-danger' : a.status === 'withdrawn' ? 'bg-surface-3 text-muted' : 'bg-ok-soft text-ok'}`}>
                {a.status.replace('_', ' ')}
              </span>
              <span className="min-w-0 flex-1 truncate">{a.title}</span>
              <span className="text-muted">{a.decided_by}</span>
              <span className="text-faint">{a.decided_at ? relative(new Date(a.decided_at)) : ''}</span>
            </div>
          ))}
          {recent.length === 0 ? <p className="px-4 py-3 text-[13px] text-muted">No decisions yet.</p> : null}
        </div>
      </section>
    </div>
  );
}
