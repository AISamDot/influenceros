import type { ProviderEnv } from '@ios/agents';
import { EMBEDDING_DIM } from '@ios/providers';
import { describe, expect, it } from 'vitest';
import {
  ClaudeWebResearch,
  decodeEntities,
  extractJson,
  hostAllowed,
  HttpFeedProvider,
  isPrivateAddress,
  knowledgeLiveProviders,
  LocalEmbeddings,
  parseFeedXml,
  type ResearchClient,
  VoyageEmbeddings,
} from '../src';

const RSS = `<?xml version="1.0"?>
<!DOCTYPE rss [<!ENTITY boom "boom">]>
<rss version="2.0"><channel><title>Global Dating Insights</title>
<item><title>Payers fall &amp; singles go offline</title><link>https://www.globaldatinginsights.com/a/1</link>
<pubDate>Wed, 14 Oct 2026 06:00:00 GMT</pubDate><description><![CDATA[<p>Dating app <b>payers</b> fell.</p>]]></description></item>
<item><title>Second</title><guid>https://www.globaldatinginsights.com/a/2</guid></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
<title>Channel name</title>
<entry><title>Video one</title><link rel="alternate" href="https://www.youtube.com/watch?v=abc"/>
<published>2026-10-13T10:00:00+00:00</published><media:group><media:description>About the video</media:description></media:group></entry>
</feed>`;

describe('RSS / Atom parsing', () => {
  it('reads RSS 2.0 (CDATA, entities, guid links) and ignores DOCTYPE entities', () => {
    const items = parseFeedXml(RSS, 'fallback');
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: 'Payers fall & singles go offline',
      url: 'https://www.globaldatinginsights.com/a/1',
      publishedAt: new Date('2026-10-14T06:00:00Z'),
      summary: 'Dating app payers fell.',
      source: 'Global Dating Insights',
    });
    expect(items[1]!.url).toBe('https://www.globaldatinginsights.com/a/2');
  });

  it('decodes HTML that feeds escaped twice (Reddit, Google News)', () => {
    expect(decodeEntities('I&#39;ve said &quot;no&quot; &amp; meant it &#x2014; twice')).toBe('I\'ve said "no" & meant it — twice');
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>r/dating_advice</title><entry><title>He said &amp;quot;hey&amp;quot;</title><link href="https://www.reddit.com/r/dating_advice/comments/1/"/><content type="html">&lt;p&gt;I&amp;#39;ve waited&lt;/p&gt;</content></entry></feed>`;
    expect(parseFeedXml(xml, 'r')[0]).toMatchObject({ title: 'He said "hey"', summary: "I've waited" });
  });

  it('reads Atom and YouTube channel feeds', () => {
    const [v] = parseFeedXml(ATOM, 'yt');
    expect(v).toMatchObject({ title: 'Video one', url: 'https://www.youtube.com/watch?v=abc', summary: 'About the video', source: 'Channel name' });
    expect(v!.publishedAt?.toISOString()).toBe('2026-10-13T10:00:00.000Z');
    expect(() => parseFeedXml('<html><body>nope</body></html>', 'x')).toThrow(/not an RSS/);
  });
});

describe('HttpFeedProvider (allowlist, SSRF guards)', () => {
  const publicDns = async () => ['93.184.216.34'];
  const ok = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { 'content-type': 'application/rss+xml', ...headers } });

  it('fetches allowlisted hosts, including subdomains', async () => {
    const seen: string[] = [];
    const p = new HttpFeedProvider({ resolve: publicDns, fetchImpl: (async (u: URL) => (seen.push(String(u)), ok(RSS))) as unknown as typeof fetch });
    const items = await p.fetchFeed({ url: 'https://www.globaldatinginsights.com/feed/', limit: 1 });
    expect(items).toHaveLength(1);
    expect(seen).toEqual(['https://www.globaldatinginsights.com/feed/']);
    expect(hostAllowed('old.reddit.com', new Set(['reddit.com']))).toBe(true);
    expect(hostAllowed('reddit.com.evil.io', new Set(['reddit.com']))).toBe(false);
  });

  it('refuses hosts off the allowlist, private addresses, credentials and odd ports', async () => {
    const p = new HttpFeedProvider({ resolve: publicDns, fetchImpl: (async () => ok(RSS)) as unknown as typeof fetch });
    await expect(p.fetchFeed({ url: 'https://evil.example.org/rss' })).rejects.toThrow(/allowlist/);
    await expect(p.fetchFeed({ url: 'http://127.0.0.1/rss' })).rejects.toThrow(/allowlist/);
    await expect(p.fetchFeed({ url: 'https://user:pw@news.google.com/rss' })).rejects.toThrow(/credentials/);
    await expect(p.fetchFeed({ url: 'https://news.google.com:8443/rss' })).rejects.toThrow(/port/);
    await expect(p.fetchFeed({ url: 'file:///etc/passwd' })).rejects.toThrow(/http/);
    const rebinding = new HttpFeedProvider({ resolve: async () => ['10.0.0.7'], fetchImpl: (async () => ok(RSS)) as unknown as typeof fetch });
    await expect(rebinding.fetchFeed({ url: 'https://news.google.com/rss' })).rejects.toThrow(/private address/);
    for (const ip of ['10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) expect(isPrivateAddress(ip)).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });

  it('re-checks every redirect hop and caps the body size', async () => {
    const redirecting = new HttpFeedProvider({
      resolve: publicDns,
      fetchImpl: (async () => new Response(null, { status: 301, headers: { location: 'https://attacker.example.net/feed' } })) as unknown as typeof fetch,
    });
    await expect(redirecting.fetchFeed({ url: 'https://news.google.com/rss' })).rejects.toThrow(/allowlist: attacker\.example\.net/);
    const big = new HttpFeedProvider({ resolve: publicDns, maxBytes: 100, fetchImpl: (async () => ok(RSS)) as unknown as typeof fetch });
    await expect(big.fetchFeed({ url: 'https://news.google.com/rss' })).rejects.toThrow(/larger than 100 bytes/);
  });

  it('accepts hosts the studio registered at run time', async () => {
    const p = new HttpFeedProvider({ resolve: publicDns, fetchImpl: (async () => ok(RSS)) as unknown as typeof fetch });
    await expect(p.fetchFeed({ url: 'https://blog.studio-feed.test/rss' })).rejects.toThrow(/allowlist/);
    p.allowHosts(['https://blog.studio-feed.test/anything', '10.0.0.1']);
    expect(p.allowed()).toContain('blog.studio-feed.test');
    expect(p.allowed()).not.toContain('10.0.0.1');
    await expect(p.fetchFeed({ url: 'https://blog.studio-feed.test/rss' })).resolves.toHaveLength(2);
  });
});

/** A stub of the SDK's beta.messages: canned responses, recorded requests. */
function stubClient(responses: Array<Record<string, unknown>>, repair?: Record<string, unknown>) {
  const requests: Array<Record<string, unknown>> = [];
  const creates: Array<Record<string, unknown>> = [];
  const client = {
    beta: {
      messages: {
        stream: (body: Record<string, unknown>) => {
          requests.push(structuredClone(body));
          const next = responses.shift();
          if (!next) throw new Error('no more stub responses');
          return { finalMessage: async () => next };
        },
        create: async (body: Record<string, unknown>) => {
          creates.push(body);
          return repair;
        },
      },
    },
  } as unknown as ResearchClient;
  return { client, requests, creates };
}

const usage = (inTok: number, outTok: number, searches = 0) => ({
  input_tokens: inTok,
  output_tokens: outTok,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  server_tool_use: { web_search_requests: searches, web_fetch_requests: 0 },
});

const TOPIC = {
  synthesis: 'Present bias makes later feel cheaper than now.',
  facts: [
    { claim: 'Defaults raise saving rates.', citations: [{ url: 'https://example.edu/paper', title: 'Paper', quote: 'Automatic enrolment raised participation substantially.' }] },
    { claim: 'An uncited claim', citations: [] },
  ],
  frameworks: ['Pay yourself first'],
  questions: ['Why do I spend my raise?'],
  sources: [{ url: 'https://example.edu/paper', title: 'Paper' }],
};

describe('ClaudeWebResearch (Claude web search / fetch)', () => {
  it('sends the 20260209 server tools with prompt caching and continues paused turns', async () => {
    const { client, requests } = stubClient([
      { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: {} }, { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://example.org/a', title: 'A', encrypted_content: 'x', page_age: null }] }], usage: usage(1000, 100, 2) },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: `Here you go.\n\`\`\`json\n${JSON.stringify(TOPIC)}\n\`\`\`` }], usage: usage(2000, 800, 1) },
    ]);
    const r = await new ClaudeWebResearch(client).researchTopic({ niche: 'wealth', path: 'behaviour/present-bias', title: 'Present bias' });
    expect(requests).toHaveLength(2);
    const body = requests[0]!;
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.tools).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 6 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6 },
    ]);
    expect((body.system as Array<{ cache_control?: unknown }>)[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(body.fallbacks).toBe('default');
    // The paused assistant turn is sent back unchanged to resume.
    expect((requests[1]!.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(r.synthesis).toBe(TOPIC.synthesis);
    expect(r.facts).toHaveLength(1); // the uncited claim is dropped
    expect(r.sources.map((s) => s.url)).toEqual(['https://example.edu/paper', 'https://example.org/a']);
    // Sonnet 5.5 at $2/$10 per MTok plus three searches at $0.01.
    expect(r.costUsd).toBeCloseTo((3000 * 2 + 900 * 10) / 1e6 + 0.03, 6);
  });

  it('repairs a prose answer with a structured-output call on the fast tier', async () => {
    const { client, creates } = stubClient(
      [{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Prose only, no JSON.' }], usage: usage(500, 200) }],
      { content: [{ type: 'text', text: JSON.stringify({ sources: [], experts: [], curriculum: [{ path: 'basics/x', title: 'X', level: 'fundamental' }] }) }], usage: usage(300, 100) },
    );
    const map = await new ClaudeWebResearch(client).mapField({ niche: 'wealth' });
    expect(map.curriculum).toEqual([{ path: 'basics/x', title: 'X', level: 'fundamental' }]);
    expect(creates[0]!.model).toBe('claude-haiku-5-5');
    expect((creates[0]!.output_config as { format: { type: string } }).format.type).toBe('json_schema');
  });

  it('surfaces refusals instead of storing an empty node', async () => {
    const { client } = stubClient([{ stop_reason: 'refusal', stop_details: { category: 'bio' }, content: [], usage: usage(10, 0) }]);
    await expect(new ClaudeWebResearch(client).researchTopic({ niche: 'x', path: 'a/b', title: 'B' })).rejects.toThrow(/refused \(bio\)/);
  });

  it('extracts the last fenced JSON block or the outermost object', () => {
    expect(extractJson('a ```json\n{"a":1}\n``` b ```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('text {"b": [1, 2]} text')).toEqual({ b: [1, 2] });
    expect(extractJson('nothing here')).toBeUndefined();
  });
});

describe('embeddings adapters', () => {
  it('LocalEmbeddings returns 384-d unit vectors from the transformers.js pipeline', async () => {
    let loads = 0;
    const local = new LocalEmbeddings({
      cacheDir: '/tmp/models-test',
      load: async () => {
        loads += 1;
        const env = { cacheDir: null as string | null };
        return {
          env,
          pipeline: async (_task: string, model: string) => {
            expect(model).toBe('Xenova/bge-small-en-v1.5');
            expect(env.cacheDir).toBe('/tmp/models-test');
            return async (texts: string[]) => ({ tolist: () => texts.map((_, i) => Array.from({ length: 384 }, (_, j) => (j === i ? 3 : 0))) });
          },
        };
      },
    });
    const v = await local.embed(['a', 'b']);
    await local.embed(['c']);
    expect(loads).toBe(1);
    expect(v).toHaveLength(2);
    expect(v[0]).toHaveLength(EMBEDDING_DIM);
    expect(Math.hypot(...v[0]!)).toBeCloseTo(1, 6);
  });

  it('VoyageEmbeddings truncates 512-d vectors to 384 and re-normalises', async () => {
    let sent: Record<string, unknown> = {};
    const voyage = new VoyageEmbeddings('vk-test', (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: Array.from({ length: 512 }, () => 1) }] }), { status: 200 });
    }) as unknown as typeof fetch);
    const [v] = await voyage.embed(['hello']);
    expect(sent).toMatchObject({ model: 'voyage-3.5-lite', output_dimension: 512 });
    expect(v).toHaveLength(384);
    expect(Math.hypot(...v!)).toBeCloseTo(1, 6);
  });
});

describe('liveProviders switch', () => {
  const env = (live: boolean, secrets: Record<string, string> = {}): ProviderEnv => ({ isLive: (id) => live && id === 'anthropic', secret: (n) => secrets[n] ?? null });

  it('stays on fakes when IOS_FAKE_PROVIDERS forces them (every test run)', () => {
    expect(knowledgeLiveProviders(env(true, { 'anthropic.api_key': 'k' }), { IOS_FAKE_PROVIDERS: '1' })).toEqual({});
    expect(Object.keys(knowledgeLiveProviders(env(true, { 'anthropic.api_key': 'k' }), { IOS_FAKE_PROVIDERS: 'feeds,embeddings' }))).toEqual(['webResearch']);
  });

  it('goes live per member: research only with the Anthropic key, feeds and local embeddings without keys', () => {
    const noKey = knowledgeLiveProviders(env(false), {});
    expect(noKey.webResearch).toBeUndefined();
    expect(noKey.feeds?.name).toBe('http-feeds');
    expect(noKey.embeddings?.name).toBe('local:bge-small-en-v1.5');
    const live = knowledgeLiveProviders(env(true, { 'anthropic.api_key': 'sk-test', 'voyage.api_key': 'vk' }), { IOS_EMBEDDINGS: 'voyage', IOS_FEED_ALLOWLIST: 'feeds.example.com' });
    expect(live.webResearch?.name).toBe('claude-web-research');
    expect(live.embeddings?.name).toBe('voyage:voyage-3.5-lite@384');
    expect((live.feeds as HttpFeedProvider).allowed()).toContain('feeds.example.com');
    expect(knowledgeLiveProviders(env(false), { IOS_EMBEDDINGS: 'fake' }).embeddings).toBeUndefined();
  });
});
