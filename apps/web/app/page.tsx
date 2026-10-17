import { NotFoundError, studioTotals, studioWall } from '@troupe/core';
import { listDrafts } from '@troupe/generator';
import Link from 'next/link';
import { ChatPanel } from '@/components/chat-panel';
import { Kpi } from '@/components/kpi';
import { PersonaCard } from '@/components/persona-card';
import { ProfitCard } from '@/components/profit-card';
import { SetupHint } from '@/components/setup-hint';
import { compact, usd } from '@/lib/format';
import { loadChat, studioContext } from '@/lib/server';
import { requireOwnerPage } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function StudioWall() {
  await requireOwnerPage();
  let ctx;
  try {
    ctx = await studioContext();
  } catch (err) {
    if (err instanceof NotFoundError || /relation .* does not exist/.test(String(err))) return <SetupHint error={String(err)} />;
    throw err;
  }
  const { db, studio } = ctx;
  const [cards, totals, chat, drafts] = await Promise.all([
    studioWall(db, studio.id),
    studioTotals(db, studio.id),
    loadChat(db, studio.id, 'studio'),
    listDrafts(db, studio.id, 'active'),
  ]);
  const views = cards.reduce((a, c) => a + c.totals.views7d, 0);
  const revenue = cards.reduce((a, c) => a + c.totals.revenue7dCents, 0);
  const testing = cards.filter((c) => c.persona.state === 'TESTING').length;
  const today = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow">{today}</div>
          <h1 className="font-[family-name:var(--font-display)] text-[44px] leading-none tracking-tight sm:text-[52px]">The studio</h1>
          <p className="mt-2 text-[14px] text-muted">
            {totals.live} {totals.live === 1 ? 'persona' : 'personas'} live · {testing} testing · {totals.setup} in setup · every post AI-labelled
          </p>
        </div>
      </div>

      {/* An empty studio: the way in comes first (on a phone it would otherwise sit under four zero tiles). */}
      {cards.length === 0 ? (
        <div className="card relative overflow-hidden p-6 sm:p-8">
          <div className="pointer-events-none absolute inset-0 opacity-[0.08]" style={{ background: 'radial-gradient(70% 90% at 100% 0%, var(--accent), transparent 60%)' }} />
          <div className="relative max-w-xl">
            <div className="eyebrow">An empty studio</div>
            <h2 className="mt-1 font-[family-name:var(--font-display)] text-[34px] leading-[1.05] tracking-tight">Create your first persona in the Persona Generator</h2>
            <p className="mt-2 text-[14px] text-muted">
              The Studio Manager ranks opportunities with evidence, drafts three concepts, then the character, look, voice, content and products. You pick, edit or mix at every step,
              and you approve the launch.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Link href="/generator" className="btn btn-ink">
                Open the Persona Generator
              </Link>
              <Link href="/archive" className="btn">
                Restore from the archive
              </Link>
            </div>
            <p className="mt-3 text-[12.5px] text-muted">The 14 Oct launch five (Rosa, Margot, Dot, Walt, Ambrose) are archived with everything kept.</p>
          </div>
        </div>
      ) : null}

      {cards.length || totals.pending ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Live personas" value={totals.live} hint={`${totals.setup} in setup · ${cards.length} on the wall`} />
          <Kpi label="Views · 7 days" value={compact(views)} hint="all platforms" />
          <Kpi label="Revenue · 7 days" value={usd(revenue)} hint="store orders" tone="ok" />
          <Link href="/approvals" className="block">
            <Kpi
              label="Waiting for you"
              value={totals.pending}
              hint={totals.kills ? `${totals.kills} kill proposal${totals.kills > 1 ? 's' : ''} first` : 'approvals'}
              tone={totals.kills ? 'danger' : undefined}
            />
          </Link>
        </div>
      ) : null}

      {/* Profit Engine card (IOS-2 stream D owns components/profit-card.tsx; renders nothing until it lands). */}
      {cards.length ? <ProfitCard db={db} studioId={studio.id} /> : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 xl:order-2">
          <ChatPanel
            threadId={chat.thread.id}
            title="Studio Manager"
            subtitle="Runs the studio end to end · ask anything, @mention a persona"
            initial={chat.initial}
            mode={chat.mode}
            placeholder="Ask the Studio Manager… (try @amos)"
            className="h-[420px] xl:sticky xl:top-20 xl:h-[calc(100dvh-7rem)]"
          />
        </div>
        <section className="min-w-0 space-y-4 xl:order-1" aria-label="Personas">
          {drafts.length ? (
            <Link href="/generator" className="card flex items-center gap-3 px-4 py-3 text-[13.5px] transition hover:shadow-lift">
              <span className="pill bg-accent-soft text-accent">Generator</span>
              <span className="min-w-0 flex-1 truncate">
                {drafts.length} persona draft{drafts.length === 1 ? '' : 's'} in progress: {drafts.slice(0, 3).map((d) => d.title).join(', ')}
              </span>
              <span className="text-muted">Continue →</span>
            </Link>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            {cards.map((c) => (
              <PersonaCard key={c.persona.id} card={c} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
