import { ApprovalError, ApprovalRequiredError, decide, InvalidTransitionError, NotFoundError, OWNER } from '@ios/core';
import { getDb } from '@ios/db';
import { backTo, isFormPost, isJson, UUID_RE } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * Approve or reject: JSON {decision: "approve"|"reject", note?, payloadHash?} or an HTML form post (redirects
 * back, with ?error=… when the decision couldn't be applied). The dashboard user is the Owner; every decision is
 * audited by the engine. (Auth lands before deploy: IOS-5. Until then the server binds to 127.0.0.1 and
 * proxy.ts rejects cross-site posts.)
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
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
    const j = (await req.json().catch(() => ({}))) as { decision?: unknown; note?: unknown; payloadHash?: unknown };
    decision = j.decision;
    note = j.note;
    hash = j.payloadHash;
  }
  const fail = (status: number, error: string) => (isForm ? backTo(req, '/approvals', { error }) : Response.json({ error }, { status }));
  if (decision !== 'approve' && decision !== 'reject') return fail(400, 'decision must be "approve" or "reject"');
  if (!UUID_RE.test(id)) return fail(404, `approval ${id} not found`);
  try {
    const db = await getDb();
    if (isForm && decision === 'approve') {
      // The kill/retire form asks the Owner to type the persona's name (mis-tap guard); check it here too.
      const k = await db.maybeOne<{ kind: string; name: string | null }>(
        `SELECT a.kind, p.name FROM approval a LEFT JOIN persona p ON p.id = a.persona_id WHERE a.id = $1`,
        [id],
      );
      if (k && (k.kind === 'persona_kill' || k.kind === 'persona_retire') && (typeof confirm !== 'string' || confirm.trim() !== (k.name ?? 'Studio'))) {
        return fail(400, `type ${k.name ?? 'the persona name'} exactly to confirm`);
      }
    }
    const a = await decide(db, {
      approvalId: id,
      decision,
      actor: OWNER,
      note: typeof note === 'string' && note.trim() ? note.trim() : undefined,
      payloadHash: typeof hash === 'string' && hash ? hash : undefined,
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
