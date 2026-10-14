import type { Providers } from '@ios/providers';
import type { JobHandlerMap, ProviderEnv, ScheduledTask, ToolDef } from './contracts';
import { A_JOBS, A_SCHEDULES } from './jobs';
import { AnthropicLlm } from './live/anthropic';
import { ResendEmail } from './live/resend';
import { A_TOOLS } from './tools';

/**
 * @ios/agents: the IOS-2 contracts (frozen, contracts.ts) plus the agent runtime, tool registry, Studio Manager
 * and Persona Manager (stream A).
 */
export * from './contracts';
export * from './defaults';
export { createToolRegistry, ownerAsked } from './registry';
export { createFakeRuntime, createLiveRuntime, createServices, pickEngine, RUN_CAP_USD, runAgent, type RunOptions, type StudioRuntime } from './runtime';
export { AnthropicLlm, isAnthropicLlm } from './live/anthropic';
export { ResendEmail } from './live/resend';
export { AgentOutputError, AgentRefusalError, type Engine, type EngineRequest, type EngineResult } from './live/engine';
export { createMessagesEngine, type MessagesClient, type MessageStreamLike } from './live/messages-engine';
export { createAgentSdkEngine, DISALLOWED_BUILTINS, type AgentSdk } from './live/agent-sdk-engine';
export { acceptOwnerMessage, newMessageId, type OwnerTurn, respondToOwner } from './chat';
export { isUntrustedMessage, transcript, turnTrust } from './agents/common';
export { personaManagerAnswer, personaManagerTurn, proposalText, statusText } from './agents/persona-manager';
export { overviewText, studioManagerTurn } from './agents/studio-manager';
export { STUDIO_RULES } from './agents/prompts';
export {
  applyFeedback,
  BIBLE_SECTIONS,
  type FeedbackProposal,
  heuristicClassify,
  logFeedback,
  parseClassification,
  pendingFeedback,
  rejectFeedback,
  reviseBible,
} from './feedback';
export { FEEDBACK_EFFECTS_JOB, measureFeedbackEffects, RECOVER_PUBLISHING_JOB } from './jobs';
export { A_TOOLS } from './tools';
export { ToolInputError } from './tools/schema';

// StudioModule exports, composed by @ios/wiring.
export const tools: ReadonlyArray<ToolDef<any, any>> = A_TOOLS;
export const jobs: JobHandlerMap = A_JOBS;
export const schedules: readonly ScheduledTask[] = A_SCHEDULES;

/** Live adapters stream A owns: `llm` (Anthropic) and `email` (Resend, for the Owner's sign-in links). */
export function liveProviders(env: ProviderEnv): Partial<Providers> {
  const out: { -readonly [K in keyof Providers]?: Providers[K] } = {};
  if (env.isLive('anthropic')) {
    const key = env.secret('anthropic.api_key');
    if (key) out.llm = new AnthropicLlm({ apiKey: key });
  }
  if (env.isLive('resend')) {
    const key = env.secret('resend.api_key');
    if (key) out.email = new ResendEmail({ apiKey: key });
  }
  return out;
}
