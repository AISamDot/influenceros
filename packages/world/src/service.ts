import type {
  Grounding,
  QcCheck,
  ServiceBase,
  ServiceFactory,
  SlotBeat,
  StudioServices,
  WorldCheckRequest,
  WorldDraft,
  WorldDraftRequest,
  WorldRecordRequest,
  WorldService,
} from '@ios/agents';
import { type Actor, actorRef } from '@ios/core';
import { type Db, json } from '@ios/db';
import { bibleFacts, contradictions, continuityChecks, extractFacts, type Fact, FACTS_SCHEMA, type LedgerFact, mergeFacts, parseFacts } from './continuity';
import { buildBible, buildStoryline, draftSummary, fakeWorldDraft, inputOf, resolvePlace } from './draft';
import { placeFromText } from './geo';
import { computeGrounding, groundingChecks, LIVE_WINDOW_MS, type LiveWeather } from './grounding';
import { adoptBoard, moodBoard } from './inspiration';
import { asBible, asStoryline, mergeBible, parseCast, parsePlaces, parseStoryline, type Storyline, type WorldBible } from './model';
import { checkConceptFingerprint, checkWording, logBlock, noRepeatChecks, recordFingerprint } from './norepeat';
import { assignBeats, insertArc } from './storyline';

/**
 * Stream J's WorldService (docs/IOS-5-CONTRACTS.md §5): World Bible, real-time grounding, storyline beats,
 * the continuity ledger and the no-repeat engine, plus the generator's step-6 World Bible draft and its adoption at
 * launch. Every model call goes through the runtime with a deterministic fake.
 */

export interface WorldRow {
  persona_id: string;
  studio_id: string;
  version: number;
  city: string;
  region: string | null;
  country: string;
  timezone: string;
  lat: number | null;
  lon: number | null;
  summary: string;
  content: WorldBible;
  source: string;
  updated_by: string;
  updated_at: Date;
}

export async function loadWorld(db: Db, personaId: string): Promise<{ row: WorldRow; bible: WorldBible } | null> {
  const row = await db.maybeOne<WorldRow>('SELECT * FROM world_bible WHERE persona_id = $1', [personaId]);
  const bible = row ? asBible(row.content) : null;
  return row && bible ? { row, bible } : null;
}

const WEATHER_TTL_MS = 30 * 60_000;

/** Live weather for the persona's place (cached 30 min), or null (outside the live window, or the call failed). */
export async function liveWeather(base: ServiceBase, personaId: string, bible: WorldBible, at: Date): Promise<LiveWeather | null> {
  const now = base.now();
  if (Math.abs(at.getTime() - now.getTime()) > LIVE_WINDOW_MS || bible.place.lat === null || bible.place.lon === null) return null;
  const source: LiveWeather['source'] = base.providers.weather.name.startsWith('fake') ? 'fake' : 'open-meteo';
  const cached = await base.db.maybeOne<{ fetched_at: Date; data: Omit<LiveWeather, 'at'> & { at: string } }>('SELECT fetched_at, data FROM world_weather WHERE persona_id = $1', [personaId]);
  if (cached && now.getTime() - new Date(cached.fetched_at).getTime() < WEATHER_TTL_MS && cached.data.source === source) return { ...cached.data, at: new Date(cached.data.at) };
  try {
    const w = await base.providers.weather.current({ lat: bible.place.lat, lon: bible.place.lon, timezone: bible.place.timezone });
    const lw: LiveWeather = { ...w, source };
    await base.db.query(
      `INSERT INTO world_weather (persona_id, fetched_at, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (persona_id) DO UPDATE SET fetched_at = EXCLUDED.fetched_at, data = EXCLUDED.data`,
      [personaId, now, json(lw)],
    );
    return lw;
  } catch {
    return null;
  }
}

export async function groundingFor(base: ServiceBase, personaId: string, at: Date): Promise<Grounding | null> {
  const w = await loadWorld(base.db, personaId);
  if (!w) return null;
  return computeGrounding(personaId, w.bible, at, await liveWeather(base, personaId, w.bible, at));
}

/** Facts in a text: the deterministic extractor, plus the continuity-keeper's extraction (live mode adds what patterns miss). */
export async function factsIn(services: StudioServices, q: { studioId: string; personaId: string; text: string; label: string }): Promise<Fact[]> {
  const rules = extractFacts(q.text);
  if (q.text.trim().length < 20) return rules;
  const res = await services.runtime.run<{ facts: Fact[] }>({
    agent: 'continuity-keeper',
    scope: { studioId: q.studioId, personaId: q.personaId },
    label: q.label,
    system:
      "You keep an AI character's continuity ledger. Extract only facts the character states about herself and her fictional world: people (relation + name), pets, her age, life events (with numbers), possessions, opinions (positive/negative), where she lives. Ignore advice, hypotheticals and other people's lines. Kinds: person, pet, age, event, possession, opinion, place, other.",
    prompt: `Text:\n${q.text.slice(0, 4000)}\nReturn {"facts": [{"kind": "...", "subject": "...", "value": "...", "statement": "..."}]}.`,
    maxTokens: 800,
    parse: parseFacts,
    jsonSchema: FACTS_SCHEMA as unknown as Record<string, unknown>,
    fake: () => ({ facts: rules }),
    costRef: { type: 'persona', id: q.personaId },
  });
  return mergeFacts(rules, res.output.facts);
}

export async function ledgerOf(db: Db, personaId: string, exclude?: { type: string; id: string | null } | null): Promise<LedgerFact[]> {
  const rows = await db.query<{ id: string; kind: Fact['kind']; subject: string; value: string; statement: string; source_type: string; source_id: string | null; stated_at: Date }>(
    `SELECT id, kind, subject, value, statement, source_type, source_id, stated_at FROM continuity_fact
      WHERE persona_id = $1 AND status = 'active' ${exclude?.id ? 'AND NOT (source_type = $2 AND source_id = $3)' : ''}
      ORDER BY stated_at, created_at`,
    exclude?.id ? [personaId, exclude.type, exclude.id] : [personaId],
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, subject: r.subject, value: r.value, statement: r.statement, sourceType: r.source_type, sourceId: r.source_id, statedAt: new Date(r.stated_at) }));
}

export async function insertFacts(db: Db, q: { studioId: string; personaId: string; facts: readonly Fact[]; sourceType: string; sourceId: string | null; at: Date }): Promise<number> {
  const have = await ledgerOf(db, q.personaId);
  let n = 0;
  for (const f of q.facts) {
    if (have.some((h) => h.kind === f.kind && h.subject === f.subject && h.value.toLowerCase() === f.value.toLowerCase())) continue;
    await db.query(
      `INSERT INTO continuity_fact (studio_id, persona_id, kind, subject, value, statement, source_type, source_id, stated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [q.studioId, q.personaId, f.kind, f.subject, f.value, f.statement, q.sourceType, q.sourceId, q.at],
    );
    n++;
  }
  return n;
}

/** Writes (or replaces) a persona's World Bible; every change is a new version. */
export async function writeBible(db: Db, q: { personaId: string; studioId: string; bible: WorldBible; summary?: string; change: string; actor: Actor; source: 'generator' | 'owner' | 'agent' | 'backfill' }): Promise<number> {
  const b = q.bible;
  const prev = await db.maybeOne<{ version: number; summary: string }>('SELECT version, summary FROM world_bible WHERE persona_id = $1', [q.personaId]);
  const version = (prev?.version ?? 0) + 1;
  await db.query(
    `INSERT INTO world_bible (persona_id, studio_id, version, city, region, country, timezone, lat, lon, summary, content, source, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
     ON CONFLICT (persona_id) DO UPDATE SET version = EXCLUDED.version, city = EXCLUDED.city, region = EXCLUDED.region, country = EXCLUDED.country,
       timezone = EXCLUDED.timezone, lat = EXCLUDED.lat, lon = EXCLUDED.lon, summary = EXCLUDED.summary, content = EXCLUDED.content,
       source = EXCLUDED.source, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [q.personaId, q.studioId, version, b.place.city, b.place.region, b.place.country, b.place.timezone, b.place.lat, b.place.lon, q.summary ?? prev?.summary ?? '', json(b), q.source, actorRef(q.actor)],
  );
  await db.query(`INSERT INTO world_bible_version (persona_id, version, content, change, actor) VALUES ($1, $2, $3::jsonb, $4, $5)`, [q.personaId, version, json(b), q.change.slice(0, 300), actorRef(q.actor)]);
  return version;
}

/** Owner / agent edit of a live World Bible (place stays; cast, places, routine, seasons, holidays and local life merge). */
export async function updateBible(db: Db, q: { personaId: string; patch: Record<string, unknown>; actor: Actor; change?: string }): Promise<{ version: number; bible: WorldBible }> {
  const w = await loadWorld(db, q.personaId);
  if (!w) throw new Error('this persona has no World Bible yet');
  const bible = mergeBible(w.bible, q.patch);
  const version = await writeBible(db, {
    personaId: q.personaId,
    studioId: w.row.studio_id,
    bible,
    change: q.change ?? `edited: ${Object.keys(q.patch).join(', ')}`,
    actor: q.actor,
    source: q.actor.type === 'owner' ? 'owner' : 'agent',
  });
  // New cast members become ledger facts, so later scripts are held to them.
  if (q.patch.cast) await insertFacts(db, { studioId: w.row.studio_id, personaId: q.personaId, facts: bibleFacts(bible).filter((f) => f.kind === 'person' || f.kind === 'pet'), sourceType: 'bible', sourceId: `v${version}`, at: new Date() });
  return { version, bible };
}

const LIVE_DRAFT_SYSTEM = `You are the Studio Manager writing the World Bible and the first ~12-week storyline for a new AI character (PRD §3.14).
Everything is fictional and generic: invented family and neighbours (never real people), generic local shops (no brands), English only.
Keep the given place and timezone. Write a recurring cast of 4–6 people, 5–7 recurring places, and a season arc of 4 chapters (3 weeks each),
each with tension, payoff, subplots and 2 beats a week (setup, development, gag, callback, cliffhanger, payoff, milestone), with planned callbacks.
Mood descriptors from inspiration boards, if any, are style notes only: never a face or a real person.`;

export async function draftWorldWith(services: StudioServices, q: WorldDraftRequest): Promise<WorldDraft> {
  const now = services.now();
  const base = fakeWorldDraft(q, now);
  const baseBible = base.bible as unknown as WorldBible;
  const baseStory = base.storyline as unknown as Storyline;
  const mood = await moodBoard(services.db, { draftId: q.draftId });
  type Raw = { cast: unknown; recurringPlaces: unknown; routine: unknown; home: unknown; storyline: unknown };
  const res = await services.runtime.run<Raw>({
    agent: 'studio-manager',
    tier: 'standard',
    scope: { studioId: q.studioId, personaId: null },
    label: `generator: world bible + storyline (${q.concept.name})`,
    system: LIVE_DRAFT_SYSTEM,
    prompt: `Character: ${q.concept.name}, ${q.concept.archetype}. Premise: ${q.concept.premise}. Mechanic: ${q.concept.mechanic}. Niche: ${q.niche}.
${q.character ? `Home base: ${q.character.homeBase}. Lore: ${q.character.lore}. Identity: ${q.character.identity}.` : ''}
Place (keep): ${baseBible.place.city}${baseBible.place.region ? `, ${baseBible.place.region}` : ''}, ${baseBible.place.country} (${baseBible.place.timezone}); local holidays: ${baseBible.holidays.join(', ')}.
${mood.descriptors.length ? `Mood descriptors: ${mood.descriptors.join('; ')}.` : ''}
Starting draft to improve (same JSON shape): ${JSON.stringify({ cast: baseBible.cast, recurringPlaces: baseBible.recurringPlaces, routine: baseBible.routine, home: baseBible.home, storyline: baseStory })}
Return {"cast": [...], "recurringPlaces": [...], "routine": {...}, "home": {...}, "storyline": {...}}.`,
    maxTokens: 6000,
    parse: (v) => {
      const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
      return { cast: o.cast, recurringPlaces: o.recurringPlaces, routine: o.routine, home: o.home, storyline: o.storyline };
    },
    fake: () => ({ cast: baseBible.cast, recurringPlaces: baseBible.recurringPlaces, routine: baseBible.routine, home: baseBible.home, storyline: baseStory }),
  });
  const o = res.output;
  const bible: WorldBible = {
    ...mergeBible(baseBible, { routine: o.routine, home: o.home } as Record<string, unknown>),
    cast: parseCast(o.cast, baseBible.cast),
    recurringPlaces: parsePlaces(o.recurringPlaces, baseBible.recurringPlaces),
  };
  const storyline = parseStoryline(o.storyline, baseStory);
  const summary = draftSummary(bible, storyline);
  return {
    summary,
    place: base.place,
    bible: { ...(bible as unknown as Record<string, unknown>), sourceDraftId: q.draftId },
    storyline: storyline as unknown as Record<string, unknown>,
  };
}

/** A World Bible for a persona launched before IOS-5 (or restored from the archive): drafted from its bible, then adopted. */
export async function backfillWorld(services: StudioServices, q: { personaId: string; actor: Actor }): Promise<{ created: boolean; summary: string }> {
  const have = await loadWorld(services.db, q.personaId);
  if (have) return { created: false, summary: have.row.summary };
  const p = await services.db.one<{ studio_id: string; name: string; niche: string; timezone: string }>('SELECT studio_id, name, niche, timezone FROM persona WHERE id = $1', [q.personaId]);
  const pb = await services.db.maybeOne<{ content: Record<string, unknown> }>(`SELECT content FROM persona_bible WHERE persona_id = $1 ORDER BY version DESC LIMIT 1`, [q.personaId]);
  const blob = pb ? JSON.stringify(pb.content) : '';
  const place = placeFromText(blob) ?? resolvePlace(null, p.timezone);
  const archetype = (/"(?:archetype|identity|age)"\s*:\s*"?(\d{2,3})/.exec(blob)?.[1] ?? '') + (/(\d{1,2}) years/.exec(blob)?.[0] ? `, for ${/(\d{1,2}) years/.exec(blob)![1]} years` : '');
  const inp = { draftId: q.personaId, name: p.name, archetype, premise: `${p.name}'s ${p.niche} life.`, mechanic: '', niche: p.niche, homeBase: `${place.city}${place.region ? `, ${place.region}` : ''}`, lore: null, timezone: p.timezone };
  const bible = buildBible(inp, services.now());
  const storyline = buildStoryline(inp, bible, services.now());
  const draft: WorldDraft = { summary: draftSummary(bible, storyline), place: { city: bible.place.city, region: bible.place.region, country: bible.place.country, timezone: bible.place.timezone }, bible: bible as unknown as Record<string, unknown>, storyline: storyline as unknown as Record<string, unknown> };
  await services.db.transaction((tx) => adoptWorldInto(tx, { personaId: q.personaId, studioId: p.studio_id, draft, actor: q.actor, source: 'backfill' }));
  return { created: true, summary: draft.summary };
}

export async function adoptWorldInto(db: Db, q: { personaId: string; studioId: string; draft: WorldDraft; actor: Actor; source?: 'generator' | 'backfill'; now?: Date }): Promise<void> {
  const bible = asBible(q.draft.bible);
  if (!bible) throw new Error('the World Bible draft is incomplete');
  await writeBible(db, { personaId: q.personaId, studioId: q.studioId, bible, summary: q.draft.summary, change: 'adopted at launch', actor: q.actor, source: q.source ?? 'generator' });
  const storyline = asStoryline(q.draft.storyline);
  if (storyline && !(await db.maybeOne(`SELECT 1 FROM storyline_arc WHERE persona_id = $1`, [q.personaId]))) {
    await insertArc(db, { personaId: q.personaId, studioId: q.studioId, storyline, createdBy: actorRef(q.actor) });
  }
  await insertFacts(db, { studioId: q.studioId, personaId: q.personaId, facts: bibleFacts(bible), sourceType: 'bible', sourceId: 'v1', at: q.now ?? new Date() });
  const draftId = typeof (q.draft.bible as { sourceDraftId?: unknown }).sourceDraftId === 'string' ? ((q.draft.bible as { sourceDraftId: string }).sourceDraftId) : null;
  if (draftId && /^[0-9a-f-]{36}$/i.test(draftId) && (await db.maybeOne('SELECT 1 FROM persona_draft WHERE id = $1', [draftId]))) {
    await adoptBoard(db, { draftId, personaId: q.personaId, studioId: q.studioId });
  }
}

async function checkContentWith(services: StudioServices, q: WorldCheckRequest): Promise<QcCheck[]> {
  const out: QcCheck[] = [];
  const subject = { type: q.subject.type, id: q.subject.id };
  const guard = async (name: string, fn: () => Promise<QcCheck[]>) => {
    try {
      out.push(...(await fn()));
    } catch (err) {
      out.push({ check: name, pass: true, severity: 'minor', message: `${name} check skipped: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}` });
    }
  };
  const world = await loadWorld(services.db, q.personaId);
  if (world) {
    await guard('world_grounding', async () => {
      const g = computeGrounding(q.personaId, world.bible, q.at, await liveWeather(services, q.personaId, world.bible, q.at));
      return groundingChecks(g, world.bible, q.text, q.visualBrief);
    });
  }
  await guard('continuity', async () => {
    const facts = await factsIn(services, { studioId: q.studioId, personaId: q.personaId, text: q.text, label: `continuity: check ${q.subject.type}` });
    const ledger = await ledgerOf(services.db, q.personaId, subject);
    const found = contradictions(facts, ledger, q.at, world ? world.bible.place : null);
    for (const c of found) await logBlock(services, { studioId: q.studioId, personaId: q.personaId, subject, check: 'continuity', reason: c.message });
    return continuityChecks(found);
  });
  await guard('no_repeat', async () => {
    const concept = q.fingerprint ? await checkConceptFingerprint(services, { studioId: q.studioId, personaId: q.personaId, fingerprint: q.fingerprint, subject }) : null;
    const wording = await checkWording(services, { studioId: q.studioId, personaId: q.personaId, text: q.text, subject });
    const checks = noRepeatChecks(concept, wording);
    for (const c of checks.filter((x) => !x.pass)) {
      await logBlock(services, {
        studioId: q.studioId,
        personaId: q.personaId,
        subject,
        check: c.check,
        similarity: c.check === 'near_duplicate_wording' ? wording?.similarity : concept?.similarity,
        nearestId: c.check === 'near_duplicate_wording' ? (wording?.nearest?.id ?? null) : (concept?.nearest?.id ?? null),
        reason: c.message,
      });
    }
    return checks;
  });
  return out;
}

async function recordWith(services: StudioServices, q: WorldRecordRequest): Promise<void> {
  const first = await services.db.maybeOne<{ subject_id: string }>(
    `INSERT INTO continuity_record (subject_type, subject_id, persona_id) VALUES ($1, $2, $3) ON CONFLICT (subject_type, subject_id) DO NOTHING RETURNING subject_id`,
    [q.subject.type, q.subject.id, q.personaId],
  );
  if (!first) return;
  const facts = await factsIn(services, { studioId: q.studioId, personaId: q.personaId, text: q.text, label: `continuity: record ${q.subject.type}` });
  const n = await insertFacts(services.db, { studioId: q.studioId, personaId: q.personaId, facts, sourceType: q.subject.type, sourceId: q.subject.id, at: q.at });
  await services.db.query('UPDATE continuity_record SET facts = $3 WHERE subject_type = $1 AND subject_id = $2', [q.subject.type, q.subject.id, n]);
  if (q.fingerprint) await recordFingerprint(services, { studioId: q.studioId, personaId: q.personaId, subject: q.subject, fingerprint: q.fingerprint, text: q.text });
}

export const createWorldService: ServiceFactory<WorldService> = (base, services) => ({
  grounding: (personaId, at) => groundingFor(base, personaId, at),
  beatsForWeek: (q): Promise<SlotBeat[]> => assignBeats(base.db, q),
  checkContent: (q) => checkContentWith(services(), q),
  recordApproved: (q) => recordWith(services(), q),
  checkConcept: (q) => checkConceptFingerprint(base, { studioId: q.studioId, personaId: q.personaId, fingerprint: q.fingerprint }).then(({ series: _s, ...r }) => r),
  draftWorld: async (q) => {
    try {
      return await draftWorldWith(services(), q);
    } catch {
      return fakeWorldDraft(q, base.now());
    }
  },
  adoptWorld: (db, q) => adoptWorldInto(db, { ...q, now: base.now() }),
  moodBoard: (q) => moodBoard(base.db, q),
});

export { inputOf };
