/* eslint-disable @next/next/no-img-element */
import { StubHeader } from '@/components/stub';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Pipeline' };

const STAGES = [
  { key: 'idea', label: 'Idea', statuses: [] as string[] },
  { key: 'script', label: 'Script', statuses: ['planned', 'scripted'] },
  { key: 'voice', label: 'Voice', statuses: [] },
  { key: 'render', label: 'Render', statuses: ['rendering'] },
  { key: 'qc', label: 'QC', statuses: [] },
  { key: 'gate', label: 'Gate', statuses: ['qc'] },
  { key: 'scheduled', label: 'Scheduled', statuses: ['scheduled'] },
  { key: 'live', label: 'Live', statuses: ['live'] },
];

export default async function Pipeline() {
  const { db, studio } = await studioContext();
  const slots = await db.query<{ id: string; status: string; title: string; thumbnail_url: string | null; name: string }>(
    `SELECT s.id, s.status, s.title, s.thumbnail_url, p.name FROM calendar_slot s JOIN persona p ON p.id = s.persona_id
      WHERE p.studio_id = $1 AND s.slot_at > now() - interval '2 days' AND s.slot_at < now() + interval '7 days'
      ORDER BY s.slot_at`,
    [studio.id],
  );
  return (
    <div className="space-y-6">
      <StubHeader title="Pipeline" milestone="IOS-4" lead="Idea → Script → Voice → Render → QC → Gate → Scheduled → Live, with thumbnails and the reason for any block. Today it groups the calendar by status." />
      <div className="scroll-x pb-2">
        <div className="grid min-w-[1100px] grid-cols-8 gap-3">
          {STAGES.map((st) => {
            const items = slots.filter((s) => st.statuses.includes(s.status));
            return (
              <div key={st.key} className="rounded-2xl bg-surface-2 p-2">
                <div className="flex items-baseline justify-between px-1 pb-2">
                  <span className="text-[12.5px] font-semibold">{st.label}</span>
                  <span className="text-[11px] text-muted">{items.length}</span>
                </div>
                <div className="space-y-2">
                  {items.slice(0, 8).map((s) => (
                    <div key={s.id} className="flex gap-2 rounded-xl border border-line bg-surface p-1.5">
                      <img src={s.thumbnail_url ?? ''} alt="" className="h-12 w-[27px] shrink-0 rounded-md object-cover" />
                      <div className="min-w-0">
                        <div className="truncate text-[11px] font-semibold">{s.name}</div>
                        <div className="line-clamp-2 text-[11px] text-muted">{s.title}</div>
                      </div>
                    </div>
                  ))}
                  {items.length > 8 ? <div className="px-1 text-[11px] text-muted">+{items.length - 8} more</div> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
