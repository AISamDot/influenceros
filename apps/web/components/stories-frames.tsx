import { STORY_KIND_LABEL, type StoryFrameRow } from '@ios/formats';
import { approveFrame } from '@/app/generator/formats-actions';
import { SubmitButton } from './submit-button';

/** Stream L: a row of Story frames (kind, local time, overlay text, QC + Gate, publish status). */

const STATUS_TONE: Record<string, string> = {
  published: 'text-emerald-600 dark:text-emerald-400',
  approved: 'text-sky-600 dark:text-sky-400',
  awaiting_approval: 'text-amber-600 dark:text-amber-400',
  blocked: 'text-red-600 dark:text-red-400',
  failed: 'text-red-600 dark:text-red-400',
};

export type FramePost = { story_frame_id: string; platform: string; status: string };

export function StoryFrames({ frames, posts, timeZone, back }: { frames: readonly StoryFrameRow[]; posts: readonly FramePost[]; timeZone: string; back: string }) {
  const time = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(d));
  return (
    <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      {frames.map((f) => {
        const sent = posts.filter((p) => p.story_frame_id === f.id);
        return (
          <li key={f.id} className="stories-frame rounded-lg border border-line p-2.5 text-[12px]">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{STORY_KIND_LABEL[f.kind]}</span>
              <span className="tabular-nums text-muted">{time(f.planned_at)}</span>
            </div>
            <p className="mt-1 line-clamp-3 min-h-[3em]">{f.text}</p>
            <p className={`mt-1 ${STATUS_TONE[f.status] ?? 'text-muted'}`}>
              {f.status.replace('_', ' ')}
              {f.gate_verdict ? ` · Gate ${f.gate_verdict}` : ''}
              {sent.length ? ` · ${sent.map((s) => `${s.platform} ${s.status}`).join(', ')}` : ''}
            </p>
            {f.block_reason ? <p className="mt-0.5 line-clamp-2 text-[11px] text-muted">{f.block_reason}</p> : null}
            {f.status === 'awaiting_approval' ? (
              <form action={approveFrame} className="mt-1.5">
                <input type="hidden" name="frame_id" value={f.id} />
                <input type="hidden" name="back" value={back} />
                <SubmitButton className="btn btn-sm">Approve</SubmitButton>
              </form>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
