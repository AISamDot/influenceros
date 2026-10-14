import { requireOwner } from '@/lib/auth';
import { studioContext } from '@/lib/server';
import { knowledgeService, NICHE_RE } from '@/app/knowledge/_data';

export const dynamic = 'force-dynamic';

/** GET ?niche=dating&q=…&k=5&kinds=node,news → the hits a content agent would get (ids, text, citations). */
export async function GET(req: Request) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const niche = (url.searchParams.get('niche') ?? '').trim();
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 2000);
  if (!NICHE_RE.test(niche) || !q) return Response.json({ error: 'niche and q are required' }, { status: 400 });
  const k = Math.min(25, Math.max(1, Number(url.searchParams.get('k')) || 5));
  const kinds = (url.searchParams.get('kinds') ?? '').split(',').filter((x): x is 'node' | 'news' => x === 'node' || x === 'news');
  const { db, studio } = await studioContext();
  const hits = await knowledgeService(db).retrieve({ studioId: studio.id, niche, query: q, k, kinds: kinds.length ? kinds : undefined });
  return Response.json({ hits });
}
