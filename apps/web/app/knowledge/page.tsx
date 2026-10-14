import { latestBriefing } from '@ios/knowledge';
import { fieldBrainStatus } from '@ios/knowledge';
import Link from 'next/link';
import { Flash } from '@/components/flash';
import { KnowledgeHits } from '@/components/knowledge-hits';
import { NewsBriefing } from '@/components/news-briefing';
import { SubmitButton } from '@/components/submit-button';
import { relative, shortDate } from '@/lib/format';
import { studioContext } from '@/lib/server';
import { activeNiches, knowledgeProviders, knowledgeService } from './_data';
import { requireOwnerPage } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Knowledge' };

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

export default async function Knowledge({ searchParams }: { searchParams: Promise<{ q?: string; niche?: string; error?: string; ok?: string }> }) {
  await requireOwnerPage();
  const sp = await searchParams;
  const { db, studio } = await studioContext();
  const niches = await activeNiches(db, studio.id);
  const brains = await fieldBrainStatus({ db, providers: knowledgeProviders() }, studio.id);
  const q = (sp.q ?? '').trim().slice(0, 300);
  const niche = sp.niche && niches.includes(sp.niche.toLowerCase()) ? sp.niche.toLowerCase() : niches[0];
  const hits = q && niche ? await knowledgeService(db).retrieve({ studioId: studio.id, niche, query: q, k: 8 }) : null;

  const personas = await db.query<{ id: string; slug: string; name: string; niche: string; portrait_url: string | null }>(
    `SELECT id, slug, name, niche, portrait_url FROM persona WHERE studio_id = $1 AND state NOT IN ('KILLED','RETIRED') ORDER BY name`,
    [studio.id],
  );
  const briefings = await Promise.all(personas.map(async (p) => ({ persona: p, briefing: await latestBriefing(db, p.id) })));
  const news = await db.query<{ id: string; niche: string; title: string; url: string; score: number | null; kind: string; coverage: number; created_at: Date; source: string | null }>(
    `SELECT id, niche, title, url, score, kind, coverage, created_at, raw->>'source' AS source FROM news_item
      WHERE studio_id = $1 AND duplicate_of IS NULL AND created_at > now() - interval '48 hours'
      ORDER BY score DESC NULLS LAST, created_at DESC LIMIT 12`,
    [studio.id],
  );

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-[44px] leading-none tracking-tight">Knowledge</h1>
        <p className="mt-2 max-w-2xl text-muted">
          Each niche&apos;s Field Brain (cited curriculum, source canon, expert map) and the News Desk&apos;s morning briefings. Content agents cite these
          ids for every factual claim. Builds refresh weekly and the desk scans daily at 05:00 UTC, so these buttons are only for an extra run.
        </p>
      </div>
      <Flash error={sp.error} ok={sp.ok} />

      <section>
        <h2 className="eyebrow mb-3">Field Brains</h2>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {brains.map((b) => (
            <article key={b.niche} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-[17px] font-semibold capitalize">{b.niche}</h3>
                  <p className="text-[12.5px] text-muted">
                    {b.lastVerifiedAt ? `Last verified ${relative(new Date(b.lastVerifiedAt))}` : 'Seed only: not researched yet'}
                    {b.lastBuild ? ` · last build ${b.lastBuild.status} (${b.lastBuild.mode}), $${b.lastBuild.costUsd.toFixed(2)}` : ''}
                  </p>
                </div>
                <span className={`pill ${b.researched >= b.nodes && b.nodes ? 'bg-ok-soft text-ok' : 'bg-surface-2 text-muted'}`}>{pct(b.researched, b.nodes)}% researched</span>
              </div>
              <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                {[
                  ['Nodes', b.nodes],
                  ['Embedded', b.embedded],
                  ['Canon', b.canon],
                  ['Sources', b.sources],
                  ['Experts', b.experts],
                  ['Feeds', b.feeds],
                ].map(([label, v]) => (
                  <div key={label} className="rounded-lg bg-surface-2/60 px-2 py-1.5">
                    <dt className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">{label}</dt>
                    <dd className="text-[16px] font-semibold tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-3 flex flex-wrap gap-2">
                <form action="/api/knowledge/build" method="post">
                  <input type="hidden" name="niche" value={b.niche} />
                  <SubmitButton className="btn btn-sm">Rebuild</SubmitButton>
                </form>
                <form action="/api/news/scan" method="post">
                  <input type="hidden" name="niche" value={b.niche} />
                  <SubmitButton className="btn btn-sm">Scan news</SubmitButton>
                </form>
              </div>
            </article>
          ))}
          {brains.length === 0 ? <p className="text-muted">No niches yet.</p> : null}
        </div>
      </section>

      <section className="card p-4">
        <h2 className="eyebrow mb-3">Ask the Field Brain</h2>
        <form className="flex flex-wrap gap-2" method="get">
          <select name="niche" defaultValue={niche} className="input w-auto capitalize" aria-label="Niche">
            {niches.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <input name="q" defaultValue={q} placeholder="What do content agents get back for…" className="input min-w-[16rem] flex-1" aria-label="Query" />
          <button className="btn btn-ink">Search</button>
        </form>
        {hits ? <KnowledgeHits hits={hits} /> : null}
      </section>

      <section>
        <h2 className="eyebrow mb-3">Morning briefings</h2>
        <div className="grid gap-3 lg:grid-cols-2">
          {briefings.map(({ persona, briefing }) => (
            <article key={persona.id} className="card p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <Link href={`/personas/${persona.slug}`} className="text-[15px] font-semibold hover:underline">
                  {persona.name}
                </Link>
                <span className="text-[12px] text-muted">{briefing ? shortDate(new Date(`${briefing.date}T12:00:00Z`)) : 'No briefing yet'}</span>
              </div>
              {briefing ? <NewsBriefing briefing={briefing} /> : <p className="text-[13px] text-muted">The first one arrives after the next daily scan of {persona.niche}.</p>}
            </article>
          ))}
        </div>
      </section>

      <section>
        <h2 className="eyebrow mb-3">Top stories, last 48 hours</h2>
        <div className="card divide-y divide-line">
          {news.map((n) => (
            <a key={n.id} href={n.url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-3 px-4 py-2.5 transition hover:bg-surface-2/60">
              <span className="w-9 shrink-0 text-right text-[13px] font-semibold tabular-nums">{n.score ?? '–'}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px]">{n.title}</span>
                <span className="text-[11.5px] text-muted">
                  <span className="capitalize">{n.niche}</span> · {n.source ?? n.kind}
                  {n.coverage > 1 ? ` · ${n.coverage} outlets` : ''} · {relative(new Date(n.created_at))}
                </span>
              </span>
            </a>
          ))}
          {news.length === 0 ? <p className="px-4 py-6 text-center text-[13px] text-muted">No stories yet: the News Desk scans every day at 05:00 UTC.</p> : null}
        </div>
      </section>
    </div>
  );
}
