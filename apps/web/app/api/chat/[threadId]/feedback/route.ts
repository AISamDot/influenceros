import { addMessage, ApprovalError, getThread, NotFoundError, OWNER } from '@ios/core';
import { ToolPermissionError } from '@ios/agents';
import { requireOwner } from '@/lib/auth';
import { isJson, UUID_RE } from '@/lib/http';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

/**
 * The Owner's one-tap Apply / Not now on a persona manager's proposal: JSON {feedbackId, decision: "apply"|"reject"}.
 * Runs the Owner-only `feedback.decide` tool, then the manager confirms in the thread.
 */
export async function POST(req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const { threadId } = await params;
  if (!isJson(req)) return Response.json({ error: 'send JSON' }, { status: 415 });
  const j = (await req.json().catch(() => ({}))) as { feedbackId?: unknown; decision?: unknown };
  if (!UUID_RE.test(threadId) || typeof j.feedbackId !== 'string' || !UUID_RE.test(j.feedbackId)) return Response.json({ error: 'not found' }, { status: 404 });
  if (j.decision !== 'apply' && j.decision !== 'reject') return Response.json({ error: 'decision must be "apply" or "reject"' }, { status: 400 });
  const services = await getServices();
  const thread = await getThread(services.db, threadId);
  if (!thread || thread.kind !== 'persona' || !thread.persona_id) return Response.json({ error: 'not found' }, { status: 404 });
  const owns = await services.db.maybeOne('SELECT 1 FROM feedback WHERE id = $1 AND persona_id = $2', [j.feedbackId, thread.persona_id]);
  if (!owns) return Response.json({ error: 'not found' }, { status: 404 });
  try {
    const r = (await services.tools.invoke(
      { services, studioId: thread.studio_id, personaId: null, caller: 'owner', actor: OWNER },
      'feedback.decide',
      { feedback_id: j.feedbackId, decision: j.decision },
    )) as { status: string; summary?: string; result?: { bibleVersion?: number } };
    const body =
      r.status === 'applied'
        ? `Done. ${r.summary ?? ''}${r.result?.bibleVersion ? ' New scripts use it from the next batch.' : ''} I'll report the measured effect in the weekly review.`
        : 'Dropped it. Nothing changed.';
    const message = await addMessage(services.db, {
      threadId,
      role: 'agent',
      author: 'agent:persona-manager',
      body: body.replace(/\s+/g, ' ').trim(),
      personaId: thread.persona_id,
      meta: { kind: 'reply', feedback: { id: j.feedbackId, status: r.status, ...(r.result ?? {}) } },
    });
    return Response.json({ message });
  } catch (err) {
    if (err instanceof NotFoundError) return Response.json({ error: err.message }, { status: 404 });
    if (err instanceof ApprovalError || err instanceof ToolPermissionError) return Response.json({ error: err.message }, { status: 409 });
    throw err;
  }
}
