import { NotFoundError, studioTotals, studioWall } from '@ios/core';
import Link from 'next/link';
import { ChatPanel } from '@/components/chat-panel';
import { Kpi } from '@/components/kpi';
import { PersonaCard } from '@/components/persona-card';
import { ProfitCard } from '@/components/profit-card';
import { SetupHint } from '@/components/setup-hint';
import { compact, usd } from '@/lib/format';
import { loadChat, studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function StudioWall() {
  let ctx;
  try {
    ctx = await studioContext();
  } catch (err) {
    if (err instanceof NotFoundError || /relation .* does not exist/.test(String(err))) return <SetupHint error={String(err)} />;
    throw err;
  }
  const { db, studio } = ctx;
  const [cards, totals, chat] = await Promise.all([
    studioWall(db, studio.id),
    studioTotals(db, studio.id),
    loadChat(db, studio.id, 'studio'),
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
            {totals.active} personas live · {testing} testing · every post AI-labelled
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Active personas" value={totals.active} hint={`${cards.length} on the wall`} />
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

      {/* Profit Engine card (IOS-2 stream D owns components/profit-card.tsx; renders nothing until it lands). */}
      <ProfitCard db={db} studioId={studio.id} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 xl:order-2">
          <ChatPanel
            threadId={chat.thread.id}
            title="Studio Manager"
            subtitle="Runs the studio end to end · ask anything, @mention a persona"
            initial={chat.initial}
            placeholder="Ask the Studio Manager… (try @amos)"
            className="h-[420px] xl:sticky xl:top-20 xl:h-[calc(100dvh-7rem)]"
          />
        </div>
        <section className="min-w-0 xl:order-1" aria-label="Personas">
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
