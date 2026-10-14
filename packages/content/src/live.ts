import type { ProviderEnv } from '@ios/agents';
import type { Providers, TranscribeProvider, TranscriptWord } from '@ios/providers';

/**
 * Live adapters stream B owns. `transcribe` (QC Q2) runs on ElevenLabs Speech-to-Text (Scribe): Whisper-style word
 * timestamps from the same key the voice uses (`elevenlabs.api_key`), so no extra account. It goes live only when
 * the ElevenLabs integration is live (key present, live adapter enabled, IOS_FAKE_PROVIDERS not set); otherwise the
 * FakeTranscriber reads back what FakeVoice synthesised.
 */

/** ElevenLabs Scribe list price, USD per audio hour (check the current price list when the plan changes). */
export const STT_USD_PER_HOUR = 0.4;
export const ELEVENLABS_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

interface ScribeWord {
  text?: string;
  start?: number;
  end?: number;
  type?: 'word' | 'spacing' | 'audio_event';
}

export class ElevenLabsTranscriber implements TranscribeProvider {
  readonly name = 'elevenlabs-scribe';
  readonly #apiKey: string;
  readonly #fetch: FetchFn;
  constructor(
    apiKey: string,
    fetchFn: FetchFn = (i, init) => fetch(i, init),
    private readonly model = 'scribe_v1',
  ) {
    this.#apiKey = apiKey;
    this.#fetch = fetchFn;
  }

  async transcribe(req: { audioUrl: string; language?: 'en'; prompt?: string }) {
    let url: URL;
    try {
      url = new URL(req.audioUrl);
    } catch {
      throw new Error('transcribe: audioUrl is not a URL');
    }
    if (url.protocol !== 'https:') throw new Error('transcribe: audioUrl must be https');
    const audio = await this.#fetch(url.toString());
    if (!audio.ok) throw new Error(`transcribe: audio download failed (${audio.status})`);
    const form = new FormData();
    form.set('model_id', this.model);
    form.set('file', await audio.blob(), 'voice.mp3');
    form.set('language_code', req.language ?? 'en');
    form.set('timestamps_granularity', 'word');
    form.set('tag_audio_events', 'false');
    const res = await this.#fetch(ELEVENLABS_STT_URL, { method: 'POST', headers: { 'xi-api-key': this.#apiKey }, body: form });
    if (!res.ok) throw new Error(`ElevenLabs speech-to-text failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { text?: string; words?: ScribeWord[] };
    const words: TranscriptWord[] = (body.words ?? [])
      .filter((w) => (w.type ?? 'word') === 'word' && typeof w.text === 'string')
      .map((w) => ({ word: w.text!.trim(), startS: Number(w.start ?? 0), endS: Number(w.end ?? w.start ?? 0) }));
    const durationS = words.at(-1)?.endS ?? 0;
    return { text: (body.text ?? '').trim(), words, durationS, costUsd: Math.round((durationS / 3600) * STT_USD_PER_HOUR * 1e6) / 1e6 };
  }
}

export function contentLiveProviders(env: ProviderEnv): Partial<Providers> {
  if (!env.isLive('elevenlabs')) return {};
  const key = env.secret('elevenlabs.api_key');
  return key ? { transcribe: new ElevenLabsTranscriber(key) } : {};
}
