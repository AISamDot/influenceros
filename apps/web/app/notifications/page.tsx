import { listNotifications } from '@ios/core';
import { relative } from '@/lib/format';
import { studioContext } from '@/lib/server';
import { requireOwnerPage } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Notifications' };

const TONE = { critical: 'bg-danger', warn: 'bg-warn', info: 'bg-accent' } as const;

export default async function Notifications() {
  await requireOwnerPage();
  const { db, studio } = await studioContext();
  const items = await listNotifications(db, studio.id, 100);
  const unread = items.filter((n) => !n.read_at).length;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-[44px] leading-none tracking-tight">Notifications</h1>
          <p className="mt-2 text-muted">Approvals, escalations, budget alerts and digests. {unread} unread.</p>
        </div>
        {unread ? (
          <form action="/api/notifications/read" method="post">
            <button className="btn">Mark all read</button>
          </form>
        ) : null}
      </div>
      <div className="card divide-y divide-line">
        {items.map((n) => {
          const body = (
            <>
              <span className={`mt-1.5 size-2 shrink-0 rounded-full ${TONE[n.severity]}`} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[14px] font-semibold">{n.title}</span>
                  <span className="text-[12px] text-muted">{relative(new Date(n.created_at))}</span>
                </span>
                {n.body ? <span className="mt-0.5 block text-[13px] text-muted">{n.body}</span> : null}
                <span className="mt-1 block text-[11px] font-semibold uppercase tracking-wide text-muted">{n.kind}</span>
              </span>
            </>
          );
          const row = `flex w-full gap-3 px-4 py-3 text-left ${n.read_at ? 'opacity-60' : ''}`;
          // Opening a notification marks it read, then follows its link. Rows without a link aren't links.
          return n.link ? (
            <form key={n.id} action="/api/notifications/read" method="post">
              <input type="hidden" name="id" value={n.id} />
              <input type="hidden" name="next" value={n.link} />
              <button className={`${row} cursor-pointer transition hover:bg-surface-2/60`}>{body}</button>
            </form>
          ) : (
            <div key={n.id} className={row}>
              {body}
            </div>
          );
        })}
        {items.length === 0 ? <p className="px-4 py-6 text-center text-muted">All quiet.</p> : null}
      </div>
    </div>
  );
}
