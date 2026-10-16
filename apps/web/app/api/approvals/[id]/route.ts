import { ApprovalError, ApprovalRequiredError, decide, InvalidTransitionError, NotFoundError, OWNER } from '@ios/core';
import { getDb } from '@ios/db';
// Relative imports so the route can be exercised directly in tests (apps/web/test/routes.test.ts).
import { requireOwner } from '../../../../lib/auth';
import { backTo, isFormPost, isJson, UUID_RE } from '../../../../lib/http';

export const dynamic = 'force-dynamic';

/**
 * Approve or reject, as the signed-in Owner: JSON {decision: "approve"|"reject", note?, payloadHash?, confirm?} or
 * an HTML form post (redirects back, with ?error=… when the decision couldn't be applied). Approving a kill or
 * retire needs the payload hash of the card and the persona's name typed exactly (`confirm`), on both paths: the
 * approval engine enforces it. Every decision is audited by the engine.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const { id } = await params;
  const isForm = isFormPost(req);
  if (!isForm && !isJson(req)) return Response.json({ error: 'send JSON or a form' }, { status: 415 });
  let decision: unknown;
  let note: unknown;
  let hash: unknown;
  let confirm: unknown;
  if (isForm) {
    const f = await req.formData();
    decision = f.get('decision');
    note = f.get('note');
    hash = f.get('payload_hash');
    confirm = f.get('confirm');
  } else {
    const j = (await req.json().catch(() => ({}))) as { decision?: unknown; note?: unknown; payloadHash?: unknown; confirm?: unknown; confirmName?: unknown };
    decision = j.decision;
    note = j.note;
    hash = j.payloadHash;
    confirm = j.confirm ?? j.confirmName;
  }
  const fail = (status: number, error: string) => (isForm ? backTo(req, '/approvals', { error }) : Response.json({ error }, { status }));
  if (decision !== 'approve' && decision !== 'reject') return fail(400, 'decision must be "approve" or "reject"');
  if (!UUID_RE.test(id)) return fail(404, `approval ${id} not found`);
  try {
    const db = await getDb();
    // An Owner-only persona launch is approved in the Persona Generator's review (step 7), never by a bare approve.
    if (decision === 'approve') {
      const card = await db.maybeOne<{ kind: string; payload: Record<string, unknown> }>('SELECT kind, payload FROM approval WHERE id = $1', [id]);
      if (card?.kind === 'persona_launch' && card.payload?.owner_only === true) return fail(409, 'approve this launch in the Persona Generator review (Approvals → Open the review)');
    }
    const a = await decide(db, {
      approvalId: id,
      decision,
      actor: OWNER,
      note: typeof note === 'string' && note.trim() ? note.trim() : undefined,
      payloadHash: typeof hash === 'string' && hash ? hash : undefined,
      confirmName: typeof confirm === 'string' ? confirm : undefined,
    });
    if (isForm) return backTo(req, '/approvals', { ok: decision === 'approve' ? 'approved' : 'rejected' });
    return Response.json({ approval: a });
  } catch (err) {
    const status =
      err instanceof NotFoundError
        ? 404
        : err instanceof ApprovalError || err instanceof InvalidTransitionError || err instanceof ApprovalRequiredError
          ? 409
          : 500;
    if (status === 500) throw err;
    return fail(status, (err as Error).message);
  }
}
