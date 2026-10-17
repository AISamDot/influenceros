import type { ChatMessageRow } from '@troupe/core';
import type { Caller, RunTrust, StudioServices } from '../contracts';

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

/** Wraps third-party text (feeds, research, comments, other agents' posts) as data: see STUDIO_RULES. */
export function untrusted(source: string, text: string): string {
  const safe = text.replace(/<\/?\s*untrusted\b[^>]*>/gi, '[tag removed]');
  return `<untrusted source="${source.replace(/[^\w:. -]/g, '')}">\n${safe}\n</untrusted>`;
}

/** Message kinds that carry outside text even when an agent posts them (a News Desk briefing, a relayed comment or DM). */
const THIRD_PARTY_KINDS = new Set(['briefing', 'news', 'comment', 'dm', 'research', 'web']);

/**
 * Whether a chat message is third-party text for `self` (the agent reading the thread): anything but the Owner's
 * messages and this agent's own earlier replies, plus any message that relays outside text (briefings, comments, DMs,
 * research). Other agents' posts count as third-party: they can relay a feed or a comment.
 */
export function isUntrustedMessage(m: Pick<ChatMessageRow, 'role' | 'author' | 'meta'>, self: string | null = null): boolean {
  if (m.role === 'owner') return false;
  const meta = (m.meta ?? {}) as Record<string, unknown>;
  if (meta.untrusted === true || (typeof meta.kind === 'string' && THIRD_PARTY_KINDS.has(meta.kind))) return true;
  return !self || m.author !== `agent:${self}`;
}

/**
 * The recent conversation as plain text for the prompt (oldest first, capped). The Owner's messages are instructions
 * and `self`'s own earlier replies are its own words (so the Owner's "yes" to its proposal reads as a yes); every
 * third-party message (news briefings, comments, DMs, research, other agents' posts) is fenced as untrusted data.
 */
export function transcript(messages: readonly ChatMessageRow[], self: string | null = null, maxChars = 6000): string {
  const lines = messages.map((m) => {
    if (m.role === 'owner') return `Owner: ${m.body}`;
    const who = m.author.replace(/^agent:/, '');
    if (!isUntrustedMessage(m, self)) return `You (${who}): ${m.body}`;
    return `${who}:\n${untrusted(who, m.body)}`;
  });
  let out = lines.join('\n\n');
  while (out.length > maxChars && lines.length > 1) {
    lines.shift();
    out = lines.join('\n\n');
  }
  return out || '(no earlier messages)';
}

/**
 * The provenance of an Owner chat turn for `self`: untrusted when the thread holds third-party text; the Owner's
 * message is the turn's instruction; `self`'s own reply just before it is what an Owner "yes" confirms.
 */
export function turnTrust(history: readonly ChatMessageRow[], self: string, ownerText: string): RunTrust {
  const last = history.at(-1);
  return {
    untrusted: history.some((m) => isUntrustedMessage(m, self)),
    ownerText,
    proposal: last && last.role !== 'owner' && !isUntrustedMessage(last, self) ? last.body : null,
  };
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
