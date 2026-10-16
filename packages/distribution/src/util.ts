import type { StudioServices } from '@ios/agents';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
export const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 500);

/** `due` for a schedule that runs every `ms`. */
export const every = (ms: number) => (now: Date, last: Date | null): boolean => !last || now.getTime() - last.getTime() >= ms;

/**
 * Third-party text (comments, DMs, webhooks) goes to a model only inside this fence, with the run marked untrusted.
 * Fence markers inside the text are neutralised and the text is trimmed, so it can't close the block early.
 */
export { fenceUntrusted } from '@ios/content';

/** A short single-line excerpt for notifications and the dashboard. */
export const excerpt = (text: string, max = 140): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

export async function studioOf(services: StudioServices, personaId: string): Promise<string> {
  return (await services.db.one<{ studio_id: string }>('SELECT studio_id FROM persona WHERE id = $1', [personaId])).studio_id;
}

export const SYSTEM_PUBLISHER = { type: 'system', id: 'publisher' } as const;
export const COMMUNITY_ACTOR = { type: 'agent', id: 'community-manager' } as const;
