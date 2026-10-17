import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { FeedItem, FeedProvider } from '@troupe/providers';
import { parseFeedXml } from './rss';

/**
 * Live FeedProvider: plain HTTPS GETs of RSS/Atom feeds, refused unless the host is on the allowlist (built-in
 * news hosts + the launch personas' feed hosts + TROUPE_FEED_ALLOWLIST + feeds the studio itself registered).
 * Defence in depth on top of the allowlist: http(s) only, no credentials in URLs, no private or loopback
 * addresses, redirects re-checked hop by hop, a 10 s timeout and a 3 MB body cap. Free (no costUsd).
 */

export const BUILTIN_FEED_HOSTS: readonly string[] = [
  // Aggregators and platforms (Google News RSS searches, subreddit RSS, YouTube channel RSS)
  'news.google.com',
  'reddit.com',
  'youtube.com',
  // Wire services and broad reputable outlets
  'apnews.com',
  'feeds.bbci.co.uk',
  'feeds.npr.org',
  'npr.org',
  'theguardian.com',
  'rss.nytimes.com',
  'feeds.washingtonpost.com',
  'feeds.reuters.com',
  // The launch personas' Field Brain feeds
  'countrylife.co.uk',
  'robbreport.com',
  'spearswms.com',
  'tatler.com',
  'federalreserve.gov',
  'fca.org.uk',
  'gov.uk',
  'hrdive.com',
  'globaldatinginsights.com',
  'valueaddedresource.net',
  'food.gov.uk',
  'consumer.ftc.gov',
  'ftc.gov',
];

/** Allowlist entries cover their subdomains ("reddit.com" allows "www.reddit.com"). */
export function hostAllowed(host: string, allow: ReadonlySet<string>): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  for (const a of allow) if (h === a || h.endsWith(`.${a}`)) return true;
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::') return true;
    if (s.startsWith('::ffff:')) return isPrivateAddress(s.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
  }
  return true;
}

export interface HttpFeedOptions {
  allow?: readonly string[];
  fetchImpl?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

const normalise = (h: string) => h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');

export class HttpFeedProvider implements FeedProvider {
  readonly name = 'http-feeds';
  readonly #allow: Set<string>;
  readonly #fetch: typeof fetch;
  readonly #resolve: (host: string) => Promise<string[]>;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #maxRedirects: number;

  constructor(opts: HttpFeedOptions = {}) {
    this.#allow = new Set([...BUILTIN_FEED_HOSTS, ...(opts.allow ?? [])].map(normalise).filter(Boolean));
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#resolve = opts.resolve ?? (async (host) => (await lookup(host, { all: true })).map((a) => a.address));
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
    this.#maxBytes = opts.maxBytes ?? 3_000_000;
    this.#maxRedirects = opts.maxRedirects ?? 3;
  }

  /** Adds hosts the studio registered itself (seed and Owner feeds). */
  allowHosts(hosts: readonly string[]): void {
    for (const h of hosts) {
      const n = normalise(h);
      if (n && !isIP(n) && n.includes('.')) this.#allow.add(n);
    }
  }

  allowed(): string[] {
    return [...this.#allow].sort();
  }

  async #check(raw: string): Promise<URL> {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`feed url is not a URL: ${raw.slice(0, 120)}`);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`feed url must be http(s): ${u.protocol}`);
    if (u.username || u.password) throw new Error('feed url must not carry credentials');
    if (u.port && u.port !== '443' && u.port !== '80') throw new Error(`feed port ${u.port} is not allowed`);
    const host = u.hostname.toLowerCase();
    if (isIP(host) || !hostAllowed(host, this.#allow)) throw new Error(`feed host not on the allowlist: ${host}`);
    const addresses = await this.#resolve(host);
    if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error(`feed host resolves to a private address: ${host}`);
    return u;
  }

  async fetchFeed(req: { url: string; limit?: number }): Promise<FeedItem[]> {
    let url = await this.#check(req.url);
    let res: Response | null = null;
    for (let hop = 0; hop <= this.#maxRedirects; hop++) {
      res = await this.#fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { 'user-agent': 'TroupeHouse-NewsDesk/1.0 (+RSS reader)', accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5' },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = await this.#check(new URL(res.headers.get('location')!, url).toString());
        continue;
      }
      break;
    }
    if (!res || res.status >= 300) throw new Error(`feed fetch failed: HTTP ${res?.status ?? 'none'} for ${url.hostname}`);
    const xml = await readCapped(res, this.#maxBytes);
    return parseFeedXml(xml, url.hostname)
      .filter((i) => i.title && /^https?:\/\//.test(i.url))
      .slice(0, req.limit ?? 25);
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) throw new Error(`feed is larger than ${max} bytes`);
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error(`feed is larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
