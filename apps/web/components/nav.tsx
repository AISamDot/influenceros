'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { IconBell, IconSignOut } from './icons';
import { ThemeToggle } from './theme-toggle';

// IOS-2: each stream appends its own links inside its marked block only (docs/IOS-2-CONTRACTS.md §6).
const LINKS: Array<{ href: string; label: string; badge?: 'approvals' }> = [
  { href: '/', label: 'Studio' },
  { href: '/pipeline', label: 'Pipeline' },
  { href: '/approvals', label: 'Approvals', badge: 'approvals' },
  { href: '/chat', label: 'Chat' },
  { href: '/niches', label: 'Niches' },
  { href: '/money', label: 'Money' },
  // >>> stream A nav (append only)
  // <<< stream A nav
  // >>> stream B nav (append only)
  // <<< stream B nav
  // >>> stream C nav (append only)
  // <<< stream C nav
  // >>> stream D nav (append only)
  // <<< stream D nav
  { href: '/settings', label: 'Settings' },
];

export function Nav({ pending, kills, unread, signedIn = false }: { pending: number; kills: number; unread: number; signedIn?: boolean }) {
  const path = usePathname();
  const active = (href: string) => (href === '/' ? path === '/' || path.startsWith('/personas') : path.startsWith(href));
  const navRef = useRef<HTMLElement>(null);
  // On a phone the links scroll sideways: keep the current page's link in view.
  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [path]);
  const badge = (
    <span className={`grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[10.5px] font-bold ${kills ? 'bg-danger text-on-danger' : 'bg-accent text-on-accent'}`}>{pending}</span>
  );
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-[10px] bg-ink font-[family-name:var(--font-display)] text-[17px] leading-none text-on-ink">io</span>
          <span className="hidden text-[15px] font-semibold tracking-tight sm:block">Influencer OS</span>
        </Link>
        <nav ref={navRef} className="no-scrollbar fade-x -mx-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1 pr-6 sm:[mask-image:none]" aria-label="Main">
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
              {l.badge && pending > 0 ? badge : null}
            </Link>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-1">
          {/* Phones: the approvals count stays visible even when the Approvals link is scrolled away. */}
          {pending > 0 ? (
            <Link href="/approvals" className="grid h-9 place-items-center px-1 sm:hidden" aria-label={`Approvals (${pending} pending${kills ? `, ${kills} kill` : ''})`}>
              {badge}
            </Link>
          ) : null}
          <Link href="/notifications" className="relative grid size-9 place-items-center rounded-full text-muted transition hover:bg-surface-2 hover:text-fg" aria-label={`Notifications (${unread} unread)`}>
            <IconBell size={17} />
            {unread > 0 ? <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[9.5px] font-bold text-on-danger">{unread > 9 ? '9+' : unread}</span> : null}
          </Link>
          <ThemeToggle />
          {signedIn ? (
            <form action="/api/auth/logout" method="post">
              <button className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-surface-2 hover:text-fg" aria-label="Sign out" title="Sign out">
                <IconSignOut size={16} />
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </header>
  );
}
