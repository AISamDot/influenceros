import type { Db } from '@ios/db';

/**
 * Persona page panel for stream J (docs/IOS-5-CONTRACTS.md §4): the World Bible (place, home, recurring places and cast, seasons, holidays; editable), today's grounding, the storyline arc with chapters and beats, recent continuity facts and no-repeat blocks.
 * Contract stub: renders nothing until stream J fills it. Keep the name and props; a failure here must never take
 * the persona page down (catch and return null).
 */
export async function WorldPersonaPanel(_props: { db: Db; studioId: string; personaId: string; slug: string }) {
  return null;
}
