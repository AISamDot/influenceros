import type { Db } from '@ios/db';

export type NotificationKind = 'approval' | 'escalation' | 'budget' | 'digest' | 'publish' | 'system';
export type Severity = 'info' | 'warn' | 'critical';

export interface NotificationRow {
  id: string;
  studio_id: string;
  persona_id: string | null;
  kind: NotificationKind;
  severity: Severity;
  title: string;
  body: string | null;
  link: string | null;
  read_at: Date | null;
  created_at: Date;
}

export async function notify(
  db: Db,
  n: { studioId: string; personaId?: string | null; kind: NotificationKind; severity?: Severity; title: string; body?: string; link?: string },
): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO notification (studio_id, persona_id, kind, severity, title, body, link)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [n.studioId, n.personaId ?? null, n.kind, n.severity ?? 'info', n.title, n.body ?? null, n.link ?? null],
  );
  return row.id;
}

export async function listNotifications(db: Db, studioId: string, limit = 50): Promise<NotificationRow[]> {
  return db.query<NotificationRow>(
    `SELECT * FROM notification WHERE studio_id = $1 ORDER BY (read_at IS NULL) DESC, created_at DESC LIMIT $2`,
    [studioId, limit],
  );
}

export async function unreadCount(db: Db, studioId: string): Promise<number> {
  const r = await db.one<{ n: number }>(
    'SELECT count(*)::int AS n FROM notification WHERE studio_id = $1 AND read_at IS NULL',
    [studioId],
  );
  return r.n;
}

export async function markRead(db: Db, studioId: string, ids?: readonly string[]): Promise<void> {
  if (ids?.length) {
    await db.query(
      'UPDATE notification SET read_at = now() WHERE studio_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL',
      [studioId, ids],
    );
  } else {
    await db.query('UPDATE notification SET read_at = now() WHERE studio_id = $1 AND read_at IS NULL', [studioId]);
  }
}
