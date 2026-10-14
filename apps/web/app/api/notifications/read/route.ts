import { markRead } from '@ios/core';
import { backTo, isFormPost, redirectTo, safePath, UUID_RE } from '@/lib/http';
import { requireOwner } from '@/lib/auth';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

/**
 * Marks notifications read: all of them, or one (`id`) when the Owner opens it, then follows its link (`next`).
 * Form posts redirect; JSON gets {ok}.
 */
export async function POST(req: Request) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const { db, studio } = await studioContext();
  const isForm = isFormPost(req);
  const f = isForm ? await req.formData() : null;
  const id = f?.get('id');
  const next = f?.get('next');
  if (typeof id === 'string' && UUID_RE.test(id)) {
    await markRead(db, studio.id, [id]);
    if (next) return redirectTo(safePath(next, '/notifications'));
  } else {
    await markRead(db, studio.id);
  }
  if (isForm) return backTo(req, '/notifications');
  return Response.json({ ok: true });
}
