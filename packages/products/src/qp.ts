import type { QcCheck } from '@troupe/agents';
import type { Db } from '@troupe/db';
import { json } from '@troupe/db';
import type { PdfInspection } from './inspect';
import type { Layout } from './layout';
import { blockStrings, docLinks, docStrings, PAGE_GEOMETRY, type PageSize, plainInline, type ProductDoc, titleMatches } from './model';

/**
 * QC stage QP (PRD §3.6 Products, FR-21.4): the files (the PDF opens, paper size, fonts embedded, file size, links),
 * the content (no placeholder text, TOC and page numbers right, no layout overflow, every promised section present,
 * the credits page), and light spelling. Severities follow FR-21.5: blockers can't be overridden; majors fail QP.
 */

export interface LinkChecker {
  readonly name: string;
  /** null = fine; else what's wrong with the URL. */
  check(url: string): Promise<string | null>;
}

/** Well-formed http(s)/mailto URLs pass; nothing goes on the network (tests and fake mode). */
export class SyntaxLinkChecker implements LinkChecker {
  readonly name = 'syntax-links';
  async check(url: string): Promise<string | null> {
    return linkSyntaxError(url);
  }
}

export function linkSyntaxError(url: string): string | null {
  if (/^mailto:[^@\s]+@[^@\s]+\.[^@\s]+$/i.test(url)) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return `unsupported link scheme ${u.protocol}`;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return `not a public host: ${u.hostname}`;
    if (/example\.(com|org|net)$|\.invalid$|\.test$/.test(u.hostname)) return `placeholder host ${u.hostname}`;
    return null;
  } catch {
    return 'malformed URL';
  }
}

/**
 * Live link checks (HEAD, then GET on 405) for external URLs. Links into the studio's own persona sites are checked
 * for syntax only: the site may be served by this very process or not be deployed yet.
 */
export class HttpLinkChecker implements LinkChecker {
  readonly name = 'http-links';
  constructor(
    private readonly ownHosts: readonly string[] = [],
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 8000,
  ) {}
  async check(url: string): Promise<string | null> {
    const syntax = linkSyntaxError(url);
    if (syntax || url.startsWith('mailto:')) return syntax;
    const host = new URL(url).hostname;
    if (host === 'localhost' || this.ownHosts.some((h) => host === h || host.endsWith(`.${h}`))) return null;
    for (const method of ['HEAD', 'GET'] as const) {
      try {
        const res = await this.fetchImpl(url, { method, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) TroupeHouse-LinkCheck/1.0' }, signal: AbortSignal.timeout(this.timeoutMs) });
        if ((res.status === 405 || res.status === 501) && method === 'HEAD') continue;
        // 401/403/429: the page exists but blocks robots (common on government and shop sites). 404/410/5xx are broken.
        return res.status < 400 || res.status === 401 || res.status === 403 || res.status === 429 ? null : `HTTP ${res.status}`;
      } catch (err) {
        if (method === 'GET') return `unreachable (${(err as Error).name})`;
      }
    }
    return 'unreachable';
  }
}

/** Placeholder text a finished product must never contain. */
export const PLACEHOLDER_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /lorem ipsum|dolor sit amet/i, label: 'lorem ipsum' },
  { re: /\bTODO\b|\bFIXME\b|\bTBD\b|\bTBC\b/, label: 'TODO/TBD' },
  { re: /\bXXX+\b/, label: 'XXX' },
  { re: /\[(?:insert|add|your|name|placeholder|todo|tk|link|image|photo)[^\]]*\](?!\()/i, label: '[insert …]' },
  { re: /\{\{[^}]*\}\}|<<[^>]*>>/, label: '{{template}}' },
  { re: /<\s*(?:placeholder|insert)[^>]*>/i, label: '<placeholder>' },
  { re: /\bplaceholder\b|\bcoming soon\b|\b(?:text|copy|content) (?:goes )?here\b/i, label: 'placeholder wording' },
];

export interface QpInput {
  readonly doc: ProductDoc;
  readonly renders: ReadonlyArray<{ readonly size: PageSize; readonly layout: Layout; readonly html: string; readonly pdf: PdfInspection; readonly overflowPages: readonly number[] }>;
  readonly links?: LinkChecker;
  /** Largest acceptable PDF (Lemon Squeezy and email delivery). */
  readonly maxBytes?: number;
}

export interface QpResult {
  readonly pass: boolean;
  readonly score: number;
  readonly checks: QcCheck[];
  /** Failures the content writer can fix (fed back to the product-builder agent). */
  readonly contentFeedback: string[];
  /** Overflowing pages per size (the layout can fix these). */
  readonly overflow: boolean;
}

const MAX_BYTES = 25 * 1024 * 1024;

export async function runQp(input: QpInput): Promise<QpResult> {
  const checks: QcCheck[] = [];
  const feedback: string[] = [];
  const add = (c: QcCheck, fb?: string) => {
    checks.push(c);
    if (!c.pass && fb) feedback.push(fb);
  };
  const { doc } = input;

  // ── Files ──
  for (const r of input.renders) {
    const p = r.pdf;
    add({ check: 'pdf_opens', pass: p.opens, severity: 'blocker', message: p.opens ? `${r.size}: opens (PDF ${p.version}, ${p.pages} pages)` : `${r.size}: the PDF doesn't open: ${p.error}`, location: r.size });
    if (!p.opens) continue;
    const [w, h] = PAGE_GEOMETRY[r.size].pt;
    const sizeOk = !!p.mediaBox && Math.abs(p.mediaBox[0] - w) < 2 && Math.abs(p.mediaBox[1] - h) < 2;
    add({ check: 'page_size', pass: sizeOk, severity: 'major', message: sizeOk ? `${r.size}: paper size right` : `${r.size}: paper is ${p.mediaBox?.map((n) => n.toFixed(0)).join('×') ?? 'unknown'} pt, expected ${w.toFixed(0)}×${h.toFixed(0)}`, location: r.size });
    const unembedded = p.fonts.filter((f) => !f.embedded).map((f) => f.name);
    add({ check: 'fonts_embedded', pass: p.fonts.length > 0 && !unembedded.length, severity: 'blocker', message: !p.fonts.length ? `${r.size}: no fonts found` : unembedded.length ? `${r.size}: fonts not embedded: ${unembedded.join(', ')}` : `${r.size}: ${p.fonts.length} fonts, all embedded`, location: r.size });
    const max = input.maxBytes ?? MAX_BYTES;
    add({ check: 'file_size', pass: p.bytes > 1024 && p.bytes <= max, severity: 'major', message: `${r.size}: ${(p.bytes / 1024).toFixed(0)} KB${p.bytes > max ? ` (over ${(max / 1048576).toFixed(0)} MB)` : ''}`, location: r.size });
    const pagesOk = p.pages === r.layout.pages.length;
    add({ check: 'page_count', pass: pagesOk, severity: 'major', message: pagesOk ? `${r.size}: ${p.pages} pages as laid out` : `${r.size}: the PDF has ${p.pages} pages, the layout ${r.layout.pages.length} (page numbers and TOC would be wrong)`, location: r.size });
  }

  // ── Content: placeholder text ──
  const strings = docStrings(doc);
  const hits: string[] = [];
  for (const s of strings) for (const p of PLACEHOLDER_PATTERNS) if (p.re.test(s)) hits.push(`${p.label}: "${plainInline(s).slice(0, 60)}"`);
  const secOf = (needle: string) => doc.sections.find((sec) => sec.title === needle || sec.blocks.some((b) => blockStrings(b).includes(needle)))?.title;
  add(
    { check: 'no_placeholder', pass: !hits.length, severity: 'blocker', message: hits.length ? `placeholder text: ${hits.slice(0, 5).join('; ')}` : 'no placeholder text', location: hits.length ? secOf(strings.find((s) => PLACEHOLDER_PATTERNS.some((p) => p.re.test(s)))!) : undefined },
    hits.length ? `Replace every placeholder with finished text (${hits.slice(0, 5).join('; ')}).` : undefined,
  );

  // ── Every promised section is present (and has content) ──
  const titles = doc.sections.map((s) => s.title);
  const missing = doc.promised.filter((p) => !titles.some((t) => titleMatches(p, t)));
  add({ check: 'sections_present', pass: !missing.length, severity: 'blocker', message: missing.length ? `missing promised sections: ${missing.join('; ')}` : `all ${doc.promised.length} promised sections present` }, missing.length ? `Add the promised sections, titled exactly: ${missing.join('; ')}.` : undefined);
  const empty = doc.sections.filter((s) => !s.blocks.some((b) => b.t !== 'pagebreak'));
  add({ check: 'sections_have_content', pass: !empty.length, severity: 'major', message: empty.length ? `empty sections: ${empty.map((s) => s.title).join('; ')}` : 'every section has content' }, empty.length ? `Write the content of: ${empty.map((s) => s.title).join('; ')}.` : undefined);

  // ── Credits page (workbook-builder skill) ──
  const credits = doc.sections.find((s) => s.kind === 'credits');
  const creditsText = credits ? credits.blocks.flatMap(blockStrings).join(' ') : '';
  const creditsOk = /AI character/i.test(creditsText) && /not professional advice/i.test(creditsText);
  add({ check: 'credits_page', pass: creditsOk, severity: 'blocker', message: creditsOk ? 'credits page: AI character, not professional advice, referral' : 'the credits page must say it was created by an AI character and is general education, not professional advice' });

  // ── TOC and page numbers ──
  for (const r of input.renders) {
    const { layout, html } = r;
    const starts = new Map(layout.pages.filter((p) => p.sectionStart).map((p) => [p.sectionStart!.id, p.number]));
    const wrong = layout.toc.filter((e) => starts.get(e.id) !== e.page);
    const tocInHtml = [...html.matchAll(/data-toc-page="(\d+)"/g)].map((m) => Number(m[1]));
    const htmlOk = tocInHtml.length === layout.toc.length && tocInHtml.every((n, i) => n === layout.toc[i]!.page);
    const needsToc = layout.pages.length > 8 || doc.sections.length >= 3;
    const hasToc = layout.pages.some((p) => p.kind === 'toc');
    const linksOk = !hasToc || r.pdf.internalLinks >= layout.toc.length;
    const tocOk = (!needsToc || hasToc) && !wrong.length && htmlOk && linksOk;
    add({
      check: 'toc',
      pass: tocOk,
      severity: 'major',
      message: tocOk
        ? `${r.size}: contents lists ${layout.toc.length} sections with the right pages and working links`
        : `${r.size}: ${needsToc && !hasToc ? 'no table of contents; ' : ''}${wrong.length ? `wrong pages for ${wrong.map((w) => w.title).join(', ')}; ` : ''}${!htmlOk ? 'printed page numbers differ; ' : ''}${!linksOk ? `${r.pdf.internalLinks}/${layout.toc.length} contents links work` : ''}`.replace(/;\s*$/, ''),
      location: r.size,
    });
    const footers = [...html.matchAll(/data-pn="(\d+)"/g)].map((m) => Number(m[1]));
    const expected = layout.pages.filter((p) => p.kind !== 'cover').map((p) => p.number);
    const pnOk = footers.length === expected.length && footers.every((n, i) => n === expected[i]) && expected.every((n, i) => n === i + 2);
    add({ check: 'page_numbers', pass: pnOk, severity: 'major', message: pnOk ? `${r.size}: pages numbered 2–${layout.pages.length}` : `${r.size}: page numbers out of sequence`, location: r.size });
    add({ check: 'layout_overflow', pass: !r.overflowPages.length, severity: 'major', message: r.overflowPages.length ? `${r.size}: content runs off page ${r.overflowPages.join(', ')}` : `${r.size}: nothing runs off a page`, location: r.overflowPages.length ? `${r.size} p.${r.overflowPages.join(',')}` : r.size });
  }

  // ── Links ──
  const links = docLinks(doc);
  const checker = input.links ?? new SyntaxLinkChecker();
  const bad: string[] = [];
  for (const url of links) {
    const err = await checker.check(url);
    if (err) bad.push(`${url} (${err})`);
  }
  const external = links.filter((u) => /^(https?:|mailto:)/i.test(u));
  const notInPdf = input.renders.flatMap((r) => (r.pdf.opens ? external.filter((u) => !r.pdf.uris.includes(u)).map((u) => `${r.size}: ${u}`) : []));
  add(
    {
      check: 'links',
      pass: !bad.length && !notInPdf.length,
      severity: 'major',
      message: bad.length ? `broken links: ${bad.join('; ')}` : notInPdf.length ? `links not clickable in the PDF: ${notInPdf.join('; ')}` : `${links.length} links, all working`,
    },
    bad.length ? `Fix or remove these links: ${bad.join('; ')}.` : undefined,
  );

  // ── Spelling (light, minor) ──
  const doubled = [...new Set(strings.flatMap((s) => [...plainInline(s).matchAll(/\b([A-Za-z]{2,})\s+\1\b/gi)].map((m) => m[0])))];
  add({ check: 'spelling', pass: !doubled.length, severity: 'minor', message: doubled.length ? `doubled words: ${doubled.slice(0, 5).join(', ')}` : 'no doubled words' }, doubled.length ? `Fix doubled words: ${doubled.slice(0, 5).join(', ')}.` : undefined);

  const failing = checks.filter((c) => !c.pass);
  const score = Math.max(0, 100 - failing.reduce((a, c) => a + (c.severity === 'blocker' ? 30 : c.severity === 'major' ? 10 : 2), 0));
  return {
    pass: !failing.some((c) => c.severity !== 'minor'),
    score,
    checks,
    contentFeedback: feedback,
    overflow: input.renders.some((r) => r.overflowPages.length > 0),
  };
}

/** Stores the QP report (qc_report subject 'product', stage 'QP') and mirrors failures into qc_defect. */
export async function saveQpReport(
  db: Db,
  args: { personaId: string; productId: string; version: number; result: QpResult; extra?: Record<string, unknown> },
): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO qc_report (persona_id, subject_type, subject_id, stage, score, pass, details) VALUES ($1, 'product', $2, 'QP', $3, $4, $5::jsonb) RETURNING id`,
    [args.personaId, args.productId, args.result.score, args.result.pass, json({ checks: args.result.checks, version: args.version, ...(args.extra ?? {}) })],
  );
  for (const c of args.result.checks.filter((x) => !x.pass)) {
    await db.query(`INSERT INTO qc_defect (qc_report_id, persona_id, type, severity, location, fix_action) VALUES ($1, $2, $3, $4, $5, $6)`, [
      row.id,
      args.personaId,
      c.check,
      c.severity,
      c.location ?? null,
      c.message.slice(0, 500),
    ]);
  }
  return row.id;
}
