import '@fontsource-variable/geist';
import '@fontsource/instrument-serif/400.css';
import './globals.css';
import { studioTotals } from '@ios/core';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Nav } from '@/components/nav';
import { studioContext } from '@/lib/server';

export const metadata: Metadata = {
  title: { default: 'Influencer OS', template: '%s · Influencer OS' },
  description: 'The studio dashboard for openly AI influencer personas.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { colorScheme: 'light dark', width: 'device-width', initialScale: 1 };
export const dynamic = 'force-dynamic';

// Applies the saved theme (or the system preference) before first paint.
const THEME_SCRIPT = `try{var t=localStorage.getItem('ios-theme');if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t}catch(e){}`;

async function counts() {
  try {
    const { db, studio } = await studioContext();
    return await studioTotals(db, studio.id);
  } catch {
    return { active: 0, pending: 0, kills: 0, unread: 0 };
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const c = await counts();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="bg-bg text-fg">
        <Nav pending={c.pending} kills={c.kills} unread={c.unread} />
        <main className="mx-auto max-w-[1440px] px-4 pb-24 pt-6 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
