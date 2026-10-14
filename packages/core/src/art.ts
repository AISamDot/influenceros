import type { PostFormat } from './types';

/**
 * Locally generated placeholder art (no external fetches): portraits, look-pack variants and post thumbnails as
 * SVG data URIs. Real Higgsfield stills replace them in IOS-3.
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c);

export const svgDataUri = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

const hsl = (h: number, s: number, l: number) => `hsl(${((h % 360) + 360) % 360} ${s}% ${l}%)`;

/** A portrait: soft two-tone gradient, an abstract bust silhouette and serif initials. */
export function portraitSvg(name: string, hue: number, opts: { variant?: number; label?: string } = {}): string {
  const v = opts.variant ?? 0;
  const h1 = hue + v * 18;
  const h2 = hue + 38 + v * 12;
  const id = `p${Math.abs(Math.round(hue * 10 + v))}`;
  const motifs = [
    // window light
    `<g opacity=".16" fill="#fff"><rect x="250" y="40" width="110" height="150" rx="6"/><rect x="250" y="112" width="110" height="4" fill="${hsl(h2, 40, 30)}"/><rect x="303" y="40" width="4" height="150" fill="${hsl(h2, 40, 30)}"/></g>`,
    // arch
    `<path d="M40 260 V120 a80 80 0 0 1 160 0 V260 Z" fill="#fff" opacity=".12"/>`,
    // sun
    `<circle cx="310" cy="110" r="62" fill="#fff" opacity=".18"/>`,
    // shelves
    `<g fill="#fff" opacity=".13"><rect x="30" y="90" width="120" height="6" rx="3"/><rect x="30" y="150" width="120" height="6" rx="3"/><rect x="44" y="60" width="18" height="30" rx="2"/><rect x="70" y="66" width="14" height="24" rx="2"/><rect x="100" y="122" width="26" height="28" rx="2"/></g>`,
  ];
  const label = opts.label
    ? `<g transform="translate(20 448)"><rect width="${opts.label.length * 8.6 + 24}" height="30" rx="15" fill="#000" opacity=".28"/><text x="12" y="20" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="14" font-weight="600" fill="#fff">${esc(opts.label)}</text></g>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500" width="400" height="500">
<defs>
<linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hsl(h1, 62, 74)}"/><stop offset="1" stop-color="${hsl(h2, 52, 40)}"/></linearGradient>
<radialGradient id="${id}r" cx=".3" cy=".2" r=".9"><stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></radialGradient>
<linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".34"/><stop offset="1" stop-color="#fff" stop-opacity=".08"/></linearGradient>
</defs>
<rect width="400" height="500" fill="url(#${id}g)"/>
<rect width="400" height="500" fill="url(#${id}r)"/>
${motifs[v % motifs.length]}
<circle cx="200" cy="215" r="78" fill="url(#${id}f)"/>
<path d="M62 500 C70 380 130 318 200 318 C270 318 330 380 338 500 Z" fill="url(#${id}f)"/>
<text x="200" y="244" text-anchor="middle" font-family="ui-serif,Georgia,Cambria,Times New Roman,serif" font-size="84" font-weight="600" letter-spacing="2" fill="#fff" fill-opacity=".94">${esc(initials(name))}</text>
${label}
</svg>`;
}

export const portraitUri = (name: string, hue: number, opts?: { variant?: number; label?: string }) =>
  svgDataUri(portraitSvg(name, hue, opts));

const FORMAT_GLYPH: Record<PostFormat, string> = {
  talking: '<circle cx="135" cy="200" r="46" fill="none" stroke="#fff" stroke-width="10"/><path d="M85 300 c10-40 40-58 50-58 s40 18 50 58" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round"/>',
  activity_text: '<path d="M110 160 L180 200 L110 240 Z" fill="#fff"/><rect x="80" y="270" width="110" height="10" rx="5" fill="#fff"/>',
  voiceover: '<g fill="#fff"><rect x="80" y="190" width="12" height="40" rx="6"/><rect x="104" y="165" width="12" height="90" rx="6"/><rect x="128" y="150" width="12" height="120" rx="6"/><rect x="152" y="175" width="12" height="70" rx="6"/><rect x="176" y="195" width="12" height="30" rx="6"/></g>',
  static: '<rect x="75" y="150" width="120" height="110" rx="12" fill="none" stroke="#fff" stroke-width="10"/><circle cx="110" cy="185" r="12" fill="#fff"/><path d="M80 250 L125 210 L190 255" fill="none" stroke="#fff" stroke-width="10" stroke-linejoin="round"/>',
  carousel: '<rect x="100" y="150" width="100" height="120" rx="12" fill="#fff" opacity=".5"/><rect x="70" y="165" width="100" height="120" rx="12" fill="#fff"/>',
};

function wrap(text: string, max: number, lines: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/)) {
    if ((cur + ' ' + w).trim().length > max && cur) {
      out.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = `${kept[lines - 1]?.replace(/[.,;:!?]?$/, '')}…`;
    return kept;
  }
  return out;
}

/** A 9:16 post thumbnail: persona colour, faint format glyph, the hook in bold type. */
export function thumbnailSvg(title: string, hue: number, format: PostFormat, seed = 0): string {
  const h = hue + ((seed * 23) % 40) - 20;
  const id = `t${Math.abs(Math.round(h * 7 + seed))}`;
  const lines = wrap(title, 15, 4);
  const text = lines
    .map((l, i) => `<text x="22" y="${395 - (lines.length - 1 - i) * 30}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="25" font-weight="800" fill="#fff">${esc(l)}</text>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 270 480" width="270" height="480">
<defs><linearGradient id="${id}" x1="0" y1="0" x2=".6" y2="1"><stop offset="0" stop-color="${hsl(h, 58, 62)}"/><stop offset="1" stop-color="${hsl(h + 30, 50, 28)}"/></linearGradient>
<linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset=".45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></linearGradient></defs>
<rect width="270" height="480" fill="url(#${id})"/>
<g opacity=".22">${FORMAT_GLYPH[format]}</g>
<rect width="270" height="480" fill="url(#${id}s)"/>
${text}
</svg>`;
}

export const thumbnailUri = (title: string, hue: number, format: PostFormat, seed?: number) =>
  svgDataUri(thumbnailSvg(title, hue, format, seed));
