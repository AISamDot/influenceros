import type { Db } from '@ios/db';

/**
 * Persona page panel for stream G (docs/IOS-34-CONTRACTS.md §4): store link, site URLs, email list, members and attributed sales.
 * Contract stub: renders nothing until stream G fills it. Keep the name and props; a failure here must never take
 * the persona page down (catch and return null).
 */
export async function CommercePersonaPanel(_props: { db: Db; studioId: string; personaId: string; slug: string }) {
  return null;
}
