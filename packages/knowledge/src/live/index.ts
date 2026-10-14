import Anthropic from '@anthropic-ai/sdk';
import type { ProviderEnv } from '@ios/agents';
import type { Providers } from '@ios/providers';
import { LocalEmbeddings, VoyageEmbeddings } from './embeddings';
import { HttpFeedProvider } from './feeds';
import { ClaudeWebResearch } from './web-research';

export { BUILTIN_FEED_HOSTS, hostAllowed, HttpFeedProvider, isPrivateAddress } from './feeds';
export { LOCAL_MODEL, LocalEmbeddings, unitize, VoyageEmbeddings } from './embeddings';
export { decodeEntities, parseFeedXml } from './rss';
export { ClaudeWebResearch, extractJson, parseFieldMap, parseTopicResearch, type ResearchClient, WEB_SEARCH_USD } from './web-research';

/**
 * Stream C's live adapters, overlaid on the fakes by @ios/wiring:
 * - webResearch: Claude web search/fetch, only when the Anthropic integration is live (key present + adapter);
 * - feeds: real RSS fetches with the allowlist (no key needed);
 * - embeddings: the local model by default (no key), Voyage when IOS_EMBEDDINGS=voyage and its key is set.
 * IOS_FAKE_PROVIDERS ("1"/"all", or a list naming webResearch, feeds, embeddings) keeps any of them on fakes;
 * Vitest sets it to "1", so tests never touch the network or load a model.
 */
export function knowledgeLiveProviders(env: ProviderEnv, processEnv: Readonly<Record<string, string | undefined>> = process.env): Partial<Providers> {
  const forced = (processEnv.IOS_FAKE_PROVIDERS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const fake = (id: string) => forced.includes('1') || forced.includes('all') || forced.includes(id.toLowerCase());
  const out: { -readonly [K in keyof Providers]?: Providers[K] } = {};

  if (!fake('webResearch') && env.isLive('anthropic')) {
    const apiKey = env.secret('anthropic.api_key');
    if (apiKey) out.webResearch = new ClaudeWebResearch(new Anthropic({ apiKey }));
  }
  if (!fake('feeds')) {
    const extra = (processEnv.IOS_FEED_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    out.feeds = new HttpFeedProvider({ allow: extra });
  }
  if (!fake('embeddings')) {
    const mode = (processEnv.IOS_EMBEDDINGS ?? 'local').trim().toLowerCase();
    const voyageKey = mode === 'voyage' ? env.secret('voyage.api_key') : null;
    if (voyageKey) out.embeddings = new VoyageEmbeddings(voyageKey);
    else if (mode !== 'fake') out.embeddings = new LocalEmbeddings();
  }
  return out;
}
