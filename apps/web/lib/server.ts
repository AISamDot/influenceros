import { findThread, getStudio, listMessages, type ThreadKind } from '@troupe/core';
import { getDb } from '@troupe/db';
import type { Db } from '@troupe/db';
import type { ChatMsg } from '@/components/chat-panel';
import { getServices } from './services';

/** The shared DB handle and the (single) studio. Pages are dynamic, so nothing touches the DB at build time. */
export async function studioContext() {
  const db = await getDb();
  const studio = await getStudio(db);
  return { db, studio };
}


/** A chat thread plus its recent messages, serialised for the client panel, and whether agents run live. */
export async function loadChat(db: Db, studioId: string, kind: ThreadKind, personaId?: string) {
  const thread = await findThread(db, studioId, kind, personaId);
  const msgs = await listMessages(db, thread.id, 60);
  const initial: ChatMsg[] = msgs.map(toChatMsg);
  const mode = await getServices()
    .then((s) => s.runtime.mode)
    .catch(() => 'fake' as const);
  return { thread, initial, mode };
}

export function toChatMsg(m: { id: string; role: ChatMsg['role']; author: string; body: string; meta: Record<string, unknown>; created_at: Date | string }): ChatMsg {
  return { id: m.id, role: m.role, author: m.author, body: m.body, meta: m.meta ?? {}, created_at: new Date(m.created_at).toISOString() };
}
