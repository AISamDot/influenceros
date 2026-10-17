// `pnpm world <command>`: stream J from the terminal (docs/IOS-5-CONTRACTS.md).
//
//   place <home base text>           the gazetteer's place for a home base (no database)
//   weather <city>                   Open-Meteo geocode + current weather (no key, no database; fake under TROUPE_FAKE_PROVIDERS)
//   show <persona-slug>              World Bible summary, today's grounding and the storyline
//   grounding <persona-slug> [--at <ISO time>]
//   facts <persona-slug>             the continuity ledger
//   backfill <persona-slug>          draft + adopt a World Bible for a persona that has none
//   steer <persona-slug> "<instruction>"
//
// With local PGlite only one process may open the data dir: use a scratch PGLITE_DIR, never the dev server's.
import { troupeEnv } from '@troupe/env';
import { createServices, type StudioServices } from '@troupe/agents';
import { OWNER } from '@troupe/core';
import { exitOnOpenError, openDb } from '@troupe/db';
import { migrate } from '@troupe/db/migrate';
import { createFakeProviders, type Providers } from '@troupe/providers';
import { placeFromText } from './geo';
import { liveProviders } from './index';
import { OpenMeteoWeather } from './live';
import { backfillWorld, createWorldService, groundingFor, ledgerOf, loadWorld } from './service';
import { storylineView } from './storyline';
import { WORLD_TOOLS } from './tools';
import { steerStoryline } from './upkeep';

const args = process.argv.slice(2);
const [cmd, ...rest] = args;
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const HELP = `pnpm world <command>

  place <home base text>           the gazetteer's place for a home base (no database)
  weather <city>                   Open-Meteo geocode + current weather (no key, no database)
  show <persona-slug>              World Bible, today's grounding and the storyline
  grounding <persona-slug> [--at <ISO time>]
  facts <persona-slug>             the continuity ledger
  backfill <persona-slug>          draft + adopt a World Bible for a persona that has none
  steer <persona-slug> "<instruction>"`;

const fakeForced = () => /(^|,)\s*(1|all|open-meteo)\s*(,|$)/.test(troupeEnv('FAKE_PROVIDERS') ?? '');

function providers(): Providers {
  const env = {
    isLive: (id: string) => (id === 'open-meteo' ? !fakeForced() : id === 'pinterest' ? !!process.env.PINTEREST_ACCESS_TOKEN && !fakeForced() : false),
    secret: (name: string) => (name === 'pinterest.access_token' ? (process.env.PINTEREST_ACCESS_TOKEN ?? null) : null),
  };
  return { ...createFakeProviders(), ...liveProviders(env) } as Providers;
}

async function withServices<T>(fn: (s: StudioServices) => Promise<T>): Promise<T> {
  const db = await openDb({ role: 'world-cli' }).catch((err) => exitOnOpenError('world', err));
  try {
    await migrate(db);
    return await fn(createServices({ db, providers: providers(), mode: 'auto', tools: WORLD_TOOLS, world: createWorldService }));
  } finally {
    await db.close();
  }
}

async function personaId(s: StudioServices, slug: string | undefined): Promise<string> {
  if (!slug) throw new Error('give a persona slug');
  const p = await s.db.maybeOne<{ id: string }>('SELECT id FROM persona WHERE slug = $1 ORDER BY created_at DESC LIMIT 1', [slug]);
  if (!p) throw new Error(`no persona "${slug}"`);
  return p.id;
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'place': {
      console.log(JSON.stringify(placeFromText(rest.join(' ')), null, 2));
      return;
    }
    case 'weather': {
      const w = fakeForced() ? createFakeProviders().weather : new OpenMeteoWeather();
      const [place] = await w.geocode({ name: rest.join(' ') || 'York' });
      if (!place) throw new Error('place not found');
      console.log(place, await w.current({ lat: place.lat, lon: place.lon, timezone: place.timezone }));
      return;
    }
    case 'show':
      return withServices(async (s) => {
        const id = await personaId(s, rest[0]);
        const w = await loadWorld(s.db, id);
        if (!w) return console.log('No World Bible yet (pnpm world backfill <slug>).');
        console.log(w.row.summary);
        console.log((await groundingFor(s, id, new Date()))?.block);
        const story = await storylineView(s.db, id, new Date());
        for (const c of story?.chapters ?? []) console.log(`- ${c.title} (weeks ${c.weeks.join('–')}): ${c.beats.length} beats`);
      });
    case 'grounding':
      return withServices(async (s) => {
        const at = opt('at') ? new Date(opt('at')!) : new Date();
        console.log(JSON.stringify(await groundingFor(s, await personaId(s, rest[0]), at), null, 2));
      });
    case 'facts':
      return withServices(async (s) => {
        for (const f of await ledgerOf(s.db, await personaId(s, rest[0]))) console.log(`${f.kind}\t${f.subject}\t${f.value}\t(${f.sourceType})`);
      });
    case 'backfill':
      return withServices(async (s) => console.log(await backfillWorld(s, { personaId: await personaId(s, rest[0]), actor: OWNER })));
    case 'steer':
      return withServices(async (s) => console.log(await steerStoryline(s, { personaId: await personaId(s, rest[0]), instruction: rest.slice(1).join(' '), actor: OWNER })));
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(`[world] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
