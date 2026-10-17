import type { JobHandlerMap, ProviderEnv, ScheduledTask, ToolDef } from '@troupe/agents';
import type { Providers } from '@troupe/providers';
import { jobs as mediaJobs, schedules as mediaSchedules } from './jobs';
import { mediaLiveProviders } from './live';
import { tools as mediaTools } from './tools';

/**
 * @troupe/media (IOS-3 stream E; IOS-5 stream K adds the format-library templates, the compiler in every generation, the
 * production identity and the location lock): Higgsfield adapter (Soul ID, stills, activity clips, Seedance talking, cost probe),
 * ElevenLabs / Higgsfield TTS voice, the render worker for the 5 formats (FFmpeg + sharp), QC Q3/Q4 with ≤ 2 maker
 * fix loops, and the media.render job that hands finished posts to distribution. See docs/IOS-34-CONTRACTS.md.
 */
export * from './config';
export * from './toolkit';
export * from './qc';
export * from './read';
export { FakeFaceMatcher, FakeOcr, FakeToolkit, readManifest, type FakeManifest, type FakeRenderOverride } from './fake-toolkit';
export { FfmpegToolkit, resolveBins, videoArgs, parseEbur128, parseIntervals, gradeFilter } from './ffmpeg';
export { HiggsfieldCli, HiggsfieldCliError, HiggsfieldSeedanceTalking, HiggsfieldTtsVoice, isPreSubmissionError, jobCredits, parseCliJson, readJob, type Exec } from './higgsfield';
export { FalKlingAvatar } from './fal';
export { ElevenLabsVoice, mp3Seconds } from './voice';
export { AppleVisionFaces, AppleVisionOcr, appleVisionAvailable } from './vision';
export { mediaDeps, setMediaDeps, talkingProvider, type MediaDeps } from './deps';
export { ensureProfile, SOUL_ID_MAX_FAILURES, buildLookPack, buildProductionIdentity, characterBrief, getProfile, lockPersonaLocations, lookPromptsFor, parseLookPrompts, type MediaProfile } from './profile';
export { estimateCredits, hfSpend, probePrices, usdSpend, type SpendScope } from './spend';
export { renderSlot, type RenderOutcome } from './render';
export { MEDIA_JOB, MEDIA_SLOT_STATUSES, latestRenderPayload, parseRenderPayload, rerenderSlot, sweepStuckRenders } from './jobs';
export { mediaDir, mediaLiveProviders } from './live';

// StudioModule exports, composed by @troupe/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = mediaTools;
export const jobs: JobHandlerMap = mediaJobs;
export const schedules: readonly ScheduledTask[] = mediaSchedules;
export function liveProviders(env: ProviderEnv): Partial<Providers> {
  return mediaLiveProviders(env);
}
