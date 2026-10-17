import { requireOwner } from '@/lib/auth';
import { latestBriefing } from '@troupe/knowledge';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

/** GET ?persona=<slug> → that persona's latest morning briefing (null before the first scan). */
export async function GET(req: Request) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const slug = new URL(req.url).searchParams.get('persona') ?? '';
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug)) return Response.json({ error: 'persona slug is required' }, { status: 400 });
  const { db, studio } = await studioContext();
  const p = await db.maybeOne<{ id: string }>('SELECT id FROM persona WHERE studio_id = $1 AND slug = $2', [studio.id, slug]);
  if (!p) return Response.json({ error: 'no such persona' }, { status: 404 });
  return Response.json({ briefing: await latestBriefing(db, p.id) });
}
