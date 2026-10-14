import { activeKillSwitches, clearKillSwitch, type KillScope, OWNER, PLATFORMS, type Platform, setKillSwitch } from '@ios/core';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { db, studio } = await studioContext();
  return Response.json({ active: await activeKillSwitches(db, studio.id) });
}

/** {action: "set"|"clear", scope: "global"|"persona"|"platform", personaId?, platform?, reason?} as JSON or a form. */
export async function POST(req: Request) {
  const isForm = (req.headers.get('content-type') ?? '').includes('form');
  const input: Record<string, string> = isForm
    ? Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, String(v)]))
    : ((await req.json().catch(() => ({}))) as Record<string, string>);
  let scope: KillScope;
  if (input.scope === 'global') scope = { scope: 'global' };
  else if (input.scope === 'persona' && input.personaId) scope = { scope: 'persona', personaId: input.personaId };
  else if (input.scope === 'platform' && PLATFORMS.includes(input.platform as Platform)) scope = { scope: 'platform', platform: input.platform as Platform };
  else return Response.json({ error: 'invalid scope' }, { status: 400 });
  if (input.action !== 'set' && input.action !== 'clear') return Response.json({ error: 'action must be set or clear' }, { status: 400 });

  const { db, studio } = await studioContext();
  if (input.action === 'set') await setKillSwitch(db, studio.id, scope, OWNER, input.reason || 'paused from the dashboard');
  else await clearKillSwitch(db, studio.id, scope, OWNER);
  if (isForm) return Response.redirect(new URL(req.headers.get('referer') ?? '/settings', req.url), 303);
  return Response.json({ active: await activeKillSwitches(db, studio.id) });
}
