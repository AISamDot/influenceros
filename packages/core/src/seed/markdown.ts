/**
 * Small, dependency-free Markdown readers for the launch-persona documents (bible, content plan, Field Brain seed).
 * They are tolerant by design: the Persona Architect's files vary in table layouts and headings, so every reader
 * keys off header names and falls back to "nothing found" rather than throwing.
 */

export interface MdSection {
  readonly title: string;
  readonly body: string;
}

export interface MdTable {
  readonly header: string[];
  readonly rows: string[][];
}

/** Splits `md` at headings of exactly `level` (2 = `##`). Text before the first heading is returned as `intro`. */
export function splitSections(md: string, level: number): { intro: string; sections: MdSection[] } {
  const marker = '#'.repeat(level);
  const re = new RegExp(`^${marker}\\s+(.+?)\\s*$`);
  const lines = md.split(/\r?\n/);
  const sections: Array<{ title: string; lines: string[] }> = [];
  const intro: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = !inFence ? re.exec(line) : null;
    if (m && !line.startsWith(`${marker}#`)) {
      sections.push({ title: m[1]!, lines: [] });
      continue;
    }
    (sections.at(-1)?.lines ?? intro).push(line);
  }
  return { intro: intro.join('\n').trim(), sections: sections.map((s) => ({ title: s.title, body: s.lines.join('\n').trim() })) };
}

/** Strips inline Markdown (bold, italics, code, links) and collapses whitespace. */
export function cleanInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function firstUrl(s: string): string | null {
  const m = /https?:\/\/[^\s|)>\]`"'*]+/.exec(s);
  return m ? m[0].replace(/[.,;:]+$/, '') : null;
}

export function slugify(s: string, max = 60): string {
  const slug = cleanInline(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, max).replace(/-+$/g, '') || 'item';
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  // Split on pipes that are not escaped and not inside inline code.
  const cells: string[] = [];
  let cur = '';
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '`') code = !code;
    if (c === '|' && !code && s[i - 1] !== '\\') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const isDivider = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/** Every pipe table in `md`, in order. Header cells are cleaned; body cells are kept raw (callers clean them). */
export function parseTables(md: string): MdTable[] {
  const lines = md.split(/\r?\n/);
  const tables: MdTable[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i]!.trim().startsWith('|') || !isDivider(lines[i + 1]!)) continue;
    const header = splitRow(lines[i]!).map(cleanInline);
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j]!.trim().startsWith('|'); j++) rows.push(splitRow(lines[j]!));
    tables.push({ header, rows });
    i = j - 1;
  }
  return tables;
}

/** Index of the first header matching `re`, or -1. */
export function col(header: readonly string[], re: RegExp, exclude: readonly number[] = []): number {
  return header.findIndex((h, i) => !exclude.includes(i) && re.test(h));
}

export type MdValue = string | MdValue[] | { [key: string]: MdValue };

/**
 * Converts a block of Markdown into plain JSON the dashboard's profile renderer shows well:
 * a two-column "Field | Value" table becomes an object, other tables become arrays of row objects, bullet lists
 * become string arrays, paragraphs become strings, and `###` subsections become keys. Nothing is dropped.
 */
export function mdToValue(md: string): MdValue {
  const { intro, sections } = splitSections(md, 3);
  if (!sections.length) return blockToValue(md);
  const out: Record<string, MdValue> = {};
  const introValue = intro ? blockToValue(intro) : '';
  if (introValue !== '' && !(Array.isArray(introValue) && !introValue.length)) out.overview = introValue;
  for (const s of sections) {
    let key = cleanInline(s.title) || 'section';
    while (key in out) key = `${key} (cont.)`;
    out[key] = blockToValue(s.body);
  }
  return out;
}

type Piece = { kind: 'text'; text: string } | { kind: 'list'; items: string[] } | { kind: 'table'; value: MdValue } | { kind: 'code'; text: string };

function tableValue(t: MdTable): MdValue {
  const cleanRows = t.rows.map((r) => r.map(cleanInline));
  if (t.header.length === 2 && /^(field|item|key|what|setting|decision|value|platform)?$/i.test(t.header[0] ?? '')) {
    const obj: Record<string, MdValue> = {};
    for (const r of cleanRows) if (r[0]) obj[r[0]] = r[1] ?? '';
    return obj;
  }
  return cleanRows.map((r) => {
    const obj: Record<string, MdValue> = {};
    t.header.forEach((h, i) => {
      const key = h || (i === 0 ? 'item' : `col ${i + 1}`);
      if ((r[i] ?? '') !== '') obj[key] = r[i] ?? '';
    });
    return obj;
  });
}

function blockToValue(md: string): MdValue {
  const pieces: Piece[] = [];
  const lines = md.split(/\r?\n/);
  let para: string[] = [];
  const flush = () => {
    const text = cleanInline(para.join(' '));
    if (text && !/^-{3,}$/.test(text)) pieces.push({ kind: 'text', text });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      pieces.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && isDivider(lines[i + 1]!)) {
      flush();
      let j = i;
      while (j < lines.length && lines[j]!.trim().startsWith('|')) j++;
      const [t] = parseTables(lines.slice(i, j).join('\n'));
      if (t) pieces.push({ kind: 'table', value: tableValue(t) });
      i = j - 1;
      continue;
    }
    const li = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const nested = li[1]!.length >= 2;
      const text = cleanInline(li[2]!);
      const last = pieces.at(-1);
      if (last?.kind === 'list') last.items.push(nested ? `– ${text}` : text);
      else pieces.push({ kind: 'list', items: [text] });
      continue;
    }
    if (!line.trim() || /^-{3,}\s*$/.test(line.trim()) || /^#{1,6}\s/.test(line)) {
      flush();
      if (/^#{4,6}\s/.test(line)) pieces.push({ kind: 'text', text: cleanInline(line.replace(/^#+\s*/, '')) });
      continue;
    }
    if (/^\s*>/.test(line)) {
      para.push(line.replace(/^\s*>\s?/, ''));
      continue;
    }
    // A continuation line of a list item (indented text) joins the previous item.
    const last = pieces.at(-1);
    if (!para.length && last?.kind === 'list' && /^\s{2,}\S/.test(line)) {
      last.items[last.items.length - 1] += ` ${cleanInline(line)}`;
      continue;
    }
    para.push(line);
  }
  flush();
  if (!pieces.length) return '';
  if (pieces.length === 1) {
    const p = pieces[0]!;
    return p.kind === 'list' ? p.items : p.kind === 'table' ? p.value : p.text;
  }
  if (pieces.every((p) => p.kind === 'text' || p.kind === 'code')) return pieces.map((p) => (p as { text: string }).text).join('\n\n');
  const out: Record<string, MdValue> = {};
  const add = (key: string, v: MdValue) => {
    let k = key;
    for (let n = 2; k in out; n++) k = `${key} ${n}`;
    out[k] = v;
  };
  let notes: string[] = [];
  const flushNotes = () => {
    if (notes.length) add('notes', notes.join('\n\n'));
    notes = [];
  };
  for (const p of pieces) {
    if (p.kind === 'text' || p.kind === 'code') {
      notes.push(p.text);
      continue;
    }
    flushNotes();
    if (p.kind === 'list') add('points', p.items);
    else add('table', p.value);
  }
  flushNotes();
  return out;
}
