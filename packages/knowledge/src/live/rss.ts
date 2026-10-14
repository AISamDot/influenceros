import type { FeedItem } from '@ios/providers';
import { XMLParser } from 'fast-xml-parser';

/**
 * RSS 2.0, RSS 1.0 (RDF) and Atom (incl. YouTube channel feeds and Reddit) into FeedItems. DOCTYPE declarations are
 * stripped before parsing, so no entity expansion or external entities are possible.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => name === 'item' || name === 'entry' || name === 'link',
});

type Node = Record<string, unknown>;

function text(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') {
    const o = v as Node;
    if ('#text' in o) return text(o['#text']);
    if ('__cdata' in o) return text(o.__cdata);
  }
  return '';
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…' };

/** Feeds often carry HTML that was escaped twice (Reddit, Google News): decode what's left after XML parsing. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const stripHtml = (s: string) =>
  decodeEntities(decodeEntities(s).replace(/<[^>]+>/g, ' '))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function date(v: unknown): Date | null {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function atomLink(v: unknown): string {
  const links = (Array.isArray(v) ? v : [v]).filter(Boolean) as Array<Node | string>;
  const alt = links.find((l) => typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate')) ?? links[0];
  if (!alt) return '';
  return typeof alt === 'string' ? alt : text(alt['@_href'] ?? alt['#text']);
}

export function parseFeedXml(xml: string, fallbackSource: string): FeedItem[] {
  const clean = xml.replace(/<!DOCTYPE[\s\S]*?(\[[\s\S]*?\])?\s*>/gi, '');
  const doc = parser.parse(clean) as Node;
  const rss = doc.rss as Node | undefined;
  if (rss?.channel) {
    const ch = (Array.isArray(rss.channel) ? rss.channel[0] : rss.channel) as Node;
    const source = text(ch.title) || fallbackSource;
    return ((ch.item as Node[] | undefined) ?? []).map((it) => ({
      title: stripHtml(text(it.title)),
      url: text(it.link) || (/^https?:/.test(text(it.guid)) ? text(it.guid) : ''),
      publishedAt: date(it.pubDate ?? it['dc:date']),
      summary: stripHtml(text(it.description ?? it['content:encoded'])) || null,
      source: text(it.source) || source,
    }));
  }
  const rdf = doc['rdf:RDF'] as Node | undefined;
  if (rdf) {
    const source = text((rdf.channel as Node | undefined)?.title) || fallbackSource;
    return ((rdf.item as Node[] | undefined) ?? []).map((it) => ({
      title: stripHtml(text(it.title)),
      url: text(it.link),
      publishedAt: date(it['dc:date']),
      summary: stripHtml(text(it.description)) || null,
      source,
    }));
  }
  const feed = doc.feed as Node | undefined;
  if (feed) {
    const source = text(feed.title) || fallbackSource;
    return ((feed.entry as Node[] | undefined) ?? []).map((e) => {
      const media = e['media:group'] as Node | undefined;
      return {
        title: stripHtml(text(e.title)),
        url: atomLink(e.link),
        publishedAt: date(e.published ?? e.updated),
        summary: stripHtml(text(e.summary ?? e.content ?? media?.['media:description'])) || null,
        source,
      };
    });
  }
  throw new Error('not an RSS or Atom feed');
}
