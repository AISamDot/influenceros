import type { StudioServices } from '@ios/agents';
import { sourceFor } from './attribution';
import { sitePersona } from './sites';
import { storeFor } from './store';

/**
 * The buy button. API-less first: a stored checkout URL gets the attribution as Lemon Squeezy prefill parameters
 * (`checkout[custom][…]`, `checkout[discount_code]`). Without one, a linked store variant gets a checkout created
 * through the API with the same custom data. Custom data: product_id, persona_id and, from the short link the
 * visitor came through, post_id, short_link and coupon.
 */
export async function checkoutUrlFor(
  services: StudioServices,
  args: { slug: string; productSlug: string; src?: string | null; studioId?: string },
): Promise<string | null> {
  const { db } = services;
  const persona = await sitePersona(db, args.slug, args.studioId);
  if (!persona || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(args.productSlug)) return null;
  const p = await db.maybeOne<{ id: string; checkout_url: string | null; store_variant_id: string | null; store_id: string | null; status: string; ladder_rung: string }>(
    `SELECT id, checkout_url, store_variant_id, store_id, status, ladder_rung FROM product WHERE persona_id = $1 AND slug = $2`,
    [persona.id, args.productSlug],
  );
  if (!p || p.status !== 'live' || p.ladder_rung === 'lead_magnet') return null;
  const src = await sourceFor(db, persona.id, args.src);
  const custom: Record<string, string> = { product_id: p.id, persona_id: persona.id };
  if (src.postId) custom.post_id = src.postId;
  if (src.code) custom.short_link = src.code;
  if (src.coupon) custom.coupon = src.coupon;
  if (p.checkout_url) {
    const u = new URL(p.checkout_url);
    for (const [k, v] of Object.entries(custom)) u.searchParams.set(`checkout[custom][${k}]`, v);
    if (src.coupon) u.searchParams.set('checkout[discount_code]', src.coupon);
    return u.toString();
  }
  const store = p.store_id ? { storeId: p.store_id } : await storeFor(db, persona.id);
  if (p.store_variant_id && store) {
    const { url } = await services.providers.store.createCheckout({ storeId: store.storeId, variantId: p.store_variant_id, customData: custom, discountCode: src.coupon ?? undefined });
    return url;
  }
  return null;
}
