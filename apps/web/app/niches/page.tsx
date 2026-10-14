import { Empty, StubHeader } from '@/components/stub';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Niches' };

export default async function Niches() {
  const { db, studio } = await studioContext();
  const rows = await db.query<{ niche: string; personas: string; nodes: number }>(
    `SELECT p.niche, string_agg(p.name, ', ' ORDER BY p.name) AS personas,
            (SELECT count(*) FROM knowledge_node k WHERE k.studio_id = $1 AND k.niche = p.niche)::int AS nodes
       FROM persona p WHERE p.studio_id = $1 GROUP BY p.niche ORDER BY p.niche`,
    [studio.id],
  );
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <StubHeader title="Niches" milestone="IOS-2" lead="The Studio Manager's scored niche candidates (demand, buyer intent, competition, product fit, seasonality, policy risk) and each niche's Field Brain." />
      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((r) => (
          <article key={r.niche} className="card p-4">
            <div className="eyebrow">Occupied niche</div>
            <h2 className="mt-1 text-[17px] font-semibold">{r.niche}</h2>
            <p className="text-[12.5px] text-muted">{r.personas}</p>
            <div className="mt-3 flex gap-2 text-[12px]">
              <span className="pill bg-surface-2 text-muted">Score: pending</span>
              <span className="pill bg-surface-2 text-muted">Field Brain: {r.nodes} nodes</span>
            </div>
          </article>
        ))}
      </div>
      <Empty>Candidate niches appear here once the Niche Analyst runs (IOS-2).</Empty>
    </div>
  );
}
