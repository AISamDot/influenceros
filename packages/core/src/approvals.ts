import { type Db, json } from '@ios/db';
import { audit } from './audit';
import { creditPeriod } from './governor';
import { ApprovalError, NotFoundError } from './errors';
import { transition } from './lifecycle';
import { notify } from './notifications';
import { getSettings } from './settings';
import {
  type Actor,
  actorRef,
  type ApprovalKind,
  type ApprovalMode,
  type ApprovalRow,
  type Autonomy,
  type GateVerdict,
  type PersonaRow,
  type StudioSettings,
  SYSTEM,
} from './types';

/**
 * Approval engine (PRD §3.7).
 * - Owner-only kinds (kill/retire, spend above caps, plan upgrades, disclosure/legal text): explicit Owner
 *   approval, no timer, never auto-approved. Agents can only propose. The database enforces this too.
 * - Cards (persona launch, product v1): auto-approve after N hours (default 24) unless the studio switched it off.
 * - Posts: L0 = explicit; L1 = green auto after the veto window, amber explicit; L2 = green+amber after the veto
 *   window. Red never publishes.
 */
export const OWNER_ONLY_KINDS: readonly ApprovalKind[] = [
  'persona_kill',
  'persona_retire',
  'spend_over_cap',
  'plan_upgrade',
  'disclosure_change',
  'legal_text_change',
];
export const CARD_KINDS: readonly ApprovalKind[] = ['persona_launch', 'product_v1'];

export const isOwnerOnly = (k: ApprovalKind) => OWNER_ONLY_KINDS.includes(k);

export interface PolicyContext {
  autonomy?: Autonomy;
  gate?: GateVerdict;
}

export function approvalPolicy(
  kind: ApprovalKind,
  settings: StudioSettings,
  ctx: PolicyContext = {},
): { mode: ApprovalMode; windowMs: number | null } {
  if (isOwnerOnly(kind)) return { mode: 'explicit', windowMs: null };
  if (CARD_KINDS.includes(kind)) {
    return settings.approvals.auto_approve_cards
      ? { mode: 'auto_after', windowMs: settings.approvals.auto_approve_hours * 3_600_000 }
      : { mode: 'explicit', windowMs: null };
  }
  // post
  const gate = ctx.gate ?? 'green';
  if (gate === 'red') throw new ApprovalError('Gate red: the post is blocked and can never be queued for publishing');
  const veto = { mode: 'veto_window' as const, windowMs: settings.approvals.post_veto_window_minutes * 60_000 };
  switch (ctx.autonomy ?? 'L0') {
    case 'L0':
      return { mode: 'explicit', windowMs: null };
    case 'L1':
      return gate === 'green' ? veto : { mode: 'explicit', windowMs: null };
    case 'L2':
      return veto;
  }
}

export interface ProposeInput {
  studioId: string;
  personaId?: string | null;
  kind: ApprovalKind;
  title: string;
  summary?: string;
  payload?: Record<string, unknown>;
  subjectType?: string;
  subjectId?: string;
  proposedBy: Actor;
  /** Post approvals only. */
  gate?: GateVerdict;
  now?: Date;
}

export async function propose(db: Db, input: ProposeInput): Promise<ApprovalRow> {
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx, input.studioId);
    let autonomy: Autonomy | undefined;
    if (input.personaId) {
      autonomy = (await tx.one<{ autonomy: Autonomy }>('SELECT autonomy FROM persona WHERE id = $1', [input.personaId]))
        .autonomy;
    }
    const policy = approvalPolicy(input.kind, settings, { autonomy, gate: input.gate });
    const now = input.now ?? new Date();
    const autoAt = policy.windowMs === null ? null : new Date(now.getTime() + policy.windowMs);
    const row = await tx.one<ApprovalRow>(
      `INSERT INTO approval (studio_id, persona_id, kind, mode, title, summary, payload, subject_type, subject_id,
                             proposed_by, auto_approve_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12) RETURNING *`,
      [
        input.studioId,
        input.personaId ?? null,
        input.kind,
        policy.mode,
        input.title,
        input.summary ?? null,
        json(input.payload ?? {}),
        input.subjectType ?? null,
        input.subjectId ?? null,
        actorRef(input.proposedBy),
        autoAt,
        now,
      ],
    );
    await audit(tx, {
      studioId: input.studioId,
      personaId: input.personaId,
      actor: input.proposedBy,
      action: 'approval.proposed',
      entityType: 'approval',
      entityId: row.id,
      data: { kind: row.kind, mode: row.mode, auto_approve_at: autoAt?.toISOString() ?? null },
    });
    if (input.kind !== 'post' || policy.mode === 'explicit') {
      await notify(tx, {
        studioId: input.studioId,
        personaId: input.personaId,
        kind: 'approval',
        severity: input.kind === 'persona_kill' || input.kind === 'persona_retire' ? 'critical' : isOwnerOnly(input.kind) ? 'warn' : 'info',
        title: input.title,
        body: input.summary,
        link: '/approvals',
      });
    }
    return row;
  });
}

/** The Studio Manager's kill proposal: a kill_scale_proposal plus an Owner-only approval. The persona keeps running. */
export async function proposeKill(
  db: Db,
  input: {
    personaId: string;
    rationale: string;
    evidence?: Record<string, unknown>;
    score?: number;
    proposedBy: Actor;
    action?: 'kill' | 'retire';
    now?: Date;
  },
): Promise<{ approval: ApprovalRow; proposalId: string }> {
  return db.transaction(async (tx) => {
    const p = await tx.one<PersonaRow>('SELECT * FROM persona WHERE id = $1', [input.personaId]);
    const action = input.action ?? 'kill';
    const approval = await propose(tx, {
      studioId: p.studio_id,
      personaId: p.id,
      kind: action === 'kill' ? 'persona_kill' : 'persona_retire',
      title: `${action === 'kill' ? 'Kill' : 'Retire'} ${p.name}`,
      summary: input.rationale,
      payload: { evidence: input.evidence ?? {}, score: input.score ?? null },
      subjectType: 'persona',
      subjectId: p.id,
      proposedBy: input.proposedBy,
      now: input.now,
    });
    const now = input.now ?? new Date();
    const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
    const prop = await tx.one<{ id: string }>(
      `INSERT INTO kill_scale_proposal (studio_id, persona_id, week_start, action, score, rationale, evidence, approval_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING id`,
      [p.studio_id, p.id, weekStart.toISOString().slice(0, 10), action, input.score ?? null, input.rationale, json(input.evidence ?? {}), approval.id],
    );
    return { approval, proposalId: prop.id };
  });
}

async function execute(tx: Db, a: ApprovalRow, actor: Actor): Promise<unknown> {
  switch (a.kind) {
    case 'persona_kill':
    case 'persona_retire': {
      if (!a.persona_id) throw new ApprovalError('kill/retire approval without a persona');
      const to = a.kind === 'persona_kill' ? 'KILLED' : 'RETIRED';
      await transition(tx, { personaId: a.persona_id, to, actor, approvalId: a.id, reason: a.summary ?? undefined });
      await tx.query(`UPDATE kill_scale_proposal SET status = 'executed' WHERE approval_id = $1`, [a.id]);
      return { state: to };
    }
    case 'persona_launch': {
      if (!a.persona_id) throw new ApprovalError('launch approval without a persona');
      await transition(tx, { personaId: a.persona_id, to: 'SETUP', actor, approvalId: a.id, reason: 'launch approved' });
      return { state: 'SETUP' };
    }
    case 'product_v1': {
      if (a.subject_id) {
        await tx.query(`UPDATE product SET status = 'approved' WHERE id = $1`, [a.subject_id]);
        await tx.query(`UPDATE product_version SET status = 'approved' WHERE product_id = $1 AND version = 1`, [a.subject_id]);
      }
      return { product: a.subject_id, status: 'approved' };
    }
    case 'post': {
      if (a.subject_id) await tx.query(`UPDATE post SET status = 'scheduled', updated_at = now() WHERE id = $1`, [a.subject_id]);
      return { post: a.subject_id, status: 'scheduled' };
    }
    case 'spend_over_cap': {
      // A grant raises headroom for the month: available = cap + grants − debits.
      const unit = String(a.payload.unit ?? 'llm_usd');
      const amount = Number(a.payload.amount ?? 0);
      if (!(amount > 0)) throw new ApprovalError('spend_over_cap needs a positive amount');
      await tx.query(
        `INSERT INTO credit_ledger (studio_id, persona_id, unit, entry_type, amount, period, operation, ref_type, ref_id)
         VALUES ($1, $2, $3, 'grant', $4, $5, 'owner_grant', 'approval', $6)`,
        [a.studio_id, a.persona_id, unit, amount, String(a.payload.period ?? creditPeriod(new Date())), a.id],
      );
      return { granted: { unit, amount } };
    }
    case 'disclosure_change': {
      const text = String(a.payload.text ?? '');
      if (!text) throw new ApprovalError('disclosure_change needs text');
      await tx.query(
        `UPDATE studio SET settings = jsonb_set(settings, '{disclosure_text}', to_jsonb($2::text)), updated_at = now() WHERE id = $1`,
        [a.studio_id, text],
      );
      return { disclosure_text: text };
    }
    case 'plan_upgrade':
    case 'legal_text_change':
      // Recorded decision; the Owner makes the purchase / the legal page update lands with its feature.
      return { recorded: true };
  }
}

async function onReject(tx: Db, a: ApprovalRow): Promise<void> {
  if (a.kind === 'post' && a.subject_id) {
    await tx.query(`UPDATE post SET status = 'vetoed', updated_at = now() WHERE id = $1`, [a.subject_id]);
  }
  if (a.kind === 'product_v1' && a.subject_id) {
    await tx.query(`UPDATE product SET status = 'building' WHERE id = $1`, [a.subject_id]);
  }
  await tx.query(`UPDATE kill_scale_proposal SET status = 'rejected' WHERE approval_id = $1`, [a.id]);
}

export interface DecideInput {
  approvalId: string;
  decision: 'approve' | 'reject';
  actor: Actor;
  note?: string;
  now?: Date;
}

/** The Owner approves or rejects. Agents and the system can never decide; they can only propose. */
export async function decide(db: Db, input: DecideInput): Promise<ApprovalRow> {
  if (input.actor.type !== 'owner') {
    throw new ApprovalError(`${actorRef(input.actor)} cannot decide approvals: only the Owner can (agents only propose)`);
  }
  return db.transaction(async (tx) => {
    const a = await tx.maybeOne<ApprovalRow>('SELECT * FROM approval WHERE id = $1 FOR UPDATE', [input.approvalId]);
    if (!a) throw new NotFoundError(`approval ${input.approvalId} not found`);
    if (a.status !== 'pending') throw new ApprovalError(`approval is already ${a.status}`);
    const now = input.now ?? new Date();
    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    const decided = await tx.one<ApprovalRow>(
      `UPDATE approval SET status = $2, decided_by = $3, decided_at = $4, decision_note = $5 WHERE id = $1 RETURNING *`,
      [a.id, status, actorRef(input.actor), now, input.note ?? null],
    );
    await audit(tx, {
      studioId: a.studio_id,
      personaId: a.persona_id,
      actor: input.actor,
      action: `approval.${status}`,
      entityType: 'approval',
      entityId: a.id,
      data: { kind: a.kind, note: input.note ?? null },
    });
    if (status === 'rejected') {
      await onReject(tx, decided);
      return decided;
    }
    await tx.query(`UPDATE kill_scale_proposal SET status = 'approved' WHERE approval_id = $1`, [a.id]);
    return markExecuted(tx, decided, await execute(tx, decided, input.actor), input.actor);
  });
}

async function markExecuted(tx: Db, a: ApprovalRow, result: unknown, actor: Actor): Promise<ApprovalRow> {
  const row = await tx.one<ApprovalRow>(
    `UPDATE approval SET executed_at = now(), execution_result = $2::jsonb WHERE id = $1 RETURNING *`,
    [a.id, json(result)],
  );
  await audit(tx, {
    studioId: a.studio_id,
    personaId: a.persona_id,
    actor,
    action: 'approval.executed',
    entityType: 'approval',
    entityId: a.id,
    data: { kind: a.kind, result: result as Record<string, unknown> },
  });
  return row;
}

/** The proposer (or the Owner) withdraws a pending approval. */
export async function withdraw(db: Db, approvalId: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const a = await tx.one<ApprovalRow>('SELECT * FROM approval WHERE id = $1 FOR UPDATE', [approvalId]);
    if (a.status !== 'pending') throw new ApprovalError(`approval is already ${a.status}`);
    if (actor.type !== 'owner' && a.proposed_by !== actorRef(actor)) {
      throw new ApprovalError('only the proposer or the Owner can withdraw');
    }
    await tx.query(`UPDATE approval SET status = 'withdrawn', decided_by = $2, decided_at = now() WHERE id = $1`, [
      approvalId,
      actorRef(actor),
    ]);
    await audit(tx, { studioId: a.studio_id, personaId: a.persona_id, actor, action: 'approval.withdrawn', entityType: 'approval', entityId: a.id });
  });
}

/**
 * Auto-approves timed cards and veto-window posts whose time has come. Owner-only kinds are never touched (and
 * the database would reject it). If the studio switched auto-approve off, pending cards become explicit.
 */
export async function sweepAutoApprovals(db: Db, opts: { now?: Date } = {}): Promise<string[]> {
  const now = opts.now ?? new Date();
  const approved: string[] = [];
  const due = await db.query<{ id: string }>(
    `SELECT id FROM approval
      WHERE status = 'pending' AND mode IN ('auto_after','veto_window') AND auto_approve_at <= $1
        AND kind <> ALL($2::text[])
      ORDER BY auto_approve_at`,
    [now, OWNER_ONLY_KINDS],
  );
  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const a = await tx.maybeOne<ApprovalRow>(
        `SELECT * FROM approval WHERE id = $1 AND status = 'pending' FOR UPDATE SKIP LOCKED`,
        [id],
      );
      if (!a || isOwnerOnly(a.kind) || a.auto_approve_at === null || a.auto_approve_at > now) return;
      if (a.mode === 'auto_after') {
        const settings = await getSettings(tx, a.studio_id);
        if (!settings.approvals.auto_approve_cards) {
          await tx.query(`UPDATE approval SET mode = 'explicit', auto_approve_at = NULL WHERE id = $1`, [a.id]);
          await audit(tx, { studioId: a.studio_id, personaId: a.persona_id, actor: SYSTEM, action: 'approval.auto_disabled', entityType: 'approval', entityId: a.id });
          return;
        }
      }
      const decided = await tx.one<ApprovalRow>(
        `UPDATE approval SET status = 'auto_approved', decided_by = 'system:auto-approve', decided_at = $2 WHERE id = $1 RETURNING *`,
        [a.id, now],
      );
      const actor: Actor = { type: 'system', id: 'auto-approve' };
      await audit(tx, {
        studioId: a.studio_id,
        personaId: a.persona_id,
        actor,
        action: 'approval.auto_approved',
        entityType: 'approval',
        entityId: a.id,
        data: { kind: a.kind, mode: a.mode },
      });
      await markExecuted(tx, decided, await execute(tx, decided, actor), actor);
      approved.push(a.id);
    });
  }
  return approved;
}

export async function listPendingApprovals(db: Db, studioId: string): Promise<Array<ApprovalRow & { persona_name: string | null; persona_slug: string | null; portrait_url: string | null }>> {
  // Kill/retire proposals first, then other Owner-only items, then timed cards (soonest first).
  return db.query(
    `SELECT a.*, p.name AS persona_name, p.slug AS persona_slug, p.portrait_url
       FROM approval a LEFT JOIN persona p ON p.id = a.persona_id
      WHERE a.studio_id = $1 AND a.status = 'pending'
      ORDER BY CASE WHEN a.kind IN ('persona_kill','persona_retire') THEN 0
                    WHEN a.mode = 'explicit' THEN 1 ELSE 2 END,
               a.auto_approve_at NULLS FIRST, a.created_at`,
    [studioId],
  );
}
