import { listPendingApprovals } from '@ios/core';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

/** Pending approvals, kill proposals first. */
export async function GET() {
  const { db, studio } = await studioContext();
  return Response.json({ approvals: await listPendingApprovals(db, studio.id) });
}
