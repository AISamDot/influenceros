import type { StudioServices } from '@ios/agents';
import { type Actor, actorRef, audit } from '@ios/core';
import { buildStoryline } from './draft';
import { ARC_WEEKS, type BeatKind } from './model';
import { loadWorld } from './service';
import { activeArc, applySteer, type SteerOp, arcBeats, fakeSteerOps, insertArc, markUsedBeats, parseSteerOps, refreshPlannedSlots, weekOfArc } from './storyline';

/**
 * The Persona Manager maintains the storyline: the Owner steers it in chat ("make Angie's visit a surprise next
 * week"), and the arc is extended into a new season near its end, with callbacks to what the audience liked.
 */

export async function steerStoryline(services: StudioServices, q: { personaId: string; instruction: string; actor: Actor }): Promise<{ ops: number; rewritten: number; added: number; dropped: number; slotsUpdated: number }> {
  const instruction = q.instruction.replace(/\s+/g, ' ').trim().slice(0, 600);
  if (instruction.length < 4) throw new Error('say how the storyline should change');
  const arc = await activeArc(services.db, q.personaId);
  if (!arc) throw new Error('this persona has no storyline yet');
  const now = services.now();
  const week = Math.max(1, weekOfArc(arc, now) ?? 1);
  const beats = await arcBeats(services.db, arc.id);
  const upcoming = beats.filter((b) => b.status !== 'used' && b.status !== 'dropped' && b.week >= week).slice(0, 16);
  const p = await services.db.one<{ studio_id: string; name: string }>('SELECT studio_id, name FROM persona WHERE id = $1', [q.personaId]);
  const res = await services.runtime.run({
    agent: 'persona-manager',
    scope: { studioId: p.studio_id, personaId: q.personaId },
    label: `storyline: steer (${p.name})`,
    system: `You maintain ${p.name}'s season storyline. Apply the Owner's steer to upcoming beats only (never to beats already posted), keeping chapters, tension and payoffs coherent. Fictional, generic, English. Ops: rewrite (beat_id, text), add (week, kind, text), drop (beat_id).`,
    prompt: `Arc: ${arc.title} (week ${week} of ${arc.weeks}). Chapters: ${arc.content.chapters.map((c) => `${c.id} "${c.title}" weeks ${c.weeks.join('–')}: ${c.tension} → ${c.payoff}`).join('; ')}.
Upcoming beats:\n${upcoming.map((b) => `- ${b.id} (week ${b.week}, ${b.kind}): ${b.text}`).join('\n')}
Owner's steer: ${instruction}
Return {"ops": [{"op": "rewrite" | "add" | "drop", "beat_id": "...", "week": 0, "kind": "...", "text": "..."}]}.`,
    parse: parseSteerOps,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['ops'],
      properties: {
        ops: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['op'],
            properties: { op: { type: 'string', enum: ['rewrite', 'add', 'drop'] }, beat_id: { type: 'string' }, week: { type: 'number' }, kind: { type: 'string' }, text: { type: 'string' } },
          },
        },
      },
    },
    fake: () => ({ ops: fakeSteerOps(instruction, upcoming, week).map((x) => ({ op: x.op, ...(x.beatId ? { beat_id: x.beatId } : {}), ...(x.week ? { week: x.week } : {}), ...(x.kind ? { kind: x.kind } : {}), ...(x.text ? { text: x.text } : {}) })) as unknown as SteerOp[] }),
    costRef: { type: 'persona', id: q.personaId },
  });
  const applied = await applySteer(services.db, arc, res.output.ops, week);
  const slotsUpdated = await refreshPlannedSlots(services.db, q.personaId, now);
  await audit(services.db, { studioId: p.studio_id, personaId: q.personaId, actor: q.actor, action: 'storyline.steer', entityType: 'storyline_arc', entityId: arc.id, data: { instruction: instruction.slice(0, 300), ...applied } });
  return { ops: res.output.ops.length, ...applied, slotsUpdated };
}

export async function addBeat(services: StudioServices, q: { personaId: string; text: string; week?: number; kind?: BeatKind }): Promise<{ added: number }> {
  const arc = await activeArc(services.db, q.personaId);
  if (!arc) throw new Error('this persona has no storyline yet');
  const week = Math.max(1, weekOfArc(arc, services.now()) ?? 1);
  const r = await applySteer(services.db, arc, [{ op: 'add', text: q.text, week: q.week ?? week, kind: q.kind ?? 'development' }], week);
  return { added: r.added };
}

/** Top beats by audience response (views + saves + shares + comments of the posts that carried them). */
async function audienceFavourites(services: StudioServices, personaId: string, arcId: string): Promise<string[]> {
  const rows = await services.db.query<{ text: string; score: number }>(
    `SELECT b.text, COALESCE(sum(m.views + 20 * (m.saves + m.shares) + 10 * m.comments), 0)::float8 AS score
       FROM storyline_beat b
       JOIN calendar_slot s ON s.persona_id = b.persona_id AND s.meta->'story'->>'beatId' = b.id::text
       LEFT JOIN post po ON po.calendar_slot_id = s.id
       LEFT JOIN metric_snapshot m ON m.post_id = po.id
      WHERE b.arc_id = $1 AND b.persona_id = $2
      GROUP BY b.id, b.text HAVING COALESCE(sum(m.views), 0) > 0
      ORDER BY score DESC LIMIT 3`,
    [arcId, personaId],
  );
  return rows.map((r) => r.text.slice(0, 90));
}

/** A new season when the arc is at (or past) its last two weeks; no-op otherwise unless forced. */
export async function extendStoryline(services: StudioServices, q: { personaId: string; actor: Actor; force?: boolean }): Promise<{ extended: boolean; season: number | null; reason?: string }> {
  const arc = await activeArc(services.db, q.personaId);
  const world = await loadWorld(services.db, q.personaId);
  if (!world) return { extended: false, season: null, reason: 'no World Bible' };
  const now = services.now();
  const week = arc ? weekOfArc(arc, now) : null;
  if (arc && !q.force && (week === null || week < arc.weeks - 1)) return { extended: false, season: arc.season, reason: `week ${week ?? 0} of ${arc.weeks}` };
  const p = await services.db.one<{ studio_id: string; name: string; niche: string }>('SELECT studio_id, name, niche FROM persona WHERE id = $1', [q.personaId]);
  const favourites = arc ? await audienceFavourites(services, q.personaId, arc.id) : [];
  const leftovers = arc ? (await arcBeats(services.db, arc.id)).filter((b) => b.kind === 'cliffhanger' && b.status !== 'dropped').map((b) => b.text.slice(0, 90)) : [];
  const season = (arc?.season ?? 0) + 1;
  // The next arc starts the Monday after the current one ends (or next Monday).
  const startIso = arc?.starts_on ? new Date(Date.parse(`${String(arc.starts_on).slice(0, 10)}T00:00:00Z`) + arc.weeks * 7 * 86_400_000) : null;
  const startsOn = startIso && startIso.getTime() > now.getTime() - 7 * 86_400_000 ? startIso : null;
  const storyline = buildStoryline(
    { draftId: q.personaId, name: world.bible.self.name, archetype: world.bible.self.background, premise: `${p.name} carries on.`, mechanic: '', niche: p.niche, homeBase: world.bible.place.city, lore: null, timezone: world.bible.place.timezone },
    world.bible,
    startsOn ?? now,
    season,
    { callbacks: [...leftovers, ...favourites].slice(0, 6), reactions: favourites },
  );
  await services.db.transaction((tx) => insertArc(tx, { personaId: q.personaId, studioId: p.studio_id, storyline: { ...storyline, weeks: ARC_WEEKS }, createdBy: actorRef(q.actor), startsOn, source: 'extend' }));
  return { extended: true, season };
}

export async function storylineUpkeep(services: StudioServices, personaId: string, actor: Actor): Promise<{ used: number; extended: boolean }> {
  const used = await markUsedBeats(services.db, personaId);
  const ext = await extendStoryline(services, { personaId, actor });
  return { used, extended: ext.extended };
}
