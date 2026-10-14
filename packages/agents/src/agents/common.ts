import type { ChatMessageRow } from '@ios/core';
import type { Caller, StudioServices } from '../contracts';

/** What an agent turn produced, before it is saved as a chat message. */
export interface AgentReply {
  text: string;
  /** agent_run id of the run that wrote the text (null for deterministic replies such as applying a confirmed change). */
  runId: string | null;
  mode: 'live' | 'fake';
  /** chat_message.meta extras (kind, feedback state, approval ids…). */
  meta: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DELAY = process.env.VITEST ? 0 : 12;

/** Streams already-composed text in small chunks (deterministic replies, so the panel behaves the same). */
export async function emitChunks(text: string, onText?: (delta: string) => void): Promise<void> {
  if (!onText) return;
  const parts = text.split(/(?<=\s)/);
  for (let i = 0; i < parts.length; i += 3) {
    onText(parts.slice(i, i + 3).join(''));
    if (DELAY) await sleep(DELAY);
  }
}

/** The recent conversation as plain text for the prompt (oldest first, capped). */
export function transcript(messages: readonly ChatMessageRow[], maxChars = 6000): string {
  const lines = messages.map((m) => {
    const who = m.role === 'owner' ? 'Owner' : m.author.replace(/^agent:/, '');
    return `${who}: ${m.body}`;
  });
  let out = lines.join('\n\n');
  while (out.length > maxChars && lines.length > 1) {
    lines.shift();
    out = lines.join('\n\n');
  }
  return out || '(no earlier messages)';
}

/** Names of the registry tools a caller may see, optionally limited to namespaces. */
export function toolNamesFor(services: StudioServices, caller: Caller, opts: { only?: readonly string[]; exclude?: readonly string[] } = {}): string[] {
  return services.tools
    .list({ caller })
    .map((t) => t.name)
    .filter((n) => !opts.only || opts.only.some((ns) => n.startsWith(`${ns}.`)))
    .filter((n) => !opts.exclude?.some((ns) => n.startsWith(`${ns}.`)))
    .sort();
}

export const today = (now: Date) => now.toISOString().slice(0, 10);
