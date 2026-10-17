// `pnpm --filter @troupe/distribution zernio:check` (or `pnpm distribution zernio-check`): a live, read-only smoke test of
// the Zernio key. GET /accounts, /profiles and /usage only; prints counts and platforms, never ids, handles, names or
// the key. Any non-GET request is refused before it leaves the process. Opens no database.
import { defaultBackend, readSecret } from '@troupe/secrets';
import { ZernioPublisher, type ZernioSnapshot } from './zernio';

/** A fetch that only lets GET through: the check can never create, edit or delete anything. */
export function getOnlyFetch(inner: typeof fetch = fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET') return Promise.reject(new Error(`zernio:check is read-only; refused ${method}`));
    return inner(input, init);
  }) as typeof fetch;
}

/** The printable report: counts and platform names only. */
export function formatSnapshot(s: ZernioSnapshot): string {
  const platforms = Object.entries(s.accountsByPlatform)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, n]) => `${p} ${n}`)
    .join(', ');
  const u = s.usage;
  const usage = [
    u.connectedAccounts !== null ? `connected accounts ${u.connectedAccounts}` : null,
    u.uploads !== null ? `uploads ${u.uploads}${u.uploadsLimit !== null ? `/${u.uploadsLimit < 0 ? 'unlimited' : u.uploadsLimit}` : ''}` : null,
    u.profiles !== null ? `profiles ${u.profiles}${u.profilesLimit !== null ? `/${u.profilesLimit < 0 ? 'unlimited' : u.profilesLimit}` : ''}` : null,
  ].filter(Boolean);
  return [
    `Zernio (read-only check)`,
    `  accounts: ${s.accounts} (${s.activeAccounts} active)${platforms ? ` · ${platforms}` : ''}`,
    `  profiles: ${s.profiles}`,
    `  usage:    ${usage.length ? usage.join(' · ') : 'n/a'}`,
    ...(s.instagramNotFacebookLogin ? [`  warning:  ${s.instagramNotFacebookLogin} Instagram account(s) not on Facebook Login (reconnect choosing the Facebook option)`] : []),
  ].join('\n');
}

/** Reads the key from the Keychain (via @troupe/secrets), runs the GET-only snapshot and prints it. Exit code. */
export async function runZernioCheck(): Promise<number> {
  const backend = defaultBackend(process.env);
  const key = readSecret('zernio.api_key', backend, process.env)?.reveal() ?? null;
  if (!key) {
    console.error('zernio:check: no zernio.api_key (add it with `pnpm troupe secrets set zernio.api_key`)');
    return 1;
  }
  const z = new ZernioPublisher({ apiKey: key, fetch: getOnlyFetch(), baseUrl: process.env.ZERNIO_API_URL || undefined, timeoutMs: 20_000 });
  console.log(formatSnapshot(await z.snapshot()));
  return 0;
}

if (process.argv[1] && /zernio-check\.[cm]?[jt]s$/.test(process.argv[1])) {
  runZernioCheck().then(
    (code) => process.exit(code),
    (err) => {
      // Error text names the route and status only; the key is never part of it.
      console.error(`zernio:check failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
