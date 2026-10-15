/* eslint-disable @next/next/no-img-element */
import type { BoardItem } from '@ios/content';
import Link from 'next/link';
import { FORMAT_LABEL } from '@/lib/format';
import { FormatIcon } from './icons';

export const PURPOSE_STYLE: Record<string, { label: string; cls: string }> = {
  reach: { label: 'Reach', cls: 'bg-[#e3effc] text-[#1d5fa8] dark:bg-[#132a42] dark:text-[#8cc2ff]' },
  trust: { label: 'Trust', cls: 'bg-ok-soft text-ok' },
  sell: { label: 'Sell', cls: 'bg-warn-soft text-warn' },
};

export const VERDICT_STYLE: Record<string, string> = {
  green: 'bg-ok-soft text-ok',
  amber: 'bg-warn-soft text-warn',
  red: 'bg-danger-soft text-danger',
};

/** "Tue 19:04" in the persona's own time zone (falls back to UTC). */
export function localTime(d: Date, timeZone: string, opts: { date?: boolean } = {}): string {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz, ...(opts.date ? { day: 'numeric', month: 'short' } : {}) }).format(d);
  try {
    return fmt(timeZone);
  } catch {
    return `${fmt('UTC')} UTC`;
  }
}

/** IOS-3 media steps as short card labels. */
export const MEDIA_STEP_LABEL: Record<string, string> = {
  voice: 'voice',
  generate: 'generating',
  q3: 'avatar QC',
  render: 'rendering',
  q4: 'final QC',
  done: 'rendered',
  blocked: 'blocked',
};

/** The card's image: the render cover once Q4 passed (thumbnail_url), else the newest generated still, else the script art. */
export function cardThumb(item: BoardItem): string {
  const covered = item.thumbnailUrl?.startsWith('/api/');
  return (covered ? item.thumbnailUrl : (item.renderThumbUrl ?? item.thumbnailUrl)) ?? '';
}

export function PipelineCard({ item }: { item: BoardItem }) {
  const purpose = PURPOSE_STYLE[item.purpose];
  const rendering = item.mediaStep && !['done', 'blocked'].includes(item.mediaStep) && item.stage !== 'blocked';
  return (
    <Link
      href={`/pipeline/${item.slotId}`}
      className={`flex gap-2 rounded-xl border bg-surface p-1.5 transition hover:border-line-strong ${item.stage === 'blocked' ? 'border-danger/40' : 'border-line'}`}
    >
      <img src={cardThumb(item)} alt="" className={`h-[60px] w-[34px] shrink-0 rounded-md bg-surface-3 object-cover ${rendering ? 'opacity-80' : ''}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-1">
          <span className="truncate text-[11px] font-semibold">{item.personaName}</span>
          <span className="shrink-0 text-[10.5px] tabular-nums text-muted" title={`${item.slotAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`}>
            {localTime(item.slotAt, item.personaTimezone)}
          </span>
        </div>
        <p className="line-clamp-2 text-[11.5px] leading-snug">{item.hook ?? item.title}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="grid size-[18px] place-items-center rounded-full bg-surface-2 text-muted" title={FORMAT_LABEL[item.format]}>
            <FormatIcon format={item.format} size={11} />
          </span>
          {purpose ? <span className={`rounded-full px-1.5 py-px text-[9.5px] font-bold uppercase ${purpose.cls}`}>{purpose.label}</span> : null}
          {item.ctaKeyword ? <span className="rounded-full bg-surface-2 px-1.5 py-px font-mono text-[9.5px] font-semibold text-muted">{item.ctaKeyword}</span> : null}
          {item.gateVerdict ? <span className={`rounded-full px-1.5 py-px text-[9.5px] font-bold uppercase ${VERDICT_STYLE[item.gateVerdict]}`}>Gate {item.gateVerdict}</span> : null}
          {item.queued ? <span className="rounded-full bg-accent-soft px-1.5 py-px text-[9.5px] font-semibold text-accent">queued</span> : null}
          {rendering ? <span className="rounded-full bg-accent-soft px-1.5 py-px text-[9.5px] font-semibold text-accent">{MEDIA_STEP_LABEL[item.mediaStep!] ?? item.mediaStep}</span> : null}
          {item.mediaCredits ? (
            <span className="rounded-full bg-surface-2 px-1.5 py-px text-[9.5px] tabular-nums text-muted" title="Higgsfield credits spent on this post">
              {Math.round(item.mediaCredits)} cr
            </span>
          ) : null}
        </div>
        {item.blockReason && item.stage === 'blocked' ? <p className="mt-1 line-clamp-3 text-[10.5px] leading-snug text-danger">{item.blockReason}</p> : null}
        {item.waiting && item.stage !== 'blocked' ? <p className="mt-1 line-clamp-2 text-[10.5px] leading-snug text-warn">{item.waiting}</p> : null}
      </div>
    </Link>
  );
}
