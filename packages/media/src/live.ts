import { join } from 'node:path';
import type { ProviderEnv } from '@ios/agents';
import { findRepoRoot } from '@ios/db';
import { LocalMediaStore, type MediaStore, type Providers } from '@ios/providers';
import { FalKlingAvatar } from './fal';
import { HiggsfieldCli, HiggsfieldSeedanceTalking, HiggsfieldTtsVoice } from './higgsfield';
import { ElevenLabsVoice } from './voice';

/**
 * Stream E's live members (docs/IOS-34-CONTRACTS.md §5.3): `storage` (local disk on the Mac), and with keys
 * `imageVideo` (Higgsfield CLI), `talking` (Seedance by default, fal Kling AI Avatar v2 with IOS_TALKING_PROVIDER=fal)
 * and `voice` (ElevenLabs; Higgsfield TTS with IOS_VOICE_PROVIDER=higgsfield). Nothing here is live without its key,
 * and Vitest always keeps the in-memory store and the fakes.
 */
export function mediaDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.IOS_MEDIA_DIR?.trim() || join(findRepoRoot(), '.data', 'media');
}

export function mediaLiveProviders(penv: ProviderEnv, env: Readonly<Record<string, string | undefined>> = process.env): Partial<Providers> {
  if (env.VITEST) return {};
  const out: { -readonly [K in keyof Providers]?: Providers[K] } = {};
  const storage: MediaStore = new LocalMediaStore(mediaDir(env));
  out.storage = storage;

  let hf: HiggsfieldCli | null = null;
  if (penv.isLive('higgsfield')) {
    const key = penv.secret('higgsfield.api_key');
    const secret = penv.secret('higgsfield.api_secret');
    if (key && secret) {
      hf = new HiggsfieldCli({ apiKey: key, apiSecret: secret });
      out.imageVideo = hf;
    }
  }

  const wantFal = env.IOS_TALKING_PROVIDER?.trim() === 'fal';
  const falKey = penv.isLive('fal') ? penv.secret('fal.api_key') : null;
  if (falKey && (wantFal || !hf)) out.talking = new FalKlingAvatar(falKey);
  else if (hf) out.talking = new HiggsfieldSeedanceTalking(hf);

  if (env.IOS_VOICE_PROVIDER?.trim() === 'higgsfield' && hf) out.voice = new HiggsfieldTtsVoice(hf);
  else if (penv.isLive('elevenlabs')) {
    const key = penv.secret('elevenlabs.api_key');
    // With Higgsfield live, voice tracks are uploaded there so Seedance (--audio) and Q2's STT get an https URL.
    if (key) out.voice = new ElevenLabsVoice(key, storage, hf ? { publish: async (filePath) => (await hf!.upload({ filePath, contentType: 'audio/mpeg' })).url } : {});
  }
  return out;
}
