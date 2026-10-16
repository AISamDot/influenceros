import { getStudio } from '@ios/core';
import { enqueueWeekly } from '@ios/radar';
// Relative imports so the route can be exercised directly in tests.
import { requireOwner } from '../../../../lib/auth';
import { backTo, isFormPost } from '../../../../lib/http';
import { getServices } from '../../../../lib/services';

export const dynamic = 'force-dynamic';

/** Owner: queue this week's Growth Radar run now (deduplicated per week; it stays inside the Apify weekly cap). */
export async function POST(req: Request) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const services = await getServices();
  const studio = await getStudio(services.db);
  const jobId = await enqueueWeekly(services, studio.id);
  const ok = jobId ? 'Radar scan queued: results land here and in the Studio chat.' : 'This week’s Radar scan is already queued or done.';
  return isFormPost(req) ? backTo(req, '/radar', { ok }) : Response.json({ jobId, ok });
}
