import { troupeEnv } from '@troupe/env';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StudioServices } from '@troupe/agents';
import { HiggsfieldSeedanceTalking } from './higgsfield';
import { FakeFaceMatcher, FakeOcr, FakeToolkit } from './fake-toolkit';
import { FfmpegToolkit, resolveBins } from './ffmpeg';
import type { FaceMatcher, MediaToolkit, OcrProvider } from './toolkit';
import { appleVisionAvailable, AppleVisionFaces, AppleVisionOcr } from './vision';
import type { TalkingProvider } from '@troupe/providers';

/**
 * The local tooling a render uses. Real FFmpeg + Apple Vision when the generations are real (a live Higgsfield
 * adapter) and the binaries resolve; otherwise the fakes, so the dev server without keys and every test still render
 * every format end to end. TROUPE_MEDIA_TOOLKIT=ffmpeg|fake forces one. Tests inject their own with `setMediaDeps`.
 */
export interface MediaDeps {
  readonly toolkit: MediaToolkit;
  readonly ocr: OcrProvider;
  readonly face: FaceMatcher;
  /** Scratch space for one render (files also go to `providers.storage`). */
  readonly workRoot: string;
}

const overrides = new WeakMap<object, Partial<MediaDeps>>();

/** Overrides the tooling for one services object (tests; the CLI's sample run). */
export function setMediaDeps(services: StudioServices, deps: Partial<MediaDeps>): void {
  overrides.set(services, deps);
}

export function mediaDeps(services: StudioServices, env: Readonly<Record<string, string | undefined>> = process.env): MediaDeps {
  const o = overrides.get(services) ?? {};
  const workRoot = o.workRoot ?? join(tmpdir(), 'troupe-media', 'work');
  const forced = troupeEnv('MEDIA_TOOLKIT', env)?.trim();
  const realGenerations = !services.providers.imageVideo.name.startsWith('fake');
  const bins = forced === 'fake' ? null : resolveBins(env);
  const real = !env.VITEST && bins !== null && (forced === 'ffmpeg' || realGenerations);
  const toolkit = o.toolkit ?? (real ? new FfmpegToolkit(bins!) : new FakeToolkit());
  const realTools = toolkit.name !== 'fake-toolkit' && appleVisionAvailable();
  return {
    toolkit,
    ocr: o.ocr ?? (realTools ? new AppleVisionOcr() : new FakeOcr()),
    face: o.face ?? (realTools ? new AppleVisionFaces() : new FakeFaceMatcher()),
    workRoot,
  };
}

/**
 * Talking clips go through Higgsfield Seedance by default (owner rule), via `providers.talking` when that is the
 * Seedance adapter, else on top of `providers.imageVideo`. TROUPE_TALKING_PROVIDER=fal switches to `providers.talking`
 * (the fal Kling AI Avatar v2 adapter when its key is present).
 */
export function talkingProvider(services: StudioServices, env: Readonly<Record<string, string | undefined>> = process.env): TalkingProvider {
  const t = services.providers.talking;
  if (troupeEnv('TALKING_PROVIDER', env)?.trim() === 'fal' || t.name === 'higgsfield-seedance') return t;
  return new HiggsfieldSeedanceTalking(services.providers.imageVideo);
}
