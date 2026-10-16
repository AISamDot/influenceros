import type { Db } from '@ios/db';

/**
 * The Stories lane on the Pipeline board (stream L, docs/IOS-5-CONTRACTS.md §4): today's and tomorrow's story frames
 * per persona (kind, QC + Gate, publish status). `personaId` is the board's persona filter (null = all).
 * Contract stub: renders nothing until stream L fills it. Keep the name and props; catch your own errors and return null.
 */
export async function StoriesLane(_props: { db: Db; studioId: string; personaId: string | null }) {
  return null;
}
