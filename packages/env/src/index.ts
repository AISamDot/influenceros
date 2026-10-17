/**
 * Troupe House environment switches. Every studio switch is `TROUPE_<NAME>`; the pre-rename `IOS_<NAME>` (Influencer
 * OS) is still read as a fallback for one release so existing shells, `.env.local` files and Vercel projects keep
 * working. Read switches only through `troupeEnv`, never `process.env.TROUPE_…` directly.
 */
export type Env = Readonly<Record<string, string | undefined>>;

export const ENV_PREFIX = 'TROUPE_';
/** Deprecated prefix, read as a fallback only. */
export const LEGACY_ENV_PREFIX = 'IOS_';

/**
 * `TROUPE_<name>`, else the legacy `IOS_<name>`. A blank value (e.g. a `TROUPE_AUTH=` line copied from .env.example)
 * does not hide a non-blank legacy one; when both are blank the new name's value is returned. `name` is given without
 * a prefix (`'FAKE_PROVIDERS'`); a prefixed name is accepted too.
 */
export function troupeEnv(name: string, env: Env = process.env): string | undefined {
  const bare = name.startsWith(ENV_PREFIX) ? name.slice(ENV_PREFIX.length) : name.startsWith(LEGACY_ENV_PREFIX) ? name.slice(LEGACY_ENV_PREFIX.length) : name;
  const current = env[`${ENV_PREFIX}${bare}`];
  const legacy = env[`${LEGACY_ENV_PREFIX}${bare}`];
  if (current !== undefined && current.trim() !== '') return current;
  if (legacy !== undefined && legacy.trim() !== '') return legacy;
  return current ?? legacy;
}

/** Deployed (Vercel, or `TROUPE_DEPLOYED=1` elsewhere): local-only conveniences are refused. */
export const isDeployed = (env: Env = process.env): boolean => Boolean(env.VERCEL) || troupeEnv('DEPLOYED', env) === '1';

/** The studio's public domain. Persona sites live at `https://<slug>.troupehouse.com`. */
export const DEFAULT_STUDIO_DOMAIN = 'troupehouse.com';

/**
 * The studio domain persona sites are served on (`<slug>.<domain>`), lower-cased without stray dots, or null when
 * sites are served at `/p/<slug>` on the app itself. `TROUPE_STUDIO_DOMAIN` wins; deployed without it the default is
 * troupehouse.com; locally (not deployed) it stays unset so sites live at /p/<slug>. `TROUPE_STUDIO_DOMAIN=off` turns
 * persona hosts off even when deployed.
 */
export function studioDomain(env: Env = process.env): string | null {
  const configured = troupeEnv('STUDIO_DOMAIN', env)?.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (configured === 'off') return null;
  if (configured) return configured;
  return isDeployed(env) ? DEFAULT_STUDIO_DOMAIN : null;
}
