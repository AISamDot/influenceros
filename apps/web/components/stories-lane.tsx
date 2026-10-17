import type { Db } from '@troupe/db';
import { localDate, type StoryFrameRow } from '@troupe/formats';
import { type FramePost, StoryFrames } from './stories-frames';

/**
 * The Stories lane on the Pipeline board (stream L, docs/IOS-5-CONTRACTS.md §4): today's and tomorrow's story frames
 * per persona (kind, QC + Gate, publish status). `personaId` is the board's persona filter (null = all).
 * Returns null on any failure.
 */
export async function StoriesLane({ db, studioId, personaId }: { db: Db; studioId: string; personaId: string | null }) {
  try {
    const now = new Date();
    const personas = await db.query<{ id: string; name: string; slug: string; timezone: string }>(
      `SELECT id, name, slug, timezone FROM persona WHERE studio_id = $1 AND ($2::uuid IS NULL OR id = $2) AND state IN ('TESTING','MONETISING','RE_ANGLE','SCALING','BRAND') ORDER BY name`,
      [studioId, personaId],
    );
    const rows: Array<{ p: (typeof personas)[number]; date: string; frames: StoryFrameRow[] }> = [];
    for (const p of personas) {
      const today = localDate(now, p.timezone);
      const tomorrow = localDate(new Date(now.getTime() + 86_400_000), p.timezone);
      const frames = await db.query<StoryFrameRow>(`SELECT * FROM story_frame WHERE persona_id = $1 AND story_date IN ($2::date, $3::date) ORDER BY story_date, seq`, [p.id, today, tomorrow]);
      for (const date of [today, tomorrow]) {
        const day = frames.filter((f) => String(typeof f.story_date === 'string' ? f.story_date : new Date(f.story_date).toISOString()).slice(0, 10) === date);
        if (day.length) rows.push({ p, date, frames: day });
      }
    }
    const ids = rows.flatMap((r) => r.frames.map((f) => f.id));
    const posts = ids.length ? await db.query<FramePost>('SELECT story_frame_id, platform, status FROM story_post WHERE story_frame_id = ANY($1::uuid[])', [ids]) : [];
    return (
      <section className="card p-5" aria-labelledby="stories-lane">
        <div className="flex items-center justify-between gap-3">
          <h2 id="stories-lane" className="text-[15px] font-semibold">
            Stories
          </h2>
          <span className="text-[12px] text-muted">3–5 native frames a day per persona · Instagram where the API allows</span>
        </div>
        {rows.length ? (
          <div className="mt-3 space-y-4">
            {rows.map((r) => (
              <div key={`${r.p.id}:${r.date}`}>
                <p className="mb-1.5 text-[12.5px] font-medium">
                  {r.p.name} · {r.date}
                </p>
                <StoryFrames frames={r.frames} posts={posts} timeZone={r.p.timezone} back="/pipeline" />
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-[13px] text-muted">No story frames today yet: each publishing persona gets its frames planned when its morning starts.</p>
        )}
      </section>
    );
  } catch {
    return null;
  }
}
