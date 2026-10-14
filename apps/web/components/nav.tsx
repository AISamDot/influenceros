'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { IconBell } from './icons';
import { ThemeToggle } from './theme-toggle';

const LINKS = [
  { href: '/', label: 'Studio' },
  { href: '/pipeline', label: 'Pipeline' },
  { href: '/approvals', label: 'Approvals', badge: 'approvals' as const },
  { href: '/chat', label: 'Chat' },
  { href: '/niches', label: 'Niches' },
  { href: '/money', label: 'Money' },
  { href: '/settings', label: 'Settings' },
];

export function Nav({ pending, kills, unread }: { pending: number; kills: number; unread: number }) {
  const path = usePathname();
  const active = (href: string) => (href === '/' ? path === '/' || path.startsWith('/personas') : path.startsWith(href));
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-[10px] bg-ink font-[family-name:var(--font-display)] text-[17px] leading-none text-on-ink">io</span>
          <span className="hidden text-[15px] font-semibold tracking-tight sm:block">Influencer OS</span>
        </Link>
        <nav className="no-scrollbar -mx-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1" aria-label="Main">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active(l.href) ? 'page' : undefined}
              className={`relative flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition ${
                active(l.href) ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg'
              }`}
            >
              {l.label}
              {l.badge && pending > 0 ? (
                <span className={`grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[10.5px] font-bold text-white ${kills ? 'bg-danger' : 'bg-accent'}`}>{pending}</span>
              ) : null}
            </Link>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-1">
          <Link href="/notifications" className="relative grid size-9 place-items-center rounded-full text-muted transition hover:bg-surface-2 hover:text-fg" aria-label={`Notifications (${unread} unread)`}>
            <IconBell size={17} />
            {unread > 0 ? <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[9.5px] font-bold text-white">{unread > 9 ? '9+' : unread}</span> : null}
          </Link>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
