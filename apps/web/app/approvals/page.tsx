/* eslint-disable @next/next/no-img-element */
import { type ApprovalRow, listPendingApprovals, payloadHash } from '@ios/core';
import Link from 'next/link';
import { Countdown } from '@/components/countdown';
import { Flash } from '@/components/flash';
import { SubmitButton } from '@/components/submit-button';
import { IconCheck, IconClock, IconFlag, IconX } from '@/components/icons';
import { relative } from '@/lib/format';
import { studioContext } from '@/lib/server';
import { requireOwnerPage } from '@/lib/auth';

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
  qc_override: 'Publish anyway?',
  persona_archive: 'Archive persona',
};

/** A launch only the Owner approves (generator-created or restored): decided in the Persona Generator's review step. */
function LaunchReview({ a, draftId }: { a: Row; draftId: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Link href={`/generator/${draftId}?step=7`} className="btn btn-ink">
        Review and approve in the Generator →
      </Link>
      <form action={`/api/approvals/${a.id}`} method="post">
        <input type="hidden" name="decision" value="reject" />
        <SubmitButton className="btn">
          <IconX size={14} /> Reject
        </SubmitButton>
      </form>
    </div>
  );
}

/** QC failed on majors only: publishing anyway needs a reason (logged with the override). Blockers never get a card. */
function QcOverrideDecide({ a }: { a: Row }) {
  return (
    <div className="flex w-full flex-col gap-2 sm:w-80">
      <form action={`/api/approvals/${a.id}`} method="post" className="space-y-2">
        <input type="hidden" name="decision" value="approve" />
        <input type="hidden" name="payload_hash" value={payloadHash(a.payload)} />
        <textarea name="note" rows={2} required minLength={3} className="input h-auto py-2" placeholder="Why publish anyway? (required, logged)" aria-label="Reason for publishing anyway" />
        <SubmitButton className="btn btn-ink w-full justify-center">
          <IconCheck size={14} /> Publish anyway
        </SubmitButton>
      </form>
      <form action={`/api/approvals/${a.id}`} method="post">
        <input type="hidden" name="decision" value="reject" />
        <SubmitButton className="btn w-full justify-center">
          <IconX size={14} /> Keep it blocked
        </SubmitButton>
      </form>
    </div>
  );
}

function Decide({ a, approveLabel = 'Approve', rejectLabel = 'Reject' }: { a: Row; approveLabel?: string; rejectLabel?: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <form action={`/api/approvals/${a.id}`} method="post">
        <input type="hidden" name="decision" value="approve" />
        <input type="hidden" name="payload_hash" value={payloadHash(a.payload)} />
        <SubmitButton className="btn btn-ink">
          <IconCheck size={14} /> {approveLabel}
        </SubmitButton>
      </form>
      <form action={`/api/approvals/${a.id}`} method="post">
        <input type="hidden" name="decision" value="reject" />
        <SubmitButton className="btn">
          <IconX size={14} /> {rejectLabel}
        </SubmitButton>
      </form>
    </div>
  );
}

const escapePattern = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

/**
 * Kill/retire: "Keep running" is the primary action. Approving needs a second step: open the confirm panel and
 * type the persona's name (checked by the browser and again by the server), with an optional note.
 */
function KillDecide({ a }: { a: Row }) {
  const name = a.persona_name ?? 'Studio';
  const verb = a.kind === 'persona_retire' ? 'Retire' : 'Kill';
  return (
    <div className="flex flex-wrap items-start justify-end gap-2">
      <form action={`/api/approvals/${a.id}`} method="post">
        <input type="hidden" name="decision" value="reject" />
        <SubmitButton className="btn btn-ink">
          <IconX size={14} /> Keep running
        </SubmitButton>
      </form>
      <details className="w-full sm:w-auto">
        <summary className="btn btn-danger cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <IconCheck size={14} /> Approve {verb.toLowerCase()}…
        </summary>
        <form action={`/api/approvals/${a.id}`} method="post" className="mt-3 space-y-2 rounded-xl border border-danger/40 bg-danger-soft p-3 sm:w-80">
          <input type="hidden" name="decision" value="approve" />
          <input type="hidden" name="payload_hash" value={payloadHash(a.payload)} />
          <label className="block text-[12.5px] text-fg">
            {verb === 'Kill' ? 'This is permanent: a killed persona can only be retired.' : 'This retires the persona for good.'} Type{' '}
            <b>{name}</b> to confirm.
            <input
              name="confirm"
              required
              pattern={escapePattern(name)}
              title={`Type ${name} exactly`}
              autoComplete="off"
              className="input mt-1"
              placeholder={name}
            />
          </label>
          <textarea name="note" rows={2} className="input h-auto py-2" placeholder="Note (optional)" />
          <SubmitButton className="btn btn-danger w-full justify-center">
            {verb} {name}
          </SubmitButton>
        </form>
      </details>
    </div>
  );
}

const UNIT_LABEL: Record<string, string> = { llm_usd: 'USD of LLM spend', hf_credits: 'Higgsfield credits', media_usd: 'USD of media spend' };

/** Exactly what approving will execute, read from the payload (not the agent-written title). */
function Executes({ a, disclosure }: { a: Row; disclosure: string }) {
  const p = a.payload;
  if (a.kind === 'spend_over_cap') {
    return (
      <p className="mt-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px]">
        <span className="text-muted">Approving grants </span>
        <b className="tabular-nums">+{Number(p.amount).toLocaleString('en-US')}</b> {UNIT_LABEL[String(p.unit)] ?? String(p.unit)}
        <span className="text-muted"> for {String(p.period)}</span>
      </p>
    );
  }
  if (a.kind === 'disclosure_change') {
    return (
      <div className="mt-2 grid gap-2 text-[13px] sm:grid-cols-2">
        <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
          <div className="eyebrow">Current</div>
          <p className="mt-1 whitespace-pre-wrap text-muted">{disclosure || '(none)'}</p>
        </div>
        <div className="rounded-lg border border-warn/50 bg-warn-soft px-3 py-2">
          <div className="eyebrow">Replaced with</div>
          <p className="mt-1 whitespace-pre-wrap font-medium">{String(p.text ?? '')}</p>
        </div>
      </div>
    );
  }
  if (a.kind === 'qc_override') {
    const failing = Array.isArray(p.failing) ? (p.failing as Array<{ check: string; severity: string; message: string; location?: string | null; platform?: string }>) : [];
    return (
      <ul className="mt-2 space-y-1 rounded-lg border border-warn/50 bg-warn-soft px-3 py-2 text-[13px]">
        {failing.map((f, i) => (
          <li key={`${f.check}-${i}`}>
            <span className="font-medium">{f.severity}</span> · {f.platform ? `${f.platform}: ` : ''}
            {f.message}
            {f.location ? <span className="text-muted"> ({f.location})</span> : null}
          </li>
        ))}
        {p.report_id ? <li className="text-muted">QC report {String(p.report_id).slice(0, 8)} · {String(p.stage ?? 'Q4')}</li> : null}
      </ul>
    );
  }
  if (a.kind === 'legal_text_change' || a.kind === 'plan_upgrade') {
    const entries = Object.entries(p).filter(([k]) => k !== 'thumbnail_url');
    if (!entries.length) return null;
    return (
      <dl className="mt-2 space-y-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px]">
        {entries.map(([k, v]) => (
          <div key={k}>
            <dt className="inline text-muted">{k.replace(/_/g, ' ')}: </dt>
            <dd className="inline whitespace-pre-wrap">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return null;
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

export default async function Approvals({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  await requireOwnerPage();
  const sp = await searchParams;
  const { db, studio } = await studioContext();
  const pending = (await listPendingApprovals(db, studio.id)) as Row[];
  const kills = pending.filter((a) => a.kind === 'persona_kill' || a.kind === 'persona_retire');
  const explicit = pending.filter((a) => !kills.includes(a) && a.mode === 'explicit');
  const timed = pending.filter((a) => a.mode !== 'explicit');
  const launchDrafts = new Map(
    (await db.query<{ persona_id: string; id: string }>(`SELECT persona_id, id FROM persona_draft WHERE studio_id = $1 AND status = 'active' AND persona_id IS NOT NULL`, [studio.id])).map((r) => [r.persona_id, r.id]),
  );
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
      <Flash error={sp.error} ok={sp.ok ? `Done: ${sp.ok}.` : undefined} />

      <section className="space-y-3">
        <h2 className="eyebrow flex items-center gap-1.5 !text-danger">
          <IconFlag size={13} /> Kill and retire proposals · {kills.length}
        </h2>
        {kills.length === 0 ? <p className="text-[13px] text-muted">No kill proposals.</p> : null}
        {kills.map((a) => (
          <article key={a.id} id={`approval-${a.id}`} className="scroll-mt-20 card overflow-hidden">
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
                <KillDecide a={a} />
              </div>
            </div>
          </article>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="eyebrow">Needs your approval · {explicit.length}</h2>
        {explicit.length === 0 ? <p className="text-[13px] text-muted">Nothing else needs you.</p> : null}
        {explicit.map((a) => (
          <article key={a.id} id={`approval-${a.id}`} className="scroll-mt-20 card flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
            {typeof a.payload.thumbnail_url === 'string' ? <img src={a.payload.thumbnail_url} alt="" className="h-24 w-[54px] shrink-0 rounded-lg object-cover" /> : null}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="pill bg-warn-soft text-warn">{KIND_LABEL[a.kind]}</span>
                <Who a={a} />
              </div>
              <h3 className="mt-2 text-[15px] font-semibold">{a.title}</h3>
              {a.summary ? <p className="mt-0.5 text-[13px] text-muted">{a.summary}</p> : null}
              <Executes a={a} disclosure={studio.resolved.disclosure_text} />
            </div>
            {a.kind === 'qc_override' ? (
              <QcOverrideDecide a={a} />
            ) : a.kind === 'persona_launch' && a.persona_id && launchDrafts.has(a.persona_id) ? (
              <LaunchReview a={a} draftId={launchDrafts.get(a.persona_id)!} />
            ) : (
              <Decide a={a} />
            )}
          </article>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="eyebrow">Auto-approving cards · {timed.length}</h2>
        <p className="-mt-1 text-[12.5px] text-muted">
          Product v1s approve themselves after 24 h; L1 posts publish after the veto window (switch either off in Settings). Persona launches never auto-approve.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          {timed.map((a) => (
            <article key={a.id} id={`approval-${a.id}`} className="scroll-mt-20 card flex flex-col gap-3 p-4">
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
              <Decide a={a} approveLabel={a.mode === 'veto_window' ? 'Approve now' : 'Approve'} rejectLabel={a.mode === 'veto_window' ? 'Veto' : 'Reject'} />
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
              <span className="text-muted">{a.decided_at ? relative(new Date(a.decided_at)) : ''}</span>
            </div>
          ))}
          {recent.length === 0 ? <p className="px-4 py-3 text-[13px] text-muted">No decisions yet.</p> : null}
        </div>
      </section>
    </div>
  );
}
