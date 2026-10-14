import { findThread, getStudio, listMessages, type ThreadKind } from '@ios/core';
import { getDb } from '@ios/db';
import type { Db } from '@ios/db';
import type { ChatMsg } from '@/components/chat-panel';

/** The shared DB handle and the (single) studio. Pages are dynamic, so nothing touches the DB at build time. */
export async function studioContext() {
  const db = await getDb();
  const studio = await getStudio(db);
  return { db, studio };
}


/** A chat thread plus its recent messages, serialised for the client panel. */
export async function loadChat(db: Db, studioId: string, kind: ThreadKind, personaId?: string) {
  const thread = await findThread(db, studioId, kind, personaId);
  const msgs = await listMessages(db, thread.id, 60);
  const initial: ChatMsg[] = msgs.map((m) => ({ id: m.id, role: m.role, body: m.body, created_at: new Date(m.created_at).toISOString() }));
  return { thread, initial };
}
