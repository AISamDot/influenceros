import type { Db } from '@ios/db';

/**
 * Persona page panel for stream F (docs/IOS-34-CONTRACTS.md §4): accounts, AI-label status, scorecard (1h/24h/72h/7d metrics) and community queue.
 * Contract stub: renders nothing until stream F fills it. Keep the name and props; a failure here must never take
 * the persona page down (catch and return null).
 */
export async function DistributionPersonaPanel(_props: { db: Db; studioId: string; personaId: string; slug: string }) {
  return null;
}
