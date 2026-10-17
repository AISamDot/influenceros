import type { Db } from '@troupe/db';
import { framesFor, highlightsFor, localDate, storiesPlanFor, storyStats, STORY_KIND_LABEL } from '@troupe/formats';
import { type FramePost, StoryFrames } from './stories-frames';

/**
 * Persona page panel for stream L (docs/IOS-5-CONTRACTS.md §4): today's Stories lane (3–5 frames with their kind, QC
 * and Gate status, publish status), the highlight sets and 14 days of story metrics. Returns null on any failure.
 */
export async function StoriesPersonaPanel({ db, personaId, slug }: { db: Db; studioId: string; personaId: string; slug: string }) {
  try {
    const now = new Date();
    const p = await db.one<{ timezone: string }>('SELECT timezone FROM persona WHERE id = $1', [personaId]);
    const services = { db, now: () => now };
    const date = localDate(now, p.timezone);
    const [frames, plan, highlights, stats] = await Promise.all([framesFor(services, personaId, date), storiesPlanFor(services, personaId), highlightsFor(services, personaId), storyStats(services, personaId, now, 14)]);
    const posts = frames.length ? await db.query<FramePost>('SELECT story_frame_id, platform, status FROM story_post WHERE story_frame_id = ANY($1::uuid[])', [frames.map((f) => f.id)]) : [];
    const reach = stats.reduce((a, s) => a + s.reach, 0);
    const replies = stats.reduce((a, s) => a + s.replies, 0);
    return (
      <section className="card p-5" aria-labelledby="stories-panel">
        <div className="flex items-center justify-between gap-3">
          <h2 id="stories-panel" className="text-[15px] font-semibold">
            Stories today
          </h2>
          <span className="text-[12px] text-muted">
            {plan.perDay} a day · {date}
          </span>
        </div>
        <div className="mt-3">
          {frames.length ? (
            <StoryFrames frames={frames} posts={posts} timeZone={p.timezone} back={`/personas/${slug}`} />
          ) : (
            <p className="text-[13px] text-muted">Today&apos;s frames are planned once the persona&apos;s morning starts (06:00 local), while it is publishing.</p>
          )}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px] sm:grid-cols-4">
          <div>
            <dt className="eyebrow">Reach · 14d</dt>
            <dd className="font-semibold tabular-nums">{reach.toLocaleString('en-US')}</dd>
          </div>
          <div>
            <dt className="eyebrow">Replies · 14d</dt>
            <dd className="font-semibold tabular-nums">{replies}</dd>
          </div>
          {stats
            .sort((a, b) => b.replyRate - a.replyRate)
            .slice(0, 2)
            .map((s) => (
              <div key={s.kind}>
                <dt className="eyebrow">{STORY_KIND_LABEL[s.kind]}</dt>
                <dd className="tabular-nums">
                  {s.replyRate}% replies · {Math.round(s.dropRate * 100)}% drop
                </dd>
              </div>
            ))}
        </dl>
        <p className="mt-3 text-[12.5px] text-muted">
          Highlights:{' '}
          {highlights.length ? highlights.map((h) => `${h.set_name} (${h.frame_ids.length})`).join(' · ') : 'curated weekly by the Persona Manager once frames are live'}
        </p>
      </section>
    );
  } catch {
    return null;
  }
}
