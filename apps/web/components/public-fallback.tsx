import type React from 'react';
import { headers } from 'next/headers';

/**
 * Public 404 for persona sites (/p/<slug>/… and <slug>.<domain>): neutral copy, the persona home link, never the
 * studio, the dashboard or setup commands.
 */
export async function publicSiteHome(): Promise<string | null> {
  const h = await headers();
  if (h.get('x-ios-site')) return '/';
  const m = /^\/p\/([a-z0-9-]+)/.exec(h.get('x-ios-path') ?? '');
  return m ? `/p/${m[1]}` : null;
}

/** Neutral colours for a 404 outside a persona layout (hidden or unknown persona). */
const NEUTRAL = { '--s-bg': '#FAF7F2', '--s-ink': '#1C1A17', '--s-accent': '#2F6FB0', '--s-accent2': '#2F6FB0', '--s-cta': '#1C1A17', '--s-on-cta': '#FFFFFF', '--s-accent-text': '#1C1A17' };

export function PublicNotFound({ home, standalone }: { home: string; standalone?: boolean }) {
  return (
    <div className="site" style={{ minHeight: '100vh', ...(standalone ? NEUTRAL : {}) } as React.CSSProperties}>
      <main className="site-wrap" style={{ textAlign: 'center' }}>
        <h1 className="site-name" style={{ fontSize: 32 }}>
          This page isn&apos;t here
        </h1>
        <p className="site-lead" style={{ marginTop: 10 }}>
          The link may be old, or the page has moved.
        </p>
        <div className="site-links">
          <a className="site-btn site-btn-primary" href={home}>
            Go to the home page
          </a>
        </div>
      </main>
    </div>
  );
}
