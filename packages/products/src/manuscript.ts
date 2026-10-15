import { type Block, type DocSection, type ProductDoc, sectionIds, type SectionKind, slugify } from './model';

/**
 * Ready-written manuscripts (markdown dropped into the inbox folder) → ProductDoc. No model is involved: the text is
 * rendered as written (imported manuscripts are third-party text and never become instructions).
 *
 * Conventions (all optional except at least one `##` section):
 *
 * ```
 * ---
 * title: The Sunday Reset Workbook
 * subtitle: Plan your week in 20 minutes
 * persona: dot            # persona slug (else the inbox subfolder name)
 * slug: sunday-reset      # product slug: a changed manuscript with the same slug becomes a new version
 * rung: entry             # ladder rung (default entry)
 * price: 19               # USD (default: the persona's price band)
 * sections: Start here; The reset; Weekly tracker   # promised sections QP checks
 * templates: sheets, notion
 * ---
 * # Title (when there is no front matter title)
 * ## Section            (## Bonus: … is a bonus page)
 * ### Rule: Name        then a paragraph: a named rule
 * ### Example: Title    then paragraphs: a worked example
 * ### Checklist: Title  then "- [ ] item" lines (tick boxes; also without the heading)
 * ### Tracker: Title    then "Rows: a; b" and "Columns: Mon; Tue" lines (or a table whose cells are "[ ]")
 * Fill in: prompt       (Fill in (6): prompt for six writing lines)
 * > callout · - list · 1. ordered list · | table | · <!-- pagebreak -->
 * ```
 */

export interface ManuscriptMeta {
  readonly title?: string;
  readonly subtitle?: string;
  readonly persona?: string;
  readonly slug?: string;
  readonly rung?: string;
  readonly priceCents?: number;
  readonly sections?: readonly string[];
  readonly templates?: ReadonlyArray<'sheet' | 'notion'>;
  /** Extra palette rows for rendering without a persona (`palette: #F5EFE6, #1F2A44, #D9822B`). */
  readonly palette?: readonly string[];
  readonly raw: Readonly<Record<string, string>>;
}

export interface ParsedManuscript {
  readonly meta: ManuscriptMeta;
  readonly doc: ProductDoc;
}

const splitList = (v: string): string[] =>
  v
    .split(/\s*[;|]\s*|\s*,\s*(?=[A-Z0-9#])/)
    .map((s) => s.trim())
    .filter(Boolean);

function parseFrontMatter(text: string): { meta: Record<string, string>; lists: Record<string, string[]>; body: string } {
  const meta: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta, lists, body: text };
  let current: string | null = null;
  for (const line of m[1]!.split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && current) {
      (lists[current] ??= []).push(item[1]!.trim().replace(/^["']|["']$/g, ''));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      current = kv[1]!.toLowerCase();
      const v = kv[2]!.trim().replace(/^["']|["']$/g, '');
      if (v) meta[current] = v;
    }
  }
  return { meta, lists, body: text.slice(m[0].length) };
}

function toMeta(meta: Record<string, string>, lists: Record<string, string[]>): ManuscriptMeta {
  const list = (k: string) => lists[k] ?? (meta[k] ? splitList(meta[k]!) : undefined);
  const price = meta.price !== undefined ? Number(meta.price.replace(/[$,\s]/g, '')) : NaN;
  const templates = (lists.templates ?? meta.templates?.split(/[,;|]/) ?? [])
    .map((t) => t.toLowerCase())
    .map((t) => (/sheet/.test(t) ? 'sheet' : /notion/.test(t) ? 'notion' : null))
    .filter((t): t is 'sheet' | 'notion' => t !== null);
  return {
    title: meta.title,
    subtitle: meta.subtitle ?? meta.promise,
    persona: meta.persona?.toLowerCase(),
    slug: meta.slug ? slugify(meta.slug) : undefined,
    rung: meta.rung,
    priceCents: Number.isFinite(price) && price >= 0 ? Math.round(price * 100) : undefined,
    sections: list('sections'),
    templates: [...new Set(templates)],
    palette: list('palette')?.filter((h) => /^#[0-9a-f]{6}$/i.test(h)),
    raw: meta,
  };
}

function kindOf(title: string): SectionKind {
  if (/^bonus\b/i.test(title)) return 'bonus';
  if (/start here|how to use|introduction|welcome/i.test(title)) return 'intro';
  if (/next step/i.test(title)) return 'next';
  if (/^credits\b|credits and notes|^sources\b/i.test(title)) return 'credits';
  if (/tracker|template|tools|printable|worksheet/i.test(title)) return 'tools';
  return 'core';
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

/** Parses the body lines of one section into blocks. */
function parseBlocks(lines: readonly string[]): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  let i = 0;
  const flush = () => {
    if (para.length) out.push({ t: 'p', text: para.join(' ').trim() });
    para = [];
  };
  /** Paragraph text right after a heading (for rules and examples). */
  const takeParagraphs = (stopAtBlank: boolean): string[] => {
    const acc: string[] = [];
    let cur: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (/^#{1,6}\s/.test(l) || /^\s*([-*]|\d+\.)\s/.test(l) || /^\s*\|/.test(l) || /^\s*>/.test(l) || /^fill in\b/i.test(l.trim()) || /<!--\s*pagebreak\s*-->/i.test(l)) break;
      if (!l.trim()) {
        if (cur.length) acc.push(cur.join(' '));
        cur = [];
        i++;
        if (stopAtBlank && acc.length) break;
        continue;
      }
      cur.push(l.trim());
      i++;
    }
    if (cur.length) acc.push(cur.join(' '));
    return acc;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      i++;
      continue;
    }
    if (/^<!--\s*pagebreak\s*-->$|^\\pagebreak$|^---+$/i.test(trimmed)) {
      flush();
      out.push({ t: 'pagebreak' });
      i++;
      continue;
    }
    const h3 = /^#{3,6}\s+(.*)$/.exec(trimmed);
    if (h3) {
      flush();
      const title = h3[1]!.trim();
      i++;
      const rule = /^rule\s*[:\-–—]\s*(.+)$/i.exec(title);
      const example = /^(?:worked\s+)?example\s*[:\-–—]\s*(.+)$/i.exec(title);
      const checklist = /^checklist\s*[:\-–—]\s*(.+)$/i.exec(title);
      const tracker = /^tracker\s*[:\-–—]\s*(.+)$/i.exec(title);
      const fill = /^fill[- ]in\s*(?:\((\d+)\))?\s*[:\-–—]\s*(.+)$/i.exec(title);
      if (rule) out.push({ t: 'rule', name: rule[1]!.trim(), text: takeParagraphs(true).join(' ') });
      else if (example) out.push({ t: 'example', title: example[1]!.trim(), text: takeParagraphs(false).join('\n\n') });
      else if (fill) out.push({ t: 'fillin', prompt: fill[2]!.trim(), lines: Math.min(20, Math.max(1, Number(fill[1] ?? 4))) });
      else if (checklist) {
        const items: string[] = [];
        while (i < lines.length && (/^\s*[-*]\s+\[[ xX]?\]\s+/.test(lines[i]!) || !lines[i]!.trim())) {
          const m = /^\s*[-*]\s+\[[ xX]?\]\s+(.*)$/.exec(lines[i]!);
          if (m) items.push(m[1]!.trim());
          else if (items.length) break;
          i++;
        }
        out.push({ t: 'checklist', title: checklist[1]!.trim(), items });
      } else if (tracker) {
        let rows: string[] = [];
        let columns: string[] = [];
        while (i < lines.length) {
          const l = lines[i]!.trim();
          const r = /^rows?\s*:\s*(.*)$/i.exec(l);
          const c = /^columns?\s*:\s*(.*)$/i.exec(l);
          if (r) rows = splitList(r[1]!);
          else if (c) columns = splitList(c[1]!);
          else if (l) break;
          i++;
        }
        out.push({ t: 'tracker', title: tracker[1]!.trim(), rows, columns: columns.length ? columns : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] });
      } else out.push({ t: 'h', text: title });
      continue;
    }
    const fill = /^fill[- ]in\s*(?:\((\d+)\))?\s*:\s*(.+)$/i.exec(trimmed);
    if (fill) {
      flush();
      out.push({ t: 'fillin', prompt: fill[2]!.trim(), lines: Math.min(20, Math.max(1, Number(fill[1] ?? 4))) });
      i++;
      continue;
    }
    if (/^\s*[-*]\s+\[[ xX]?\]\s+/.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+\[[ xX]?\]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*]\s+\[[ xX]?\]\s+/, '').trim());
      out.push({ t: 'checklist', items });
      continue;
    }
    if (/^\s*([-*+])\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+(?!\[[ xX]?\])/).test(lines[i]!)) {
        let item = lines[i++]!.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();
        // Continuation lines (indented) belong to the item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i]!)) item += ` ${lines[i++]!.trim()}`;
        items.push(item);
      }
      out.push({ t: 'list', ordered, items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const acc: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) acc.push(lines[i++]!.replace(/^\s*>\s?/, '').trim());
      out.push({ t: 'callout', text: acc.join(' ').trim() });
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      const rowsRaw: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        const l = lines[i++]!;
        if (/^\s*\|?\s*:?-{2,}/.test(l.replace(/\|/g, '|'))) continue; // separator row
        rowsRaw.push(cells(l));
      }
      const [header = [], ...rows] = rowsRaw;
      const tickGrid = rows.length > 0 && rows.every((r) => r.slice(1).every((c) => /^\[\s?\]$|^$/.test(c)));
      if (tickGrid && header.length > 1) out.push({ t: 'tracker', title: header[0] || 'Tracker', rows: rows.map((r) => r[0] ?? ''), columns: header.slice(1) });
      else out.push({ t: 'table', header, rows });
      continue;
    }
    para.push(trimmed);
    i++;
  }
  flush();
  return out;
}

/** Parses a markdown manuscript. Throws when it has no title or no `##` sections. */
export function parseManuscript(text: string, opts: { filename?: string; personaName?: string } = {}): ParsedManuscript {
  const { meta: rawMeta, lists, body } = parseFrontMatter(text.replace(/\r\n/g, '\n'));
  const meta = toMeta(rawMeta, lists);
  const lines = body.split('\n');
  let title = meta.title ?? '';
  let subtitle = meta.subtitle ?? '';
  const sections: Array<{ title: string; lines: string[] }> = [];
  const preamble: string[] = [];
  for (const line of lines) {
    const h1 = /^#\s+(.*)$/.exec(line.trim());
    const h2 = /^##\s+(.*)$/.exec(line.trim());
    if (h1 && !sections.length) {
      if (!title) title = h1[1]!.trim();
      continue;
    }
    if (h2) {
      sections.push({ title: h2[1]!.trim(), lines: [] });
      continue;
    }
    if (sections.length) sections.at(-1)!.lines.push(line);
    else preamble.push(line);
  }
  if (!title && opts.filename) title = opts.filename.replace(/\.(md|markdown)$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  if (!title) throw new Error('the manuscript needs a title (front matter "title:" or a "# Title" line)');
  if (!sections.length) throw new Error('the manuscript needs at least one "## Section"');
  const pre = parseBlocks(preamble);
  if (!subtitle) {
    const first = pre.find((b) => b.t === 'p');
    if (first && first.t === 'p') subtitle = first.text;
  }
  const ids = sectionIds(sections.map((s) => s.title));
  const docSections: DocSection[] = sections.map((s, n) => ({
    id: ids[n]!,
    title: s.title.replace(/^bonus\s*[:\-–—]\s*/i, 'Bonus: '),
    kind: kindOf(s.title),
    blocks: parseBlocks(s.lines),
  }));
  return {
    meta,
    doc: {
      title: title.slice(0, 120),
      subtitle: subtitle.slice(0, 300),
      personaName: opts.personaName ?? '',
      sections: docSections,
      promised: meta.sections?.length ? meta.sections : docSections.filter((s) => s.kind !== 'credits').map((s) => s.title),
    },
  };
}
