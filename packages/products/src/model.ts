/**
 * The structured content of a product (workbook-builder skill): sections made of blocks. Both paths produce it, a
 * Monetization Agent brief (written by the product-builder agent) and an imported markdown manuscript, and the same
 * layout → HTML → PDF → QP pipeline renders it. Inline text is markdown-lite: **bold**, *italic*, [label](https://…).
 */
export type Block =
  | { readonly t: 'p'; readonly text: string }
  | { readonly t: 'h'; readonly text: string }
  | { readonly t: 'list'; readonly ordered: boolean; readonly items: readonly string[] }
  /** A named rule from the persona's framework ("The 2-minute rule"). */
  | { readonly t: 'rule'; readonly name: string; readonly text: string }
  /** Tick boxes. */
  | { readonly t: 'checklist'; readonly title?: string; readonly items: readonly string[] }
  /** A tick-box tracker grid: one row per habit/task, one column per day/week. */
  | { readonly t: 'tracker'; readonly title: string; readonly rows: readonly string[]; readonly columns: readonly string[] }
  /** A fill-in prompt with ruled writing lines. */
  | { readonly t: 'fillin'; readonly prompt: string; readonly lines: number }
  | { readonly t: 'example'; readonly title: string; readonly text: string }
  | { readonly t: 'callout'; readonly text: string }
  | { readonly t: 'table'; readonly header: readonly string[]; readonly rows: ReadonlyArray<readonly string[]> }
  | { readonly t: 'pagebreak' };

export type SectionKind = 'intro' | 'core' | 'tools' | 'bonus' | 'next' | 'credits';

export interface DocSection {
  /** Anchor id (`sec-…`), unique in the doc. */
  readonly id: string;
  readonly title: string;
  readonly kind: SectionKind;
  readonly blocks: readonly Block[];
}

export interface ProductDoc {
  readonly title: string;
  /** The one-line promise: what the buyer will do, never what will happen to them. */
  readonly subtitle: string;
  readonly personaName: string;
  readonly sections: readonly DocSection[];
  /** Section titles the brief (outline + bonuses) or the manuscript's front matter promised; QP checks each exists. */
  readonly promised: readonly string[];
}

export type PageSize = 'A4' | 'Letter';
export const PAGE_SIZES: readonly PageSize[] = ['A4', 'Letter'];

/** Page geometry in mm (and the PDF MediaBox in points, which QP checks). */
export const PAGE_GEOMETRY: Readonly<Record<PageSize, { w: number; h: number; margin: number; top: number; bottom: number; pt: readonly [number, number] }>> = {
  A4: { w: 210, h: 297, margin: 18, top: 20, bottom: 24, pt: [595.28, 841.89] },
  Letter: { w: 215.9, h: 279.4, margin: 19, top: 19, bottom: 23, pt: [612, 792] },
};

// ───────────────────────────── helpers ─────────────────────────────

export function slugify(s: string, max = 60): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/g, '') || 'product'
  );
}

/** Unique section ids. */
export function sectionIds(titles: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return titles.map((t) => {
    const base = `sec-${slugify(t, 40)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

/** Inline markdown stripped to plain text (links keep their label). */
export function plainInline(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

/** Every link target in inline text, in order. */
export function inlineLinks(s: string): string[] {
  return [...s.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)].map((m) => m[2]!);
}

/** All inline strings of a block (for link, placeholder and spelling scans). */
export function blockStrings(b: Block): string[] {
  switch (b.t) {
    case 'p':
    case 'h':
    case 'callout':
      return [b.text];
    case 'list':
      return [...b.items];
    case 'rule':
      return [b.name, b.text];
    case 'checklist':
      return [...(b.title ? [b.title] : []), ...b.items];
    case 'tracker':
      return [b.title, ...b.rows, ...b.columns];
    case 'fillin':
      return [b.prompt];
    case 'example':
      return [b.title, b.text];
    case 'table':
      return [...b.header, ...b.rows.flat()];
    case 'pagebreak':
      return [];
  }
}

export function docStrings(doc: ProductDoc): string[] {
  return [doc.title, doc.subtitle, ...doc.sections.flatMap((s) => [s.title, ...s.blocks.flatMap(blockStrings)])];
}

/** Plain text of the whole product (Gate input, hashes). */
export function docText(doc: ProductDoc): string {
  return docStrings(doc).map(plainInline).join('\n');
}

export function docLinks(doc: ProductDoc): string[] {
  return [...new Set(docStrings(doc).flatMap(inlineLinks))];
}

/** Normalised title tokens for fuzzy "is the promised section here?" matching. */
export function titleTokens(s: string): string[] {
  const stop = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'your', 'you', 'for', 'in', 'on', 'part', 'bonus', 'with', 'how', 'this', 'it']);
  return plainInline(s)
    .toLowerCase()
    .replace(/^(part|step|section|chapter)\s+\d+\s*[:.\-–—]\s*/i, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !stop.has(w));
}

/** Does a doc section answer a promised title? Containment either way, or a token overlap of at least 60 %. */
export function titleMatches(promised: string, actual: string): boolean {
  const a = titleTokens(promised);
  const b = titleTokens(actual);
  if (!a.length) return true;
  const sb = new Set(b);
  const hit = a.filter((w) => sb.has(w)).length;
  const pa = plainInline(promised).toLowerCase().replace(/^(part|step|section|chapter)\s+\d+\s*[:.\-–—]\s*/i, '').trim();
  const pb = plainInline(actual).toLowerCase();
  return (!!pa && pb.includes(pa)) || (!!pb.trim() && pa.includes(pb.trim())) || hit / a.length >= 0.6;
}
