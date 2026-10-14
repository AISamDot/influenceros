import { randomUUID } from 'node:crypto';
import {
  addMessage,
  BudgetExceededError,
  type ChatMessageRow,
  type ChatThreadRow,
  composeAgentReply,
  getThread,
  listMessages,
  NotFoundError,
  postOwnerMessage,
} from '@ios/core';
import type { AgentName, StudioServices } from './contracts';
import { type AgentReply, emitChunks, today, toolNamesFor, transcript } from './agents/common';
import { personaManagerAnswer, personaManagerTurn } from './agents/persona-manager';
import { STUDIO_RULES_BLOCK } from './agents/prompts';
import { studioManagerTurn } from './agents/studio-manager';
import { AgentRefusalError, errorMessage } from './live/engine';
import { runAgent } from './runtime';

/**
 * Owner chat (PRD §3.9, FR-16.1): every thread kind gets a real agent reply. Studio → Studio Manager (plus the
 * managers of any @mentioned personas), persona → that persona's manager (feedback loop), Monetization and
 * Quality → the thread's agent with its tools. Replies stream through `onText` and are saved as chat messages
 * (role 'agent', author 'agent:<name>', meta.kind / runId / fake).
 */
export interface OwnerTurn {
  owner: ChatMessageRow;
  /** The main reply (saved with `replyId` when given, so the API can send its id before streaming). */
  reply: ChatMessageRow;
  /** Extra replies in the same thread (@mentioned persona managers). */
  extra: ChatMessageRow[];
}

/** Stores the Owner's message (validates it). Call before streaming so a bad message is a 400, not a broken stream. */
export async function acceptOwnerMessage(services: StudioServices, threadId: string, body: string): Promise<{ thread: ChatThreadRow; owner: ChatMessageRow }> {
  const thread = await getThread(services.db, threadId);
  if (!thread) throw new NotFoundError('thread not found');
  const owner = await postOwnerMessage(services.db, threadId, body);
  return { thread, owner };
}

const THREAD_TOOLS: Partial<Record<string, readonly string[]>> = {
  'monetization-agent': ['monetization', 'gate', 'calendar', 'persona', 'studio', 'profit'],
  'quality-control': ['qc', 'gate', 'persona'],
};
const THREAD_SYSTEM: Partial<Record<string, string>> = {
  'monetization-agent':
    'You are the Monetization Agent of an AI influencer studio: what gets sold, at what price and when, per persona. Numbers first, brief. Real demand signals only; no fake scarcity; prices within each persona band. English only. Use your tools for data.',
  'quality-control':
    'You are the Quality Control agent of an AI influencer studio: studio-wide quality standards from script (Q1) to final (Q4). Brief, specific, numbers first. English only. Use your tools for data.',
};

/** Generates and saves the agent side of an Owner turn. Never throws for agent failures: it replies with a notice. */
export async function respondToOwner(
  services: StudioServices,
  input: { thread: ChatThreadRow; owner: ChatMessageRow; replyId?: string; onText?: (delta: string) => void },
): Promise<OwnerTurn> {
  const { db } = services;
  const { thread, owner } = input;
  const history = (await listMessages(db, thread.id, 14)).filter((m) => m.id !== owner.id);
  const mentions = ((owner.meta?.mentions ?? []) as Array<{ id: string; slug: string; name: string }>).slice(0, 3);
  let r: AgentReply;
  let agent = thread.agent as AgentName;
  try {
    if (thread.kind === 'studio') {
      agent = 'studio-manager';
      r = await studioManagerTurn(services, { studioId: thread.studio_id, threadId: thread.id, text: owner.body, history, mentions, onText: input.onText });
    } else if (thread.kind === 'persona' && thread.persona_id) {
      agent = 'persona-manager';
      r = await personaManagerTurn(services, { personaId: thread.persona_id, threadId: thread.id, text: owner.body, history, onText: input.onText });
    } else {
      r = await threadAgentTurn(services, thread, owner.body, history, input.onText);
    }
  } catch (err) {
    r = await failureReply(services, err, input.onText);
  }
  const reply = await addMessage(db, {
    id: input.replyId,
    threadId: thread.id,
    role: 'agent',
    author: `agent:${agent}`,
    body: r.text || '(no reply)',
    personaId: thread.persona_id,
    meta: { kind: 'reply', ...r.meta, runId: r.runId, fake: r.mode === 'fake', mode: r.mode },
  });

  const extra: ChatMessageRow[] = [];
  if (thread.kind === 'studio') {
    for (const m of mentions) {
      input.onText?.(`\n\n${m.name}'s manager:\n`);
      let a: AgentReply;
      try {
        a = await personaManagerAnswer(services, {
          personaId: m.id,
          question: owner.body,
          from: 'owner-mention',
          costRef: { type: 'chat_thread', id: thread.id },
          onText: input.onText,
        });
      } catch (err) {
        a = await failureReply(services, err, input.onText);
      }
      extra.push(
        await addMessage(db, {
          threadId: thread.id,
          role: 'agent',
          author: 'agent:persona-manager',
          body: a.text,
          personaId: m.id,
          meta: { kind: 'reply', ...a.meta, personaId: m.id, personaName: m.name, runId: a.runId, fake: a.mode === 'fake', mode: a.mode },
        }),
      );
    }
  }
  return { owner, reply, extra };
}

/** Monetization and Quality threads: run the thread's agent with its namespaces' tools (B's when merged). */
async function threadAgentTurn(
  services: StudioServices,
  thread: ChatThreadRow,
  text: string,
  history: readonly ChatMessageRow[],
  onText?: (delta: string) => void,
): Promise<AgentReply> {
  const agent = thread.agent as AgentName;
  const fakeText = await composeAgentReply(services.db, thread, text);
  const res = await runAgent(
    services,
    {
      agent,
      scope: { studioId: thread.studio_id, personaId: null },
      label: `chat: ${thread.kind}`,
      system: THREAD_SYSTEM[agent] ?? 'You are an agent of an AI influencer studio. Brief, numbers first, English only.',
      cached: [STUDIO_RULES_BLOCK],
      prompt: [`Today is ${today(services.now())}.`, `Conversation so far:\n${transcript(history)}`, `The Owner says: ${text}`].join('\n\n'),
      tools: toolNamesFor(services, agent, { only: THREAD_TOOLS[agent] ?? [] }),
      maxTokens: 1500,
      fake: () => fakeText,
      costRef: { type: 'chat_thread', id: thread.id },
    },
    { onText },
  );
  return { text: res.text, runId: res.runId, mode: services.runtime.mode, meta: { kind: 'reply' } };
}

/** A short notice instead of a reply when the run is refused (budget), declined (refusal) or fails. */
async function failureReply(services: StudioServices, err: unknown, onText?: (delta: string) => void): Promise<AgentReply> {
  let text: string;
  if (err instanceof BudgetExceededError) {
    text = `I can't run right now: the ${err.details.scope} LLM cap for this month is used up ($${err.details.used.toFixed(2)} of $${err.details.cap.toFixed(2)}). Raise the cap in Settings or approve more spend, and ask again.`;
  } else if (err instanceof AgentRefusalError) {
    text = "I can't help with that one. Try rephrasing, or ask for something else.";
  } else {
    console.error('[chat] agent turn failed:', err);
    text = `Something went wrong on my side (${errorMessage(err).slice(0, 160)}). Nothing was changed; try again.`;
  }
  await emitChunks(text, onText);
  return { text, runId: null, mode: services.runtime.mode, meta: { kind: 'notice', error: true } };
}

/** A fresh id for the reply message, sent as x-message-id before streaming starts. */
export const newMessageId = (): string => randomUUID();
