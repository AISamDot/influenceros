import { inspect } from 'node:util';

/**
 * Secrets (PRD §8.6), the Brand OS pattern: macOS Keychain via `@napi-rs/keyring`, service `ai.influencer-os`,
 * account = secret name. Values are never printed, logged, put in argv or stored in the database.
 * On Vercel the same names are read from environment variables (`ios secrets sync` lands in a later milestone).
 */
export const KEYCHAIN_SERVICE = 'ai.influencer-os';
export const BRANDOS_KEYCHAIN_SERVICE = 'ai.brandos';

/** Every secret Influencer OS knows, with the environment variable used in the cloud. */
export const SECRETS = {
  'anthropic.api_key': { env: 'ANTHROPIC_API_KEY', label: 'Anthropic API key' },
  'higgsfield.api_key': { env: 'HIGGSFIELD_API_KEY', label: 'Higgsfield API key' },
  'higgsfield.api_secret': { env: 'HIGGSFIELD_API_SECRET', label: 'Higgsfield API secret' },
  'fal.api_key': { env: 'FAL_KEY', label: 'fal.ai key' },
  'elevenlabs.api_key': { env: 'ELEVENLABS_API_KEY', label: 'ElevenLabs API key' },
  'zernio.api_key': { env: 'ZERNIO_API_KEY', label: 'Zernio API key' },
  'lemonsqueezy.api_key': { env: 'LEMONSQUEEZY_API_KEY', label: 'Lemon Squeezy API key' },
  'lemonsqueezy.webhook_secret': { env: 'LEMONSQUEEZY_WEBHOOK_SECRET', label: 'Lemon Squeezy webhook secret' },
  'resend.api_key': { env: 'RESEND_API_KEY', label: 'Resend API key' },
  // IOS-4, optional (not required for an integration to be live): webhook signing secrets. Without one, the adapter
  // polls instead of accepting webhooks.
  'zernio.webhook_secret': { env: 'ZERNIO_WEBHOOK_SECRET', label: 'Zernio webhook signing secret (optional)' },
  'resend.webhook_secret': { env: 'RESEND_WEBHOOK_SECRET', label: 'Resend webhook signing secret (optional)' },
  'apify.token': { env: 'APIFY_TOKEN', label: 'Apify token' },
  'pixabay.api_key': { env: 'PIXABAY_API_KEY', label: 'Pixabay API key' },
  'discord.bot_token': { env: 'DISCORD_BOT_TOKEN', label: 'Discord bot token' },
  'vercel.token': { env: 'VERCEL_TOKEN', label: 'Vercel token' },
  'supabase.database_url': { env: 'DATABASE_URL', label: 'Supabase Postgres URL' },
  'supabase.service_role_key': { env: 'SUPABASE_SERVICE_ROLE_KEY', label: 'Supabase service-role key' },
  'voyage.api_key': { env: 'VOYAGE_API_KEY', label: 'Voyage AI key (optional embeddings)' },
} as const satisfies Record<string, { env: string; label: string }>;

export type SecretName = keyof typeof SECRETS;

export function isSecretName(n: string): n is SecretName {
  return Object.hasOwn(SECRETS, n);
}

/** Keychain port. The real adapter is `KeyringBackend`; tests use `MemoryKeyring`. */
export interface SecretBackend {
  get(name: string): string | null;
  set(name: string, value: string): void;
  delete(name: string): boolean;
}

export class MemoryKeyring implements SecretBackend {
  private readonly items = new Map<string, string>();
  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.items.set(k, v);
  }
  get(name: string): string | null {
    return this.items.get(name) ?? null;
  }
  set(name: string, value: string): void {
    this.items.set(name, value);
  }
  delete(name: string): boolean {
    return this.items.delete(name);
  }
  toJSON(): string {
    return '[MemoryKeyring]';
  }
  [inspect.custom](): string {
    return '[MemoryKeyring]';
  }
}

/** Reads nothing, writes nothing. Used where no Keychain exists (Vercel, tests). */
export class NullBackend implements SecretBackend {
  get(): string | null {
    return null;
  }
  set(): void {
    throw new Error('no secret backend available here');
  }
  delete(): boolean {
    return false;
  }
}

/** A secret value that refuses to print itself. `reveal()` is the only way to the raw string. */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    if (value === '') throw new Error('empty secret');
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return '[secret]';
  }
  toJSON(): string {
    return '[secret]';
  }
  [inspect.custom](): string {
    return '[secret]';
  }
}

export class SecretBackendError extends Error {
  override readonly name = 'SecretBackendError';
  constructor(
    readonly secretName: string,
    cause: unknown,
  ) {
    // The cause is the backend's error text, never a value (a failed read has no value).
    super(`keychain read of ${secretName} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export function writeSecret(backend: SecretBackend, name: SecretName, value: string): void {
  if (value.trim() === '' || value !== value.trim()) throw new Error('refusing an empty or whitespace-padded secret');
  backend.set(name, value);
}

export type SecretSource = 'env' | 'keychain';

/** Where a secret is available (env wins, as on Vercel), or null. Never returns the value. */
export function secretSource(
  name: SecretName,
  backend: SecretBackend,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SecretSource | null {
  const envValue = env[SECRETS[name].env];
  if (envValue !== undefined && envValue.trim() !== '') return 'env';
  try {
    const v = backend.get(name);
    return v !== null && v !== '' ? 'keychain' : null;
  } catch {
    return null;
  }
}

/** Reads a secret for a provider adapter: env first, then the Keychain. */
export function readSecret(
  name: SecretName,
  backend: SecretBackend,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Secret | null {
  const envValue = env[SECRETS[name].env];
  if (envValue !== undefined && envValue.trim() !== '') return new Secret(envValue);
  const v = backend.get(name);
  return v ? new Secret(v) : null;
}
