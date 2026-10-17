import { accountSetupSheet, personaScorecard } from '@troupe/distribution';
import type { Db } from '@troupe/db';
import Link from 'next/link';
import { AccountStatusPill } from './accounts-status';
import { compact } from '@/lib/format';

const WINDOWS = ['1h', '24h', '72h', '7d'] as const;

/**
 * Persona page panel for stream F: accounts and AI-label status, the 7-day scorecard (metric windows) and the community
 * queue. A failure here never takes the persona page down.
 */
export async function DistributionPersonaPanel({ db, personaId }: { db: Db; studioId: string; personaId: string; slug: string }) {
  try {
    const [sheet, card, community] = await Promise.all([
      accountSetupSheet(db, personaId),
      personaScorecard({ db, now: () => new Date() }, personaId, 7),
      db.one<{ open: number; s1: number; replies: number; dms: number; hidden: number }>(
        `SELECT (SELECT count(*)::int FROM escalation WHERE persona_id = $1 AND status <> 'resolved') AS open,
                (SELECT count(*)::int FROM escalation WHERE persona_id = $1 AND status <> 'resolved' AND severity = 'S1') AS s1,
                (SELECT count(*)::int FROM comment WHERE persona_id = $1 AND action = 'reply' AND created_at > now() - interval '7 days') AS replies,
                (SELECT count(*)::int FROM comment WHERE persona_id = $1 AND action = 'dm' AND created_at > now() - interval '7 days') AS dms,
                (SELECT count(*)::int FROM comment WHERE persona_id = $1 AND action = 'hide' AND created_at > now() - interval '7 days') AS hidden`,
        [personaId],
      ),
    ]);
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    return (
      <section className="card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-[family-name:var(--font-display)] text-[26px] leading-none">Distribution</h2>
          <Link href="/settings/accounts" className="text-[12px] text-muted hover:text-fg">
            Accounts →
          </Link>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {sheet.rows.map((r) => (
            <span key={r.platform} className="flex items-center gap-1.5 text-[12.5px]">
              <span className="font-medium">{r.platform}</span>
              {r.accountId ? <span className="text-muted">@{r.handle}</span> : null}
              <AccountStatusPill status={r.status} aiLabelOk={r.aiLabelOk} />
            </span>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {[
            ['Posts 7d', String(card.posts)],
            ['Views 7d', compact(card.views)],
            ['Save rate', pct(card.saveRate)],
            ['Follows / 1K views', card.followsPer1k.toFixed(1)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl bg-surface-2 p-3">
              <div className="text-[11.5px] text-muted">{label}</div>
              <div className="text-[18px] font-semibold tabular-nums">{value}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 text-[12px] text-muted">
          Median views ·{' '}
          {WINDOWS.map((w) => (
            <span key={w} className="mr-3 tabular-nums">
              {w} {card.medianByWindow[w] === null ? '–' : compact(card.medianByWindow[w]!)}
            </span>
          ))}
        </div>
        <div className="mt-3 text-[12.5px]">
          <Link href="/community" className={community.s1 ? 'font-semibold text-danger' : 'text-muted hover:text-fg'}>
            {community.open} open escalation{community.open === 1 ? '' : 's'}
            {community.s1 ? ` (${community.s1} S1)` : ''}
          </Link>
          <span className="text-muted">
            {' '}
            · 7d: {community.replies} replies, {community.dms} keyword DMs, {community.hidden} hidden
          </span>
        </div>
      </section>
    );
  } catch {
    return null;
  }
}
