import type { StudioServices } from '@troupe/agents';
import { getDb } from '@troupe/db';
import { createStudioServices } from '@troupe/wiring';

const KEY = Symbol.for('troupe-house.services');
type G = typeof globalThis & { [KEY]?: Promise<StudioServices> };

/**
 * The composed studio services (every package's tools, live adapters where keys exist, the runtime), built once per
 * server process. With an Anthropic key the agents run live; without one they run on the fake LLM.
 */
export function getServices(): Promise<StudioServices> {
  const g = globalThis as G;
  if (!g[KEY]) {
    g[KEY] = getDb()
      .then((db) => createStudioServices(db, { mode: 'auto' }))
      .catch((err) => {
        delete g[KEY];
        throw err;
      });
  }
  return g[KEY];
}
