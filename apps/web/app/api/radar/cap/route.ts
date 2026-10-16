import { getStudio, OWNER, updateSettings } from '@ios/core';
// Relative imports so the route can be exercised directly in tests.
import { requireOwner } from '../../../../lib/auth';
import { backTo, isFormPost } from '../../../../lib/http';
import { getServices } from '../../../../lib/services';

export const dynamic = 'force-dynamic';

/**
 * Owner: set the studio's weekly Apify cap (USD over the trailing 7 days; `apify_weekly_cap_usd`). Agents only ever
 * propose a change; this route is the Owner's action. 0 pauses all scraping.
 */
export async function POST(req: Request) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const form = isFormPost(req);
  const raw = form ? (await req.formData()).get('cap') : ((await req.json().catch(() => ({}))) as { cap?: unknown }).cap;
  const cap = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(cap) || cap < 0 || cap > 500) {
    const error = 'the weekly cap must be a number from 0 to 500 (USD)';
    return form ? backTo(req, '/radar', { error }) : Response.json({ error }, { status: 400 });
  }
  const services = await getServices();
  const studio = await getStudio(services.db);
  const rounded = Math.round(cap * 100) / 100;
  await updateSettings(services.db, studio.id, { apify_weekly_cap_usd: rounded }, OWNER);
  const ok = `Weekly Apify cap set to $${rounded.toFixed(2)}.`;
  return form ? backTo(req, '/radar', { ok }) : Response.json({ capUsd: rounded, ok });
}
