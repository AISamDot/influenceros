import { ApprovalError, decide, NotFoundError, OWNER } from '@ios/core';
import { getDb } from '@ios/db';

export const dynamic = 'force-dynamic';

/**
 * Approve or reject: JSON {decision: "approve"|"reject", note?} or an HTML form post (redirects back).
 * The dashboard user is the Owner; every decision is audited by the engine. (Auth lands before deploy: IOS-5.)
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const isForm = (req.headers.get('content-type') ?? '').includes('form');
  let decision: unknown;
  let note: unknown;
  if (isForm) {
    const f = await req.formData();
    decision = f.get('decision');
    note = f.get('note');
  } else {
    const j = (await req.json().catch(() => ({}))) as { decision?: unknown; note?: unknown };
    decision = j.decision;
    note = j.note;
  }
  if (decision !== 'approve' && decision !== 'reject') {
    return Response.json({ error: 'decision must be "approve" or "reject"' }, { status: 400 });
  }
  try {
    const db = await getDb();
    const a = await decide(db, { approvalId: id, decision, actor: OWNER, note: typeof note === 'string' && note ? note : undefined });
    if (isForm) return Response.redirect(new URL(req.headers.get('referer') ?? '/approvals', req.url), 303);
    return Response.json({ approval: a });
  } catch (err) {
    const status = err instanceof NotFoundError ? 404 : err instanceof ApprovalError ? 409 : 500;
    if (status === 500) throw err;
    return Response.json({ error: (err as Error).message }, { status });
  }
}
