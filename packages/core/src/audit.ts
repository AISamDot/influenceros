import { type Db, json } from '@troupe/db';
import { type Actor } from './types';

export interface AuditEntry {
  studioId?: string | null;
  personaId?: string | null;
  actor: Actor;
  action: string;
  entityType?: string;
  entityId?: string;
  data?: Record<string, unknown>;
}

/** Appends to the immutable audit log (FR-17.3). The table rejects UPDATE and DELETE. */
export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (studio_id, persona_id, actor_type, actor_id, action, entity_type, entity_id, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      e.studioId ?? null,
      e.personaId ?? null,
      e.actor.type,
      e.actor.id,
      e.action,
      e.entityType ?? null,
      e.entityId ?? null,
      json(e.data ?? {}),
    ],
  );
}
