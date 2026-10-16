import type { Metadata } from 'next';
import type { CSSProperties, ReactNode } from 'react';
import { siteFor } from '@/components/site-shell';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const { site } = await siteFor(slug);
  return {
    title: { absolute: site.persona.name },
    description: `${site.persona.name}: ${site.persona.niche}. Free guide, resources and members area.`,
    robots: { index: true, follow: true },
  };
}

/**
 * Public persona site layout (IOS-4 stream G, docs/IOS-34-CONTRACTS.md §5.5): styled from the persona's bible palette.
 * The root layout renders /p/* bare (no nav, no session, no studio data).
 */
export default async function SiteLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { site } = await siteFor(slug);
  const c = site.colors;
  // --s-cta / --s-on-cta and --s-accent-text are contrast-checked (WCAG AA) picks from the palette.
  const style = {
    '--s-bg': c.bg,
    '--s-ink': c.ink,
    '--s-accent': c.accent,
    '--s-accent2': c.accent2,
    '--s-cta': c.cta ?? c.accent,
    '--s-on-cta': c.onCta ?? '#fff',
    '--s-accent-text': c.accentText ?? c.ink,
  } as CSSProperties;
  return (
    <div className="site" style={style}>
      {children}
    </div>
  );
}
