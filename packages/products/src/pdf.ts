import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Layout } from './layout';
import { blockStrings, inlineLinks, PAGE_GEOMETRY, plainInline } from './model';

/**
 * HTML → PDF behind an interface (docs/IOS-34-CONTRACTS.md §5.3: local tooling stays in the owning package, with a
 * fake). The live renderer is headless Chrome (`--print-to-pdf`, the system Chrome/Chromium/Edge/Brave or
 * IOS_CHROME_PATH); the fake writes a small valid PDF with the same pages and links, so tests never need a browser.
 */
export interface PdfRenderRequest {
  readonly html: string;
  readonly layout: Layout;
  readonly title: string;
}
export interface PdfRenderResult {
  readonly pdf: Uint8Array;
  /** Page numbers whose body overflowed its box (Chrome measures; the fake reports what it was told to). */
  readonly overflowPages: readonly number[];
}
export interface PdfRenderer {
  readonly name: string;
  render(req: PdfRenderRequest): Promise<PdfRenderResult>;
}

// ───────────────────────────── headless Chrome ─────────────────────────────

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** The browser binary: IOS_CHROME_PATH, else the first installed candidate, else null. */
export function findChrome(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const configured = env.IOS_CHROME_PATH?.trim();
  if (configured) return existsSync(configured) ? configured : null;
  return CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

function run(bin: string, args: readonly string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, [...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env } }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(`${bin.split('/').pop()} failed: ${err.message.split('\n')[0]}`), { stderr }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export class ChromePdfRenderer implements PdfRenderer {
  readonly name = 'chrome-pdf';
  constructor(
    readonly bin: string,
    private readonly timeoutMs = 120_000,
  ) {}

  async render(req: PdfRenderRequest): Promise<PdfRenderResult> {
    const dir = await mkdtemp(join(tmpdir(), 'ios-pdf-'));
    try {
      const html = join(dir, 'product.html');
      const out = join(dir, 'product.pdf');
      await writeFile(html, req.html);
      const url = pathToFileURL(html).href;
      const common = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', `--user-data-dir=${join(dir, 'profile')}`];
      // 1. Measure: the page script writes overflowing pages onto <body data-overflow>.
      const dom = await run(this.bin, [...common, '--virtual-time-budget=5000', '--dump-dom', url], this.timeoutMs);
      const m = /data-overflow="([^"]*)"/.exec(dom.stdout);
      const overflowPages = (m?.[1] ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
      // 2. Print. The CSS @page size (A4 / letter) sets the paper; no header/footer from Chrome itself.
      await run(this.bin, [...common, '--no-pdf-header-footer', '--run-all-compositor-stages-before-draw', '--virtual-time-budget=5000', `--print-to-pdf=${out}`, url], this.timeoutMs);
      return { pdf: new Uint8Array(await readFile(out)), overflowPages };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

// ───────────────────────────── fake ─────────────────────────────

/** Escapes a PDF literal string (ASCII only: the fake writes plain text). */
const pdfStr = (s: string) => `(${s.replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1')})`;

export interface FakePdfOptions {
  /** Declare fonts as embedded (FontFile2), like Chrome does. false = an unembedded standard font. */
  embedFonts?: boolean;
  /** Pages to report as overflowing, for the first `overflowTimes` renders. */
  overflowPages?: readonly number[];
  overflowTimes?: number;
  /** Write garbage instead of a PDF. */
  corrupt?: boolean;
  /** Drop link annotations (a "links don't work" PDF). */
  dropLinks?: boolean;
  /** Add (or remove) pages compared to the layout. */
  pageDelta?: number;
}

/**
 * A deterministic, valid PDF: one page per layout page at the right paper size, the visible text of each page, URI
 * link annotations for every external link and GoTo links from the TOC. It declares an embedded TrueType font with a
 * stub font program: it's a fake (nothing ships from fake mode), but QP inspects it exactly like Chrome's output.
 */
export class FakePdfRenderer implements PdfRenderer {
  readonly name = 'fake-pdf';
  readonly calls: Array<{ title: string; size: string; pages: number }> = [];
  constructor(private readonly opts: FakePdfOptions = {}) {}

  async render(req: PdfRenderRequest): Promise<PdfRenderResult> {
    this.calls.push({ title: req.title, size: req.layout.size, pages: req.layout.pages.length });
    const overflowPages = this.opts.overflowPages && this.calls.length <= (this.opts.overflowTimes ?? Infinity) ? this.opts.overflowPages : [];
    if (this.opts.corrupt) return { pdf: new TextEncoder().encode('<html>not a pdf</html>'), overflowPages };
    return { pdf: writeFakePdf(req, this.opts), overflowPages };
  }
}

function writeFakePdf(req: PdfRenderRequest, opts: FakePdfOptions): Uint8Array {
  const [W, H] = PAGE_GEOMETRY[req.layout.size].pt;
  const pages = req.layout.pages.slice(0, Math.max(1, req.layout.pages.length + Math.min(0, opts.pageDelta ?? 0)));
  const extra = Math.max(0, opts.pageDelta ?? 0);
  const objs: string[] = []; // 1-based object bodies
  const add = (body: string) => objs.push(body) as number; // returns the object number
  const catalog = add('');
  const pagesObj = add('');
  const font = add('');
  const embed = opts.embedFonts !== false;
  if (embed) {
    const program = 'FAKE-TRUETYPE-PROGRAM';
    const file = add(`<< /Length ${program.length} >>\nstream\n${program}\nendstream`);
    const desc = add(`<< /Type /FontDescriptor /FontName /AAAAAA+FakeSans /Flags 32 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 ${file} 0 R >>`);
    objs[font - 1] = `<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+FakeSans /FirstChar 32 /LastChar 126 /Widths [${Array(95).fill(500).join(' ')}] /FontDescriptor ${desc} 0 R /Encoding /WinAnsiEncoding >>`;
  } else {
    objs[font - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  }
  const pageNums: number[] = [];
  const all = [...pages, ...Array.from({ length: extra }, (_, i) => ({ number: pages.length + i + 1, kind: 'content' as const, blocks: [] }))];
  // Reserve page object numbers first so TOC links can point forward.
  for (let i = 0; i < all.length; i++) pageNums.push(add(''));
  const sectionPage = new Map<string, number>();
  for (const [i, p] of all.entries()) if ('sectionStart' in p && p.sectionStart) sectionPage.set(p.sectionStart.id, i);
  for (const [i, p] of all.entries()) {
    const text: string[] = [];
    if (p.kind === 'cover') text.push(req.title);
    if (p.kind === 'toc') text.push('Contents', ...req.layout.toc.map((e) => `${e.title} .... ${e.page}`));
    if ('sectionStart' in p && p.sectionStart) text.push(p.sectionStart.title);
    for (const b of p.blocks) text.push(...blockStrings(b).map(plainInline));
    if (p.kind !== 'cover') text.push(`${p.number} / ${all.length}`);
    const ops = text
      .slice(0, 60)
      .map((t, k) => `BT /F1 10 Tf 50 ${(H - 60 - k * 13).toFixed(0)} Td ${pdfStr(t.slice(0, 110))} Tj ET`)
      .join('\n');
    const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    const annots: number[] = [];
    if (!opts.dropLinks) {
      const links = p.blocks.flatMap((b) => blockStrings(b).flatMap(inlineLinks)).filter((u) => /^(https?:|mailto:)/i.test(u));
      for (const [k, url] of links.entries()) annots.push(add(`<< /Type /Annot /Subtype /Link /Rect [50 ${100 + k * 14} 300 ${112 + k * 14}] /Border [0 0 0] /A << /S /URI /URI ${pdfStr(url)} >> >>`));
      if (p.kind === 'toc') {
        for (const [k, e] of req.layout.toc.entries()) {
          const target = sectionPage.get(e.id);
          if (target !== undefined) annots.push(add(`<< /Type /Annot /Subtype /Link /Rect [50 ${H - 90 - k * 13} 500 ${H - 78 - k * 13}] /Border [0 0 0] /Dest [${pageNums[target]} 0 R /XYZ 0 ${H} 0] >>`));
        }
      }
    }
    objs[pageNums[i]! - 1] =
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R${annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>`;
  }
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageNums.length} >>`;
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  const info = add(`<< /Title ${pdfStr(req.title)} /Producer (Influencer OS fake-pdf) >>`);
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  for (const [i, body] of objs.entries()) {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/** Thrown when no browser is installed outside fake mode: the build defers instead of shipping a fake PDF. */
export class PdfRendererUnavailableError extends Error {
  override readonly name = 'PdfRendererUnavailableError';
}

class UnavailablePdfRenderer implements PdfRenderer {
  readonly name = 'unavailable';
  async render(): Promise<PdfRenderResult> {
    throw new PdfRendererUnavailableError('no headless Chrome on this machine: install Google Chrome (or Chromium/Edge/Brave) or set IOS_CHROME_PATH; product builds run on the Mac worker');
  }
}

/**
 * The renderer to use: the fake under IOS_FAKE_PROVIDERS=1 (tests) or IOS_PRODUCTS_PDF=fake; otherwise headless
 * Chrome (a local binary, not a paid provider, so no key). Without a browser, renders throw
 * PdfRendererUnavailableError and the build waits (never a fake PDF outside fake mode).
 */
export function defaultPdfRenderer(env: Readonly<Record<string, string | undefined>> = process.env): PdfRenderer {
  if (env.IOS_FAKE_PROVIDERS === '1' || env.IOS_PRODUCTS_PDF === 'fake') return new FakePdfRenderer();
  const bin = findChrome(env);
  return bin ? new ChromePdfRenderer(bin) : new UnavailablePdfRenderer();
}
