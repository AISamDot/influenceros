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

/** Wraps text that is not the Owner's (feeds, research, other agents' posts) as data: see STUDIO_RULES. */
export function untrusted(source: string, text: string): string {
  const safe = text.replace(/<\/?\s*untrusted\b[^>]*>/gi, '[tag removed]');
  return `<untrusted source="${source.replace(/[^\w:. -]/g, '')}">\n${safe}\n</untrusted>`;
}

/**
 * The recent conversation as plain text for the prompt (oldest first, capped). Only the Owner's messages are
 * instructions; every other message (news briefings, notices, delegated answers, earlier agent replies) is fenced
 * as untrusted data, so a feed title or a persona manager's post can't steer an agent holding mutating tools.
 */
export function transcript(messages: readonly ChatMessageRow[], maxChars = 6000): string {
  const lines = messages.map((m) => {
    if (m.role === 'owner') return `Owner: ${m.body}`;
    const who = m.author.replace(/^agent:/, '');
    return `${who}:\n${untrusted(who, m.body)}`;
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
