import { type Db, json } from '@troupe/db';
import { audit } from './audit';
import { addMessage, findThread } from './chat';
import { capFor, creditPeriod, type Unit } from './governor';
import { ApprovalError, NotFoundError } from './errors';
import { archivePersona } from './archive';
import { canTransition, transition } from './lifecycle';
import { notify } from './notifications';
import {
  approvalPolicy,
  isOwnerOnly,
  latestPostGate,
  makeExplicit,
  OWNER_ONLY_KINDS,
  payloadHash,
  postWindowAllowed,
  requiresOwner,
} from './policy';
import { enqueue } from './queue';
import { getSettings } from './settings';
import {
  type Actor,
  actorRef,
  type ApprovalKind,
  type ApprovalRow,
  type Autonomy,
  type GateVerdict,
  type PersonaRow,
  type PersonaState,
  type StudioSettings,
  SYSTEM,
} from './types';

/**
 * Approval engine (PRD §3.7). The policy (which kinds are Owner-only, card timers, post autonomy) lives in
 * policy.ts; this module proposes, decides, executes and sweeps.
 */

/** The lifecycle state each lifecycle approval moves its persona into. */
const LIFECYCLE_TARGET: Partial<Record<ApprovalKind, PersonaState>> = {
  persona_kill: 'KILLED',
  persona_retire: 'RETIRED',
  persona_launch: 'SETUP',
};

/** Units a spend_over_cap grant can raise (the capped ones). */
const GRANT_UNITS: readonly Unit[] = ['llm_usd', 'hf_credits'];

const nextPeriod = (now: Date) => creditPeriod(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));

/**
 * Checks and normalises what an Owner-only card will execute, so the card shows exactly what runs:
 * spend grants need a capped unit, a finite positive amount no larger than one month of the studio cap, and the
 * current or next period; disclosure changes need non-empty text.
 */
function validatePayload(kind: ApprovalKind, payload: Record<string, unknown>, settings: StudioSettings, now: Date): Record<string, unknown> {
  if (kind === 'spend_over_cap') {
    const unit = String(payload.unit ?? 'llm_usd') as Unit;
    if (!GRANT_UNITS.includes(unit)) throw new ApprovalError(`spend_over_cap: unit must be one of ${GRANT_UNITS.join(', ')}`);
    const amount = Number(payload.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new ApprovalError('spend_over_cap needs a finite, positive amount');
    const cap = capFor(unit, settings.caps) ?? 0;
    if (amount > cap) throw new ApprovalError(`spend_over_cap: ${amount} ${unit} is more than a full month of the studio cap (${cap})`);
    const period = payload.period === undefined ? creditPeriod(now) : String(payload.period);
    if (period !== creditPeriod(now) && period !== nextPeriod(now)) {
      throw new ApprovalError(`spend_over_cap: period must be ${creditPeriod(now)} or ${nextPeriod(now)}`);
    }
    return { ...payload, unit, amount, period };
  }
  if (kind === 'disclosure_change') {
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text) throw new ApprovalError('disclosure_change needs non-empty text');
    return { ...payload, text };
  }
  return payload;
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
  /**
   * Post approvals only: the verdict the proposer saw. The stored gate_result decides; if this disagrees with it
   * the proposal is refused. A post with no stored verdict is never auto-published.
   */
  gate?: GateVerdict;
  /**
   * (16 Oct) persona_launch only: the Owner must approve this launch (generator-created and archive-restored personas).
   * The card is explicit with no timer, carries `payload.owner_only`, and the database refuses any other decider.
   */
  ownerOnly?: boolean;
  now?: Date;
}

export async function propose(db: Db, input: ProposeInput): Promise<ApprovalRow> {
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx, input.studioId);
    const now = input.now ?? new Date();
    let persona: Pick<PersonaRow, 'id' | 'name' | 'state' | 'autonomy'> | null = null;
    if (input.personaId) {
      persona = await tx.maybeOne('SELECT id, name, state, autonomy FROM persona WHERE id = $1', [input.personaId]);
      if (!persona) throw new NotFoundError(`persona ${input.personaId} not found`);
    }

    // Lifecycle cards must be executable when the Owner (or the timer) approves them.
    const target = LIFECYCLE_TARGET[input.kind];
    if (target) {
      if (!persona) throw new ApprovalError(`${input.kind} needs a persona`);
      if (!canTransition(persona.state, target)) {
        throw new ApprovalError(`${persona.name} is ${persona.state}: ${persona.state} → ${target} is not a valid transition`);
      }
    }

    if (input.ownerOnly && input.kind !== 'persona_launch') throw new ApprovalError('ownerOnly applies to persona_launch cards only');
    if (input.kind === 'persona_archive') {
      if (!persona) throw new ApprovalError('persona_archive needs a persona');
      if (['ARCHIVED', 'KILLED', 'RETIRED'].includes(persona.state)) throw new ApprovalError(`${persona.name} is ${persona.state}: nothing to archive`);
    }
    const payload = validatePayload(input.kind, { ...(input.payload ?? {}), ...(input.ownerOnly ? { owner_only: true } : {}) }, settings, now);

    // Posts: the approval is bound to one post of this persona, and the Gate verdict comes from the stored
    // gate_result, never from the caller.
    let gate: GateVerdict | undefined;
    if (input.kind === 'post') {
      if (!persona) throw new ApprovalError('a post approval needs a persona');
      if (input.subjectType !== 'post' || !input.subjectId) throw new ApprovalError('a post approval needs subjectType "post" and the post id');
      const post = await tx.maybeOne<{ persona_id: string; status: string }>('SELECT persona_id, status FROM post WHERE id = $1 FOR UPDATE', [input.subjectId]);
      if (!post) throw new NotFoundError(`post ${input.subjectId} not found`);
      if (post.persona_id !== persona.id) throw new ApprovalError('the post belongs to another persona');
      if (post.status !== 'draft' && post.status !== 'awaiting_approval') throw new ApprovalError(`the post is ${post.status}, not awaiting approval`);
      const open = await tx.maybeOne(`SELECT 1 FROM approval WHERE kind = 'post' AND subject_id = $1 AND status = 'pending'`, [input.subjectId]);
      if (open) throw new ApprovalError('the post already has a pending approval');
      gate = (await latestPostGate(tx, input.subjectId))?.verdict;
      if (input.gate && gate && input.gate !== gate) {
        throw new ApprovalError(`Gate verdict mismatch: the proposer says ${input.gate}, the stored Gate result is ${gate}`);
      }
    }

    const autonomy: Autonomy | undefined = persona?.autonomy;
    const policy = approvalPolicy(input.kind, settings, { autonomy, gate, ownerOnly: input.ownerOnly === true });
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
        json(payload),
        input.subjectType ?? null,
        input.subjectId ?? null,
        actorRef(input.proposedBy),
        autoAt,
        now,
      ],
    );
    if (input.kind === 'post') {
      await tx.query(`UPDATE post SET status = 'awaiting_approval', approval_id = $2, updated_at = now() WHERE id = $1`, [input.subjectId, row.id]);
    }
    await audit(tx, {
      studioId: input.studioId,
      personaId: input.personaId,
      actor: input.proposedBy,
      action: 'approval.proposed',
      entityType: 'approval',
      entityId: row.id,
      data: { kind: row.kind, mode: row.mode, auto_approve_at: autoAt?.toISOString() ?? null, gate: gate ?? null },
    });
    if (input.kind !== 'post' || policy.mode === 'explicit') {
      await notify(tx, {
        studioId: input.studioId,
        personaId: input.personaId,
        kind: 'approval',
        severity: input.kind === 'persona_kill' || input.kind === 'persona_retire' ? 'critical' : isOwnerOnly(input.kind) || input.ownerOnly ? 'warn' : 'info',
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
    case 'persona_archive': {
      if (!a.persona_id) throw new ApprovalError('archive approval without a persona');
      const p = await archivePersona(tx, { personaId: a.persona_id, actor, approvalId: a.id, reason: a.summary ?? undefined });
      return { state: p.state, from: p.archived_from_state };
    }
    case 'persona_launch': {
      if (!a.persona_id) throw new ApprovalError('launch approval without a persona');
      if (a.payload.owner_only === true && actor.type !== 'owner') throw new ApprovalError('this launch needs the Owner\'s approval');
      await transition(tx, { personaId: a.persona_id, to: 'SETUP', actor, approvalId: a.id, reason: 'launch approved' });
      return { state: 'SETUP' };
    }
    case 'product_v1': {
      // v1 approves the product; a later version (payload.version > 1, a material change, FR-9.3) becomes current.
      const version = Math.max(1, Math.floor(Number(a.payload.version ?? 1)) || 1);
      if (a.subject_id && version === 1) {
        await tx.query(`UPDATE product SET status = 'approved' WHERE id = $1`, [a.subject_id]);
        await tx.query(`UPDATE product_version SET status = 'approved' WHERE product_id = $1 AND version = 1`, [a.subject_id]);
      } else if (a.subject_id) {
        await tx.query(`UPDATE product_version SET status = 'approved' WHERE product_id = $1 AND version = $2`, [a.subject_id, version]);
        await tx.query(`UPDATE product SET current_version = GREATEST(COALESCE(current_version, 0), $2) WHERE id = $1`, [a.subject_id, version]);
      }
      return { product: a.subject_id, status: 'approved', version };
    }
    case 'qc_override': {
      // Majors only: a card that lists a blocker is refused (blockers are never overridable).
      const failing = Array.isArray(a.payload.failing) ? (a.payload.failing as Array<{ severity?: string }>) : [];
      if (failing.some((f) => f.severity === 'blocker')) throw new ApprovalError('a QC blocker can never be overridden');
      const prepare = (a.payload.prepare ?? null) as Record<string, unknown> | null;
      const slotId = typeof prepare?.slotId === 'string' ? prepare.slotId : null;
      if (!prepare || !slotId) throw new ApprovalError('qc_override without the post to publish');
      const reason = String(a.decision_note ?? '').slice(0, 500);
      // Posts blocked by post-QC (never by the Gate) go back to draft so publish.prepare re-runs them with the override.
      await tx.query(
        `UPDATE post SET status = 'draft', meta = meta - 'blocked_reason', updated_at = now()
          WHERE calendar_slot_id = $1 AND status = 'blocked' AND meta->>'blocked_reason' LIKE 'post Q4:%'`,
        [slotId],
      );
      await tx.query(`UPDATE calendar_slot SET status = 'final_gate', block_reason = NULL, stage_changed_at = now() WHERE id = $1 AND status = 'blocked'`, [slotId]);
      const job = await enqueue(tx, {
        kind: 'publish.prepare',
        payload: { ...prepare, qcOverride: { approvalId: a.id, reason, stage: String(a.payload.stage ?? 'Q4') }, dedupe: `slot:${slotId}:override:${a.id}` },
        studioId: a.studio_id,
        personaId: a.persona_id,
      });
      return { slot: slotId, publishJob: job.id, reason };
    }
    case 'post': {
      if (a.subject_type !== 'post' || !a.subject_id || !a.persona_id) throw new ApprovalError('post approval without a post');
      const rows = await tx.query(
        `UPDATE post SET status = 'scheduled', approval_id = $3, updated_at = now()
          WHERE id = $1 AND persona_id = $2 AND status = 'awaiting_approval' RETURNING id`,
        [a.subject_id, a.persona_id, a.id],
      );
      if (!rows.length) throw new ApprovalError('the post is no longer awaiting approval');
      return { post: a.subject_id, status: 'scheduled' };
    }
    case 'spend_over_cap': {
      // A grant raises headroom for the month: available = cap + grants − debits.
      const unit = String(a.payload.unit ?? 'llm_usd');
      const amount = Number(a.payload.amount ?? 0);
      if (!Number.isFinite(amount) || amount <= 0) throw new ApprovalError('spend_over_cap needs a finite, positive amount');
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
    case 'legal_text_change': {
      // A persona's identity / compliance / disclosure bible text (from the feedback loop): the Owner's approval
      // writes Bible vN+1 and confirms in the persona chat. Without a section it is a recorded decision.
      const section = typeof a.payload.section === 'string' ? a.payload.section : '';
      const text = typeof a.payload.text === 'string' ? a.payload.text.trim() : '';
      if (!section || !text || !a.persona_id) return { recorded: true };
      const version = await writeOwnerBibleRule(tx, { studioId: a.studio_id, personaId: a.persona_id, section, rule: text, approvalId: a.id, actor });
      const feedbackId = typeof a.payload.feedback_id === 'string' ? a.payload.feedback_id : null;
      if (feedbackId) {
        await tx.query(`UPDATE feedback SET applied_change = applied_change || $2::jsonb WHERE id = $1 AND persona_id = $3`, [
          feedbackId,
          json({ result: { approvalId: a.id, bibleVersion: version }, live_at: new Date().toISOString() }),
          a.persona_id,
        ]);
      }
      const thread = await findThread(tx, a.studio_id, 'persona', a.persona_id);
      await addMessage(tx, {
        threadId: thread.id,
        role: 'agent',
        author: 'agent:persona-manager',
        personaId: a.persona_id,
        body: `Approved: Bible v${version} is live with the new ${section} text. New scripts use it from the next batch.`,
        meta: { kind: 'notice', approvalId: a.id, bibleVersion: version },
      });
      return { bibleVersion: version, section };
    }
    case 'plan_upgrade':
      // Recorded decision; the Owner makes the purchase.
      return { recorded: true };
  }
}

/**
 * Bible vN+1 with an Owner-approved rule in an Owner-only section (identity, compliance, disclosure): the previous
 * version's content plus the rule in the section's `owner_rules` and a changelog entry. Mirrors the agents'
 * reviseBible, which refuses these sections; only an approved legal_text_change reaches this.
 */
async function writeOwnerBibleRule(
  tx: Db,
  input: { studioId: string; personaId: string; section: string; rule: string; approvalId: string; actor: Actor },
): Promise<number> {
  await tx.query('SELECT id FROM persona WHERE id = $1 FOR UPDATE', [input.personaId]);
  const cur = await tx.maybeOne<{ content: Record<string, unknown> }>(
    `SELECT content FROM persona_bible WHERE persona_id = $1 AND status = 'approved' ORDER BY version DESC LIMIT 1`,
    [input.personaId],
  );
  const max = await tx.one<{ v: number }>('SELECT COALESCE(MAX(version), 0)::int AS v FROM persona_bible WHERE persona_id = $1', [input.personaId]);
  const version = max.v + 1;
  const content = structuredClone(cur?.content ?? {});
  const sec = content[input.section];
  if (sec && typeof sec === 'object' && !Array.isArray(sec)) {
    const s = sec as Record<string, unknown>;
    s.owner_rules = [...(Array.isArray(s.owner_rules) ? s.owner_rules : []), input.rule];
  } else if (sec === undefined) {
    content[input.section] = { owner_rules: [input.rule] };
  } else {
    content.owner_rules = [...(Array.isArray(content.owner_rules) ? content.owner_rules : []), { section: input.section, rule: input.rule }];
  }
  content.changelog = [
    ...(Array.isArray(content.changelog) ? content.changelog : []),
    { version, section: input.section, change: input.rule, by: 'owner', approval_id: input.approvalId },
  ];
  const by = actorRef(input.actor);
  await tx.query(`UPDATE persona_bible SET status = 'superseded' WHERE persona_id = $1 AND status = 'approved'`, [input.personaId]);
  await tx.query(
    `INSERT INTO persona_bible (persona_id, version, content, status, created_by, approved_by, approved_at)
     VALUES ($1, $2, $3::jsonb, 'approved', 'agent:persona-manager', $4, now())`,
    [input.personaId, version, json(content), by],
  );
  await tx.query('UPDATE persona SET current_bible_version = $2, updated_at = now() WHERE id = $1', [input.personaId, version]);
  await audit(tx, {
    studioId: input.studioId,
    personaId: input.personaId,
    actor: input.actor,
    action: 'bible.revised',
    entityType: 'persona_bible',
    entityId: `${input.personaId}:v${version}`,
    data: { section: input.section, rule: input.rule, approval_id: input.approvalId, to: version },
  });
  return version;
}

async function onReject(tx: Db, a: ApprovalRow): Promise<void> {
  if (a.kind === 'post' && a.subject_id) {
    await tx.query(`UPDATE post SET status = 'vetoed', updated_at = now() WHERE id = $1 AND status = 'awaiting_approval'`, [a.subject_id]);
  }
  if (a.kind === 'product_v1' && a.subject_id) {
    const version = Math.max(1, Math.floor(Number(a.payload.version ?? 1)) || 1);
    // A rejected later version is retired; the product keeps selling the current one.
    if (version > 1) await tx.query(`UPDATE product_version SET status = 'retired' WHERE product_id = $1 AND version = $2 AND status = 'awaiting_approval'`, [a.subject_id, version]);
    else await tx.query(`UPDATE product SET status = 'building' WHERE id = $1`, [a.subject_id]);
  }
  await tx.query(`UPDATE kill_scale_proposal SET status = 'rejected' WHERE approval_id = $1`, [a.id]);
}

export interface DecideInput {
  approvalId: string;
  decision: 'approve' | 'reject';
  actor: Actor;
  note?: string;
  /**
   * payloadHash() of the payload shown on the card. When given, decide refuses if the payload differs. Approving a
   * kill or retire requires it.
   */
  payloadHash?: string;
  /** Approving a kill or retire requires the persona's name, typed by the Owner (mis-tap guard). */
  confirmName?: string;
  now?: Date;
}

/** Kinds whose approval needs the typed persona name and the card's payload hash, on every path (form, JSON, chat). */
export const CONFIRM_KINDS: readonly ApprovalKind[] = ['persona_kill', 'persona_retire'];

/**
 * The Owner approves or rejects. Agents and the system can never decide; they can only propose.
 * Approving a kill or retire also needs the payload hash of the card the Owner reviewed and the persona's name
 * typed exactly, whichever path the decision comes from.
 */
export async function decide(db: Db, input: DecideInput): Promise<ApprovalRow> {
  if (input.actor.type !== 'owner') {
    throw new ApprovalError(`${actorRef(input.actor)} cannot decide approvals: only the Owner can (agents only propose)`);
  }
  return db.transaction(async (tx) => {
    const a = await tx.maybeOne<ApprovalRow>('SELECT * FROM approval WHERE id = $1 FOR UPDATE', [input.approvalId]);
    if (!a) throw new NotFoundError(`approval ${input.approvalId} not found`);
    if (a.status !== 'pending') throw new ApprovalError(`approval is already ${a.status}`);
    if (input.decision === 'approve' && CONFIRM_KINDS.includes(a.kind)) {
      const p = a.persona_id ? await tx.maybeOne<{ name: string }>('SELECT name FROM persona WHERE id = $1', [a.persona_id]) : null;
      const name = p?.name ?? '';
      if (typeof input.payloadHash !== 'string' || !input.payloadHash) {
        throw new ApprovalError(`approving "${a.title}" needs the payload hash of the card you reviewed`);
      }
      if (typeof input.confirmName !== 'string' || !name || input.confirmName.trim() !== name) {
        throw new ApprovalError(`type ${name || 'the persona name'} exactly to confirm`);
      }
    }
    if (input.decision === 'approve' && a.kind === 'qc_override' && !input.note?.trim()) {
      throw new ApprovalError('publishing past failed QC needs your reason (it is logged with the override)');
    }
    if (input.payloadHash !== undefined && input.payloadHash !== payloadHash(a.payload)) {
      throw new ApprovalError('this card changed after you opened it: reload and check it again');
    }
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
 * the database would reject it). Before approving, the policy is re-checked against the current state: if the
 * studio switched card auto-approve off, or a post's persona dropped to a level (or its Gate verdict changed to
 * one) that needs the Owner, the approval becomes explicit instead. One failing approval never blocks the rest:
 * it is audited, the Owner is notified, and it becomes explicit so it can't fail again on the next tick.
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
  const actor: Actor = { type: 'system', id: 'auto-approve' };
  for (const { id } of due) {
    try {
      const done = await db.transaction(async (tx) => {
        const a = await tx.maybeOne<ApprovalRow>(
          `SELECT * FROM approval WHERE id = $1 AND status = 'pending' FOR UPDATE SKIP LOCKED`,
          [id],
        );
        if (!a || requiresOwner(a) || a.auto_approve_at === null || a.auto_approve_at > now) return false;
        const settings = await getSettings(tx, a.studio_id);
        if (a.mode === 'auto_after' && a.kind !== 'persona_launch' && !settings.approvals.auto_approve_cards) {
          await makeExplicit(tx, a, SYSTEM, 'approval.auto_disabled', {});
          return false;
        }
        if (a.kind === 'post') {
          // Re-check against the persona's autonomy and the Gate verdict as they are now, not as proposed.
          const p = a.persona_id
            ? await tx.maybeOne<{ autonomy: Autonomy }>('SELECT autonomy FROM persona WHERE id = $1 FOR SHARE', [a.persona_id])
            : null;
          const gate = a.subject_id ? ((await latestPostGate(tx, a.subject_id))?.verdict ?? null) : null;
          if (!p || !postWindowAllowed(settings, p.autonomy, gate)) {
            await makeExplicit(tx, a, SYSTEM, 'approval.window_revoked', { autonomy: p?.autonomy ?? null, gate });
            return false;
          }
        }
        const decided = await tx.one<ApprovalRow>(
          `UPDATE approval SET status = 'auto_approved', decided_by = 'system:auto-approve', decided_at = $2 WHERE id = $1 RETURNING *`,
          [a.id, now],
        );
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
        return true;
      });
      if (done) approved.push(id);
    } catch (err) {
      await quarantine(db, id, err);
    }
  }
  return approved;
}

/** A timed approval whose execution failed: make it explicit, audit why, and tell the Owner. */
async function quarantine(db: Db, id: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  try {
    await db.transaction(async (tx) => {
      const a = await tx.maybeOne<ApprovalRow>(`SELECT * FROM approval WHERE id = $1 AND status = 'pending' FOR UPDATE`, [id]);
      if (!a) return;
      await makeExplicit(tx, a, SYSTEM, 'approval.auto_failed', { error: message });
      await notify(tx, {
        studioId: a.studio_id,
        personaId: a.persona_id,
        kind: 'approval',
        severity: 'warn',
        title: `Couldn't auto-approve: ${a.title}`,
        body: `${message}. It now waits for your decision.`,
        link: '/approvals',
      });
    });
  } catch (inner) {
    console.error(`[approvals] could not quarantine approval ${id}:`, inner, 'original error:', err);
  }
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
