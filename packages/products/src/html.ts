import type { PersonaKit } from '@troupe/agents';
import type { Layout, LayoutPage } from './layout';
import { type Block, PAGE_GEOMETRY, type ProductDoc } from './model';

/**
 * Styled HTML in the persona's visual identity (PersonaKit colours), one fixed-size `.page` per layout page, so the
 * printed PDF has exactly the layout's pages, page numbers and TOC. Headless Chrome prints it (pdf.ts); the
 * embedded script marks overflowing pages on <body data-overflow> for the overflow check (Chrome --dump-dom).
 */

export type KitColors = PersonaKit['colors'];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SAFE_URL = /^(https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+)$/i;

/** Inline markdown-lite → HTML. Only http(s) and mailto links become anchors. */
export function inline(s: string): string {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    out += fmt(s.slice(last, m.index));
    const url = m[2]!;
    out += SAFE_URL.test(url) ? `<a href="${esc(url)}">${fmt(m[1]!)}</a>` : fmt(m[1]!);
    last = m.index! + m[0].length;
  }
  return out + fmt(s.slice(last));
}
function fmt(s: string): string {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}
function relLum(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [relLum(a), relLum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
const mix = (hex: string, toward: string, t: number): string => {
  const a = hexToRgb(hex);
  const b = hexToRgb(toward);
  return `#${a.map((v, i) => Math.round((v + (b[i]! - v) * t) * 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
};

/** Print-safe picks: white pages, ink text with AA contrast, accents darkened until they read as text. */
export function printPalette(c: KitColors): { paper: string; ink: string; accent: string; accentText: string; accent2: string; tint: string; cover: string; coverInk: string } {
  const ink = contrast(c.ink, '#FFFFFF') >= 7 ? c.ink : '#1C1A17';
  let accentText = c.accent;
  for (let i = 0; i < 10 && contrast(accentText, '#FFFFFF') < 4.5; i++) accentText = mix(accentText, ink, 0.2);
  const cover = c.bg;
  const coverInk = contrast(ink, cover) >= 4.5 ? ink : '#FFFFFF';
  return { paper: '#FFFFFF', ink, accent: c.accent, accentText, accent2: c.accent2, tint: mix(c.bg, '#FFFFFF', 0.35), cover, coverInk };
}

function blockHtml(b: Block): string {
  switch (b.t) {
    case 'p':
      return `<p>${inline(b.text)}</p>`;
    case 'h':
      return `<h3>${inline(b.text)}</h3>`;
    case 'list':
      return `<${b.ordered ? 'ol' : 'ul'} class="list">${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${b.ordered ? 'ol' : 'ul'}>`;
    case 'rule':
      return `<div class="rule"><div class="label">Rule · ${inline(b.name)}</div><p>${inline(b.text)}</p></div>`;
    case 'example':
      return `<div class="example"><div class="label">Example · ${inline(b.title)}</div>${b.text
        .split(/\n{2,}/)
        .map((t) => `<p>${inline(t)}</p>`)
        .join('')}</div>`;
    case 'callout':
      return `<blockquote class="callout">${inline(b.text)}</blockquote>`;
    case 'checklist':
      return `<div class="check">${b.title ? `<h4>${inline(b.title)}</h4>` : ''}<ul>${b.items.map((i) => `<li><span class="box" aria-hidden="true"></span><span>${inline(i)}</span></li>`).join('')}</ul></div>`;
    case 'tracker':
      return `<table class="tracker"><caption>${inline(b.title)}</caption><thead><tr><th></th>${b.columns.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${b.rows
        .map((r) => `<tr><th>${inline(r)}</th>${b.columns.map(() => '<td><span class="box" aria-hidden="true"></span></td>').join('')}</tr>`)
        .join('')}</tbody></table>`;
    case 'fillin':
      return `<div class="fill"><p class="prompt">${inline(b.prompt)}</p>${'<div class="line"></div>'.repeat(b.lines)}</div>`;
    case 'table':
      return `<table class="data"><thead><tr>${b.header.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${b.rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`;
    case 'pagebreak':
      return '';
  }
}

function css(size: Layout['size'], c: ReturnType<typeof printPalette>): string {
  const g = PAGE_GEOMETRY[size];
  return `
@page { size: ${size === 'A4' ? 'A4' : 'letter'}; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: ${c.paper}; color: ${c.ink}; }
body { font-family: 'Avenir Next', 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { width: ${g.w}mm; height: ${g.h}mm; position: relative; overflow: hidden; break-after: page; page-break-after: always; background: ${c.paper}; }
.page:last-of-type { break-after: auto; page-break-after: auto; }
.page-body { position: absolute; left: ${g.margin}mm; right: ${g.margin}mm; top: ${g.top}mm; bottom: ${g.bottom}mm; overflow: hidden; }
.foot { position: absolute; left: ${g.margin}mm; right: ${g.margin}mm; bottom: ${Math.max(8, g.bottom - 14)}mm; display: flex; justify-content: space-between; font-size: 8pt; color: ${c.accentText}; border-top: 0.4mm solid ${c.accent}; padding-top: 2mm; letter-spacing: 0.02em; }
h1, h2, h3, h4, .display { font-family: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif; font-weight: 600; line-height: 1.15; margin: 0; }
p { margin: 0 0 3mm; }
a { color: ${c.accentText}; text-decoration: underline; }
.sec-head { height: 26mm; margin-bottom: 4mm; border-bottom: 0.6mm solid ${c.accent}; display: flex; flex-direction: column; justify-content: flex-end; padding-bottom: 3mm; }
.sec-head .eyebrow { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.14em; color: ${c.accentText}; margin-bottom: 1.5mm; }
.sec-head h2 { font-size: 22pt; }
h3 { font-size: 13pt; margin: 2mm 0 3mm; color: ${c.accentText}; }
h4 { font-size: 11pt; margin: 0 0 2mm; }
.list { margin: 0 0 3mm; padding-left: 6mm; }
.list li { margin-bottom: 1.2mm; }
.rule, .example { border-left: 1.6mm solid ${c.accent}; background: ${c.tint}; padding: 4mm 5mm 3mm; margin: 0 0 4mm; border-radius: 0 2mm 2mm 0; }
.example { border-left-color: ${c.accent2}; }
.label { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.12em; color: ${c.accentText}; font-weight: 600; margin-bottom: 1.5mm; }
.callout { margin: 0 0 4mm; padding: 4mm 6mm; border: 0.4mm solid ${c.accent}; border-radius: 2mm; font-family: 'Iowan Old Style', Palatino, Georgia, serif; font-size: 12pt; }
.check { margin: 0 0 4mm; }
.check ul { list-style: none; margin: 0; padding: 0; }
.check li { display: flex; gap: 3mm; align-items: flex-start; min-height: 7.5mm; padding: 1mm 0; border-bottom: 0.2mm dotted ${c.accent}; }
.box { display: inline-block; flex: none; width: 4.2mm; height: 4.2mm; border: 0.45mm solid ${c.ink}; border-radius: 0.8mm; margin-top: 0.6mm; background: #fff; }
table { border-collapse: collapse; width: 100%; margin: 0 0 4mm; }
caption { text-align: left; font-family: 'Iowan Old Style', Palatino, Georgia, serif; font-weight: 600; font-size: 11pt; margin-bottom: 2mm; }
.tracker th, .tracker td { border: 0.3mm solid ${c.accent}; height: 8mm; padding: 1mm 2mm; font-size: 9pt; text-align: center; }
.tracker tbody th { text-align: left; font-weight: 500; width: 38%; }
.tracker thead th { background: ${c.tint}; }
.data th, .data td { border-bottom: 0.3mm solid ${c.accent}; padding: 1.5mm 2mm; text-align: left; vertical-align: top; font-size: 9.5pt; }
.data th { background: ${c.tint}; }
.fill { margin: 0 0 4mm; }
.fill .prompt { font-weight: 600; margin-bottom: 1mm; }
.fill .line { height: 9mm; border-bottom: 0.3mm solid ${c.accent}; }
.cover { background: ${c.cover}; color: ${c.coverInk}; }
.cover .band { position: absolute; left: 0; right: 0; top: 0; height: 12mm; background: ${c.accent}; }
.cover .band2 { position: absolute; left: 0; width: 40%; top: 12mm; height: 3mm; background: ${c.accent2}; }
.cover .inner { position: absolute; left: ${g.margin + 4}mm; right: ${g.margin + 4}mm; top: 70mm; }
.cover h1 { font-size: 34pt; margin-bottom: 8mm; }
.cover .promise { font-size: 14pt; line-height: 1.4; max-width: 140mm; }
.cover .by { position: absolute; left: ${g.margin + 4}mm; bottom: 26mm; font-size: 11pt; letter-spacing: 0.06em; }
.cover .by small { display: block; font-size: 8.5pt; opacity: 0.85; margin-top: 1.5mm; letter-spacing: 0.02em; }
.toc-list { list-style: none; margin: 0; padding: 0; }
.toc-list li { margin: 0 0 2.4mm; }
.toc-list a { display: flex; align-items: baseline; gap: 2mm; color: ${c.ink}; text-decoration: none; font-size: 11pt; }
.toc-list .dots { flex: 1; border-bottom: 0.3mm dotted ${c.accent}; transform: translateY(-1mm); }
.toc-list .pn { font-variant-numeric: tabular-nums; color: ${c.accentText}; }
code { font-family: Menlo, Consolas, monospace; font-size: 9pt; }
`;
}

function footer(doc: ProductDoc, page: LayoutPage, total: number): string {
  return `<footer class="foot"><span>${esc(doc.title)}${doc.personaName ? ` · ${esc(doc.personaName)}` : ''}</span><span class="pn" data-pn="${page.number}">${page.number} / ${total}</span></footer>`;
}

/** Overflow probe: pages whose body overflows its box, as a comma list on <body data-overflow>. */
const OVERFLOW_SCRIPT = `<script>(function(){var o=[];document.querySelectorAll('.page').forEach(function(p){var b=p.querySelector('.page-body');if(b&&b.scrollHeight>b.clientHeight+2)o.push(p.getAttribute('data-page'));});document.body.setAttribute('data-overflow',o.join(','));document.body.setAttribute('data-ready','1');})();</script>`;

export function renderHtml(doc: ProductDoc, layout: Layout, colors: KitColors): string {
  const c = printPalette(colors);
  const total = layout.pages.length;
  const tocPages = layout.pages.filter((p) => p.kind === 'toc');
  const perToc = Math.ceil(layout.toc.length / Math.max(1, tocPages.length));
  const pages = layout.pages.map((p) => {
    if (p.kind === 'cover') {
      return `<section class="page cover" data-page="1"><div class="band"></div><div class="band2"></div><div class="inner"><h1>${esc(doc.title)}</h1>${doc.subtitle ? `<div class="promise">${inline(doc.subtitle)}</div>` : ''}</div>${
        doc.personaName ? `<div class="by">by ${esc(doc.personaName)}<small>An AI character from the Troupe House studio</small></div>` : ''
      }</section>`;
    }
    if (p.kind === 'toc') {
      const i = tocPages.indexOf(p);
      const entries = layout.toc.slice(i * perToc, (i + 1) * perToc);
      return `<section class="page toc" data-page="${p.number}"><div class="page-body"><header class="sec-head"><div class="eyebrow">Inside</div><h2>Contents</h2></header><ol class="toc-list">${entries
        .map((e) => `<li><a href="#${e.id}" data-toc-page="${e.page}"><span>${esc(e.title)}</span><span class="dots"></span><span class="pn">${e.page}</span></a></li>`)
        .join('')}</ol></div>${footer(doc, p, total)}</section>`;
    }
    const st = p.sectionStart;
    // No "Part 1" eyebrow over a title that already starts with it.
    const eyebrow = st && !st.title.toLowerCase().startsWith(st.eyebrow.toLowerCase()) ? `<div class="eyebrow">${esc(st.eyebrow)}</div>` : '<div class="eyebrow">&nbsp;</div>';
    const head = st ? `<header class="sec-head">${eyebrow}<h2>${esc(st.title)}</h2></header>` : '';
    return `<section class="page"${p.sectionStart ? ` id="${p.sectionStart.id}"` : ''} data-page="${p.number}"><div class="page-body">${head}${p.blocks.map(blockHtml).join('')}</div>${footer(doc, p, total)}</section>`;
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(doc.title)}</title><meta name="author" content="${esc(doc.personaName)}"><meta name="generator" content="Troupe House Product Builder"><style>${css(layout.size, c)}</style></head>
<body data-size="${layout.size}" data-pages="${total}">
${pages.join('\n')}
${OVERFLOW_SCRIPT}
</body></html>`;
}

/** A 4:5 cover image (SVG) for the listing pack and the persona site's product page. */
export function coverSvg(doc: ProductDoc, colors: KitColors): string {
  const c = printPalette(colors);
  const words = doc.title.split(/\s+/);
  const rows: string[] = [];
  for (const w of words) {
    const last = rows.at(-1);
    if (last && `${last} ${w}`.length <= 16) rows[rows.length - 1] = `${last} ${w}`;
    else rows.push(w);
  }
  const title = rows
    .slice(0, 5)
    .map((r, i) => `<text x="96" y="${520 + i * 118}" font-size="104" font-weight="600" font-family="Iowan Old Style, Palatino, Georgia, serif" fill="${c.coverInk}">${esc(r)}</text>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1500" viewBox="0 0 1200 1500"><rect width="1200" height="1500" fill="${c.cover}"/><rect width="1200" height="64" fill="${c.accent}"/><rect y="64" width="480" height="16" fill="${c.accent2}"/>${title}<text x="96" y="1380" font-size="40" font-family="Avenir Next, Helvetica Neue, Arial, sans-serif" fill="${c.coverInk}">${esc(doc.personaName ? `by ${doc.personaName}` : '')}</text></svg>`;
}
