import type { Db } from '@ios/db';

/**
 * Persona page panel for stream L (docs/IOS-5-CONTRACTS.md §4): today's Stories lane (3–5 frames with their kind, QC and Gate status, publish status), highlight sets and story metrics.
 * Contract stub: renders nothing until stream L fills it. Keep the name and props; a failure here must never take
 * the persona page down (catch and return null).
 */
export async function StoriesPersonaPanel(_props: { db: Db; studioId: string; personaId: string; slug: string }) {
  return null;
}
