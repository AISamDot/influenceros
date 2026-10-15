// `pnpm knowledge <command>`: Field Brain, News Desk, persona import and skills commands (IOS-2 stream C).
//
// Commands that cost money queue jobs by default; the worker runs them with the Keychain keys. `--inline` runs here
// instead, with live research only when ANTHROPIC_API_KEY is set in this shell (the CLI never reads the Keychain).
// Local PGlite allows one process per data dir: while `pnpm dev` runs these commands refuse (lock), so stop it first or set DATABASE_URL.
import { createServices, type ProviderEnv, type StudioServices } from '@ios/agents';
import { getStudio, OWNER } from '@ios/core';
import { type Db, exitOnOpenError, openDb } from '@ios/db';
import { migrate } from '@ios/db/migrate';
import { createFakeProviders, type Providers } from '@ios/providers';
import { buildFieldBrain, fieldBrainStatus } from './field-brain';
import { embedPending } from './embed';
import { knowledgeLiveProviders } from './live';
import { buildBriefing, scanNiche } from './news';
import { importPersonas, personasSourceDir, syncPersonaDocs } from './personas';
import { createKnowledgeService } from './service';
import { validateSkills } from './skills';
import { requestFieldBrainBuild, requestNewsScan } from './requests';

const HELP = `pnpm knowledge <command>

  status [niche]                     Field Brain coverage per niche
  build <niche> [--inline] [--max-nodes N]
                                     map, plan and research a niche (queues jobs unless --inline)
  embed                              embed nodes and news that have no vector for the current model
  retrieve <niche> <query…>          what content agents get back for a query
  scan <niche> [--inline]            News Desk scan (inline also writes today's briefings)
  brief <persona-slug> [--force]     write a persona's morning briefing now
  personas sync [--from <dir>]       copy the persona documents into packages/knowledge/seed/personas
  personas import [--dir <dir>]      add new personas / new bible versions to the studio
  skills check                       validate .claude/skills (frontmatter, no tool grants, no shell lines)`;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--') && ['--max-nodes', '--from', '--dir'].includes(args[i - 1]!)));

/** Env-only ProviderEnv for the CLI (the worker and the web app use @ios/wiring, which also reads the Keychain). */
const envOnly: ProviderEnv = {
  isLive: (id) => id === 'anthropic' && !!process.env.ANTHROPIC_API_KEY,
  secret: (name) => (name === 'anthropic.api_key' ? process.env.ANTHROPIC_API_KEY ?? null : name === 'voyage.api_key' ? process.env.VOYAGE_API_KEY ?? null : null),
};

function services(db: Db): StudioServices {
  const providers = { ...createFakeProviders(), ...knowledgeLiveProviders(envOnly) } as Providers;
  return createServices({ db, providers, mode: 'auto', knowledge: createKnowledgeService });
}

async function withDb<T>(fn: (db: Db, studioId: string) => Promise<T>): Promise<T> {
  const db = await openDb().catch((err) => exitOnOpenError('knowledge', err));
  try {
    await migrate(db);
    const studio = await getStudio(db);
    return await fn(db, studio.id);
  } finally {
    await db.close();
  }
}

const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

async function main(): Promise<void> {
  const [cmd, sub] = positional;
  switch (cmd) {
    case 'status':
      return withDb(async (db, studioId) => print(await fieldBrainStatus(services(db), studioId, sub)));
    case 'build': {
      if (!sub) throw new Error('usage: pnpm knowledge build <niche> [--inline]');
      const maxNodes = opt('--max-nodes') ? Number(opt('--max-nodes')) : undefined;
      return withDb(async (db, studioId) => {
        if (flag('--inline')) return print(await buildFieldBrain(services(db), { studioId, niche: sub, maxNodes, inline: true }));
        const job = await requestFieldBrainBuild(db, { studioId, niche: sub, maxNodes, actor: OWNER });
        print({ queued: !!job, job: job?.id ?? 'already queued' });
      });
    }
    case 'embed':
      return withDb(async (db) => print(await embedPending(services(db), { limit: 5000 })));
    case 'retrieve': {
      const query = positional.slice(2).join(' ');
      if (!sub || !query) throw new Error('usage: pnpm knowledge retrieve <niche> <query…>');
      return withDb(async (db, studioId) => print(await services(db).knowledge.retrieve({ studioId, niche: sub, query, k: 5 })));
    }
    case 'scan': {
      if (!sub) throw new Error('usage: pnpm knowledge scan <niche> [--inline]');
      return withDb(async (db, studioId) => {
        if (!flag('--inline')) {
          const job = await requestNewsScan(db, { studioId, niche: sub, actor: OWNER });
          return print({ queued: !!job });
        }
        const s = services(db);
        const summary = await scanNiche(s, { studioId, niche: sub, queueBriefings: false });
        const personas = await db.query<{ id: string; slug: string }>(`SELECT id, slug FROM persona WHERE studio_id = $1 AND lower(niche) = lower($2) AND state NOT IN ('PROPOSED','KILLED','RETIRED')`, [studioId, sub]);
        const briefings = [];
        for (const p of personas) briefings.push({ slug: p.slug, items: (await buildBriefing(s, { personaId: p.id }))?.briefing.items.length ?? 0 });
        print({ ...summary, briefings });
      });
    }
    case 'brief': {
      if (!sub) throw new Error('usage: pnpm knowledge brief <persona-slug> [--force]');
      return withDb(async (db) => {
        const p = await db.one<{ id: string }>('SELECT id FROM persona WHERE slug = $1', [sub]);
        print((await buildBriefing(services(db), { personaId: p.id, force: flag('--force') }))?.briefing ?? null);
      });
    }
    case 'personas': {
      if (sub === 'sync') {
        const from = opt('--from') ?? process.env.IOS_PERSONAS_SOURCE;
        if (!from) throw new Error('usage: pnpm knowledge personas sync --from <dir> (or set IOS_PERSONAS_SOURCE)');
        return print({ copied: syncPersonaDocs(from) });
      }
      if (sub === 'import') {
        return withDb(async (db, studioId) => print(await importPersonas(services(db), { studioId, dir: opt('--dir') ?? personasSourceDir() })));
      }
      throw new Error('usage: pnpm knowledge personas sync|import');
    }
    case 'skills': {
      const problems = validateSkills();
      print(problems.length ? problems : 'all 10 skills OK');
      if (problems.length) process.exitCode = 1;
      return;
    }
    default:
      console.log(HELP);
      if (cmd && cmd !== 'help') process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[knowledge] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
