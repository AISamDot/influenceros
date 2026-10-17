import { inspect } from 'node:util';
import type { EmailProvider } from '@troupe/providers';

/**
 * Live Resend adapter (REST: POST https://api.resend.com/emails). IOS-2 uses it for the Owner's sign-in links;
 * IOS-4 builds lists and sequences on the same provider. The key stays inside this object.
 */
export class ResendEmail implements EmailProvider {
  readonly name = 'resend';
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(opts: { apiKey: string; fetch?: typeof fetch }) {
    if (!opts.apiKey) throw new Error('ResendEmail needs an API key');
    this.#apiKey = opts.apiKey;
    this.#fetch = opts.fetch ?? fetch;
  }

  async send(req: { from: string; to: string; subject: string; html: string; tags?: Record<string, string> }): Promise<{ id: string }> {
    const res = await this.#fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: req.from,
        to: [req.to],
        subject: req.subject,
        html: req.html,
        ...(req.tags ? { tags: Object.entries(req.tags).map(([name, value]) => ({ name, value })) } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (!res.ok || !body.id) throw new Error(`resend: ${res.status} ${body.name ?? ''} ${body.message ?? ''}`.trim());
    return { id: body.id };
  }

  toJSON(): string {
    return '[ResendEmail]';
  }
  [inspect.custom](): string {
    return '[ResendEmail]';
  }
}
