import { createHash } from 'node:crypto';
import type { MediaStore, VoiceProvider } from '@troupe/providers';
import { ELEVENLABS_MODEL, ELEVENLABS_USD_PER_CHAR } from './config';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const ELEVENLABS_API = 'https://api.elevenlabs.io/v1';

/** Duration of a constant-bitrate MP3 from its size (ElevenLabs mp3_44100_128). */
export const mp3Seconds = (bytes: number, kbps = 128): number => Math.round(((bytes * 8) / (kbps * 1000)) * 100) / 100;

/**
 * ElevenLabs (Creator plan) on the existing `elevenlabs.api_key`: Voice Design for each persona's synthetic voice and
 * TTS for every voice track. The MP3 goes into the media store; `publish` (the Higgsfield upload when Higgsfield is
 * live) turns it into an https URL that Seedance (`--audio`) and Q2's Speech-to-Text can fetch. The key travels only
 * in the `xi-api-key` header.
 */
export class ElevenLabsVoice implements VoiceProvider {
  readonly name = 'elevenlabs';
  readonly #key: string;
  readonly #fetch: FetchFn;
  constructor(
    apiKey: string,
    private readonly store: MediaStore,
    private readonly opts: { fetch?: FetchFn; publish?: (filePath: string) => Promise<string> } = {},
  ) {
    this.#key = apiKey;
    this.#fetch = opts.fetch ?? ((i, init) => fetch(i, init));
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const res = await this.#fetch(`${ELEVENLABS_API}${path}`, { method: 'POST', headers: { 'xi-api-key': this.#key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`ElevenLabs ${path.split('?')[0]} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return res;
  }

  async designVoice(req: { description: string }) {
    const description = req.description.slice(0, 1000);
    const sample =
      'Hi, I am an AI creator. Every week I share small, practical ideas you can use today. Comment the keyword and I will send you the free guide. Let us keep it simple and do the next right thing.';
    const previews = (await (await this.post('/text-to-voice/create-previews', { voice_description: description, text: sample })).json()) as { previews?: Array<{ generated_voice_id: string }> };
    const gen = previews.previews?.[0]?.generated_voice_id;
    if (!gen) throw new Error('ElevenLabs Voice Design returned no preview');
    const voice = (await (await this.post('/text-to-voice/create-voice-from-preview', { voice_name: description.slice(0, 40), voice_description: description, generated_voice_id: gen })).json()) as { voice_id?: string };
    if (!voice.voice_id) throw new Error('ElevenLabs Voice Design returned no voice id');
    return { voiceId: voice.voice_id };
  }

  async tts(req: { voiceId: string; text: string; modelId?: string }) {
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(req.voiceId)) throw new Error('ElevenLabs: invalid voice id');
    const res = await this.post(`/text-to-speech/${req.voiceId}?output_format=mp3_44100_128`, { text: req.text, model_id: req.modelId ?? ELEVENLABS_MODEL });
    const data = new Uint8Array(await res.arrayBuffer());
    const key = `media/voice/${req.voiceId}/${createHash('sha256').update(req.text).digest('hex').slice(0, 16)}.mp3`;
    const stored = await this.store.put({ key, data, contentType: 'audio/mpeg' });
    let url = stored.url;
    if (this.opts.publish) {
      const file = await this.store.localPath(key);
      if (file) url = await this.opts.publish(file);
    }
    return { url, durationS: mp3Seconds(data.byteLength), characters: req.text.length, costUsd: Math.round(req.text.length * ELEVENLABS_USD_PER_CHAR * 10000) / 10000 };
  }
}
