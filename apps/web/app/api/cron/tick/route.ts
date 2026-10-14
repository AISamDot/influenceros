import { tick } from '@ios/core';
import { getDb } from '@ios/db';

export const dynamic = 'force-dynamic';

/**
 * Scheduler tick (Vercel Cron, see vercel.json; locally the dev ticker in instrumentation.ts): auto-approves due
 * 24 h cards and veto-window posts (never kill or other Owner-only kinds) and reaps jobs whose worker died.
 * Protected by CRON_SECRET; on Vercel the secret is required.
 */
async function handler(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret && process.env.VERCEL) return new Response('CRON_SECRET is not set', { status: 503 });
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) return new Response('unauthorized', { status: 401 });
  const result = await tick(await getDb());
  return Response.json(result, { status: result.errors.length ? 500 : 200 });
}

export const GET = handler;
export const POST = handler;
