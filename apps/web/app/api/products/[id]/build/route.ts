import { requestBuild } from '@troupe/products';
// Relative imports so the route can be exercised directly in tests.
import { requireOwner } from '../../../../../lib/auth';
import { backTo, isFormPost, UUID_RE } from '../../../../../lib/http';
import { getServices } from '../../../../../lib/services';

export const dynamic = 'force-dynamic';

/**
 * Owner: queue a (re)build of a product (form post → back to the referring page; JSON → { jobId, version }). Before
 * approval it rebuilds v1; an approved product gets the next version. The worker runs the build.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const { id } = await params;
  const form = isFormPost(req);
  const fail = (status: number, error: string) => (form ? backTo(req, '/products', { error }) : Response.json({ error }, { status }));
  if (!UUID_RE.test(id)) return fail(404, 'no such product');
  const services = await getServices();
  const p = await services.db.maybeOne<{ persona_id: string }>('SELECT persona_id FROM product WHERE id = $1', [id]);
  if (!p) return fail(404, 'no such product');
  try {
    const r = await requestBuild(services, id, p.persona_id);
    const ok = r.jobId ? `Build of v${r.version} queued` : 'A build is already queued';
    return form ? backTo(req, '/products', { ok }) : Response.json(r);
  } catch (err) {
    return fail(409, (err as Error).message);
  }
}
