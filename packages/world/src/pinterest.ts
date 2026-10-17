import type { StudioServices } from '@troupe/agents';
import { assertCanPublish } from '@troupe/core';

/**
 * Pinterest publishing (PRD §7: one studio Pinterest account, a board per persona; pins for products and
 * carousels). Every pin carries the AI disclosure in its description. Kill switches are checked first. A pin made on
 * the fake (no key yet) is recorded as not live, so the real pin is still made once the key arrives.
 */

export const PIN_KINDS = ['product', 'carousel'] as const;
export type PinKind = (typeof PIN_KINDS)[number];

export const isLivePinterest = (services: Pick<StudioServices, 'providers'>): boolean => !services.providers.pinterest.name.startsWith('fake');

export const aiDisclosure = (name: string): string => `${name} is an AI-generated character. Made with AI.`;

/** A public, absolute image URL Pinterest can fetch (a relative dashboard URL never is). */
const publicImage = (url: string | null | undefined): string | null => (url && /^https:\/\//i.test(url) ? url : url && /^http:\/\//i.test(url) ? url : null);

export async function ensureBoard(services: StudioServices, persona: { id: string; studio_id: string; name: string; niche: string }): Promise<{ boardId: string; name: string; live: boolean }> {
  const live = isLivePinterest(services);
  const have = await services.db.maybeOne<{ board_id: string; name: string }>('SELECT board_id, name FROM pinterest_board WHERE persona_id = $1 AND live = $2', [persona.id, live]);
  if (have) return { boardId: have.board_id, name: have.name, live };
  const name = `${persona.name} · ${persona.niche}`.slice(0, 50);
  const existing = (await services.providers.pinterest.listBoards()).find((b) => b.name === name);
  const board = existing ?? (await services.providers.pinterest.createBoard({ name, description: `${persona.name}'s ${persona.niche} ideas. ${aiDisclosure(persona.name)}`, privacy: 'PUBLIC' }));
  await services.db.query(
    `INSERT INTO pinterest_board (persona_id, live, studio_id, board_id, name) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (persona_id, live) DO NOTHING`,
    [persona.id, live, persona.studio_id, board.id, board.name],
  );
  return { boardId: board.id, name: board.name, live };
}

export interface PinResult {
  readonly status: 'published' | 'exists' | 'failed' | 'skipped';
  readonly pinId?: string | null;
  readonly url?: string | null;
  readonly live: boolean;
  readonly reason?: string;
}

/** Publishes one product or carousel as a pin on the persona's board (idempotent per kind + ref + live). */
export async function publishPin(services: StudioServices, q: { personaId: string; kind: PinKind; refId: string; link?: string | null }): Promise<PinResult> {
  const { db } = services;
  const live = isLivePinterest(services);
  const done = await db.maybeOne<{ pin_id: string | null; url: string | null; status: string }>('SELECT pin_id, url, status FROM pinterest_pin WHERE kind = $1 AND ref_id = $2 AND live = $3', [q.kind, q.refId, live]);
  if (done?.status === 'published') return { status: 'exists', pinId: done.pin_id, url: done.url, live };
  const persona = await db.one<{ id: string; studio_id: string; name: string; niche: string }>('SELECT id, studio_id, name, niche FROM persona WHERE id = $1', [q.personaId]);
  await assertCanPublish(db, q.personaId, 'pinterest');
  let title: string;
  let text: string;
  let image: string | null;
  if (q.kind === 'product') {
    const p = await db.maybeOne<{ name: string; status: string; cover_url: string | null; price_cents: number; currency: string }>(
      'SELECT name, status, cover_url, price_cents, currency FROM product WHERE id = $1 AND persona_id = $2',
      [q.refId, q.personaId],
    );
    if (!p) throw new Error('no such product for this persona');
    if (p.status !== 'live') return { status: 'skipped', live, reason: `product is ${p.status}, not live` };
    title = p.name;
    text = `${p.name}${p.price_cents > 0 ? ` (${(p.price_cents / 100).toFixed(2)} ${p.currency})` : ' (free)'}: from ${persona.name}, ${persona.niche}.`;
    image = publicImage(p.cover_url);
  } else {
    const post = await db.maybeOne<{ caption: string | null; format: string; status: string; media: Array<{ url?: string }> | null; thumbnail_url: string | null; url: string | null }>(
      'SELECT caption, format, status, media, thumbnail_url, url FROM post WHERE id = $1 AND persona_id = $2',
      [q.refId, q.personaId],
    );
    if (!post) throw new Error('no such post for this persona');
    if (post.format !== 'carousel' && post.format !== 'photo_dump') return { status: 'skipped', live, reason: `only carousels pin (this is ${post.format})` };
    if (post.status !== 'live') return { status: 'skipped', live, reason: `post is ${post.status}, not live` };
    const caption = (post.caption ?? '').replace(/#[\w-]+/g, '').trim();
    title = (caption.split(/\n|(?<=[.!?])\s/)[0] ?? `${persona.name} on ${persona.niche}`).slice(0, 100);
    text = caption.slice(0, 500);
    image = publicImage(post.thumbnail_url) ?? publicImage(post.media?.[0]?.url ?? null);
    q = { ...q, link: q.link ?? post.url };
  }
  if (!image && live) {
    await db.query(
      `INSERT INTO pinterest_pin (studio_id, persona_id, kind, ref_id, live, title, description, status, error) VALUES ($1, $2, $3, $4, $5, $6, $7, 'failed', $8)
       ON CONFLICT (kind, ref_id, live) DO UPDATE SET status = 'failed', error = EXCLUDED.error`,
      [persona.studio_id, q.personaId, q.kind, q.refId, live, title, text, 'no public image URL to pin (publish media to public storage first)'],
    );
    return { status: 'failed', live, reason: 'no public image URL' };
  }
  const description = `${text} ${aiDisclosure(persona.name)}`.trim().slice(0, 800);
  const board = await ensureBoard(services, persona);
  const pin = await services.providers.pinterest.createPin({
    boardId: board.boardId,
    title: title.slice(0, 100),
    description,
    ...(q.link ? { link: q.link } : {}),
    mediaUrl: image ?? `https://fake.pinterest.local/media/${q.refId}.jpg`,
    altText: `${title} (AI-generated)`.slice(0, 500),
  });
  await db.query(
    `INSERT INTO pinterest_pin (studio_id, persona_id, kind, ref_id, live, board_id, pin_id, url, title, description, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'published')
     ON CONFLICT (kind, ref_id, live) DO UPDATE SET board_id = EXCLUDED.board_id, pin_id = EXCLUDED.pin_id, url = EXCLUDED.url, status = 'published', error = NULL`,
    [persona.studio_id, q.personaId, q.kind, q.refId, live, board.boardId, pin.id, pin.url, title, description],
  );
  return { status: 'published', pinId: pin.id, url: pin.url, live };
}

/** Live products and carousels not yet pinned (on the current provider). */
export async function unpinned(services: StudioServices, studioId: string, limit = 20): Promise<Array<{ personaId: string; kind: PinKind; refId: string }>> {
  const live = isLivePinterest(services);
  const rows = await services.db.query<{ persona_id: string; kind: PinKind; ref_id: string }>(
    `SELECT * FROM (
       SELECT pr.persona_id, 'product' AS kind, pr.id AS ref_id, pr.created_at FROM product pr JOIN persona pe ON pe.id = pr.persona_id
        WHERE pe.studio_id = $1 AND pr.status = 'live'
       UNION ALL
       SELECT po.persona_id, 'carousel' AS kind, po.id AS ref_id, po.created_at FROM post po JOIN persona pe ON pe.id = po.persona_id
        WHERE pe.studio_id = $1 AND po.status = 'live' AND po.format IN ('carousel','photo_dump') AND po.platform = 'instagram'
     ) x
     WHERE NOT EXISTS (SELECT 1 FROM pinterest_pin pp WHERE pp.kind = x.kind AND pp.ref_id = x.ref_id AND pp.live = $2)
     ORDER BY created_at LIMIT $3`,
    [studioId, live, limit],
  );
  return rows.map((r) => ({ personaId: r.persona_id, kind: r.kind, refId: r.ref_id }));
}
