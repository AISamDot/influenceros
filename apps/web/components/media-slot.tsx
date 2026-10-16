/* eslint-disable @next/next/no-img-element */
import type { SlotMedia, SlotMediaAsset } from '@ios/media';
import { QcChecks } from './content-checks';
import { SubmitButton } from './submit-button';

const STEP_LABEL: Record<string, string> = {
  voice: 'Voice track',
  generate: 'Generating (Higgsfield)',
  q3: 'Avatar QC (Q3)',
  render: 'Rendering',
  q4: 'Final QC (Q4)',
  done: 'Rendered',
  blocked: 'Blocked by QC',
};

function Final({ a, carousel }: { a: SlotMediaAsset; carousel: boolean }) {
  if (a.fake)
    return (
      <div className={`grid place-items-center rounded-lg border border-dashed border-line-strong bg-surface-2 p-3 text-center text-[11.5px] text-muted ${carousel ? 'aspect-[4/5]' : 'aspect-[9/16]'}`}>
        Fake render{carousel && a.index ? ` · slide ${a.index}` : ''} (no Higgsfield key yet)
      </div>
    );
  if (a.type === 'video') return <video src={a.url} controls playsInline preload="metadata" className="aspect-[9/16] w-full rounded-lg bg-black" />;
  return <img src={a.url} alt={carousel && a.index ? `Slide ${a.index}` : 'Post image'} className={`w-full rounded-lg bg-surface-3 object-cover ${carousel ? 'aspect-[4/5]' : 'aspect-[9/16]'}`} />;
}

/** The slot page's media section (stream E): the render, its cover and voice, the generations and QC Q3/Q4. */
export function MediaSlot({ media, slotId, blocked }: { media: SlotMedia; slotId: string; blocked: boolean }) {
  const carousel = media.final[0]?.type === 'carousel';
  const q34 = media.reports.filter((r) => r.stage === 'Q3' || r.stage === 'Q4');
  const loops = Object.entries(media.loops).filter(([, n]) => n > 0);
  return (
    <section className="card space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="eyebrow">Media · {STEP_LABEL[media.step] ?? media.step}</h2>
        <span className="text-[12px] tabular-nums text-muted">
          {Math.round(media.credits)} Higgsfield credits · ${media.usd.toFixed(2)}
          {loops.length ? ` · fix loops ${loops.map(([k, n]) => `${k.toUpperCase()} ${n}`).join(', ')}` : ''}
        </span>
      </div>
      {media.waiting ? <p className="rounded-xl border border-warn/40 bg-warn-soft px-3 py-2 text-[13px] text-warn">Waiting: {media.waiting}</p> : null}
      {media.final.length ? (
        <div className={carousel ? 'scroll-x flex gap-2 pb-1' : 'grid gap-4 sm:grid-cols-[minmax(0,240px)_minmax(0,1fr)] [&>*:first-child]:max-w-[240px]'}>
          {carousel ? (
            media.final.map((a) => (
              <div key={a.id} className="w-[180px] shrink-0">
                <Final a={a} carousel />
              </div>
            ))
          ) : (
            <>
              <Final a={media.final[0]!} carousel={false} />
              <div className="min-w-0 space-y-3 text-[12.5px]">
                <p className="text-muted">
                  {media.final[0]!.width}×{media.final[0]!.height}
                  {media.final[0]!.durationS ? ` · ${media.final[0]!.durationS.toFixed(1)} s` : ''} · AI flag on · persona grade and sharpening applied
                </p>
                {media.cover ? (
                  <div>
                    <div className="eyebrow mb-1">Cover</div>
                    <img src={media.cover.url} alt="Cover" className="h-[120px] w-[68px] rounded-md bg-surface-3 object-cover" />
                  </div>
                ) : null}
                {media.voice && !media.voice.fake ? (
                  <div>
                    <div className="eyebrow mb-1">Voice track</div>
                    <audio src={media.voice.url} controls preload="none" className="w-full min-w-0 max-w-sm" />
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : (
        <p className="text-[12.5px] text-muted">No render yet: the video producer picks this post up from the queue.</p>
      )}
      {media.generations.some((g) => g.role === 'still' && !g.fake) ? (
        <div>
          <div className="eyebrow mb-1">Generations</div>
          <div className="scroll-x flex gap-1.5">
            {media.generations
              .filter((g) => g.role === 'still' && !g.fake)
              .map((g) => (
                <img key={g.id} src={g.url} alt="" title={`${g.credits} credits`} className="h-[90px] w-[51px] shrink-0 rounded-md bg-surface-3 object-cover" />
              ))}
          </div>
        </div>
      ) : null}
      {q34.map((q) => (
        <div key={q.id} className="rounded-xl border border-line p-3">
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[12.5px] font-semibold">
              QC · {q.stage}
              {q.loop ? ` · loop ${q.loop}` : ''}
            </span>
            <span className={`pill ${q.pass ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>
              {q.pass ? 'Pass' : 'Fail'} · {q.score ?? '–'}
            </span>
          </div>
          <QcChecks checks={q.checks} />
        </div>
      ))}
      {blocked || media.step === 'blocked' ? (
        <form action="/api/pipeline" method="post">
          <input type="hidden" name="action" value="render_slot" />
          <input type="hidden" name="slot_id" value={slotId} />
          <SubmitButton className="btn btn-sm">Render again (fresh fix loops)</SubmitButton>
        </form>
      ) : null}
    </section>
  );
}
