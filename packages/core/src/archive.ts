import type { Db } from '@ios/db';
import { propose } from './approvals';
import { audit } from './audit';
import { ApprovalError, NotFoundError } from './errors';
import { notify } from './notifications';
import { type Actor, actorRef, type ApprovalRow, type PersonaRow, type PersonaState } from './types';

/**
 * Soft archive (Owner decision, 16 Oct). An archived persona keeps every row (bible versions, products, slots, posts,
 * threads, accounts) and stops working: ARCHIVED is outside every working state, so nothing plans, scripts,
 * renders, publishes or briefs it, its email sequences pause and its site and short links go dark. Restoring returns
 * it to the state it was archived from, so the round trip is exact:
 * - pending approvals are withdrawn on archive (recorded on the audit row) and proposed again on restore, with fresh
 *   windows, so no timer fires on a parked persona and nothing the Owner had to decide is lost;
 * - scheduled posts are parked as drafts on archive (recorded too); on restore the ones still in the future are
 *   scheduled again and the ones whose time passed stay drafts to re-plan, so no backlog of stale posts fires at once.
 *
 * Who may archive:
 * - a persona that never launched (PROPOSED or SETUP, never live): the Owner or the Studio Manager, directly;
 * - a persona that launched: the Owner, typing its name on the dashboard, or an approved `persona_archive` card
 *   (Owner-only, explicit, never auto-approved). An agent can only propose that card (`proposeArchive`).
 * Killing and retiring keep their own explicit approvals (lifecycle.ts); archiving is not a way around them.
 */

const NOT_ARCHIVABLE: readonly PersonaState[] = ['ARCHIVED', 'KILLED', 'RETIRED'];

/** PROPOSED or SETUP and never live: archiving it needs no approval. */
export const neverLaunched = (p: Pick<PersonaRow, 'state' | 'launched_at'>): boolean =>
  (p.state === 'PROPOSED' || p.state === 'SETUP') && !p.launched_at;

export interface ArchiveInput {
  personaId: string;
  actor: Actor;
  reason?: string;
  /** An approved persona_archive card (the executor passes it). */
  approvalId?: string;
  /** The persona's name typed by the Owner (dashboard path for a launched persona). */
  confirmName?: string;
}

export async function archivePersona(db: Db, input: ArchiveInput): Promise<PersonaRow> {
  return db.transaction(async (tx) => {
    const p = await tx.maybeOne<PersonaRow>('SELECT * FROM persona WHERE id = $1 FOR UPDATE', [input.personaId]);
    if (!p) throw new NotFoundError(`persona ${input.personaId} not found`);
    if (NOT_ARCHIVABLE.includes(p.state)) throw new ApprovalError(`${p.name} is ${p.state}: nothing to archive`);
    if (!neverLaunched(p)) {
      if (input.approvalId) {
        const a = await tx.maybeOne<ApprovalRow>('SELECT * FROM approval WHERE id = $1', [input.approvalId]);
        const ok = a && a.kind === 'persona_archive' && a.persona_id === p.id && a.status === 'approved' && (a.decided_by ?? '').startsWith('owner:');
        if (!ok) throw new ApprovalError(`archiving ${p.name} needs an approved persona_archive card`);
      } else if (input.actor.type === 'owner') {
        if ((input.confirmName ?? '').trim() !== p.name) throw new ApprovalError(`${p.name} has launched: type ${p.name} exactly to archive`);
      } else {
        throw new ApprovalError(`${p.name} has launched: archiving needs the Owner. Propose it instead (persona_archive).`);
      }
    }
    // Pending decisions about a parked persona are withdrawn (launch cards, product cards, posts). Posts go back to draft.
    const pending = await tx.query<{ id: string; kind: string; subject_id: string | null }>(
      `UPDATE approval SET status = 'withdrawn', decided_by = $2, decided_at = now()
        WHERE persona_id = $1 AND status = 'pending' AND id IS DISTINCT FROM $3::uuid RETURNING id, kind, subject_id`,
      [p.id, actorRef(input.actor), input.approvalId ?? null],
    );
    const posts = pending.filter((a) => a.kind === 'post' && a.subject_id).map((a) => a.subject_id!);
    if (posts.length) await tx.query(`UPDATE post SET status = 'draft', updated_at = now() WHERE id = ANY($1::uuid[]) AND status = 'awaiting_approval'`, [posts]);
    // Approved, scheduled posts are parked too (publish.due never sees them); restore re-plans them.
    const parked = await tx.query<{ id: string; scheduled_at: Date | null }>(
      `UPDATE post SET status = 'draft', meta = meta || jsonb_build_object('parked_from', 'scheduled'), updated_at = now()
        WHERE persona_id = $1 AND status = 'scheduled' RETURNING id, scheduled_at`,
      [p.id],
    );
    const row = await tx.one<PersonaRow>(
      `UPDATE persona SET state = 'ARCHIVED', archived_at = now(), archived_from_state = state, archive_reason = $2,
                          state_changed_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [p.id, input.reason?.slice(0, 500) ?? null],
    );
    await tx.query(
      `INSERT INTO persona_state_log (persona_id, from_state, to_state, actor_type, actor_id, reason, approval_id)
       VALUES ($1, $2, 'ARCHIVED', $3, $4, $5, $6)`,
      [p.id, p.state, input.actor.type, input.actor.id, input.reason ?? 'archived', input.approvalId ?? null],
    );
    await audit(tx, {
      studioId: p.studio_id,
      personaId: p.id,
      actor: input.actor,
      action: 'persona.archived',
      entityType: 'persona',
      entityId: p.id,
      data: { from: p.state, reason: input.reason ?? null, approval_id: input.approvalId ?? null, withdrawn: pending.map((a) => a.id), parked_posts: parked.map((x) => x.id) },
    });
    if (input.actor.type !== 'owner') {
      await notify(tx, { studioId: p.studio_id, personaId: p.id, kind: 'system', title: `${p.name} archived`, body: `Archived from ${p.state}. Everything is kept; restore it from the Archive page.`, link: '/archive' });
    }
    return row;
  });
}

/**
 * An agent's archive request: a never-launched persona is archived at once; a launched one gets an Owner-only
 * persona_archive card (it keeps running until the Owner approves).
 */
export async function proposeArchive(
  db: Db,
  input: { personaId: string; rationale: string; proposedBy: Actor; now?: Date },
): Promise<{ archived: true; persona: PersonaRow } | { archived: false; approval: ApprovalRow }> {
  const p = await db.maybeOne<PersonaRow>('SELECT * FROM persona WHERE id = $1', [input.personaId]);
  if (!p) throw new NotFoundError(`persona ${input.personaId} not found`);
  if (neverLaunched(p)) return { archived: true, persona: await archivePersona(db, { personaId: p.id, actor: input.proposedBy, reason: input.rationale }) };
  const approval = await propose(db, {
    studioId: p.studio_id,
    personaId: p.id,
    kind: 'persona_archive',
    title: `Archive ${p.name}`,
    summary: input.rationale,
    payload: { from: p.state },
    subjectType: 'persona',
    subjectId: p.id,
    proposedBy: input.proposedBy,
    now: input.now,
  });
  return { archived: false, approval };
}

/** An actor from its stored reference ("agent:studio-manager"). */
const actorOf = (ref: string): Actor => {
  const i = ref.indexOf(':');
  const type = ref.slice(0, i) as Actor['type'];
  return { type: type === 'owner' || type === 'agent' || type === 'system' ? type : 'system', id: ref.slice(i + 1) || 'unknown' };
};

export interface RestoreResult {
  persona: PersonaRow;
  launchCard: ApprovalRow | null;
  /** The cards withdrawn at archive time, proposed again (fresh windows). */
  reproposed: ApprovalRow[];
  /** Withdrawn cards that no longer apply (e.g. their post moved on), with why. */
  notReproposed: Array<{ id: string; kind: string; reason: string }>;
  /** Parked posts scheduled again (still in the future) and left as drafts (their time passed while archived). */
  posts: { rescheduled: number; toReplan: number };
}

/**
 * The Owner restores an archived persona to the state it was archived from. Nothing was deleted, so bible versions,
 * products and history come back exactly. The approvals withdrawn when it was archived are proposed again, the
 * parked posts are re-planned, and a persona archived before launch (PROPOSED) always has an Owner-only launch card.
 */
export async function restoreArchivedPersona(db: Db, input: { personaId: string; actor: Actor; now?: Date }): Promise<RestoreResult> {
  if (input.actor.type !== 'owner') throw new ApprovalError('only the Owner restores an archived persona');
  const now = input.now ?? new Date();
  const { persona, archivedWith } = await db.transaction(async (tx) => {
    const p = await tx.maybeOne<PersonaRow>('SELECT * FROM persona WHERE id = $1 FOR UPDATE', [input.personaId]);
    if (!p) throw new NotFoundError(`persona ${input.personaId} not found`);
    if (p.state !== 'ARCHIVED' || !p.archived_from_state) throw new ApprovalError(`${p.name} is ${p.state}, not archived`);
    const to = p.archived_from_state;
    const last = await tx.maybeOne<{ data: { withdrawn?: string[]; parked_posts?: string[] } | null }>(
      `SELECT data FROM audit_log WHERE entity_type = 'persona' AND entity_id = $1 AND action = 'persona.archived' ORDER BY created_at DESC LIMIT 1`,
      [p.id],
    );
    const row = await tx.one<PersonaRow>(
      `UPDATE persona SET state = $2, archived_at = NULL, archived_from_state = NULL, archive_reason = NULL,
                          state_changed_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [p.id, to],
    );
    await tx.query(
      `INSERT INTO persona_state_log (persona_id, from_state, to_state, actor_type, actor_id, reason) VALUES ($1, 'ARCHIVED', $2, $3, $4, 'restored from the archive')`,
      [p.id, to, input.actor.type, input.actor.id],
    );
    await audit(tx, { studioId: p.studio_id, personaId: p.id, actor: input.actor, action: 'persona.restored', entityType: 'persona', entityId: p.id, data: { to } });
    return { persona: row, archivedWith: { withdrawn: last?.data?.withdrawn ?? [], parked: last?.data?.parked_posts ?? [] } };
  });

  // Posts parked from 'scheduled': back on the schedule if their time is still ahead, else drafts to re-plan.
  let rescheduled = 0;
  let toReplan = 0;
  if (archivedWith.parked.length) {
    const back = await db.query(
      `UPDATE post SET status = 'scheduled', meta = meta - 'parked_from', updated_at = now()
        WHERE id = ANY($1::uuid[]) AND status = 'draft' AND meta->>'parked_from' = 'scheduled' AND scheduled_at > $2 RETURNING id`,
      [archivedWith.parked, now],
    );
    const missed = await db.query(
      `UPDATE post SET meta = (meta - 'parked_from') || jsonb_build_object('missed_while_archived', true), updated_at = now()
        WHERE id = ANY($1::uuid[]) AND status = 'draft' AND meta->>'parked_from' = 'scheduled' RETURNING id`,
      [archivedWith.parked],
    );
    rescheduled = back.length;
    toReplan = missed.length;
  }

  // The decisions that were pending when it was archived, proposed again (each in its own transaction).
  const reproposed: ApprovalRow[] = [];
  const notReproposed: RestoreResult['notReproposed'] = [];
  if (archivedWith.withdrawn.length) {
    const cards = await db.query<ApprovalRow>(`SELECT * FROM approval WHERE id = ANY($1::uuid[]) AND status = 'withdrawn' ORDER BY created_at`, [archivedWith.withdrawn]);
    for (const a of cards) {
      try {
        const payload = { ...(a.payload ?? {}) } as Record<string, unknown>;
        const ownerOnly = payload.owner_only === true;
        delete payload.owner_only;
        reproposed.push(
          await propose(db, {
            studioId: a.studio_id,
            personaId: a.persona_id,
            kind: a.kind,
            title: a.title,
            summary: a.summary ?? undefined,
            payload,
            subjectType: a.subject_type ?? undefined,
            subjectId: a.subject_id ?? undefined,
            proposedBy: actorOf(a.proposed_by),
            ...(ownerOnly ? { ownerOnly: true } : {}),
            now,
          }),
        );
      } catch (err) {
        notReproposed.push({ id: a.id, kind: a.kind, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  let launchCard: ApprovalRow | null = null;
  if (persona.state === 'PROPOSED') {
    launchCard = await db.maybeOne<ApprovalRow>(`SELECT * FROM approval WHERE persona_id = $1 AND kind = 'persona_launch' AND status = 'pending'`, [persona.id]);
    launchCard ??= await propose(db, {
      studioId: persona.studio_id,
      personaId: persona.id,
      kind: 'persona_launch',
      title: `Launch ${persona.name}`,
      summary: 'Restored from the archive. Review it in the Persona Generator and approve the launch there.',
      subjectType: 'persona',
      subjectId: persona.id,
      proposedBy: { type: 'agent', id: 'studio-manager' },
      ownerOnly: true,
      now: input.now,
    });
  }
  if (toReplan) {
    await notify(db, {
      studioId: persona.studio_id,
      personaId: persona.id,
      kind: 'system',
      title: `${persona.name}: ${toReplan} post${toReplan === 1 ? '' : 's'} to re-plan`,
      body: `${toReplan === 1 ? 'Its time' : 'Their times'} passed while ${persona.name} was archived, so ${toReplan === 1 ? 'it is' : 'they are'} back in draft rather than publishing late.`,
      link: '/pipeline',
    });
  }
  return { persona, launchCard, reproposed, notReproposed, posts: { rescheduled, toReplan } };
}
