import { createHash, timingSafeEqual } from 'node:crypto';
import { isDeployed } from '@troupe/auth/guard';
import { getDb } from '@troupe/db';
import { studioTick } from '@troupe/profit';
import { allSchedules, createStudioServices } from '@troupe/wiring';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Scheduler tick (Vercel Cron every minute, see vercel.json; on the Mac the ticker in instrumentation.ts and
 * `pnpm worker`): the core tick (auto-approves due 24 h cards and veto-window posts, never kill or other Owner-only
 * kinds; reaps jobs whose worker died), then every due ScheduledTask from every package (they only enqueue jobs).
 * Protected by `Authorization: Bearer $CRON_SECRET`; when deployed (Vercel or TROUPE_DEPLOYED=1) the secret is required.
 */
const digest = (s: string) => createHash('sha256').update(s).digest();

function authorized(req: Request, secret: string): boolean {
  const got = req.headers.get('authorization') ?? '';
  return timingSafeEqual(digest(got), digest(`Bearer ${secret}`));
}

async function handler(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret && isDeployed()) return new Response('CRON_SECRET is not set', { status: 503 });
  if (secret && !authorized(req, secret)) return new Response('unauthorized', { status: 401 });
  const db = await getDb();
  const result = await studioTick(createStudioServices(db), allSchedules());
  return Response.json(result, { status: result.errors.length ? 500 : 200 });
}

export const GET = handler;
export const POST = handler;
