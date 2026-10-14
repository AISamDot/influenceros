import { activeKillSwitches, clearKillSwitch, type KillScope, OWNER, PLATFORMS, type Platform, setKillSwitch } from '@ios/core';
import { backTo, isFormPost, isJson, UUID_RE } from '@/lib/http';
import { requireOwner } from '@/lib/auth';
import { studioContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const { db, studio } = await studioContext();
  return Response.json({ active: await activeKillSwitches(db, studio.id) });
}

/** {action: "set"|"clear", scope: "global"|"persona"|"platform", personaId?, platform?, reason?} as JSON or a form. */
export async function POST(req: Request) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const isForm = isFormPost(req);
  if (!isForm && !isJson(req)) return Response.json({ error: 'send JSON or a form' }, { status: 415 });
  const input: Record<string, string> = isForm
    ? Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, String(v)]))
    : ((await req.json().catch(() => ({}))) as Record<string, string>);
  const fail = (error: string) => (isForm ? backTo(req, '/settings', { error }) : Response.json({ error }, { status: 400 }));
  let scope: KillScope;
  if (input.scope === 'global') scope = { scope: 'global' };
  else if (input.scope === 'persona' && input.personaId && UUID_RE.test(input.personaId)) scope = { scope: 'persona', personaId: input.personaId };
  else if (input.scope === 'platform' && PLATFORMS.includes(input.platform as Platform)) scope = { scope: 'platform', platform: input.platform as Platform };
  else return fail('invalid scope');
  if (input.action !== 'set' && input.action !== 'clear') return fail('action must be set or clear');

  const { db, studio } = await studioContext();
  if (input.action === 'set') await setKillSwitch(db, studio.id, scope, OWNER, input.reason || 'paused from the dashboard');
  else await clearKillSwitch(db, studio.id, scope, OWNER);
  if (isForm) return backTo(req, '/settings', { ok: input.action === 'set' ? 'paused' : 'resumed' });
  return Response.json({ active: await activeKillSwitches(db, studio.id) });
}
