import { audit } from '@ios/core';
import { type Caller, type ToolContext, type ToolDef, ToolPermissionError, type ToolRegistry } from './contracts';

/**
 * Tool registry with permissions enforced in code (PRD §8.4), not in the prompt:
 * - unknown tools and Owner-only tools are refused for agents and the system;
 * - `callers` is an allowlist;
 * - persona-scoped tools need `persona_id`: a persona-scoped caller may only pass its own, and the persona must
 *   belong to the caller's studio.
 * - the caller and the actor must agree on whether this is the Owner (an agent can't borrow Owner authority);
 * - successful `mutates` calls are audited.
 * Stream A owns this file and may harden it; the ToolRegistry signature is frozen (contracts.ts).
 */
const NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
