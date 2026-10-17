/* eslint-disable @next/next/no-img-element */
import { listThreads } from '@troupe/core';
import Link from 'next/link';
import { ChatPanel } from '@/components/chat-panel';
import { loadChat, studioContext } from '@/lib/server';
import { requireOwnerPage } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Chat' };

const SUBTITLE: Record<string, string> = {
  studio: 'Runs the studio end to end',
  monetization: 'What gets sold, at what price and when',
  quality: 'Studio-wide quality standards',
  persona: 'Persona manager',
};

export default async function Chat({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  await requireOwnerPage();
  const { t } = await searchParams;
  const { db, studio } = await studioContext();
  const threads = await listThreads(db, studio.id);
  const current = threads.find((x) => x.id === t) ?? threads[0]!;
  const chat = await loadChat(db, studio.id, current.kind, current.persona_id ?? undefined);
  return (
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="card h-fit overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <h1 className="font-[family-name:var(--font-display)] text-[28px] leading-none">Chat</h1>
          <p className="mt-1 text-[12px] text-muted">All Owner conversations happen here.</p>
        </div>
        <nav className="grid grid-cols-2 gap-1 p-2 lg:flex lg:flex-col" aria-label="Threads">
          {threads.map((x) => (
            <Link
              key={x.id}
              href={`/chat?t=${x.id}`}
              aria-current={x.id === current.id ? 'page' : undefined}
              className={`flex min-w-0 items-center gap-2.5 rounded-xl px-2 py-2 lg:gap-3 lg:px-2.5 ${x.id === current.id ? 'bg-surface-2' : 'hover:bg-surface-2/60'}`}
            >
              {x.portrait_url ? (
                <img src={x.portrait_url} alt="" className="size-9 shrink-0 rounded-full object-cover" />
              ) : (
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ink text-[13px] font-bold text-on-ink">{x.title.slice(0, 1)}</span>
              )}
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-semibold">{x.title}</span>
                <span className="block truncate text-[12px] text-muted">{x.last_body ?? SUBTITLE[x.kind]}</span>
              </span>
            </Link>
          ))}
        </nav>
      </aside>
      <ChatPanel
        key={current.id}
        threadId={current.id}
        title={current.title}
        subtitle={SUBTITLE[current.kind]}
        initial={chat.initial}
            mode={chat.mode}
        avatar={current.portrait_url}
        className="h-[calc(100dvh-8rem)] min-h-[480px]"
      />
    </div>
  );
}
