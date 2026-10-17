import { getStudio } from '@troupe/core';
import { radarOverview } from '@troupe/radar';
// Relative imports so the route can be exercised directly in tests.
import { requireOwner } from '../../../../lib/auth';
import { getServices } from '../../../../lib/services';

export const dynamic = 'force-dynamic';

/** Owner: the Radar read model as JSON (accounts, outliers, trends, remix briefs, benchmarks, Apify spend). */
export async function GET(req: Request) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const services = await getServices();
  const studio = await getStudio(services.db);
  return Response.json(await radarOverview(services.db, studio.id, services.now()));
}
