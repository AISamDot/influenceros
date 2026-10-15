import type { MediaResolution, TalkingProvider } from '@ios/providers';
import { FAL_AVATAR_USD_PER_S } from './config';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const FAL_AVATAR_ENDPOINT = 'https://queue.fal.run/fal-ai/kling-video/ai-avatar/v2/standard';

/**
 * fal.ai Kling AI Avatar v2: the pluggable fallback talking provider (IOS_TALKING_PROVIDER=fal). Queue API: submit,
 * poll the status URL, read the result. The key travels only in the Authorization header. Billed in USD per second.
 */
export class FalKlingAvatar implements TalkingProvider {
  readonly name = 'fal-kling-avatar' as const;
  readonly #key: string;
  readonly #fetch: FetchFn;
  constructor(
    apiKey: string,
    private readonly opts: { fetch?: FetchFn; pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.#key = apiKey;
    this.#fetch = opts.fetch ?? ((i, init) => fetch(i, init));
  }

  private async call<T>(url: string, init: RequestInit = {}): Promise<T> {
    if (!/^https:\/\/(queue\.)?fal\.run\//.test(url)) throw new Error('fal: refusing a non-fal URL');
    const res = await this.#fetch(url, { ...init, headers: { Authorization: `Key ${this.#key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
    if (!res.ok) throw new Error(`fal ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  async render(req: { imageUrl: string; audioUrl: string; durationS: number; resolution?: MediaResolution; prompt?: string }) {
    const sub = await this.call<{ request_id: string; status_url?: string; response_url?: string }>(FAL_AVATAR_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({ image_url: req.imageUrl, audio_url: req.audioUrl, ...(req.prompt ? { prompt: req.prompt } : {}) }),
    });
    const base = `${FAL_AVATAR_ENDPOINT.replace(/\/standard$/, '')}/requests/${sub.request_id}`;
    const statusUrl = sub.status_url ?? `${base}/status`;
    const responseUrl = sub.response_url ?? base;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + (this.opts.timeoutMs ?? 15 * 60_000);
    for (;;) {
      const s = await this.call<{ status: string }>(statusUrl);
      if (s.status === 'COMPLETED') break;
      if (/FAIL|ERROR|CANCEL/i.test(s.status)) throw new Error(`fal avatar ${sub.request_id}: ${s.status}`);
      if (Date.now() > deadline) throw new Error(`fal avatar ${sub.request_id}: timed out`);
      await sleep(this.opts.pollMs ?? 4000);
    }
    const out = await this.call<{ video?: { url?: string }; duration?: number }>(responseUrl);
    if (!out.video?.url) throw new Error(`fal avatar ${sub.request_id}: no video URL`);
    const durationS = Number(out.duration ?? req.durationS);
    return { jobId: sub.request_id, url: out.video.url, durationS, credits: 0, costUsd: Math.round(durationS * FAL_AVATAR_USD_PER_S * 100) / 100 };
  }
}
