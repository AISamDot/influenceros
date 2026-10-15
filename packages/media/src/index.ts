import type { JobHandlerMap, ProviderEnv, ScheduledTask, ToolDef } from '@ios/agents';
import type { Providers } from '@ios/providers';
import { jobs as mediaJobs, schedules as mediaSchedules } from './jobs';
import { mediaLiveProviders } from './live';
import { tools as mediaTools } from './tools';

/**
 * @ios/media (IOS-3 stream E): Higgsfield adapter (Soul ID, stills, activity clips, Seedance talking, cost probe),
 * ElevenLabs / Higgsfield TTS voice, the render worker for the 5 formats (FFmpeg + sharp), QC Q3/Q4 with ≤ 2 maker
 * fix loops, and the media.render job that hands finished posts to distribution. See docs/IOS-34-CONTRACTS.md.
 */
export * from './config';
export * from './toolkit';
export * from './qc';
export * from './read';
export { FakeFaceMatcher, FakeOcr, FakeToolkit, readManifest, type FakeManifest, type FakeRenderOverride } from './fake-toolkit';
export { FfmpegToolkit, resolveBins, videoArgs, parseEbur128, parseIntervals, gradeFilter } from './ffmpeg';
export { HiggsfieldCli, HiggsfieldSeedanceTalking, HiggsfieldTtsVoice, parseCliJson, readJob, type Exec } from './higgsfield';
export { FalKlingAvatar } from './fal';
export { ElevenLabsVoice, mp3Seconds } from './voice';
export { AppleVisionFaces, AppleVisionOcr, appleVisionAvailable } from './vision';
export { mediaDeps, setMediaDeps, talkingProvider, type MediaDeps } from './deps';
export { ensureProfile, buildLookPack, getProfile, lookPromptsFor, parseLookPrompts, type MediaProfile } from './profile';
export { estimateCredits, probePrices } from './spend';
export { renderSlot, type RenderOutcome } from './render';
export { MEDIA_JOB, MEDIA_SLOT_STATUSES, latestRenderPayload, parseRenderPayload, rerenderSlot, sweepStuckRenders } from './jobs';
export { mediaDir, mediaLiveProviders } from './live';

// StudioModule exports, composed by @ios/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = mediaTools;
export const jobs: JobHandlerMap = mediaJobs;
export const schedules: readonly ScheduledTask[] = mediaSchedules;
export function liveProviders(env: ProviderEnv): Partial<Providers> {
  return mediaLiveProviders(env);
}
