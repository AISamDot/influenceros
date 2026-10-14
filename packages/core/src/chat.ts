import { type Db, json } from '@ios/db';
import { audit } from './audit';
import { OWNER } from './types';

/**
 * Owner chat (FR-16.1: all Owner interaction happens in the dashboard). One Studio chat (Studio Manager), one chat
 * per persona (its manager), plus Monetization and Quality. Messages persist. The agents themselves live in
 * @ios/agents (`respondToOwner`); this module is storage, threads and mentions.
 */
export type ThreadKind = 'studio' | 'persona' | 'monetization' | 'quality';

export interface ChatThreadRow {
  id: string;
  studio_id: string;
  persona_id: string | null;
  kind: ThreadKind;
  title: string;
  agent: string;
  updated_at: Date;
}

export interface ChatMessageRow {
  id: string;
  thread_id: string;
  persona_id: string | null;
  role: 'owner' | 'agent' | 'system';
  author: string;
  body: string;
  meta: Record<string, unknown>;
  created_at: Date;
}

const AGENTS: Record<Exclude<ThreadKind, 'persona'>, { title: string; agent: string }> = {
  studio: { title: 'Studio Manager', agent: 'studio-manager' },
  monetization: { title: 'Monetization', agent: 'monetization-agent' },
  quality: { title: 'Quality', agent: 'quality-control' },
};

/** Creates any missing threads (studio, monetization, quality and one per persona). Idempotent. */
export async function ensureThreads(db: Db, studioId: string): Promise<void> {
  for (const [kind, a] of Object.entries(AGENTS)) {
    await db.query(
      `INSERT INTO chat_thread (studio_id, kind, title, agent) VALUES ($1, $2, $3, $4)
       ON CONFLICT (studio_id, kind, COALESCE(persona_id::text, '')) DO NOTHING`,
      [studioId, kind, a.title, a.agent],
    );
  }
  await db.query(
    `INSERT INTO chat_thread (studio_id, persona_id, kind, title, agent)
     SELECT p.studio_id, p.id, 'persona', p.name || '''s manager', 'persona-manager' FROM persona p
      WHERE p.studio_id = $1
     ON CONFLICT (studio_id, kind, COALESCE(persona_id::text, '')) DO NOTHING`,
    [studioId],
  );
}

export async function listThreads(db: Db, studioId: string): Promise<Array<ChatThreadRow & { persona_slug: string | null; portrait_url: string | null; last_body: string | null }>> {
  return db.query(
    `SELECT t.*, p.slug AS persona_slug, p.portrait_url,
            (SELECT body FROM chat_message m WHERE m.thread_id = t.id ORDER BY created_at DESC LIMIT 1) AS last_body
       FROM chat_thread t LEFT JOIN persona p ON p.id = t.persona_id
      WHERE t.studio_id = $1
      ORDER BY CASE t.kind WHEN 'studio' THEN 0 WHEN 'monetization' THEN 1 WHEN 'quality' THEN 2 ELSE 3 END, p.name`,
    [studioId],
  );
}

export async function findThread(db: Db, studioId: string, kind: ThreadKind, personaId?: string | null): Promise<ChatThreadRow> {
  await ensureThreads(db, studioId);
  return db.one<ChatThreadRow>(
    `SELECT * FROM chat_thread WHERE studio_id = $1 AND kind = $2 AND persona_id IS NOT DISTINCT FROM $3`,
    [studioId, kind, kind === 'persona' ? personaId ?? null : null],
  );
}

export async function getThread(db: Db, threadId: string): Promise<ChatThreadRow | null> {
  return db.maybeOne<ChatThreadRow>('SELECT * FROM chat_thread WHERE id = $1', [threadId]);
}

export async function listMessages(db: Db, threadId: string, limit = 100): Promise<ChatMessageRow[]> {
  const rows = await db.query<ChatMessageRow>(
    `SELECT * FROM chat_message WHERE thread_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [threadId, limit],
  );
  return rows.reverse();
}

export async function addMessage(
  db: Db,
  m: {
    threadId: string;
    role: ChatMessageRow['role'];
    author: string;
    body: string;
    meta?: Record<string, unknown>;
    personaId?: string | null;
    at?: Date;
    /** Pre-allocated id (the chat API sends it as x-message-id before the reply has finished streaming). */
    id?: string;
  },
): Promise<ChatMessageRow> {
  const row = await db.one<ChatMessageRow>(
    `INSERT INTO chat_message (id, thread_id, persona_id, role, author, body, meta, created_at)
     VALUES (COALESCE($8::uuid, gen_random_uuid()), $1, $2, $3, $4, $5, $6::jsonb, COALESCE($7, now())) RETURNING *`,
    [m.threadId, m.personaId ?? null, m.role, m.author, m.body, json(m.meta ?? {}), m.at ?? null, m.id ?? null],
  );
  await db.query('UPDATE chat_thread SET updated_at = now() WHERE id = $1', [m.threadId]);
  return row;
}

/**
 * Stores the Owner's message (Studio messages carry their @mentions in meta). The persona manager decides whether a
 * persona-chat message is feedback and logs it in `feedback` when it is (questions and commands are not).
 */
export async function postOwnerMessage(db: Db, threadId: string, body: string): Promise<ChatMessageRow> {
  const text = body.trim();
  if (!text) throw new Error('empty message');
  if (text.length > 4000) throw new Error('message too long (4,000 characters max)');
  return db.transaction(async (tx) => {
    const thread = await tx.one<ChatThreadRow>('SELECT * FROM chat_thread WHERE id = $1', [threadId]);
    const mentions = thread.kind === 'studio' ? await findMentions(tx, thread.studio_id, text) : [];
    const msg = await addMessage(tx, {
      threadId,
      role: 'owner',
      author: `owner:${OWNER.id}`,
      body: text,
      personaId: thread.persona_id,
      meta: mentions.length ? { mentions } : {},
    });
    await audit(tx, { studioId: thread.studio_id, personaId: thread.persona_id, actor: OWNER, action: 'chat.owner_message', entityType: 'chat_thread', entityId: threadId });
    return msg;
  });
}

/** Personas @mentioned in a message, by slug or first name (case-insensitive). */
export async function findMentions(db: Db, studioId: string, text: string): Promise<Array<{ id: string; slug: string; name: string }>> {
  const tags = [...text.matchAll(/@([a-z0-9-]+)/gi)].map((m) => m[1]!.toLowerCase());
  if (!tags.length) return [];
  return db.query(
    `SELECT id, slug, name FROM persona WHERE studio_id = $1 AND (lower(slug) = ANY($2::text[]) OR lower(split_part(name, ' ', 1)) = ANY($2::text[]))`,
    [studioId, tags],
  );
}

const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n));

/** A short, numbers-first summary built from live studio data (the no-key fallback reply). */
export async function composeAgentReply(db: Db, thread: ChatThreadRow, ownerText: string): Promise<string> {
  const since = "now() - interval '7 days'";
  if (thread.kind === 'persona' && thread.persona_id) {
    const p = await db.one<{ name: string; state: string; autonomy: string }>('SELECT name, state, autonomy FROM persona WHERE id = $1', [thread.persona_id]);
    const m = await db.one<{ views: number; rev: number }>(
      `SELECT (SELECT COALESCE(SUM(views),0) FROM metric_snapshot WHERE persona_id = $1 AND post_id IS NULL AND captured_on > (${since})::date)::int AS views,
              (SELECT COALESCE(SUM(amount_cents),0) FROM orders WHERE persona_id = $1 AND ordered_at > ${since})::int AS rev`,
      [thread.persona_id],
    );
    const next = await db.maybeOne<{ title: string; slot_at: Date }>(
      `SELECT title, slot_at FROM calendar_slot WHERE persona_id = $1 AND slot_at > now() ORDER BY slot_at LIMIT 1`,
      [thread.persona_id],
    );
    return [
      `${p.name} · ${p.state.toLowerCase().replace('_', '-')} · ${p.autonomy}. Last 7 days: ${k(m.views)} views, ${usd(m.rev)} revenue.`,
      next ? `Next post: "${next.title}".` : 'No posts scheduled yet.',
      `Noted: "${ownerText.slice(0, 120)}".`,
    ].join('\n\n');
  }
  if (thread.kind === 'monetization') {
    const r = await db.one<{ live: number; rev: number; top: string | null }>(
      `SELECT (SELECT count(*) FROM product WHERE status = 'live')::int AS live,
              (SELECT COALESCE(SUM(amount_cents),0) FROM orders WHERE ordered_at > ${since})::int AS rev,
              (SELECT pr.name FROM orders o JOIN product pr ON pr.id = o.product_id WHERE o.ordered_at > ${since}
                GROUP BY pr.name ORDER BY SUM(o.amount_cents) DESC LIMIT 1) AS top`,
    );
    return `Catalogue: ${r.live} live products, ${usd(r.rev)} revenue in the last 7 days${r.top ? `; best seller: ${r.top}` : ''}.\n\nNoted: "${ownerText.slice(0, 120)}".`;
  }
  if (thread.kind === 'quality') {
    return `QC standards v1 are in place (Q1 script → Q4 final).\n\nNoted as a studio standard request: "${ownerText.slice(0, 120)}".`;
  }
  const s = await db.one<{ personas: number; testing: number; views: number; rev: number; pending: number; kills: number }>(
    `SELECT (SELECT count(*) FROM persona WHERE studio_id = $1 AND state NOT IN ('RETIRED','KILLED'))::int AS personas,
            (SELECT count(*) FROM persona WHERE studio_id = $1 AND state = 'TESTING')::int AS testing,
            (SELECT COALESCE(SUM(views),0) FROM metric_snapshot WHERE post_id IS NULL AND captured_on > (${since})::date)::int AS views,
            (SELECT COALESCE(SUM(amount_cents),0) FROM orders WHERE ordered_at > ${since})::int AS rev,
            (SELECT count(*) FROM approval WHERE studio_id = $1 AND status = 'pending')::int AS pending,
            (SELECT count(*) FROM approval WHERE studio_id = $1 AND status = 'pending' AND kind = 'persona_kill')::int AS kills`,
    [thread.studio_id],
  );
  const mentions = await findMentions(db, thread.studio_id, ownerText);
  const lines = [
    `Studio, last 7 days: ${s.personas} active personas (${s.testing} testing), ${k(s.views)} views, ${usd(s.rev)} revenue. ${s.pending} item${s.pending === 1 ? '' : 's'} waiting in Approvals${s.kills ? `, including ${s.kills} kill proposal${s.kills === 1 ? '' : 's'}` : ''}.`,
  ];
  if (mentions.length) lines.push(`Bringing in ${mentions.map((m) => `${m.name}'s manager`).join(' and ')}.`);
  lines.push(`Noted: "${ownerText.slice(0, 140)}".`);
  return lines.join('\n\n');
}

/** Saves a data-summary reply (no agent run). The chat API uses @ios/agents `respondToOwner` instead. */
export async function replyAsAgent(db: Db, threadId: string, ownerText: string): Promise<ChatMessageRow> {
  const thread = await db.one<ChatThreadRow>('SELECT * FROM chat_thread WHERE id = $1', [threadId]);
  const body = await composeAgentReply(db, thread, ownerText);
  return addMessage(db, { threadId, role: 'agent', author: `agent:${thread.agent}`, body, personaId: thread.persona_id, meta: { fake: true } });
}
