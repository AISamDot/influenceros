import { type Actor, actorRef, audit, NotFoundError } from '@ios/core';
import { type Db, json } from '@ios/db';
import { type DraftMessage, type DraftRow, type DraftSeed, type DraftState, emptyState, type Scorecard } from './types';

/** Persistence for persona drafts: the row, a version snapshot per change, and the draft's chat. */

export class DraftError extends Error {
  override readonly name = 'DraftError';
}

export async function insertDraft(
  db: Db,
  input: { studioId: string; title: string; seed: DraftSeed; source: DraftRow['source']; actor: Actor; state?: DraftState; currentStep?: number; personaId?: string | null; archiveRef?: DraftRow['archive_ref'] },
): Promise<DraftRow> {
  return db.transaction(async (tx) => {
    const state = input.state ?? emptyState(input.seed);
    const row = await tx.one<DraftRow>(
      `INSERT INTO persona_draft (studio_id, title, source, current_step, state, persona_id, archive_ref, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8) RETURNING *`,
      [input.studioId, input.title.slice(0, 120), input.source, input.currentStep ?? 1, json(state), input.personaId ?? null, input.archiveRef ? json(input.archiveRef) : null, actorRef(input.actor)],
    );
    await tx.query(
      `INSERT INTO persona_draft_version (draft_id, version, step, change, actor, state, scores) VALUES ($1, 1, 0, $2, $3, $4::jsonb, '{}'::jsonb)`,
      [row.id, input.source === 'archive' ? 'restored from the archive' : 'draft started', actorRef(input.actor), json(state)],
    );
    await audit(tx, { studioId: input.studioId, actor: input.actor, action: 'generator.draft_created', entityType: 'persona_draft', entityId: row.id, data: { source: input.source } });
    return row;
  });
}

export async function getDraft(db: Db, id: string): Promise<DraftRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return db.maybeOne<DraftRow>('SELECT * FROM persona_draft WHERE id = $1', [id]);
}

export async function requireDraft(db: Db, id: string): Promise<DraftRow> {
  const d = await getDraft(db, id);
  if (!d) throw new NotFoundError(`draft ${id} not found`);
  return d;
}

export async function listDrafts(db: Db, studioId: string, status?: DraftRow['status']): Promise<DraftRow[]> {
  return db.query<DraftRow>(
    `SELECT * FROM persona_draft WHERE studio_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY updated_at DESC`,
    [studioId, status ?? null],
  );
}

export interface CommitInput {
  step: number;
  change: string;
  actor: Actor;
  /** Expected version (optimistic check from a form); refused if the draft moved on. */
  expectVersion?: number;
}

/**
 * Applies `mutate` to the draft under a row lock and writes the next version snapshot. `mutate` returns the new
 * state plus optional row fields; it may throw to refuse.
 */
export async function commit(
  db: Db,
  draftId: string,
  input: CommitInput,
  mutate: (d: DraftRow) => Promise<{ state: DraftState; currentStep?: number; title?: string; scores?: DraftRow['scores']; status?: DraftRow['status']; personaId?: string | null }>,
): Promise<DraftRow> {
  return db.transaction(async (tx) => {
    const d = await tx.maybeOne<DraftRow>('SELECT * FROM persona_draft WHERE id = $1 FOR UPDATE', [draftId]);
    if (!d) throw new NotFoundError(`draft ${draftId} not found`);
    if (input.expectVersion !== undefined && input.expectVersion !== d.version) {
      throw new DraftError('this draft changed since you opened it: reload and try again');
    }
    const next = await mutate(d);
    const version = d.version + 1;
    const row = await tx.one<DraftRow>(
      `UPDATE persona_draft SET state = $2::jsonb, version = $3, current_step = $4, title = $5, scores = $6::jsonb,
                                status = $7, persona_id = $8, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [d.id, json(next.state), version, next.currentStep ?? d.current_step, (next.title ?? d.title).slice(0, 120), json(next.scores ?? d.scores), next.status ?? d.status, next.personaId === undefined ? d.persona_id : next.personaId],
    );
    await tx.query(
      `INSERT INTO persona_draft_version (draft_id, version, step, change, actor, state, scores) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
      [d.id, version, input.step, input.change.slice(0, 300), actorRef(input.actor), json(next.state), json(row.scores)],
    );
    return row;
  });
}

export async function draftVersions(db: Db, draftId: string): Promise<Array<{ version: number; step: number; change: string; actor: string; created_at: Date; scores: Partial<Scorecard> }>> {
  return db.query(`SELECT version, step, change, actor, created_at, scores FROM persona_draft_version WHERE draft_id = $1 ORDER BY version DESC`, [draftId]);
}

export async function addDraftMessage(db: Db, m: { draftId: string; step: number; role: DraftMessage['role']; author: string; body: string; meta?: Record<string, unknown> }): Promise<DraftMessage> {
  return db.one<DraftMessage>(
    `INSERT INTO persona_draft_message (draft_id, step, role, author, body, meta) VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *`,
    [m.draftId, m.step, m.role, m.author, m.body.slice(0, 8000), json(m.meta ?? {})],
  );
}

export async function listDraftMessages(db: Db, draftId: string, limit = 80): Promise<DraftMessage[]> {
  const rows = await db.query<DraftMessage>(`SELECT * FROM persona_draft_message WHERE draft_id = $1 ORDER BY created_at DESC LIMIT $2`, [draftId, limit]);
  return rows.reverse();
}
