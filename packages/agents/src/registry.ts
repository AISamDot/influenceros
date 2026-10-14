import { audit } from '@ios/core';
import { type Caller, type RunTrust, type ToolContext, type ToolDef, ToolPermissionError, type ToolRegistry } from './contracts';

/**
 * Tool registry with permissions enforced in code (PRD §8.4), not in the prompt:
 * - unknown tools and Owner-only tools are refused for agents and the system;
 * - `callers` is an allowlist;
 * - persona-scoped tools need `persona_id`: a persona-scoped caller may only pass its own, and the persona must
 *   belong to the caller's studio.
 * - the caller and the actor must agree on whether this is the Owner (an agent can't borrow Owner authority);
 * - a run whose context holds untrusted content (news, comments, web research, non-Owner messages: ctx.trust) may
 *   call a `mutates` tool only when the Owner asked for it in this turn (see ownerAsked); read-only tools stay;
 * - successful `mutates` calls are audited.
 * Stream A owns this file and may harden it; the ToolRegistry signature is frozen (contracts.ts).
 */
const NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An Owner's short yes to the agent's own proposal. */
const CONFIRM_RE = /^\s*(?:yes|yep|yeah|yup|ok(?:ay)?|sure|confirm(?:ed)?|approved?|do it|go ahead|go for it|please do|sounds good)\b/i;

/** A question never asks for a write: it ends with "?" or opens with a question word ("Give me an update on…"). */
const QUESTION_RE = /\?["'”’)\]]*\s*$|^\W*(?:what|how|why|when|where|who|whom|whose|which|give\s+me|show\s+me)\b/i;
/** A negator before the action verb: "Don't change Vivian's voice", "I won't lower her budget". */
const NEGATED_RE =
  /\b(?:don['’]?t|do\s+not|never(?!\s+mind)|no\s+need\s+to|won['’]?t|will\s+not|shouldn['’]?t|should\s+not|can['’]?t|cannot|mustn['’]?t|must\s+not|not\s+(?:yet|now))\b/i;

/** Sentences of a chat message: a sentence ends at . ! ? ; followed by a space, or at a line break. */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Whether `sentence` asks for the action: the intent (action verb … object) matches and no negator precedes it. */
function asksFor(intent: RegExp, sentence: string): boolean {
  const m = new RegExp(intent.source, intent.flags.replace(/[gy]/g, '')).exec(sentence);
  return m !== null && !NEGATED_RE.test(sentence.slice(0, m.index));
}

/**
 * Whether the Owner asked for this tool in the current turn: one sentence of the Owner's own message (dashboard
 * session) is a command that matches the tool's `ownerIntent` (an action verb plus the tool's object, e.g. "revise …
 * bible"), or the message is a "yes" to this agent's own proposal of it. Questions ("What's the budget looking
 * like?", "Give me an update on the news") and negated asks never count. Background and delegated runs carry no
 * Owner message, so in an untrusted context they never pass.
 */
export function ownerAsked(def: Pick<ToolDef, 'ownerIntent'>, trust: RunTrust): boolean {
  const owner = trust.ownerText?.trim();
  const intent = def.ownerIntent;
  if (!owner || !intent) return false;
  if (sentencesOf(owner).some((s) => !QUESTION_RE.test(s) && asksFor(intent, s))) return true;
  // The agent's proposal is usually a question ("Shall I pause TikTok?"); the Owner's "yes" makes it a command.
  return CONFIRM_RE.test(owner) && Boolean(trust.proposal) && sentencesOf(trust.proposal!).some((s) => asksFor(intent, s));
}

export function createToolRegistry(initial: ReadonlyArray<ToolDef<any, any>> = []): ToolRegistry {
  const defs = new Map<string, ToolDef<any, any>>();

  const visibleTo = (def: ToolDef<any, any>, caller: Caller): boolean => {
    if (def.ownerOnly && caller !== 'owner') return false;
    return !def.callers || def.callers.includes(caller);
  };

  const registry: ToolRegistry = {
    register(...list) {
      for (const def of list) {
        if (!NAME_RE.test(def.name)) throw new Error(`tool name must look like "namespace.verb": ${def.name}`);
        if (defs.has(def.name)) throw new Error(`duplicate tool: ${def.name}`);
        defs.set(def.name, def);
      }
    },
    get: (name) => defs.get(name),
    list(filter = {}) {
      return [...defs.values()].filter(
        (d) => (!filter.names || filter.names.includes(d.name)) && (!filter.caller || visibleTo(d, filter.caller)),
      );
    },
    async invoke(ctx: ToolContext, name: string, raw: unknown) {
      const def = defs.get(name);
      if (!def) throw new ToolPermissionError(`unknown tool: ${name}`);
      // The caller and the actor must agree: an agent (or the system) can never act with the Owner's authority.
      if ((ctx.caller === 'owner') !== (ctx.actor.type === 'owner')) {
        throw new ToolPermissionError(`caller ${ctx.caller} does not match actor ${ctx.actor.type}:${ctx.actor.id}`);
      }
      if (def.ownerOnly && (ctx.caller !== 'owner' || ctx.actor.type !== 'owner')) {
        throw new ToolPermissionError(`${name} is an Owner-only action`);
      }
      if (def.callers && !def.callers.includes(ctx.caller)) throw new ToolPermissionError(`${ctx.caller} may not call ${name}`);
      // Prompt injection: text from feeds, comments, the web or other agents can't drive a write. Enforced here, in code.
      if (def.mutates && ctx.caller !== 'owner' && ctx.trust?.untrusted && !ownerAsked(def, ctx.trust)) {
        throw new ToolPermissionError(
          `${name} is blocked in this run: its context holds untrusted content (news, comments, web research or a non-Owner message) and the Owner didn't ask for it in this turn. Propose it to the Owner instead.`,
        );
      }
      const input = def.parse(raw);
      let personaId: string | null = null;
      if (def.scope === 'persona') {
        const pid = (input as { persona_id?: unknown } | null)?.persona_id;
        if (typeof pid !== 'string' || !UUID_RE.test(pid)) throw new ToolPermissionError(`${name} needs a valid persona_id`);
        if (ctx.personaId !== null && pid !== ctx.personaId) {
          throw new ToolPermissionError(`${ctx.caller} is scoped to its own persona and may not act on ${pid}`);
        }
        const owned = await ctx.services.db.maybeOne('SELECT 1 FROM persona WHERE id = $1 AND studio_id = $2', [pid, ctx.studioId]);
        if (!owned) throw new ToolPermissionError(`persona ${pid} is not in this studio`);
        personaId = pid;
      }
      const out = await def.run(ctx, input);
      if (def.mutates) {
        await audit(ctx.services.db, {
          studioId: ctx.studioId,
          personaId: personaId ?? ctx.personaId,
          actor: ctx.actor,
          action: `tool.${name}`,
          entityType: 'tool',
          entityId: name,
        });
      }
      return out;
    },
  };
  registry.register(...initial);
  return registry;
}
