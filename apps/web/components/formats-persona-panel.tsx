import type { Db } from '@ios/db';

/**
 * Persona page panel for stream L (docs/IOS-5-CONTRACTS.md §4): the persona's Format Plan (weekly counts per format, optional formats on/off, Stories per day and their mix, reason and cost per week per line; editable), and the latest lever change.
 * Contract stub: renders nothing until stream L fills it. Keep the name and props; a failure here must never take
 * the persona page down (catch and return null).
 */
export async function FormatsPersonaPanel(_props: { db: Db; studioId: string; personaId: string; slug: string }) {
  return null;
}
