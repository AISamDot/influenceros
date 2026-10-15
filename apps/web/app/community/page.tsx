import { approvedCrisisText } from '@ios/distribution';
import Link from 'next/link';
import { CommunityClassPill } from '@/components/community-bits';
import { Flash } from '@/components/flash';
import { SubmitButton } from '@/components/submit-button';
import { requireOwnerPage } from '@/lib/auth';
import { relative } from '@/lib/format';
import { studioContext } from '@/lib/server';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Community' };

interface EscalationRow {
  id: string;
  severity: 'S1' | 'S2' | 'S3';
  category: string;
  summary: string | null;
  sla_due_at: Date | null;
  created_at: Date;
  persona_name: string | null;
  slug: string | null;
  source_type: string;
}

/**
 * Community (stream F): open S1/S2 escalations first (the bot has stopped replying to S1 people), the crisis helpline
 * approval, and what the community worker did over the last 7 days. Commenters' text is shown as plain text.
 */
export default async function Community({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  await requireOwnerPage();
  const sp = await searchParams;
  const { db, studio } = await studioContext();
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [escalations, recent, counts, paused, crisisText, pendingCrisis] = await Promise.all([
    db.query<EscalationRow>(
      `SELECT e.id, e.severity, e.category, e.summary, e.sla_due_at, e.created_at, e.source_type, p.name AS persona_name, p.slug
         FROM escalation e LEFT JOIN persona p ON p.id = e.persona_id
        WHERE p.studio_id = $1 AND e.status <> 'resolved' ORDER BY e.severity, e.created_at LIMIT 100`,
      [studio.id],
    ),
    db.query<{ id: string; platform: string; text: string; classification: string | null; action: string | null; status: string; created_at: Date; persona_name: string; reply: string | null }>(
      `SELECT c.id, c.platform, left(c.text, 240) AS text, c.classification, c.action, c.status, c.created_at, p.name AS persona_name, c.action_meta->>'reply_text' AS reply
         FROM comment c JOIN persona p ON p.id = c.persona_id WHERE p.studio_id = $1 ORDER BY c.created_at DESC LIMIT 40`,
      [studio.id],
    ),
    db.query<{ action: string | null; n: number }>(
      `SELECT c.action, count(*)::int AS n FROM comment c JOIN persona p ON p.id = c.persona_id WHERE p.studio_id = $1 AND c.created_at > $2 GROUP BY 1`,
      [studio.id, since],
    ),
    db.one<{ n: number }>(`SELECT count(*)::int AS n FROM dm_thread t JOIN persona p ON p.id = t.persona_id WHERE p.studio_id = $1 AND t.status = 'bot_paused'`, [studio.id]),
    getServices()
      .then((s) => approvedCrisisText(s, studio.id))
      .catch(() => null),
    db.maybeOne(`SELECT 1 FROM approval WHERE studio_id = $1 AND kind = 'legal_text_change' AND status = 'pending' AND payload->>'purpose' = 'crisis_helpline'`, [studio.id]),
  ]);
  const count = (a: string) => counts.filter((c) => c.action === a).reduce((x, c) => x + c.n, 0);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-[44px] leading-none tracking-tight">Community</h1>
        <p className="mt-2 max-w-2xl text-muted">
          Comments and DMs are classified and handled by policy: spam hidden, replies in voice through the Gate, keyword DMs with the link. Crisis, minors, threats and press stop the bot and come to you.
        </p>
      </div>
      <Flash error={sp.error} ok={sp.ok} />

      <section className="card p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-[family-name:var(--font-display)] text-[26px] leading-none">Crisis helpline reply</h2>
            <p className="mt-1 text-[12.5px] text-muted">
              {crisisText ? 'Approved. It is the only thing the bot sends to someone in crisis.' : 'Not approved yet: crisis threads pause and alert you, and nothing is sent.'}
            </p>
          </div>
          {crisisText ? null : pendingCrisis ? (
            <Link href="/approvals" className="btn btn-sm btn-ink">
              Review in Approvals
            </Link>
          ) : (
            <form action="/api/distribution/community" method="post">
              <input type="hidden" name="action" value="crisis_text" />
              <SubmitButton className="btn btn-sm btn-ink">Propose the default text</SubmitButton>
            </form>
          )}
        </div>
        {crisisText ? <p className="mt-3 rounded-xl bg-surface-2 p-3 text-[12.5px]">{crisisText}</p> : null}
      </section>

      <section className="card p-5 sm:p-6">
        <h2 className="font-[family-name:var(--font-display)] text-[26px] leading-none">Escalations</h2>
        <p className="mt-1 text-[12.5px] text-muted">S1 within 5 minutes, S2 within 4 hours. {paused.n ? `${paused.n} DM thread${paused.n === 1 ? '' : 's'} paused.` : ''}</p>
        <div className="mt-3 divide-y divide-line">
          {escalations.map((e) => (
            <div key={e.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className={`pill border ${e.severity === 'S1' ? 'border-danger/40 text-danger' : 'border-warn/40 text-warn'}`}>{e.severity}</span>
                  <span className="font-semibold">{e.persona_name ?? 'Studio'}</span>
                  <span className="text-muted">{e.category.replace(/_/g, ' ')} · {e.source_type === 'dm_thread' ? 'DM' : 'comment'} · {relative(new Date(e.created_at))}</span>
                </div>
                {e.summary ? <p className="mt-1 break-words text-[12.5px] text-muted">{e.summary}</p> : null}
              </div>
              <form action="/api/distribution/community" method="post" className="flex items-center gap-2">
                <input type="hidden" name="action" value="resolve" />
                <input type="hidden" name="escalationId" value={e.id} />
                <label className="flex items-center gap-1.5 text-[12px] text-muted">
                  <input type="checkbox" name="resume" value="1" className="size-3.5" /> let the bot reply again
                </label>
                <SubmitButton className="btn btn-sm">Resolve</SubmitButton>
              </form>
            </div>
          ))}
          {!escalations.length ? <p className="py-3 text-[12.5px] text-muted">Nothing open.</p> : null}
        </div>
      </section>

      <section className="card p-5 sm:p-6">
        <h2 className="font-[family-name:var(--font-display)] text-[26px] leading-none">Last 7 days</h2>
        <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-5">
          {[
            ['Replies', count('reply')],
            ['Keyword DMs', count('dm')],
            ['Hidden', count('hide')],
            ['Escalated', count('escalate') + count('helpline')],
            ['Held by the Gate', count('held')],
          ].map(([label, n]) => (
            <div key={label} className="rounded-xl bg-surface-2 p-3">
              <div className="text-[11.5px] text-muted">{label}</div>
              <div className="text-[20px] font-semibold tabular-nums">{n}</div>
            </div>
          ))}
        </div>
        <div className="mt-4 divide-y divide-line">
          {recent.map((c) => (
            <div key={c.id} className="py-2.5 text-[12.5px]">
              <div className="flex flex-wrap items-center gap-2">
                <CommunityClassPill cls={c.classification} />
                <span className="font-medium">{c.persona_name}</span>
                <span className="text-muted">
                  {c.platform} · {c.action ?? 'new'} · {relative(new Date(c.created_at))}
                </span>
              </div>
              <p className="mt-1 break-words">{c.text}</p>
              {c.reply ? <p className="mt-0.5 break-words text-muted">↳ {c.reply}</p> : null}
            </div>
          ))}
          {!recent.length ? <p className="py-3 text-[12.5px] text-muted">No comments yet.</p> : null}
        </div>
      </section>
    </div>
  );
}
