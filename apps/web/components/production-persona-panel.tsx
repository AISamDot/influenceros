import type { Db } from '@ios/db';

/**
 * Persona page panel for stream K (docs/IOS-5-CONTRACTS.md §4): the 5-view character sheet and detail strip, the 4 core reference images, the BOPA look pack, locked locations and the camera styles in rotation.
 * Contract stub: renders nothing until stream K fills it. Keep the name and props; a failure here must never take
 * the persona page down (catch and return null).
 */
export async function ProductionPersonaPanel(_props: { db: Db; studioId: string; personaId: string; slug: string }) {
  return null;
}
