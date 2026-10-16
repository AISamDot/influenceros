/**
 * IOS-3/4 shared contracts (docs/IOS-34-CONTRACTS.md). FROZEN for streams E (media), F (distribution), G (commerce)
 * and H (products): they build against these in parallel, so changes are additive and made by the integrator only.
 *
 * Cross-stream work travels through the job queue (payload types below) and the database (tables in the contracts
 * doc, §5.6); no IOS-3/4 package imports another.
 */
import { enqueue, type JobRow, type PostFormat } from '@ios/core';
import type { Db } from '@ios/db';

// ───────────────────────────── Enqueue once per subject ─────────────────────────────

/**
 * Enqueues a job unless one with the same kind and `key` (stored as `payload.dedupe`) is queued or running, or, with
 * `ever`, has already succeeded. Cross-stream jobs use it with the subject as the key (`publish.prepare` per slot,
 * `product.build` per product version) so a retried handler never hands work over twice. Returns null when skipped.
 */
export async function enqueueOnceFor(
  db: Db,
  job: { kind: string; key: string; payload: Record<string, unknown>; studioId?: string | null; personaId?: string | null; priority?: number; runAt?: Date; maxAttempts?: number },
  opts: { ever?: boolean } = {},
): Promise<JobRow | null> {
  const statuses = opts.ever ? ['queued', 'running', 'succeeded'] : ['queued', 'running'];
  const open = await db.maybeOne(
    `SELECT 1 FROM job WHERE kind = $1 AND status = ANY($2::text[]) AND payload->>'dedupe' = $3 LIMIT 1`,
    [job.kind, statuses, job.key],
  );
  if (open) return null;
  return enqueue(db, {
    kind: job.kind,
    payload: { ...job.payload, dedupe: job.key },
    studioId: job.studioId ?? null,
    personaId: job.personaId ?? null,
    priority: job.priority,
    runAt: job.runAt,
    maxAttempts: job.maxAttempts,
  });
}

// ───────────────────────────── Media → distribution (E produces, F consumes) ─────────────────────────────

/** Job kind: E enqueues it once a slot's media passed Q3/Q4; F registers the handler (posts, Gate, approval, schedule). */
export const PUBLISH_PREPARE_JOB = 'publish.prepare';

/** One finished file (an `asset` row E wrote, stored in `providers.storage`). */
export interface RenderedMedia {
  readonly assetId: string;
  readonly kind: 'video' | 'image';
  readonly storageKey: string;
  /** Dashboard URL (`storage.url(key)`). F uploads the file to the vendor before publishing. */
  readonly url: string;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly durationS: number | null;
}

/**
 * What a rendered slot hands to distribution. Exports are 1080×1920 (carousel slides 1080×1350), sharpened, with
 * the persona colour grade and burned-in captions inside the platform safe zones.
 */
export interface PublishPreparePayload {
  readonly slotId: string;
  readonly personaId: string;
  readonly scriptId: string;
  readonly format: PostFormat;
  /** Posting order: 1 video (talking, activity_text, voiceover), 1 image (static) or 6–8 slides (carousel). */
  readonly media: readonly RenderedMedia[];
  /** Cover/thumbnail frame; also shown on the Pipeline board and the persona calendar. */
  readonly cover: RenderedMedia | null;
  readonly caption: string;
  readonly hashtags: readonly string[];
  readonly ctaKeyword: string;
  /** Owner rule: every post carries the platform AI flag. Literal true so nobody can send false. */
  readonly aiGenerated: true;
  /** The passing qc_report (subject_type 'asset', stage 'Q4') of the main media. */
  readonly q4ReportId: string;
  /** A winner's activity post that should get a trending sound: F sends a draft to the app inbox instead. */
  readonly trendingSound?: boolean;
  /**
   * (IOS-4 fix, additive) The Owner approved publishing past failed QC majors (qc_override card, with a reason).
   * Post Q4 then lets majors through; blockers still block.
   */
  readonly qcOverride?: { readonly approvalId: string; readonly reason: string; readonly stage: string };
}

// ───────────────────────────── Products (H builds; G sells) ─────────────────────────────

/** Job kind: H's handler builds (or rebuilds) a product version. H's own schedule enqueues it for products at 'brief'. */
export const PRODUCT_BUILD_JOB = 'product.build';

export interface ProductBuildPayload {
  readonly productId: string;
  readonly personaId: string;
  /** 'brief' = written from the Monetization Agent's brief; 'manuscript' = an imported markdown manuscript. */
  readonly source: 'brief' | 'manuscript';
  /** Storage key of the imported manuscript (source 'manuscript'). */
  readonly manuscriptKey?: string;
}

/** product_version.files (H's migration) is an array of these; G reads them for delivery and listing packs. */
export interface ProductFile {
  readonly kind: 'pdf' | 'sheet_template' | 'notion_template' | 'audio' | 'cover' | 'image';
  readonly label: string;
  /** PDFs come in both sizes. */
  readonly pageSize?: 'A4' | 'Letter';
  /** Stored file (pdf, cover, audio). */
  readonly storageKey?: string;
  /** Copy/duplicate link (Sheets, Notion) or the file's dashboard URL. */
  readonly url: string;
  readonly pages?: number;
  readonly bytes?: number;
}

// ───────────────────────────── Community (F) ─────────────────────────────

/** comment.classification / dm_thread.classification values. B's Monetization Agent reads 'question' and 'purchase_intent'. */
export const COMMUNITY_CLASSES = [
  'spam',
  'abuse',
  'question',
  'purchase_intent',
  'praise',
  'criticism',
  'crisis',
  'minor',
  'legal_press',
  'partnership',
  'are_you_real',
] as const;
export type CommunityClass = (typeof COMMUNITY_CLASSES)[number];

// ───────────────────────────── Analytics (F writes; D, dashboards read) ─────────────────────────────

/** metric_snapshot.window for post-level rows (F's migration adds the column). Values are cumulative at capture time. */
export const METRIC_WINDOWS = ['1h', '24h', '72h', '7d'] as const;
export type MetricWindow = (typeof METRIC_WINDOWS)[number];
export const METRIC_WINDOW_MS: Readonly<Record<MetricWindow, number>> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '72h': 259_200_000,
  '7d': 604_800_000,
};

// ───────────────────────────── Persona sites (G serves; E, F, H link to them) ─────────────────────────────

type Env = Readonly<Record<string, string | undefined>>;

/** Subdomains that are never persona sites. */
export const RESERVED_SUBDOMAINS: readonly string[] = ['www', 'app', 'api', 'admin', 'studio', 'mail', 'email', 'l', 'go', 'dashboard'];

/** Fixed public paths on a persona site that other streams link to (G owns the pages). */
export const SITE_PATHS = {
  /** Link-in-bio page (the profile link on every account). */
  home: '/',
  /** Lead-magnet opt-in page (the comment-keyword DM links here when the post has no short link). */
  freebie: '/free',
} as const;

function cleanPath(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return p === '/' ? '' : p;
}

/** Origin of the dashboard / local server: IOS_PUBLIC_URL, else http://localhost:<PORT or 3100>. */
export function appOrigin(env: Env = process.env): string {
  return (env.IOS_PUBLIC_URL?.trim() || `http://localhost:${env.PORT?.trim() || 3100}`).replace(/\/+$/, '');
}

/**
 * Public URL of a page on a persona's site: `https://<slug>.<IOS_STUDIO_DOMAIN><path>` when the studio domain is set,
 * else `<appOrigin>/p/<slug><path>` (local dev).
 */
export function personaSiteUrl(slug: string, path: string = SITE_PATHS.home, env: Env = process.env): string {
  const domain = env.IOS_STUDIO_DOMAIN?.trim().toLowerCase();
  if (domain) return `https://${slug}.${domain}${cleanPath(path) || '/'}`;
  return `${appOrigin(env)}/p/${slug}${cleanPath(path)}`;
}

/** Public URL of a short link (`short_link.slug`), served by G at `/l/<code>` on the persona's host. */
export function shortLinkUrl(personaSlug: string, code: string, env: Env = process.env): string {
  const domain = env.IOS_STUDIO_DOMAIN?.trim().toLowerCase();
  if (domain) return `https://${personaSlug}.${domain}/l/${code}`;
  return `${appOrigin(env)}/l/${code}`;
}

// ───────────────────────────── Persona kit (E: grade and captions; G: sites; H: PDFs) ─────────────────────────────

export interface PersonaKitColor {
  readonly name: string;
  readonly hex: string;
  readonly use: string;
}

/** The persona's visual identity, read from the current bible (its "Palette | Hex | Used for" table). */
export interface PersonaKit {
  readonly personaId: string;
  readonly slug: string;
  readonly name: string;
  readonly niche: string;
  readonly portraitUrl: string | null;
  /** Every palette row in bible order (may be empty for personas without a palette table). */
  readonly palette: readonly PersonaKitColor[];
  /**
   * Picks for layouts: background, ink (text), accent (brand colour), and a second accent. Always valid hex.
   * (IOS-4 fix, additive) `cta` is a button fill that `onCta` text (ink or white) reads on at WCAG AA (4.5:1): the
   * accent when it passes, else accent2, else the accent darkened. Text in the accent colour on `bg` should use
   * `accentText` (the accent when it reaches 4.5:1 on bg, else ink).
   */
  readonly colors: {
    readonly bg: string;
    readonly ink: string;
    readonly accent: string;
    readonly accent2: string;
    readonly cta?: string;
    readonly onCta?: string;
    readonly accentText?: string;
  };
}

const HEX_CELL = /^#[0-9a-fA-F]{6}$/;

/**
 * Palette rows from markdown text: any table row with a `#rrggbb` cell. The cell before the hex is the name and the
 * cell after it the use, so both "| Name | #hex | Use |" and "| Role | Name | #hex | Use |" tables parse (a leading
 * role is kept in the use, e.g. "… (Pattern only)").
 */
export function parsePalette(text: string): PersonaKitColor[] {
  const out: PersonaKitColor[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    const i = cells.findIndex((c) => HEX_CELL.test(c));
    if (i < 1) continue;
    const hex = cells[i]!.toUpperCase();
    if (out.some((c) => c.hex === hex)) continue;
    const role = i > 1 ? cells.slice(0, i - 1).join(' ').replace(/\*/g, '').trim() : '';
    const use = cells[i + 1] ?? '';
    out.push({ name: cells[i - 1]!.replace(/\*/g, ''), hex, use: role ? `${use} (${role})` : use });
  }
  return out;
}

/** WCAG relative luminance of a #rrggbb colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio between two #rrggbb colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const darken = (hex: string, f: number): string =>
  `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * f).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

/** The better of ink / white for text on `fill`. */
const textOn = (fill: string, ink: string): string => (contrastRatio(fill, ink) >= contrastRatio(fill, '#FFFFFF') ? ink : '#FFFFFF');

/** A CTA fill with AA text on it (4.5:1): the accent, else accent2, else the accent darkened step by step. */
export function ctaColors(c: { ink: string; accent: string; accent2: string }): { cta: string; onCta: string } {
  for (const fill of [c.accent, c.accent2]) {
    const on = textOn(fill, c.ink);
    if (contrastRatio(fill, on) >= 4.5) return { cta: fill, onCta: on };
  }
  let fill = c.accent;
  for (let i = 0; i < 20 && contrastRatio(fill, '#FFFFFF') < 4.5; i++) fill = darken(fill, 0.9);
  return { cta: fill, onCta: '#FFFFFF' };
}

const withContrast = (c: { bg: string; ink: string; accent: string; accent2: string }): PersonaKit['colors'] => ({
  ...c,
  ...ctaColors(c),
  accentText: contrastRatio(c.accent, c.bg) >= 4.5 ? c.accent : c.ink,
});

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

/** Layout picks from a palette: the lightest as background, the darkest as ink, the most saturated others as accents. */
export function kitColors(palette: readonly PersonaKitColor[], fallbackAccent: string | null): PersonaKit['colors'] {
  const usable = palette.filter((c) => !/hair only|never on|pattern only|never a solid/i.test(`${c.name} ${c.use}`));
  const accentFallback = fallbackAccent && /^#[0-9a-f]{6}$/i.test(fallbackAccent) ? fallbackAccent.toUpperCase() : '#2F6FB0';
  if (usable.length < 2) return withContrast({ bg: '#FAF7F2', ink: '#1C1A17', accent: accentFallback, accent2: accentFallback });
  const byLum = [...usable].sort((a, b) => luminance(a.hex) - luminance(b.hex));
  const ink = byLum[0]!.hex;
  const bg = byLum.at(-1)!.hex;
  const rest = usable.filter((c) => c.hex !== ink && c.hex !== bg);
  const sat = (hex: string) => {
    const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return Math.max(...v) - Math.min(...v);
  };
  const accents = [...rest].sort((a, b) => sat(b.hex) - sat(a.hex));
  const accent = accents[0]?.hex ?? accentFallback;
  return withContrast({ bg, ink, accent, accent2: accents[1]?.hex ?? accent });
}

/** Loads the kit for one persona from its latest bible version (any string section holding a palette table counts). */
export async function loadPersonaKit(db: Db, personaId: string): Promise<PersonaKit> {
  const p = await db.one<{ id: string; slug: string; name: string; niche: string; portrait_url: string | null; accent_color: string | null }>(
    'SELECT id, slug, name, niche, portrait_url, accent_color FROM persona WHERE id = $1',
    [personaId],
  );
  const bible = await db.maybeOne<{ content: Record<string, unknown> }>(
    `SELECT content FROM persona_bible WHERE persona_id = $1 AND status <> 'superseded' ORDER BY version DESC LIMIT 1`,
    [personaId],
  );
  const text = Object.values(bible?.content ?? {})
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
  const palette = parsePalette(text);
  return {
    personaId: p.id,
    slug: p.slug,
    name: p.name,
    niche: p.niche,
    portraitUrl: p.portrait_url,
    palette,
    colors: kitColors(palette, p.accent_color),
  };
}
