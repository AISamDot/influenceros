import { markRead } from '@ios/core';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const { db, studio } = await studioContext();
  await markRead(db, studio.id);
  if ((req.headers.get('content-type') ?? '').includes('form')) {
    return Response.redirect(new URL(req.headers.get('referer') ?? '/notifications', req.url), 303);
  }
  return Response.json({ ok: true });
}
