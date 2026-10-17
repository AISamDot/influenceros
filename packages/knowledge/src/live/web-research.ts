import type Anthropic from '@anthropic-ai/sdk';
import {
  type FieldMap,
  type FieldSource,
  LLM_PRICES,
  llmCostUsd,
  type ModelTier,
  type ResearchCitation,
  type TopicResearch,
  type WebResearchProvider,
} from '@troupe/providers';

/**
 * Live WebResearchProvider: Claude with the web_search / web_fetch server tools (dynamic filtering versions), one
 * request per call through the Messages API. The model answers with a JSON block; if that block doesn't validate,
 * a small structured-output call (fast tier) converts the answer instead of failing the node. Cost = tokens at
 * the tier's list price (cache reads/writes included) + $0.01 per web search; the caller meters it as llm_usd.
 */

type Beta = Anthropic['beta']['messages'];
/** The slice of the SDK this adapter uses (tests pass a stub). */
export interface ResearchClient {
  beta: { messages: Pick<Beta, 'stream' | 'create'> };
}

export const WEB_SEARCH_USD = 0.01;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const SYSTEM = [
  'You are the research desk of an evidence-first content studio that runs openly-AI influencer personas.',
  'Research with web search and web fetch. Prefer primary, official, peer-reviewed and nationally representative',
  'sources; label company PR and advocacy-linked work as such. Write every synthesis in your own words: summaries plus',
  'short quotes (25 words at most, verbatim) with their URL, never copied passages. Every factual claim carries at',
  'least one citation. Note uncertainty and dates ("as of 2025"). General education only: no individual medical,',
  'legal or financial advice, no specific securities or crypto recommendations. English only.',
  'Finish with one ```json fenced block that matches the requested shape exactly.',
].join(' ');

export interface ClaudeWebResearchOptions {
  tier?: ModelTier;
  /** Searches per call (mapField uses twice this). */
  maxSearches?: number;
  maxFetches?: number;
  /** pause_turn continuations per call. */
  maxContinuations?: number;
}

interface CallResult {
  value: unknown;
  costUsd: number;
  searchResults: ResearchCitation[];
}

export class ClaudeWebResearch implements WebResearchProvider {
  readonly name = 'claude-web-research';
  readonly #tier: ModelTier;
  readonly #opts: Required<Omit<ClaudeWebResearchOptions, 'tier'>>;

  constructor(
    private readonly client: ResearchClient,
    opts: ClaudeWebResearchOptions = {},
  ) {
    this.#tier = opts.tier ?? 'standard';
    this.#opts = { maxSearches: opts.maxSearches ?? 6, maxFetches: opts.maxFetches ?? 6, maxContinuations: opts.maxContinuations ?? 3 };
  }

  async mapField(req: { niche: string; maxSources?: number; maxNodes?: number }): Promise<FieldMap> {
    const maxSources = req.maxSources ?? 40;
    const maxNodes = req.maxNodes ?? 120;
    const prompt = [
      `Map the field of "${req.niche}" for a studio that teaches it on short-form video.`,
      `1. Source canon: up to ${maxSources} reputable sources (journals, institutions, publications, recognised experts, datasets, and RSS feeds of reputable outlets), each with credibility 1-5 and a one-line note on what it is good for.`,
      '2. Expert map: the schools of thought and who is who (name, school, why they matter, a URL).',
      `3. Curriculum skeleton: up to ${maxNodes} topic nodes from fundamentals through intermediate and advanced methods, debates, common myths and the research frontier. Paths are lowercase "module/topic" slugs.`,
      'JSON shape: {"sources":[{"name":"","url":"","kind":"journal|institution|publication|expert|dataset|rss|other","credibility":1,"notes":""}],',
      '"experts":[{"name":"","school":"","why":"","url":""}],"curriculum":[{"path":"","title":"","level":"fundamental|intermediate|advanced|debate|myth|frontier"}]}',
    ].join('\n');
    const r = await this.#call(prompt, MAP_SCHEMA, this.#opts.maxSearches * 2);
    const map = withCost(r.costUsd, () => parseFieldMap(r.value));
    return { ...map, sources: map.sources.slice(0, maxSources), curriculum: map.curriculum.slice(0, maxNodes), costUsd: r.costUsd };
  }

  async researchTopic(req: { niche: string; path: string; title: string; questions?: readonly string[]; maxSources?: number }): Promise<TopicResearch> {
    const prompt = [
      `Research the Field Brain node "${req.title}" (${req.path}) in the niche "${req.niche}".`,
      req.questions?.length ? `It must answer: ${req.questions.map((q) => `"${q}"`).join('; ')}.` : '',
      `Use up to ${req.maxSources ?? 8} sources.`,
      'Return: a synthesis (150-300 words, your own words); 5-10 key facts, each with at least one citation {url, title, quote of 25 words at most};',
      'practical frameworks (named steps); common questions and misconceptions; and the sources you used.',
      'JSON shape: {"synthesis":"","facts":[{"claim":"","citations":[{"url":"","title":"","quote":""}]}],"frameworks":[""],"questions":[""],"sources":[{"url":"","title":""}]}',
    ].join('\n');
    const r = await this.#call(prompt, TOPIC_SCHEMA, this.#opts.maxSearches);
    const t = withCost(r.costUsd, () => parseTopicResearch(r.value));
    // Sources the model searched but didn't list still count as sources it read.
    const sources = dedupeCitations([...t.sources, ...r.searchResults]).slice(0, Math.max(4, req.maxSources ?? 8));
    return { ...t, sources, costUsd: r.costUsd };
  }

  /** Every error after the first paid stream carries what was already spent (`costUsd`), so metered() debits it. */
  async #call(prompt: string, schema: Record<string, unknown>, maxSearches: number): Promise<CallResult> {
    const spent = { usd: 0 };
    try {
      return await this.#run(prompt, schema, maxSearches, spent);
    } catch (err) {
      throw attachCost(err, spent.usd);
    }
  }

  async #run(prompt: string, schema: Record<string, unknown>, maxSearches: number, spent: { usd: number }): Promise<CallResult> {
    const model = LLM_PRICES[this.#tier].model;
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: prompt }];
    let cost = 0;
    let final: Anthropic.Beta.BetaMessage | null = null;
    const searchResults: ResearchCitation[] = [];
    for (let i = 0; i <= this.#opts.maxContinuations; i++) {
      const stream = this.client.beta.messages.stream({
        model,
        max_tokens: 16000,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: [
          { type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches },
          { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: this.#opts.maxFetches },
        ],
        output_config: { effort: 'medium' },
        messages,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
      });
      const msg = await stream.finalMessage();
      cost += usageCost(this.#tier, msg.usage);
      spent.usd = cost;
      for (const block of msg.content) {
        if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
          for (const r of block.content) searchResults.push({ url: r.url, title: r.title });
        }
      }
      if (msg.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: msg.content });
        continue;
      }
      if (msg.stop_reason === 'refusal') throw new Error(`research refused (${msg.stop_details?.category ?? 'no category'})`);
      final = msg;
      break;
    }
    if (!final) throw new Error('research did not finish within the continuation limit');
    const text = final.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const extracted = extractJson(text);
    if (extracted !== undefined && validates(schema, extracted)) return { value: extracted, costUsd: cost, searchResults };
    // Repair: a structured-output call on the fast tier turns the prose answer into the JSON shape.
    const repair = await this.client.beta.messages.create({
      model: LLM_PRICES.fast.model,
      max_tokens: 16000,
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: `Convert this research into the JSON schema. Keep every citation URL exactly as written.\n\n${text}` }],
    });
    cost += usageCost('fast', repair.usage);
    spent.usd = cost;
    const repaired = extractJson(repair.content.map((b) => (b.type === 'text' ? b.text : '')).join(''));
    if (repaired === undefined) throw new Error('research answer was not valid JSON');
    return { value: repaired, costUsd: cost, searchResults };
  }
}

/** Tags an error with the money a failed research call already spent (metered() debits `err.costUsd`). */
function attachCost(err: unknown, usd: number): unknown {
  if (usd <= 0) return err;
  const e = err instanceof Error ? err : new Error(String(err));
  if (typeof (e as { costUsd?: unknown }).costUsd !== 'number') Object.assign(e, { costUsd: usd });
  return e;
}

function withCost<T>(usd: number, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw attachCost(err, usd);
  }
}

function usageCost(tier: ModelTier, u: Anthropic.Beta.BetaUsage): number {
  const searches = u.server_tool_use?.web_search_requests ?? 0;
  return llmCostUsd(tier, u.input_tokens, u.output_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0) + searches * WEB_SEARCH_USD;
}

/** The last ```json block, else the outermost {...} in the text. */
export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const candidates = fences.length ? [fences.at(-1)![1]!] : [];
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

function validates(schema: Record<string, unknown>, v: unknown): boolean {
  const required = (schema.required as string[] | undefined) ?? [];
  return !!v && typeof v === 'object' && required.every((k) => k in (v as Record<string, unknown>));
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const KINDS: readonly FieldSource['kind'][] = ['journal', 'institution', 'publication', 'expert', 'dataset', 'rss', 'other'];
const LEVELS = ['fundamental', 'intermediate', 'advanced', 'debate', 'myth', 'frontier'] as const;

function citation(v: unknown): ResearchCitation | null {
  const c = v as Record<string, unknown>;
  const url = str(c?.url);
  if (!/^https?:\/\//.test(url)) return null;
  const quote = str(c.quote);
  return { url, title: str(c.title) || url, ...(quote ? { quote } : {}) };
}

function dedupeCitations(list: readonly ResearchCitation[]): ResearchCitation[] {
  const seen = new Set<string>();
  return list.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
}

export function parseFieldMap(v: unknown): Omit<FieldMap, 'costUsd'> {
  const o = (v ?? {}) as Record<string, unknown>;
  const arr = (x: unknown) => (Array.isArray(x) ? x : []);
  return {
    sources: arr(o.sources)
      .map((s) => s as Record<string, unknown>)
      .filter((s) => str(s.name))
      .map((s) => ({
        name: str(s.name).slice(0, 200),
        url: /^https?:\/\//.test(str(s.url)) ? str(s.url) : null,
        kind: (KINDS as readonly string[]).includes(str(s.kind)) ? (str(s.kind) as FieldSource['kind']) : 'other',
        credibility: Math.min(5, Math.max(1, Math.round(Number(s.credibility) || 3))),
        ...(str(s.notes) ? { notes: str(s.notes).slice(0, 500) } : {}),
      })),
    experts: arr(o.experts)
      .map((e) => e as Record<string, unknown>)
      .filter((e) => str(e.name))
      .map((e) => ({ name: str(e.name).slice(0, 120), school: str(e.school) || 'general', why: str(e.why), ...(/^https?:\/\//.test(str(e.url)) ? { url: str(e.url) } : {}) })),
    curriculum: arr(o.curriculum)
      .map((c) => c as Record<string, unknown>)
      .filter((c) => str(c.path) && str(c.title))
      .map((c) => ({ path: str(c.path), title: str(c.title), level: ((LEVELS as readonly string[]).includes(str(c.level)) ? str(c.level) : 'intermediate') as (typeof LEVELS)[number] })),
  };
}

export function parseTopicResearch(v: unknown): Omit<TopicResearch, 'costUsd'> {
  const o = (v ?? {}) as Record<string, unknown>;
  const arr = (x: unknown) => (Array.isArray(x) ? x : []);
  const synthesis = str(o.synthesis);
  if (!synthesis) throw new Error('research answer has no synthesis');
  return {
    synthesis,
    facts: arr(o.facts)
      .map((f) => f as Record<string, unknown>)
      .map((f) => ({ claim: str(f.claim), citations: arr(f.citations).map(citation).filter((c): c is ResearchCitation => !!c) }))
      // An uncited claim is not a fact the studio can use.
      .filter((f) => f.claim && f.citations.length),
    frameworks: arr(o.frameworks).map(str).filter(Boolean),
    questions: arr(o.questions).map(str).filter(Boolean),
    sources: dedupeCitations(arr(o.sources).map(citation).filter((c): c is ResearchCitation => !!c)),
  };
}

const MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sources', 'experts', 'curriculum'],
  properties: {
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'url', 'kind', 'credibility', 'notes'],
        properties: { name: { type: 'string' }, url: { type: 'string' }, kind: { type: 'string', enum: [...KINDS] }, credibility: { type: 'integer' }, notes: { type: 'string' } },
      },
    },
    experts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'school', 'why', 'url'],
        properties: { name: { type: 'string' }, school: { type: 'string' }, why: { type: 'string' }, url: { type: 'string' } },
      },
    },
    curriculum: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'title', 'level'],
        properties: { path: { type: 'string' }, title: { type: 'string' }, level: { type: 'string', enum: [...LEVELS] } },
      },
    },
  },
};

const CITATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['url', 'title', 'quote'],
  properties: { url: { type: 'string' }, title: { type: 'string' }, quote: { type: 'string' } },
};

const TOPIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['synthesis', 'facts', 'frameworks', 'questions', 'sources'],
  properties: {
    synthesis: { type: 'string' },
    facts: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['claim', 'citations'], properties: { claim: { type: 'string' }, citations: { type: 'array', items: CITATION_SCHEMA } } },
    },
    frameworks: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
    sources: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['url', 'title'], properties: { url: { type: 'string' }, title: { type: 'string' } } },
    },
  },
};
