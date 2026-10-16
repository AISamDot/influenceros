import * as agents from '@ios/agents';
import { createServices, type JobHandlerMap, type ProviderEnv, type ScheduledTask, type StudioModule, type StudioServices, type ToolDef } from '@ios/agents';
import * as commerce from '@ios/commerce';
import * as content from '@ios/content';
import type { Db } from '@ios/db';
import * as distribution from '@ios/distribution';
import * as formats from '@ios/formats';
import * as generator from '@ios/generator';
import * as knowledge from '@ios/knowledge';
import * as media from '@ios/media';
import * as production from '@ios/production';
import * as products from '@ios/products';
import * as profit from '@ios/profit';
import * as radar from '@ios/radar';
import * as world from '@ios/world';
import { createFakeProviders, type Providers } from '@ios/providers';
import { defaultBackend, integrationStates, isSecretName, readSecret, type SecretBackend } from '@ios/secrets';

/**
 * @ios/wiring: the composition root. The web app, the cron tick and the worker build their services here, so no
 * stream edits a shared file to plug in its tools, jobs, schedules, live adapters or policies: each package
 * exports them from its own index (StudioModule) and this file composes them all (IOS-2: agents, content, knowledge,
 * profit; IOS-3/4: media, distribution, commerce, products; the generator; IOS-5: radar, world, production, formats).
 * Owned by the integrator; streams don't edit it (docs/IOS-2-CONTRACTS.md §3, docs/IOS-34-CONTRACTS.md §3, docs/IOS-5-CONTRACTS.md §3).
 */
export type ModuleName =
  | 'agents'
  | 'content'
  | 'knowledge'
  | 'profit'
  | 'media'
  | 'distribution'
  | 'commerce'
  | 'products'
  | 'generator'
  | 'radar'
  | 'world'
  | 'production'
  | 'formats';
export const MODULES: Readonly<Record<ModuleName, StudioModule>> = {
  agents,
  content,
  knowledge,
  profit,
  media,
  distribution,
  commerce,
  products,
  generator,
  radar,
  world,
  production,
  formats,
};

function mergeUnique<T>(kind: string, entries: Array<[string, T]>): Map<string, T> {
  const out = new Map<string, T>();
  for (const [name, v] of entries) {
    if (out.has(name)) throw new Error(`duplicate ${kind}: ${name}`);
    out.set(name, v);
  }
  return out;
}

export function allTools(): Array<ToolDef<any, any>> {
  const all = Object.values(MODULES).flatMap((m) => m.tools.map((t) => [t.name, t] as [string, ToolDef<any, any>]));
  return [...mergeUnique('tool', all).values()];
}

export function allJobs(): JobHandlerMap {
  const all = Object.values(MODULES).flatMap((m) => Object.entries(m.jobs));
  return Object.fromEntries(mergeUnique('job kind', all));
}

export function allSchedules(): ScheduledTask[] {
  const all = Object.values(MODULES).flatMap((m) => m.schedules.map((s) => [s.name, s] as [string, ScheduledTask]));
  return [...mergeUnique('schedule', all).values()];
}

/** ProviderEnv over @ios/secrets: env vars win, then the Keychain; IOS_FAKE_PROVIDERS forces fakes. */
export function providerEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  backend: SecretBackend = defaultBackend(env),
): ProviderEnv {
  const live = new Set(integrationStates(backend, env).filter((s) => s.mode === 'live').map((s) => s.def.id));
  return {
    isLive: (id) => live.has(id),
    secret: (name) => (isSecretName(name) ? (readSecret(name, backend, env)?.reveal() ?? null) : null),
  };
}

/** Fakes for everything, overlaid with each package's live adapters (each stream owns distinct members). */
export function resolveProviders(penv: ProviderEnv = providerEnv()): Providers {
  const overlays = Object.entries(MODULES).map(([name, m]) => [name, m.liveProviders(penv)] as const);
  const seen = new Map<string, string>();
  for (const [name, o] of overlays) {
    for (const key of Object.keys(o)) {
      if (seen.has(key)) throw new Error(`provider ${key} supplied by both ${seen.get(key)} and ${name}`);
      seen.set(key, name);
    }
  }
  return Object.assign({}, createFakeProviders(), ...overlays.map(([, o]) => o)) as Providers;
}

/**
 * The production services: every package's tools, C's knowledge service, D's cadence and routing policies, and the
 * IOS-5 services (I's Radar, J's world, K's prompt compiler, L's Format Plans).
 */
export function createStudioServices(
  db: Db,
  opts: { mode?: 'auto' | 'live' | 'fake'; providers?: Providers; now?: () => Date } = {},
): StudioServices {
  return createServices({
    db,
    providers: opts.providers ?? resolveProviders(),
    mode: opts.mode ?? 'auto',
    tools: allTools(),
    knowledge: knowledge.createKnowledgeService,
    cadence: profit.createCadencePolicy,
    routing: profit.createRoutingPolicy,
    radar: radar.createRadarService,
    world: world.createWorldService,
    prompts: production.createPromptCompiler,
    formatPlans: formats.createFormatPlanService,
    now: opts.now,
  });
}
