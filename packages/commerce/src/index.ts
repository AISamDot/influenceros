import type { JobHandlerMap, ProviderEnv, ScheduledTask, ToolDef } from '@ios/agents';
import type { Providers } from '@ios/providers';
import { jobs as commerceJobs, schedules as commerceSchedules } from './jobs';
import { LemonSqueezyStore } from './live/lemonsqueezy';
import { ResendAudience } from './live/resend-audience';
import { tools as commerceTools } from './tools';

/**
 * @ios/commerce (IOS-4 stream G): Lemon Squeezy stores, products and webhooks; persona micro-sites; Resend lists,
 * consent, the welcome sequence and broadcasts; membership with magic-link access and a monthly drop; attribution
 * from post to order. See docs/IOS-34-CONTRACTS.md.
 */
export * from './attribution';
export * from './audience';
export * from './checkout';
export * from './delivery';
export * from './membership';
export * from './render';
export * from './sequences';
export * from './settings';
export * from './sites';
export * from './store';
export * from './tokens';
export * from './webhooks';
export { JOB } from './jobs';
export { clientHash, emailHash, isEmail, needsDoubleOptIn, PublicInputError } from './util';
export { LemonSqueezyStore, parseLemonSqueezyWebhook, UnsupportedStoreEvent } from './live/lemonsqueezy';
export { parseResendWebhook, ResendAudience, signSvix, verifySvix } from './live/resend-audience';

// StudioModule exports, composed by @ios/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = commerceTools;
export const jobs: JobHandlerMap = commerceJobs;
export const schedules: readonly ScheduledTask[] = commerceSchedules;

/**
 * Live adapters stream G owns: `store` (Lemon Squeezy, needs the API key and the webhook signing secret) and
 * `audience` (Resend audiences on the existing `resend.api_key`; webhooks need `resend.webhook_secret`).
 */
export function liveProviders(env: ProviderEnv): Partial<Providers> {
  const out: { -readonly [K in keyof Providers]?: Providers[K] } = {};
  if (env.isLive('lemonsqueezy')) {
    const apiKey = env.secret('lemonsqueezy.api_key');
    const webhookSecret = env.secret('lemonsqueezy.webhook_secret');
    if (apiKey && webhookSecret) out.store = new LemonSqueezyStore({ apiKey, webhookSecret });
  }
  if (env.isLive('resend')) {
    const apiKey = env.secret('resend.api_key');
    if (apiKey) out.audience = new ResendAudience({ apiKey, webhookSecret: env.secret('resend.webhook_secret') });
  }
  return out;
}
