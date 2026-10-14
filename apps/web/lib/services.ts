import type { StudioServices } from '@ios/agents';
import { getDb } from '@ios/db';
import { createStudioServices } from '@ios/wiring';

const KEY = Symbol.for('influencer-os.services');
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
