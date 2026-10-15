import type { StudioServices } from '@ios/agents';
import { isPublicAssetUrl } from './sites';
import { memberFromSession } from './membership';
import { productFileKey } from './store';
import { readToken } from './tokens';

/**
 * File delivery from `providers.storage` without the Owner session: lead magnets by a download token (sent in the
 * welcome email, valid 30 days), members' drops by the member session, and the public portrait and product covers
 * of a persona's site. Nothing else in storage is reachable from here.
 */
export interface DeliveredFile {
  readonly data: Uint8Array;
  readonly contentType: string;
  readonly filename: string;
}

async function fileFor(services: StudioServices, productId: string): Promise<DeliveredFile | null> {
  const { db } = services;
  const f = await productFileKey(db, productId);
  if (!f) return null;
  const obj = await services.providers.storage.get(f.key);
  if (!obj) return null;
  const slug = (await db.one<{ slug: string }>('SELECT slug FROM product WHERE id = $1', [productId])).slug;
  const ext = obj.contentType === 'application/pdf' ? 'pdf' : (f.key.split('.').pop() ?? 'bin');
  return { data: obj.data, contentType: obj.contentType, filename: `${slug}.${ext}` };
}

/** A lead-magnet (or other free product) download from an email link. */
export async function downloadByToken(services: StudioServices, token: string): Promise<DeliveredFile | null> {
  const t = await readToken(services.db, token, 'download', services.now());
  const productId = typeof t?.ref.productId === 'string' ? t.ref.productId : null;
  if (!t || !productId) return null;
  const p = await services.db.maybeOne<{ persona_id: string; status: string }>('SELECT persona_id, status FROM product WHERE id = $1', [productId]);
  if (!p || p.persona_id !== t.persona_id || !['approved', 'live'].includes(p.status)) return null;
  return fileFor(services, productId);
}

/** A member's drop file. */
export async function memberFile(services: StudioServices, args: { slug: string; session: string | null | undefined; dropId: string }): Promise<DeliveredFile | null> {
  const member = await memberFromSession(services.db, { slug: args.slug, session: args.session, now: services.now() });
  if (!member || !/^[0-9a-f-]{36}$/i.test(args.dropId)) return null;
  const drop = await services.db.maybeOne<{ product_id: string | null }>(
    `SELECT product_id FROM member_drop WHERE id = $1 AND persona_id = $2 AND status = 'ready'`,
    [args.dropId, member.personaId],
  );
  return drop?.product_id ? fileFor(services, drop.product_id) : null;
}

/** An image of the public site (the persona portrait or a live product's cover): a public URL to redirect to, or stored bytes. */
export async function siteImage(
  services: StudioServices,
  args: { slug: string; kind: 'portrait' | 'cover'; productSlug?: string },
): Promise<{ redirect: string } | { file: DeliveredFile } | null> {
  const { db } = services;
  const persona = await db.maybeOne<{ id: string; state: string; portrait_url: string | null }>(`SELECT id, state, portrait_url FROM persona WHERE slug = $1`, [args.slug]);
  if (!persona || ['PROPOSED', 'KILLED', 'RETIRED'].includes(persona.state)) return null;
  let url: string | null = persona.portrait_url;
  if (args.kind === 'cover') {
    const p = await db.maybeOne<{ cover_url: string | null }>(
      `SELECT cover_url FROM product WHERE persona_id = $1 AND slug = $2 AND (status = 'live' OR (ladder_rung = 'lead_magnet' AND status IN ('approved','live')))`,
      [persona.id, args.productSlug ?? ''],
    );
    url = p?.cover_url ?? null;
  }
  if (!url) return null;
  if (isPublicAssetUrl(url) && !url.startsWith('data:')) return { redirect: url };
  const m = /^\/api\/media\/(.+)$/.exec(url);
  const key = m ? decodeURIComponent(m[1]!) : null;
  // Only this persona's media or product files: never another persona's or anything outside those prefixes.
  if (key && (key.startsWith(`media/${persona.id}/`) || key.startsWith(`products/${persona.id}/`) || key.startsWith(`public/${args.slug}/`))) {
    const obj = await services.providers.storage.get(key);
    if (obj && obj.contentType.startsWith('image/')) return { file: { data: obj.data, contentType: obj.contentType, filename: key.split('/').pop() ?? 'image' } };
  }
  if (url.startsWith('data:image/')) {
    const comma = url.indexOf(',');
    const meta = url.slice(5, comma);
    const contentType = meta.split(';')[0]!;
    if (!/^image\/(?:png|jpeg|webp|svg\+xml)$/.test(contentType)) return null;
    const body = url.slice(comma + 1);
    const data = meta.includes(';base64') ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8');
    return { file: { data: new Uint8Array(data), contentType, filename: `image.${contentType.split('/')[1]!.replace('+xml', '')}` } };
  }
  return null;
}
