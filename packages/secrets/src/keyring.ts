import { troupeEnv } from '@troupe/env';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FallbackBackend, KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE, NullBackend, type SecretBackend, SecretBackendError } from './store';

/**
 * The macOS Keychain adapter over `@napi-rs/keyring` (Brand OS pattern): account = secret name. Loaded lazily, so
 * importing this module never touches the Keychain. `/usr/bin/security` is never used (a value on its argv would
 * show in `ps`).
 */
export interface EntryLike {
  getPassword(): string | null | undefined;
  setPassword(v: string): void;
  deletePassword(): boolean | undefined;
}
export interface KeyringModule {
  Entry: new (service: string, account: string) => EntryLike;
}

function loadKeyring(): KeyringModule {
  // Resolve from this package first; fall back to the app's cwd (bundled server code).
  const bases = [import.meta.url, join(process.cwd(), 'noop.js')];
  let lastErr: unknown;
  for (const base of bases) {
    try {
      return createRequire(base)('@napi-rs/keyring') as KeyringModule;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export class KeyringBackend implements SecretBackend {
  /** `mod` is for tests (a scripted `Entry`); production loads `@napi-rs/keyring` lazily on first use. */
  constructor(
    readonly service: string = KEYCHAIN_SERVICE,
    private mod: KeyringModule | null = null,
  ) {}

  private entry(name: string): EntryLike {
    this.mod ??= loadKeyring();
    return new this.mod.Entry(this.service, name);
  }

  /** null for a missing item; anything thrown (locked keychain, ACL denial) surfaces as SecretBackendError. */
  get(name: string): string | null {
    try {
      return this.entry(name).getPassword() ?? null;
    } catch (err) {
      throw new SecretBackendError(name, err);
    }
  }

  set(name: string, value: string): void {
    this.entry(name).setPassword(value);
  }

  delete(name: string): boolean {
    try {
      return this.entry(name).deletePassword() !== false;
    } catch {
      return false;
    }
  }

  toJSON(): string {
    return `[KeyringBackend ${this.service}]`;
  }
}

/**
 * The backend the app uses: the Keychain on macOS; nothing elsewhere (Vercel reads env vars) and never under
 * Vitest, so tests can't touch the real Keychain. `TROUPE_KEYCHAIN=off` disables it. Reads fall back to the legacy
 * Influencer OS service (`ai.influencer-os`) for items not yet migrated; writes go to `ai.troupe-house` only.
 */
export function defaultBackend(env: Readonly<Record<string, string | undefined>> = process.env): SecretBackend {
  if (env.VITEST || env.NODE_ENV === 'test' || troupeEnv('KEYCHAIN', env) === 'off' || process.platform !== 'darwin') {
    return new NullBackend();
  }
  return new FallbackBackend(new KeyringBackend(KEYCHAIN_SERVICE), new KeyringBackend(LEGACY_KEYCHAIN_SERVICE));
}
