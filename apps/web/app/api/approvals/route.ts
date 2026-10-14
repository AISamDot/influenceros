import { listPendingApprovals } from '@ios/core';
import { requireOwner } from '@/lib/auth';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

/** Pending approvals, kill proposals first. */
export async function GET(req: Request) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const { db, studio } = await studioContext();
  return Response.json({ approvals: await listPendingApprovals(db, studio.id) });
}
