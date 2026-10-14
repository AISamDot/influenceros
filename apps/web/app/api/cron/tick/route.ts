import { reapStale, sweepAutoApprovals } from '@ios/core';
import { getDb } from '@ios/db';

export const dynamic = 'force-dynamic';

/**
 * Scheduler tick (Vercel Cron or any pinger): auto-approves due 24 h cards and veto-window posts (never kill or
 * other Owner-only kinds) and requeues jobs whose worker died. Protected by CRON_SECRET when it is set.
 */
async function tick(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) return new Response('unauthorized', { status: 401 });
  const db = await getDb();
  const approved = await sweepAutoApprovals(db);
  const requeued = await reapStale(db, { timeoutMs: 15 * 60_000 });
  return Response.json({ approved, requeued });
}

export const GET = tick;
export const POST = tick;
