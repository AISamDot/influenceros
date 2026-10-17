import { studioDomain } from '@troupe/env';
import type { Db } from '@troupe/db';

/**
 * Studio commerce settings (Owner-set on /commerce): the physical-address footer every marketing email carries
 * (CAN-SPAM) and the sender domain persona lists send from (`<slug>@<domain>`, with SPF/DKIM/DMARC in Resend).
 */
export interface CommerceSettings {
  readonly physicalAddress: string | null;
  readonly senderDomain: string | null;
}

const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export async function getCommerceSettings(db: Db, studioId: string): Promise<CommerceSettings> {
  const row = await db.maybeOne<{ physical_address: string | null; sender_domain: string | null }>(
    'SELECT physical_address, sender_domain FROM commerce_settings WHERE studio_id = $1',
    [studioId],
  );
  return { physicalAddress: row?.physical_address?.trim() || null, senderDomain: row?.sender_domain?.trim() || null };
}

export async function updateCommerceSettings(db: Db, studioId: string, patch: { physicalAddress?: string | null; senderDomain?: string | null }): Promise<CommerceSettings> {
  const cur = await getCommerceSettings(db, studioId);
  const address = patch.physicalAddress === undefined ? cur.physicalAddress : patch.physicalAddress?.trim().slice(0, 300) || null;
  let domain = patch.senderDomain === undefined ? cur.senderDomain : patch.senderDomain?.trim().toLowerCase() || null;
  if (domain && !DOMAIN_RE.test(domain)) throw new Error('sender domain must be a domain name like mail.example.com');
  if (address && address.length < 10) throw new Error('the physical address looks incomplete');
  domain = domain ?? null;
  await db.query(
    `INSERT INTO commerce_settings (studio_id, physical_address, sender_domain, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (studio_id) DO UPDATE SET physical_address = EXCLUDED.physical_address, sender_domain = EXCLUDED.sender_domain, updated_at = now()`,
    [studioId, address, domain],
  );
  return { physicalAddress: address, senderDomain: domain };
}

/** The sending identity of a persona's list. Falls back to the studio domain env, then a non-routable placeholder. */
export function senderFor(persona: { slug: string; name: string }, settings: CommerceSettings, env: Readonly<Record<string, string | undefined>> = process.env) {
  const domain = settings.senderDomain ?? studioDomain(env);
  const email = `${persona.slug}@${domain ?? 'studio.invalid'}`;
  const name = persona.name.replace(/["<>\\]/g, '').trim() || persona.slug;
  return { fromEmail: email, fromName: name, from: `${name} <${email}>`, configured: Boolean(domain) };
}
