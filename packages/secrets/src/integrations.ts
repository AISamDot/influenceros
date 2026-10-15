import { type SecretBackend, type SecretName, type SecretSource, secretSource } from './store';

/**
 * Every integration, the secrets it needs and whether its real adapter exists yet. Settings → Integrations shows
 * each as Connected · Pending key · Fake mode; anything without a key (or without a real adapter yet) runs on its
 * deterministic fake.
 */
export interface IntegrationDef {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly secrets: readonly SecretName[];
  /** True once the real adapter is built. Until then the integration always runs on its fake. */
  readonly liveAdapter: boolean;
  readonly milestone: string;
  readonly kind: 'provider' | 'infra';
}

export const INTEGRATIONS: readonly IntegrationDef[] = [
  { id: 'anthropic', name: 'Anthropic', purpose: 'Claude Agent SDK: Studio Manager, persona managers, workers', secrets: ['anthropic.api_key'], liveAdapter: true, milestone: 'IOS-2', kind: 'provider' },
  // IOS-3/4: each stream edits only its own integrations' entries (e.g. liveAdapter: true once its adapter lands).
  // >>> stream E integrations
  { id: 'higgsfield', name: 'Higgsfield', purpose: 'Soul ID, stills, activity clips, Seedance talking, cost probe', secrets: ['higgsfield.api_key', 'higgsfield.api_secret'], liveAdapter: false, milestone: 'IOS-3', kind: 'provider' },
  { id: 'fal', name: 'fal.ai', purpose: 'Kling AI Avatar talking reels (pluggable with Seedance)', secrets: ['fal.api_key'], liveAdapter: false, milestone: 'IOS-3', kind: 'provider' },
  { id: 'elevenlabs', name: 'ElevenLabs', purpose: 'Synthetic voices (Voice Design) and TTS', secrets: ['elevenlabs.api_key'], liveAdapter: false, milestone: 'IOS-3', kind: 'provider' },
  // <<< stream E integrations
  // >>> stream F integrations
  { id: 'zernio', name: 'Zernio', purpose: 'Scheduling and publishing with AI labels, comments, DMs', secrets: ['zernio.api_key'], liveAdapter: false, milestone: 'IOS-4', kind: 'provider' },
  // <<< stream F integrations
  // >>> stream G integrations
  { id: 'lemonsqueezy', name: 'Lemon Squeezy', purpose: 'Stores, products (read-only), checkouts, discount codes, order and subscription webhooks', secrets: ['lemonsqueezy.api_key', 'lemonsqueezy.webhook_secret'], liveAdapter: true, milestone: 'IOS-4', kind: 'provider' },
  // <<< stream G integrations
  { id: 'resend', name: 'Resend', purpose: 'Owner sign-in links (IOS-2); email lists, sequences and the daily digest', secrets: ['resend.api_key'], liveAdapter: true, milestone: 'IOS-2', kind: 'provider' },
  { id: 'apify', name: 'Apify', purpose: 'Trend and competitor research scrapers', secrets: ['apify.token'], liveAdapter: false, milestone: 'IOS-2', kind: 'provider' },
  { id: 'pixabay', name: 'Pixabay', purpose: 'Royalty-free B-roll and music', secrets: ['pixabay.api_key'], liveAdapter: false, milestone: 'IOS-3', kind: 'provider' },
  { id: 'discord', name: 'Discord', purpose: 'Membership community access', secrets: ['discord.bot_token'], liveAdapter: false, milestone: 'Phase 1', kind: 'provider' },
  { id: 'vercel', name: 'Vercel', purpose: 'Dashboard, API and cron hosting', secrets: ['vercel.token'], liveAdapter: false, milestone: 'IOS-5', kind: 'infra' },
  { id: 'supabase', name: 'Supabase', purpose: 'Postgres (DATABASE_URL), storage and vault', secrets: ['supabase.database_url', 'supabase.service_role_key'], liveAdapter: false, milestone: 'IOS-5', kind: 'infra' },
];

export type IntegrationStatus = 'connected' | 'pending_key' | 'fake_mode';

export interface IntegrationState {
  readonly def: IntegrationDef;
  readonly status: IntegrationStatus;
  /** What actually runs right now. */
  readonly mode: 'live' | 'fake';
  readonly secrets: ReadonlyArray<{ name: SecretName; source: SecretSource | null }>;
}

/**
 * `IOS_FAKE_PROVIDERS=1` (or a comma list of ids) forces fake mode even when keys exist.
 * Never reads more than presence: no value leaves the backend.
 */
export function integrationStates(
  backend: SecretBackend,
  env: Readonly<Record<string, string | undefined>> = process.env,
): IntegrationState[] {
  const forced = (env.IOS_FAKE_PROVIDERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return INTEGRATIONS.map((def) => {
    const secrets = def.secrets.map((name) => ({ name, source: secretSource(name, backend, env) }));
    const keysPresent = secrets.every((s) => s.source !== null);
    const forcedFake = forced.includes('1') || forced.includes('all') || forced.includes(def.id);
    const status: IntegrationStatus = forcedFake ? 'fake_mode' : keysPresent ? 'connected' : 'pending_key';
    const mode = !forcedFake && keysPresent && def.liveAdapter ? 'live' : 'fake';
    return { def, status, mode, secrets };
  });
}
