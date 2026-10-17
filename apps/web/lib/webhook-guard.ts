import { isDeployed } from '@troupe/auth/guard';

const LOOPBACK = (host: string): boolean => {
  const h = host.replace(/:\d+$/, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
};

/**
 * A fake provider's webhook signing secret is a public constant, so fake-signed webhooks are accepted only on a local
 * machine reached on a loopback host: never when deployed, and never through a tunnel or a LAN address. With no
 * signing secret configured, a reachable server answers 404 (webhooks off) and the Owner sets the secret in Settings.
 */
export function fakeWebhooksRefused(providerName: string, req: Request, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (!providerName.startsWith('fake')) return false;
  if (isDeployed(env)) return true;
  const host = req.headers.get('host') ?? (() => {
    try {
      return new URL(req.url).host;
    } catch {
      return '';
    }
  })();
  const forwarded = req.headers.get('x-forwarded-host');
  return !LOOPBACK(host) || (!!forwarded && !LOOPBACK(forwarded));
}
