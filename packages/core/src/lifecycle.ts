import type { Db } from '@ios/db';
import { audit } from './audit';
import { ApprovalRequiredError, InvalidTransitionError, NotFoundError } from './errors';
import { reconcilePostApprovals } from './policy';
import { getSettings } from './settings';
import { type Actor, actorRef, type ApprovalKind, type ApprovalRow, type PersonaRow, type PersonaState } from './types';

/**
 * Persona lifecycle (PRD §4):
 * PROPOSED → SETUP → TESTING → MONETISING / RE_ANGLE / KILLED → SCALING → BRAND, plus RETIRED.
 */
export const TRANSITIONS: Readonly<Record<PersonaState, readonly PersonaState[]>> = {
  PROPOSED: ['SETUP'],
  SETUP: ['TESTING', 'KILLED'],
  TESTING: ['MONETISING', 'RE_ANGLE', 'KILLED'],
  RE_ANGLE: ['TESTING', 'MONETISING', 'KILLED'],
  MONETISING: ['SCALING', 'KILLED', 'RETIRED'],
  SCALING: ['BRAND', 'MONETISING', 'KILLED', 'RETIRED'],
  BRAND: ['SCALING', 'RETIRED'],
  KILLED: ['RETIRED'],
  RETIRED: [],
};

/** States in which a persona may publish. */
export const PUBLISHING_STATES: readonly PersonaState[] = ['TESTING', 'RE_ANGLE', 'MONETISING', 'SCALING', 'BRAND'];

export function canTransition(from: PersonaState, to: PersonaState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Which approval a transition needs. Kill and retire need the Owner's explicit approval (no timeout, never
 * auto-approved); launching (PROPOSED → SETUP) needs the launch card (Owner tap or 24 h auto-approve).
 */
export function requiredApproval(from: PersonaState, to: PersonaState): readonly ApprovalKind[] | null {
  if (to === 'KILLED') return ['persona_kill'];
  if (to === 'RETIRED') return from === 'KILLED' ? ['persona_kill', 'persona_retire'] : ['persona_retire'];
  if (from === 'PROPOSED' && to === 'SETUP') return ['persona_launch'];
  return null;
}

export interface TransitionInput {
  personaId: string;
  to: PersonaState;
  actor: Actor;
  reason?: string;
  approvalId?: string;
}

async function assertApproval(
  db: Db,
  persona: PersonaRow,
  input: TransitionInput,
  kinds: readonly ApprovalKind[],
): Promise<ApprovalRow> {
  if (!input.approvalId) {
    throw new ApprovalRequiredError(
      `${persona.state} → ${input.to} for ${persona.name} needs an approved ${kinds.join(' or ')} approval`,
    );
  }
  const a = await db.maybeOne<ApprovalRow>('SELECT * FROM approval WHERE id = $1', [input.approvalId]);
  if (!a || a.persona_id !== persona.id || !kinds.includes(a.kind)) {
    throw new ApprovalRequiredError(`approval ${input.approvalId} does not cover ${persona.state} → ${input.to}`);
  }
  const ownerOnly = a.kind === 'persona_kill' || a.kind === 'persona_retire';
  const ok = ownerOnly
    ? a.status === 'approved' && (a.decided_by ?? '').startsWith('owner:')
    : a.status === 'approved' || a.status === 'auto_approved';
  if (!ok) throw new ApprovalRequiredError(`approval ${a.id} is ${a.status}, not approved by the Owner`);
  // One approval executes one transition into a given state.
  const used = await db.maybeOne(
    'SELECT 1 FROM persona_state_log WHERE approval_id = $1 AND to_state = $2',
    [a.id, input.to],
  );
  if (used) throw new ApprovalRequiredError(`approval ${a.id} was already used for → ${input.to}`);
  return a;
}

/**
 * Moves a persona to a new state. Valid edges only; logged in persona_state_log and audit_log.
 * Going live (SETUP → TESTING) sets the persona's autonomy to the studio default (Settings → Default autonomy,
 * L1 out of the box: green posts auto-publish after the veto window). The Owner can change it per persona.
 */
export async function transition(db: Db, input: TransitionInput): Promise<PersonaRow> {
  return db.transaction(async (tx) => {
    const persona = await tx.maybeOne<PersonaRow>('SELECT * FROM persona WHERE id = $1 FOR UPDATE', [input.personaId]);
    if (!persona) throw new NotFoundError(`persona ${input.personaId} not found`);
    const from = persona.state;
    if (!canTransition(from, input.to)) {
      throw new InvalidTransitionError(`${persona.name}: ${from} → ${input.to} is not a valid transition`);
    }
    const kinds = requiredApproval(from, input.to);
    if (kinds) await assertApproval(tx, persona, input, kinds);

    const enteringTesting = from === 'SETUP' && input.to === 'TESTING';
    const settings = await getSettings(tx, persona.studio_id);
    const updated = await tx.one<PersonaRow>(
      `UPDATE persona
          SET state = $2, state_changed_at = now(), updated_at = now(),
              launched_at = CASE WHEN $3 THEN COALESCE(launched_at, now()) ELSE launched_at END,
              autonomy = CASE WHEN $3 THEN $4 ELSE autonomy END
        WHERE id = $1 RETURNING *`,
      [persona.id, input.to, enteringTesting, settings.default_autonomy],
    );
    if (updated.autonomy !== persona.autonomy) {
      await reconcilePostApprovals(tx, { personaId: persona.id, settings, actor: input.actor });
    }
    await tx.query(
      `INSERT INTO persona_state_log (persona_id, from_state, to_state, actor_type, actor_id, reason, approval_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [persona.id, from, input.to, input.actor.type, input.actor.id, input.reason ?? null, input.approvalId ?? null],
    );
    await audit(tx, {
      studioId: persona.studio_id,
      personaId: persona.id,
      actor: input.actor,
      action: 'persona.transition',
      entityType: 'persona',
      entityId: persona.id,
      data: { from, to: input.to, reason: input.reason ?? null, approval_id: input.approvalId ?? null, by: actorRef(input.actor) },
    });
    return updated;
  });
}
