import { type Block, PAGE_GEOMETRY, type PageSize, plainInline, type ProductDoc } from './model';

/**
 * Deterministic pagination. Every page is a fixed-size box, so page numbers and the table of contents are known
 * before rendering (QP then checks the PDF has exactly these pages). Heights are conservative estimates in mm; if
 * Chrome still reports an overflowing page, the build loops with a higher `density` (taller estimates, fewer blocks
 * per page).
 */

export interface LayoutPage {
  /** 1-based, the printed page number. */
  readonly number: number;
  readonly kind: 'cover' | 'toc' | 'content';
  /** The section this page belongs to (content pages). */
  readonly sectionId?: string;
  /** Set on the first page of a section: the page shows the section heading. */
  readonly sectionStart?: { readonly id: string; readonly title: string; readonly eyebrow: string };
  readonly blocks: readonly Block[];
}

export interface TocEntry {
  readonly id: string;
  readonly title: string;
  readonly page: number;
  readonly kind: string;
}

export interface Layout {
  readonly size: PageSize;
  readonly pages: readonly LayoutPage[];
  readonly toc: readonly TocEntry[];
  readonly density: number;
}

const BODY_PT = 10.5;
const PT_MM = 0.3528;
const LINE_MM = BODY_PT * 1.5 * PT_MM; // ≈ 5.56 mm
const CHAR_MM = BODY_PT * 0.56 * PT_MM; // conservative average glyph width
const TOC_PER_PAGE = 22;
const SECTION_HEAD_MM = 30;

function lines(text: string, widthMm: number): number {
  const cpl = Math.max(20, Math.floor(widthMm / CHAR_MM));
  const t = plainInline(text);
  let n = 0;
  for (const para of t.split(/\n+/)) n += Math.max(1, Math.ceil(para.length / cpl));
  return n;
}

/** Estimated height of a block in mm at a content width. */
export function blockHeight(b: Block, width: number): number {
  switch (b.t) {
    case 'p':
      return lines(b.text, width) * LINE_MM + 3;
    case 'h':
      return lines(b.text, width * 0.8) * 7 + 5;
    case 'callout':
      return lines(b.text, width - 16) * LINE_MM + 12;
    case 'list':
      return b.items.reduce((a, it) => a + lines(it, width - 8) * LINE_MM + 1.2, 0) + 3;
    case 'rule':
      return 8 + lines(b.text, width - 16) * LINE_MM + 14;
    case 'example':
      return 8 + lines(b.text, width - 16) * LINE_MM + 14;
    case 'checklist':
      return (b.title ? 9 : 0) + b.items.reduce((a, it) => a + Math.max(7.5, lines(it, width - 12) * LINE_MM + 2), 0) + 4;
    case 'tracker': {
      const rowLabel = Math.min(width * 0.38, 60);
      return 9 + 8 + b.rows.reduce((a, r) => a + Math.max(8, lines(r, rowLabel - 4) * LINE_MM + 2.5), 0) + 5;
    }
    case 'fillin':
      return lines(b.prompt, width) * LINE_MM + b.lines * 9 + 6;
    case 'table': {
      const colW = width / Math.max(1, b.header.length);
      const row = (r: readonly string[]) => Math.max(...r.map((c) => lines(c, colW - 4)), 1) * LINE_MM + 3;
      return row(b.header) + b.rows.reduce((a, r) => a + row(r), 0) + 5;
    }
    case 'pagebreak':
      return 0;
  }
}

/** Splits a block that can't fit a whole page (or the rest of one) into pieces that do. */
function splitBlock(b: Block, width: number, room: number): [Block, Block] | null {
  const fit = <T,>(items: readonly T[], make: (xs: readonly T[]) => Block): [Block, Block] | null => {
    for (let k = items.length - 1; k >= 1; k--) {
      const head = make(items.slice(0, k));
      if (blockHeight(head, width) <= room) return [head, make(items.slice(k))];
    }
    return null;
  };
  switch (b.t) {
    case 'list':
      return fit(b.items, (xs) => ({ ...b, items: xs }));
    case 'checklist':
      return fit(b.items, (xs) => ({ ...b, items: xs }));
    case 'tracker':
      return fit(b.rows, (xs) => ({ ...b, rows: xs }));
    case 'table':
      return fit(b.rows, (xs) => ({ ...b, rows: xs }));
    case 'fillin':
      if (b.lines < 2) return null;
      for (let k = b.lines - 1; k >= 1; k--) {
        const head: Block = { ...b, lines: k };
        if (blockHeight(head, width) <= room) return [head, { t: 'fillin', prompt: `${b.prompt.replace(/\s*\(continued\)$/, '')} (continued)`, lines: b.lines - k }];
      }
      return null;
    case 'p': {
      const parts = b.text.split(/(?<=[.!?])\s+(?=[A-Z0-9*“"(])/);
      if (parts.length < 2) return null;
      return fit(parts, (xs) => ({ t: 'p', text: xs.join(' ') }));
    }
    default:
      return null;
  }
}

/** Paginates a doc for one page size. `density` ≥ 1 inflates the estimates (the overflow fix loop). */
export function layoutDoc(doc: ProductDoc, size: PageSize, density = 1): Layout {
  const g = PAGE_GEOMETRY[size];
  const width = g.w - 2 * g.margin;
  const height = (g.h - g.top - g.bottom) / density;
  const sections = doc.sections.filter((s) => s.blocks.length || s.title);
  const tocPages = sections.length >= 3 ? Math.ceil(sections.length / TOC_PER_PAGE) : 0;
  let page = 1 + tocPages; // the last page used so far: cover, then the TOC pages
  const content: LayoutPage[] = [];
  const toc: TocEntry[] = [];
  let partNo = 0;

  for (const s of sections) {
    if (s.kind === 'core') partNo += 1;
    const eyebrow = s.kind === 'core' ? `Part ${partNo}` : s.kind === 'bonus' ? 'Bonus' : s.kind === 'tools' ? 'Tools' : s.kind === 'credits' ? 'Notes' : s.kind === 'next' ? 'Next' : 'Start';
    toc.push({ id: s.id, title: s.title, page: page + 1, kind: s.kind });
    const chunks: Block[][] = [[]];
    let used = SECTION_HEAD_MM;
    const newPage = () => {
      chunks.push([]);
      used = 0;
    };
    const queue: Block[] = [...s.blocks];
    while (queue.length) {
      const b = queue.shift()!;
      const cur = chunks.at(-1)!;
      if (b.t === 'pagebreak') {
        if (cur.length) newPage();
        continue;
      }
      const h = blockHeight(b, width);
      const room = height - used;
      if (h <= room) {
        cur.push(b);
        used += h;
        continue;
      }
      // Split into the rest of this page when there's meaningful room; else move to a fresh page.
      const split = room > 25 || !cur.length ? splitBlock(b, width, room) : null;
      if (split) {
        cur.push(split[0]);
        queue.unshift(split[1]);
        newPage();
        continue;
      }
      if (cur.length) {
        newPage();
        queue.unshift(b);
        continue;
      }
      cur.push(b); // a fresh page and still too tall to split: the overflow check reports it
      used = height;
    }
    if (!chunks.at(-1)!.length && chunks.length > 1) chunks.pop();
    chunks.forEach((blocks, i) => {
      page += 1;
      content.push({ number: page, kind: 'content', sectionId: s.id, ...(i === 0 ? { sectionStart: { id: s.id, title: s.title, eyebrow } } : {}), blocks });
    });
  }

  const total = page;
  const pages: LayoutPage[] = [{ number: 1, kind: 'cover', blocks: [] }];
  for (let i = 0; i < tocPages; i++) pages.push({ number: 2 + i, kind: 'toc', blocks: [] });
  pages.push(...content);
  if (pages.length !== total) throw new Error(`layout page count mismatch (${pages.length} vs ${total})`);
  return { size, pages, toc, density };
}
