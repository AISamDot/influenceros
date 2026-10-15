/**
 * A small structural PDF reader for QP: does the file open (header, objects, xref/startxref, EOF, a catalog), how many
 * pages and at what size, which fonts and whether each is embedded, and which links it carries. It reads the object
 * dictionaries only (Chrome/Skia writes them uncompressed); content streams are never decoded.
 */
export interface PdfFont {
  readonly name: string;
  readonly embedded: boolean;
}

export interface PdfInspection {
  readonly opens: boolean;
  readonly error: string | null;
  readonly version: string | null;
  readonly pages: number;
  /** MediaBox of the first page, in points. */
  readonly mediaBox: readonly [number, number] | null;
  readonly fonts: readonly PdfFont[];
  readonly uris: readonly string[];
  /** Link annotations that jump inside the document (GoTo / Dest): the TOC. */
  readonly internalLinks: number;
  readonly bytes: number;
  readonly title: string | null;
}

interface PdfObject {
  readonly num: number;
  readonly dict: string;
}

const unescapePdf = (s: string) =>
  s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c: string) =>
    ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' })[c] ?? String.fromCharCode(parseInt(c, 8)),
  );

function objects(text: string): PdfObject[] {
  const out: PdfObject[] = [];
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const streamAt = text.indexOf('stream', start);
    const endAt = text.indexOf('endobj', start);
    if (endAt < 0) break;
    const dictEnd = streamAt >= 0 && streamAt < endAt ? streamAt : endAt;
    out.push({ num: Number(m[1]), dict: text.slice(start, dictEnd) });
    if (streamAt >= 0 && streamAt < endAt) {
      // Skip the stream body: its bytes may contain anything.
      const end = text.indexOf('endstream', streamAt);
      re.lastIndex = end >= 0 ? end : endAt;
    } else {
      re.lastIndex = endAt;
    }
  }
  return out;
}

const STANDARD_14 = /^(Times-|Helvetica|Courier|Symbol|ZapfDingbats)/;

export function inspectPdf(data: Uint8Array): PdfInspection {
  const bytes = data.byteLength;
  const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('latin1');
  const fail = (error: string): PdfInspection => ({ opens: false, error, version: null, pages: 0, mediaBox: null, fonts: [], uris: [], internalLinks: 0, bytes, title: null });
  const header = /^%PDF-(\d\.\d)/.exec(text.slice(0, 1024));
  if (!header) return fail('not a PDF (no %PDF header)');
  if (!/%%EOF\s*$/.test(text.slice(-2048))) return fail('truncated PDF (no %%EOF)');
  if (!/startxref\s+\d+/.test(text.slice(-4096))) return fail('no cross-reference table');
  const objs = objects(text);
  if (!objs.length) return fail('no objects');
  const byNum = new Map(objs.map((o) => [o.num, o]));
  if (!objs.some((o) => /\/Type\s*\/Catalog\b/.test(o.dict))) return fail('no document catalog');

  const pageObjs = objs.filter((o) => /\/Type\s*\/Page(?![a-zA-Z])/.test(o.dict));
  const counts = objs.map((o) => /\/Type\s*\/Pages\b[\s\S]*?\/Count\s+(\d+)|\/Count\s+(\d+)[\s\S]*?\/Type\s*\/Pages\b/.exec(o.dict)).filter(Boolean);
  const rootCount = Math.max(0, ...counts.map((m) => Number(m![1] ?? m![2])));
  const pages = Math.max(pageObjs.length, rootCount);
  if (!pages) return fail('no pages');

  const mb = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(pageObjs[0]?.dict ?? '') ?? /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(text);
  const mediaBox = mb ? ([Number(mb[3]) - Number(mb[1]), Number(mb[4]) - Number(mb[2])] as const) : null;

  // Fonts: every simple/CID font names its FontDescriptor; a descriptor with FontFile/FontFile2/FontFile3 is embedded.
  const fonts = new Map<string, boolean>();
  for (const o of objs) {
    if (!/\/Type\s*\/Font\b/.test(o.dict)) continue;
    const sub = /\/Subtype\s*\/(\w+)/.exec(o.dict)?.[1] ?? '';
    if (sub === 'Type0' || sub === 'Type3') continue; // Type0 → its descendant CIDFont is listed itself; Type3 is drawn inline
    const name = /\/BaseFont\s*\/([^\s/<>[\]()]+)/.exec(o.dict)?.[1] ?? `font-${o.num}`;
    const ref = /\/FontDescriptor\s+(\d+)\s+\d+\s+R/.exec(o.dict);
    const desc = ref ? byNum.get(Number(ref[1])) : undefined;
    const embedded = !!desc && /\/FontFile[23]?\s+\d+\s+\d+\s+R/.test(desc.dict);
    fonts.set(name, (fonts.get(name) ?? false) || embedded);
  }
  const uris = [...text.matchAll(/\/URI\s*\(((?:\\.|[^\\)])*)\)/g)].map((m) => unescapePdf(m[1]!));
  const internalLinks = objs.filter((o) => /\/Subtype\s*\/Link\b/.test(o.dict) && (/\/Dest\b/.test(o.dict) || /\/S\s*\/GoTo\b/.test(o.dict))).length;
  const title = /\/Title\s*\(((?:\\.|[^\\)])*)\)/.exec(text)?.[1];
  return {
    opens: true,
    error: null,
    version: header[1]!,
    pages,
    mediaBox,
    fonts: [...fonts].map(([name, embedded]) => ({ name, embedded: embedded || false })),
    uris,
    internalLinks,
    bytes,
    title: title ? unescapePdf(title) : null,
  };
}

export const isStandard14 = (font: string) => STANDARD_14.test(font);
