import { enqueue, recoverPublishing } from '@troupe/core';
import { type Db, json } from '@troupe/db';
import type { JobHandlerMap, ScheduledTask, StudioServices } from './contracts';

/**
 * Stream A's queue jobs (`agent.*`) and schedules (`studio.*`, `persona.*`). Schedules only enqueue (cheap,
 * idempotent: at most one queued or running job per kind); the work runs in the worker.
 */
export const RECOVER_PUBLISHING_JOB = 'agent.recover_publishing';
export const FEEDBACK_EFFECTS_JOB = 'agent.feedback_effects';

async function enqueueOnce(db: Db, kind: string): Promise<boolean> {
  const busy = await db.maybeOne(`SELECT 1 FROM job WHERE kind = $1 AND status IN ('queued','running') LIMIT 1`, [kind]);
  if (busy) return false;
  await enqueue(db, { kind, maxAttempts: 3, priority: 50 });
  return true;
}

/**
 * Measures applied feedback a week later (PRD §3.1 step 6): average views and saves per post in the 7 days before
 * the change vs the 7 days after. Stored in feedback.effect for the weekly review.
 */
export async function measureFeedbackEffects(db: Db, now: Date = new Date()): Promise<number> {
  const due = await db.query<{ id: string; persona_id: string; applied_at: string }>(
    `SELECT id, persona_id, applied_change->>'applied_at' AS applied_at FROM feedback
      WHERE status = 'applied' AND effect IS NULL AND applied_change ? 'applied_at'
        AND (applied_change->>'applied_at')::timestamptz < $1::timestamptz - interval '7 days'
      LIMIT 50`,
    [now],
  );
  for (const f of due) {
    const win = await db.one<{ before_posts: number; before_views: number; before_saves: number; after_posts: number; after_views: number; after_saves: number }>(
      `WITH latest AS (
         SELECT p.id, p.published_at, m.views, m.saves FROM post p
         LEFT JOIN LATERAL (SELECT views, saves FROM metric_snapshot ms WHERE ms.post_id = p.id ORDER BY captured_on DESC LIMIT 1) m ON true
          WHERE p.persona_id = $1 AND p.status = 'live' AND p.published_at IS NOT NULL)
       SELECT count(*) FILTER (WHERE published_at <  $2::timestamptz AND published_at >= $2::timestamptz - interval '7 days')::int AS before_posts,
              COALESCE(AVG(views) FILTER (WHERE published_at <  $2::timestamptz AND published_at >= $2::timestamptz - interval '7 days'), 0)::float8 AS before_views,
              COALESCE(AVG(saves) FILTER (WHERE published_at <  $2::timestamptz AND published_at >= $2::timestamptz - interval '7 days'), 0)::float8 AS before_saves,
              count(*) FILTER (WHERE published_at >= $2::timestamptz AND published_at < $2::timestamptz + interval '7 days')::int AS after_posts,
              COALESCE(AVG(views) FILTER (WHERE published_at >= $2::timestamptz AND published_at < $2::timestamptz + interval '7 days'), 0)::float8 AS after_views,
              COALESCE(AVG(saves) FILTER (WHERE published_at >= $2::timestamptz AND published_at < $2::timestamptz + interval '7 days'), 0)::float8 AS after_saves
         FROM latest`,
      [f.persona_id, f.applied_at],
    );
    const pct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
    await db.query(`UPDATE feedback SET effect = $2::jsonb WHERE id = $1`, [
      f.id,
      json({
        measured_at: now.toISOString(),
        window_days: 7,
        before: { posts: win.before_posts, avg_views: Math.round(win.before_views), avg_saves: Math.round(win.before_saves) },
        after: { posts: win.after_posts, avg_views: Math.round(win.after_views), avg_saves: Math.round(win.after_saves) },
        views_change_pct: pct(win.after_views, win.before_views),
        saves_change_pct: pct(win.after_saves, win.before_saves),
      }),
    ]);
  }
  return due.length;
}

export const A_JOBS: JobHandlerMap = {
  [RECOVER_PUBLISHING_JOB]: async ({ services }) => recoverPublishing(services.db, services.providers.publish, { now: services.now() }),
  [FEEDBACK_EFFECTS_JOB]: async ({ services }) => ({ measured: await measureFeedbackEffects(services.db, services.now()) }),
};

const minutesSince = (now: Date, last: Date | null) => (last ? (now.getTime() - last.getTime()) / 60_000 : Number.POSITIVE_INFINITY);

export const A_SCHEDULES: readonly ScheduledTask[] = [
  {
    name: 'studio.recover_publishing',
    due: (now, last) => minutesSince(now, last) >= 5,
    run: async (services: StudioServices) => ({ enqueued: await enqueueOnce(services.db, RECOVER_PUBLISHING_JOB) }),
  },
  {
    name: 'persona.feedback_effects',
    due: (now, last) => minutesSince(now, last) >= 24 * 60,
    run: async (services: StudioServices) => ({ enqueued: await enqueueOnce(services.db, FEEDBACK_EFFECTS_JOB) }),
  },
];
