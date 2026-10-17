import { personaSiteUrl, SITE_PATHS, type Caller, type ToolDef } from '@troupe/agents';
import { postAttribution, sweepPostLinks } from './attribution';
import { membershipStats } from './membership';
import { listStats, sendBroadcast, writeWelcomeSequence } from './sequences';
import { productStoreBoard, storeFor, syncStores } from './store';

/**
 * Agent tools for stream G's namespaces (store.*, site.*, email.*, membership.*, attribution.*). Persona-scoped tools
 * take `persona_id` (the registry checks scope and studio). Nothing here creates store products, raises caps or
 * changes legal text: those stay with the Owner.
 */

type Raw = Record<string, unknown>;
function obj(raw: unknown, allowed: readonly string[]): Raw {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('input must be an object');
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`unknown input fields: ${extra.join(', ')}`);
  return raw as Raw;
}
function str(r: Raw, k: string, max = 2000): string {
  const v = r[k];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${k} must be a non-empty string`);
  if (v.length > max) throw new Error(`${k} is too long`);
  return v.trim();
}
const schema = (properties: Record<string, object>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const PID = { type: 'string', description: 'Persona id (uuid).' } as const;
const personaOnly = (raw: unknown) => ({ persona_id: str(obj(raw, ['persona_id']), 'persona_id', 64) });

const MANAGERS: readonly Caller[] = ['studio-manager', 'persona-manager', 'owner', 'system'];
const WRITERS: readonly Caller[] = ['email-writer', 'persona-manager', 'studio-manager', 'owner', 'system'];

const storeStatus: ToolDef<{ persona_id: string }, unknown> = {
  name: 'store.status',
  description: "The persona's Lemon Squeezy store link and every product's store status (listing pack, waiting for the store listing, linked with a checkout URL, free), with orders and revenue.",
  scope: 'persona',
  inputSchema: schema({ persona_id: PID }, ['persona_id']),
  parse: personaOnly,
  async run(ctx, input) {
    const store = await storeFor(ctx.services.db, input.persona_id);
    const products = await productStoreBoard(ctx.services.db, ctx.studioId, input.persona_id);
    return {
      store: store ? { linked: true, storeId: store.storeId } : { linked: false },
      products: products.map((p) => ({ id: p.id, name: p.name, rung: p.ladder_rung, status: p.status, store_status: p.store_status, has_checkout_url: Boolean(p.checkout_url), orders: p.orders, revenue_cents: p.revenue_cents })),
    };
  },
};

const storeSync: ToolDef<Record<string, never>, unknown> = {
  name: 'store.sync',
  description: 'Re-read the Lemon Squeezy stores (read-only API) and link each to its persona (store slug = persona slug).',
  scope: 'studio',
  mutates: true,
  callers: ['studio-manager', 'owner', 'system'],
  ownerIntent: /\b(?:sync|refresh|re-?link|link)\b.*\b(?:stores?|lemon ?squeezy)\b/i,
  inputSchema: schema({}, []),
  parse: (raw) => (obj(raw ?? {}, []), {} as Record<string, never>),
  run: (ctx) => syncStores(ctx.services, ctx.studioId),
};

const siteUrls: ToolDef<{ persona_id: string }, unknown> = {
  name: 'site.urls',
  description: "The persona's public site URLs: link-in-bio (profile link), lead-magnet opt-in, members area, privacy page and each live product page.",
  scope: 'persona',
  inputSchema: schema({ persona_id: PID }, ['persona_id']),
  parse: personaOnly,
  async run(ctx, input) {
    const p = await ctx.services.db.one<{ slug: string }>('SELECT slug FROM persona WHERE id = $1', [input.persona_id]);
    const products = await ctx.services.db.query<{ slug: string; name: string }>(`SELECT slug, name FROM product WHERE persona_id = $1 AND status = 'live' AND ladder_rung <> 'lead_magnet'`, [input.persona_id]);
    return {
      home: personaSiteUrl(p.slug, SITE_PATHS.home),
      freebie: personaSiteUrl(p.slug, SITE_PATHS.freebie),
      members: personaSiteUrl(p.slug, '/members'),
      privacy: personaSiteUrl(p.slug, '/privacy'),
      products: products.map((x) => ({ name: x.name, url: personaSiteUrl(p.slug, `/shop/${x.slug}`) })),
    };
  },
};

const emailStats: ToolDef<{ persona_id: string }, unknown> = {
  name: 'email.list_stats',
  description: "The persona's email list: active, pending (double opt-in), unsubscribed and bounced counts, emails sent in 7 days and the welcome sequence status.",
  scope: 'persona',
  inputSchema: schema({ persona_id: PID }, ['persona_id']),
  parse: personaOnly,
  run: (ctx, input) => listStats(ctx.services.db, input.persona_id),
};

const writeWelcome: ToolDef<{ persona_id: string }, unknown> = {
  name: 'email.write_welcome',
  description: "Write (or rewrite) the persona's 5-email welcome sequence. Every email passes the Compliance Gate; a red draft never sends.",
  scope: 'persona',
  mutates: true,
  callers: WRITERS,
  ownerIntent: /\b(?:write|rewrite|redo|refresh|update|draft)\b.*\b(?:welcome|sequence|onboarding emails?)\b/i,
  inputSchema: schema({ persona_id: PID }, ['persona_id']),
  parse: personaOnly,
  run: (ctx, input) => writeWelcomeSequence(ctx.services, input.persona_id),
};

const broadcast: ToolDef<{ persona_id: string; subject: string; body: string }, unknown> = {
  name: 'email.broadcast',
  description: "Send one email to the persona's whole list (plain text body, paragraphs separated by a blank line). It passes the Compliance Gate first; red is blocked. The unsubscribe link and physical address are added.",
  scope: 'persona',
  mutates: true,
  callers: ['email-writer', 'persona-manager', 'owner'],
  ownerIntent: /\b(?:send|email|broadcast|mail)\b.*\b(?:broadcast|newsletter|list|subscribers|everyone)\b/i,
  inputSchema: schema({ persona_id: PID, subject: { type: 'string' }, body: { type: 'string' } }, ['persona_id', 'subject', 'body']),
  parse: (raw) => {
    const r = obj(raw, ['persona_id', 'subject', 'body']);
    return { persona_id: str(r, 'persona_id', 64), subject: str(r, 'subject', 120), body: str(r, 'body', 8000) };
  },
  run: (ctx, input) => sendBroadcast(ctx.services, { personaId: input.persona_id, subject: input.subject, body: input.body, createdBy: ctx.caller }),
};

const memberStats: ToolDef<{ persona_id: string }, unknown> = {
  name: 'membership.stats',
  description: "The persona's membership: members with access, monthly recurring revenue (cents), past-due members and churn in 30 days.",
  scope: 'persona',
  inputSchema: schema({ persona_id: PID }, ['persona_id']),
  parse: personaOnly,
  run: (ctx, input) => membershipStats(ctx.services.db, input.persona_id, ctx.services.now()),
};

const postReport: ToolDef<{ persona_id: string }, unknown> = {
  name: 'attribution.post_report',
  description: 'Per-post funnel for the persona: short-link clicks, subscribers, attributed orders, revenue and refunds (cents), best first.',
  scope: 'persona',
  inputSchema: schema({ persona_id: PID }, ['persona_id']),
  parse: personaOnly,
  async run(ctx, input) {
    const rows = await postAttribution(ctx.services.db, input.persona_id, { limit: 30 });
    return rows.map((r) => ({ ...r, caption: r.caption?.slice(0, 120) ?? null }));
  },
};

const ensureLinks: ToolDef<Record<string, never>, unknown> = {
  name: 'attribution.ensure_links',
  description: 'Create the missing short links (every outgoing post) and coupon codes (sell posts) now, instead of waiting for the sweep.',
  scope: 'studio',
  mutates: true,
  callers: MANAGERS,
  ownerIntent: /\b(?:create|make|add|generate)\b.*\b(?:short ?links?|coupons?|codes?)\b/i,
  inputSchema: schema({}, []),
  parse: (raw) => (obj(raw ?? {}, []), {} as Record<string, never>),
  run: (ctx) => sweepPostLinks(ctx.services, { studioId: ctx.studioId }),
};

export const tools: ReadonlyArray<ToolDef<any, any>> = [storeStatus, storeSync, siteUrls, emailStats, writeWelcome, broadcast, memberStats, postReport, ensureLinks];
