import { appOrigin, kitColors, loadPersonaKit, parsePalette, personaSiteUrl, type PersonaKit } from '@ios/agents';
import type { Db } from '@ios/db';

/**
 * Persona micro-sites (docs/IOS-34-CONTRACTS.md §5.5): read models for the public pages and the URL helpers the
 * emails use. Everything here is public: it never returns studio data, other personas, costs or Owner-only URLs.
 */

/** States whose site is hidden. */
export const HIDDEN_STATES: readonly string[] = ['PROPOSED', 'KILLED', 'RETIRED'];

/** Ladder order (lower first): the thank-you upsell offers the next live rung. */
export const LADDER: readonly string[] = ['lead_magnet', 'entry', 'addon', 'core_bundle', 'upsell', 'product_2_3', 'marketplace', 'course', 'membership'];

export interface SitePersona {
  readonly id: string;
  readonly studioId: string;
  readonly slug: string;
  readonly name: string;
  readonly niche: string;
  readonly hasPortrait: boolean;
}

export interface SiteProduct {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly rung: string;
  readonly priceCents: number;
  readonly currency: string;
  readonly summary: string;
  readonly bullets: readonly string[];
  readonly audience: string | null;
  /** A checkout can be built (stored checkout URL or a linked store variant). */
  readonly buyable: boolean;
  readonly hasCover: boolean;
}

export interface SiteData {
  readonly persona: SitePersona;
  readonly colors: PersonaKit['colors'];
  readonly leadMagnet: SiteProduct | null;
  readonly products: readonly SiteProduct[];
  readonly membership: SiteProduct | null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A public URL is one that never needs the Owner session. */
export const isPublicAssetUrl = (u: string | null | undefined): boolean =>
  Boolean(u && (u.startsWith('/api/public/media/') || u.startsWith('https://') || /^data:image\/(?:png|jpeg|webp|svg\+xml);/.test(u)));

/** The persona behind a public site, or null when it doesn't exist, isn't in the studio or is hidden. */
export async function sitePersona(db: Db, slug: string, studioId?: string): Promise<SitePersona | null> {
  if (!SLUG_RE.test(slug)) return null;
  const p = await db.maybeOne<{ id: string; studio_id: string; slug: string; name: string; niche: string; state: string; portrait_url: string | null }>(
    `SELECT id, studio_id, slug, name, niche, state, portrait_url FROM persona WHERE slug = $1 AND ($2::uuid IS NULL OR studio_id = $2) ORDER BY created_at LIMIT 1`,
    [slug, studioId ?? null],
  );
  if (!p || HIDDEN_STATES.includes(p.state)) return null;
  return { id: p.id, studioId: p.studio_id, slug: p.slug, name: p.name, niche: p.niche, hasPortrait: Boolean(p.portrait_url) };
}

interface ProductRow {
  id: string;
  slug: string;
  name: string;
  ladder_rung: string;
  status: string;
  price_cents: number;
  currency: string;
  checkout_url: string | null;
  store_variant_id: string | null;
  cover_url: string | null;
  listing: Record<string, unknown> | null;
  brief: Record<string, unknown> | null;
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function toSiteProduct(r: ProductRow): SiteProduct {
  const listing = r.listing ?? {};
  const brief = r.brief ?? {};
  const summary = (typeof listing.summary === 'string' && listing.summary) || (typeof brief.promise === 'string' && brief.promise) || '';
  return {
    id: r.id,
    slug: r.slug,
    name: (typeof listing.name === 'string' && listing.name) || r.name,
    rung: r.ladder_rung,
    priceCents: Number(r.price_cents),
    currency: r.currency,
    summary,
    bullets: strs(brief.outline).slice(0, 6),
    audience: typeof brief.audience === 'string' ? brief.audience : null,
    buyable: r.ladder_rung !== 'lead_magnet' && (Boolean(r.checkout_url) || Boolean(r.store_variant_id)),
    hasCover: Boolean(r.cover_url),
  };
}

async function productRows(db: Db, personaId: string): Promise<ProductRow[]> {
  return db.query<ProductRow>(
    `SELECT pr.id, pr.slug, pr.name, pr.ladder_rung, pr.status, pr.price_cents, pr.currency, pr.checkout_url, pr.store_variant_id, pr.cover_url,
            (SELECT fields FROM product_listing l WHERE l.product_id = pr.id AND l.channel = 'lemonsqueezy' AND l.gate_verdict <> 'red') AS listing,
            (SELECT content FROM product_brief b WHERE b.product_id = pr.id ORDER BY b.created_at DESC LIMIT 1) AS brief
       FROM product pr
      WHERE pr.persona_id = $1 AND (pr.status = 'live' OR (pr.ladder_rung = 'lead_magnet' AND pr.status IN ('approved','live')))
      ORDER BY pr.created_at`,
    [personaId],
  );
}

/** Everything the public pages of one persona's site show. */
export async function loadSite(db: Db, slug: string, studioId?: string): Promise<SiteData | null> {
  const persona = await sitePersona(db, slug, studioId);
  if (!persona) return null;
  const [kit, rows] = await Promise.all([loadPersonaKit(db, persona.id).catch(() => null), productRows(db, persona.id)]);
  const all = rows.map(toSiteProduct);
  const leadMagnet = all.find((p) => p.rung === 'lead_magnet') ?? null;
  const membership = all.find((p) => p.rung === 'membership' && p.buyable) ?? null;
  const products = all
    .filter((p) => p.rung !== 'lead_magnet' && p.rung !== 'membership' && p.buyable)
    .sort((a, b) => LADDER.indexOf(a.rung) - LADDER.indexOf(b.rung));
  return { persona, colors: kit?.colors ?? kitColors(parsePalette(''), null), leadMagnet, products, membership };
}

/** The next live rung after `productSlug` (thank-you upsell), else the membership. */
export function upsellFor(site: SiteData, productSlug: string): SiteProduct | null {
  const bought = [...site.products, ...(site.membership ? [site.membership] : [])].find((p) => p.slug === productSlug);
  const at = bought ? LADDER.indexOf(bought.rung) : -1;
  const next = site.products.find((p) => p.slug !== productSlug && LADDER.indexOf(p.rung) > at);
  if (next) return next;
  return site.membership && site.membership.slug !== productSlug ? site.membership : null;
}

/** Path prefix of the site's own pages: '' on the persona's host, `/p/<slug>` locally. */
export const siteBase = (slug: string, onPersonaHost: boolean): string => (onPersonaHost ? '' : `/p/${slug}`);

type Env = Readonly<Record<string, string | undefined>>;

/** Absolute URL of a public site endpoint (`/api/public/…`, `/l/…`) on the persona's host (prod) or the app (local). */
export function publicEndpointUrl(slug: string, path: string, env: Env = process.env): string {
  const domain = env.IOS_STUDIO_DOMAIN?.trim().toLowerCase();
  const p = path.startsWith('/') ? path : `/${path}`;
  return domain ? `https://${slug}.${domain}${p}` : `${appOrigin(env)}${p}`;
}

/** Absolute URL of a site page (links in emails). */
export const sitePageUrl = (slug: string, path: string, env: Env = process.env): string => personaSiteUrl(slug, path, env);
