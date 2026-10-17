import { getStudio, OWNER } from '@troupe/core';
import { enqueueHandle, proposeCrisisText, resolveEscalation } from '@troupe/distribution';
import { requireOwner } from '@/lib/auth';
import { backTo, isFormPost, isJson, UUID_RE } from '@/lib/http';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

/**
 * Community actions (Owner only), as JSON or a form:
 *   {action: "resolve", escalationId, resolution?, resume?: "1"}   close an escalation (optionally let the bot reply again)
 *   {action: "crisis_text"}                                         propose the default crisis helpline text (Approvals)
 *   {action: "handle", personaId}                                   run the community worker for a persona now
 */
export async function POST(req: Request) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const isForm = isFormPost(req);
  if (!isForm && !isJson(req)) return Response.json({ error: 'send JSON or a form' }, { status: 415 });
  const input: Record<string, string> = isForm
    ? Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, String(v)]))
    : ((await req.json().catch(() => ({}))) as Record<string, string>);
  const done = (ok: string) => (isForm ? backTo(req, '/community', { ok }) : Response.json({ ok }));
  const fail = (error: string) => (isForm ? backTo(req, '/community', { error }) : Response.json({ error }, { status: 400 }));
  const services = await getServices();
  try {
    switch (input.action) {
      case 'resolve': {
        if (!UUID_RE.test(input.escalationId ?? '')) return fail('unknown escalation');
        const owned = await services.db.maybeOne(`SELECT 1 FROM escalation WHERE id = $1`, [input.escalationId]);
        if (!owned) return fail('unknown escalation');
        await resolveEscalation(services, input.escalationId!, OWNER, { resolution: input.resolution?.slice(0, 500), resume: input.resume === '1' || input.resume === 'true' });
        return done(input.resume === '1' || input.resume === 'true' ? 'resolved; replies resumed' : 'resolved');
      }
      case 'crisis_text': {
        const studio = await getStudio(services.db);
        return done((await proposeCrisisText(services, studio.id, OWNER)) ? 'crisis text sent to Approvals' : 'already waiting in Approvals');
      }
      case 'handle': {
        if (!UUID_RE.test(input.personaId ?? '')) return fail('choose a persona');
        const p = await services.db.maybeOne<{ studio_id: string }>('SELECT studio_id FROM persona WHERE id = $1', [input.personaId]);
        if (!p) return fail('unknown persona');
        await enqueueHandle(services, input.personaId!, p.studio_id);
        return done('community worker queued');
      }
      default:
        return fail('unknown action');
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message.slice(0, 200) : 'failed');
  }
}
