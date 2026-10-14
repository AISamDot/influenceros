import { requireOwner } from '@/lib/auth';
import { OWNER } from '@ios/core';
import { requestNewsScan } from '@ios/knowledge';
import { backTo, isFormPost, isJson } from '@/lib/http';
import { studioContext } from '@/lib/server';
import { NICHE_RE } from '@/app/knowledge/_data';

export const dynamic = 'force-dynamic';

/** Owner: queue an extra News Desk scan for a niche (the daily 05:00 UTC scan runs anyway). {niche} as a form or JSON. */
export async function POST(req: Request) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const isForm = isFormPost(req);
  if (!isForm && !isJson(req)) return Response.json({ error: 'send JSON or a form' }, { status: 415 });
  const input = isForm ? Object.fromEntries((await req.formData()).entries()) : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
  const niche = typeof input.niche === 'string' ? input.niche.trim() : '';
  if (!NICHE_RE.test(niche)) return isForm ? backTo(req, '/knowledge', { error: 'pick a niche' }) : Response.json({ error: 'niche is required' }, { status: 400 });
  const { db, studio } = await studioContext();
  const job = await requestNewsScan(db, { studioId: studio.id, niche, actor: OWNER });
  if (isForm) return backTo(req, '/knowledge', { ok: job ? `News scan queued for ${niche}.` : `A ${niche} scan is already queued.` });
  return Response.json({ queued: !!job, jobId: job?.id ?? null });
}
