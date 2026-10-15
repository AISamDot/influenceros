import type { Db } from '@ios/db';

/**
 * Persona page panel for stream E (docs/IOS-34-CONTRACTS.md §4): Soul ID and look-pack status, voice, colour grade and the latest renders.
 * Contract stub: renders nothing until stream E fills it. Keep the name and props; a failure here must never take
 * the persona page down (catch and return null).
 */
export async function MediaPersonaPanel(_props: { db: Db; studioId: string; personaId: string; slug: string }) {
  return null;
}
