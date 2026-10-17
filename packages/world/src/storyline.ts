import type { SlotBeat } from '@troupe/agents';
import type { PostFormat, PostPurpose } from '@troupe/core';
import { type Db, json } from '@troupe/db';
import { type BeatKind, type Storyline, type StoryChapter } from './model';
import { isoDay, mondayOf } from './time';

/**
 * The storyline (PRD §3.14.3): a ~12-week season arc of chapters (tension → payoff) whose beats are assigned to the
 * weekly planner's slots. Beats live in `storyline_beat`; the arc's chapters, gags and callbacks in
 * `storyline_arc.content`. Week 1 is anchored to the first week the calendar plans after the launch.
 */

export interface ArcRow {
  id: string;
  persona_id: string;
  studio_id: string;
  season: number;
  title: string;
  premise: string;
  weeks: number;
  starts_on: string | Date | null;
  status: 'active' | 'done' | 'superseded';
  content: Omit<Storyline, 'chapters'> & { chapters: Array<Omit<StoryChapter, 'beats'>> };
}

export interface BeatRow {
  id: string;
  arc_id: string;
  persona_id: string;
  chapter_id: string;
  beat_key: string;
  week: number;
  ord: number;
  kind: BeatKind;
  text: string;
  tension: string | null;
  payoff: string | null;
  status: 'planned' | 'assigned' | 'used' | 'dropped';
  assigned_week: string | Date | null;
  slot_at: Date | null;
  source: string;
}

const dayStr = (d: string | Date | null): string | null => (d === null ? null : typeof d === 'string' ? d.slice(0, 10) : isoDay(d));

/** Writes an arc and its beats (the arc becomes the persona's active one; an earlier active arc is closed). */
export async function insertArc(db: Db, q: { personaId: string; studioId: string; storyline: Storyline; createdBy: string; startsOn?: Date | null; source?: 'draft' | 'extend' }): Promise<string> {
  const s = q.storyline;
  await db.query(`UPDATE storyline_arc SET status = 'done', updated_at = now() WHERE persona_id = $1 AND status = 'active'`, [q.personaId]);
  const season = Math.max(s.season, ((await db.one<{ n: number }>('SELECT COALESCE(max(season), 0)::int AS n FROM storyline_arc WHERE persona_id = $1', [q.personaId])).n ?? 0) + 1);
  const { chapters, ...rest } = s;
  const arc = await db.one<{ id: string }>(
    `INSERT INTO storyline_arc (persona_id, studio_id, season, title, premise, weeks, starts_on, status, content, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8::jsonb, $9) RETURNING id`,
    [q.personaId, q.studioId, season, s.title, s.premise, s.weeks, q.startsOn ? isoDay(q.startsOn) : null, json({ ...rest, season, chapters: chapters.map(({ beats: _b, ...c }) => c) }), q.createdBy],
  );
  let ord = 0;
  for (const c of chapters) {
    for (const b of c.beats) {
      await db.query(
        `INSERT INTO storyline_beat (arc_id, persona_id, chapter_id, beat_key, week, ord, kind, text, tension, payoff, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (arc_id, beat_key) DO NOTHING`,
        [arc.id, q.personaId, c.id, b.id, b.week, ord++, b.kind, b.text, c.tension || null, b.kind === 'payoff' || b.kind === 'milestone' ? c.payoff || null : null, q.source ?? 'draft'],
      );
    }
  }
  return arc.id;
}

export async function activeArc(db: Db, personaId: string): Promise<ArcRow | null> {
  return db.maybeOne<ArcRow>(`SELECT * FROM storyline_arc WHERE persona_id = $1 AND status = 'active'`, [personaId]);
}

export async function arcBeats(db: Db, arcId: string): Promise<BeatRow[]> {
  return db.query<BeatRow>(`SELECT * FROM storyline_beat WHERE arc_id = $1 ORDER BY week, ord`, [arcId]);
}

export function weekOfArc(arc: Pick<ArcRow, 'starts_on'>, weekStart: Date): number | null {
  const start = dayStr(arc.starts_on);
  if (!start) return null;
  return Math.floor((mondayOf(weekStart).getTime() - Date.parse(`${start}T00:00:00Z`)) / (7 * 86_400_000)) + 1;
}

/** Story-friendly formats first; sell slots carry a beat only when nothing else is left. */
const FORMAT_RANK: Partial<Record<PostFormat, number>> = { talking: 0, voiceover: 1, photo_dump: 2, static: 3, text_note: 4, activity_text: 5, reply_comment: 6, carousel: 7, facecam_screen: 8, meme: 9 };
const PURPOSE_RANK: Record<PostPurpose, number> = { trust: 0, reach: 1, sell: 3 };

/**
 * Assigns the week's beats to the planned slots (one beat per slot, spread over different days, story-friendly
 * slots first). Idempotent: planning the same week again returns the same beats; a later week never reuses them.
 */
export async function assignBeats(
  db: Db,
  q: { personaId: string; weekStart: Date; slots: ReadonlyArray<{ index: number; at: Date; format: PostFormat; purpose: PostPurpose }> },
): Promise<SlotBeat[]> {
  const arc = await activeArc(db, q.personaId);
  if (!arc || !q.slots.length) return [];
  const monday = mondayOf(q.weekStart);
  if (!arc.starts_on) {
    await db.query(`UPDATE storyline_arc SET starts_on = $2, updated_at = now() WHERE id = $1 AND starts_on IS NULL`, [arc.id, isoDay(monday)]);
    arc.starts_on = isoDay(monday);
  }
  const week = weekOfArc(arc, monday);
  if (week === null || week < 1) return [];
  const weekIso = isoDay(monday);
  // This week's beats: anything scheduled for weeks ≤ this one that is still planned (a skipped week rolls forward),
  // plus beats already assigned to this same week (re-planning).
  const beats = await db.query<BeatRow>(
    `SELECT * FROM storyline_beat
      WHERE arc_id = $1 AND status <> 'dropped'
        AND ((status = 'planned' AND week <= $2) OR (status = 'assigned' AND assigned_week = $3))
      ORDER BY week, ord LIMIT 4`,
    [arc.id, week, weekIso],
  );
  if (!beats.length) return [];
  const chapters = new Map(arc.content.chapters.map((c) => [c.id, c]));
  const ranked = [...q.slots].sort(
    (a, b) => PURPOSE_RANK[a.purpose] - PURPOSE_RANK[b.purpose] || (FORMAT_RANK[a.format] ?? 10) - (FORMAT_RANK[b.format] ?? 10) || a.at.getTime() - b.at.getTime(),
  );
  const usedDays = new Set<string>();
  const usedSlots = new Set<number>();
  const pickSlot = (): (typeof q.slots)[number] | null => {
    const fresh = ranked.find((s) => !usedSlots.has(s.index) && !usedDays.has(isoDay(s.at)) && s.purpose !== 'sell');
    return fresh ?? ranked.find((s) => !usedSlots.has(s.index) && s.purpose !== 'sell') ?? ranked.find((s) => !usedSlots.has(s.index)) ?? null;
  };
  const out: SlotBeat[] = [];
  // Assign in chronological slot order so the story reads forward through the week.
  const picks: Array<{ beat: BeatRow; slot: (typeof q.slots)[number] }> = [];
  for (const beat of beats) {
    const slot = pickSlot();
    if (!slot) break;
    usedSlots.add(slot.index);
    usedDays.add(isoDay(slot.at));
    picks.push({ beat, slot });
  }
  const slotsInOrder = picks.map((p) => p.slot).sort((a, b) => a.at.getTime() - b.at.getTime());
  for (let i = 0; i < picks.length; i++) {
    const beat = picks[i]!.beat;
    const slot = slotsInOrder[i]!;
    const ch = chapters.get(beat.chapter_id);
    await db.query(`UPDATE storyline_beat SET status = 'assigned', assigned_week = $2, slot_at = $3, updated_at = now() WHERE id = $1`, [beat.id, weekIso, slot.at]);
    out.push({
      slotIndex: slot.index,
      arcId: arc.id,
      chapterId: beat.chapter_id,
      beatId: beat.id,
      chapter: ch?.title ?? beat.chapter_id,
      beat: beat.text,
      ...(beat.tension || ch?.tension ? { tension: beat.tension ?? ch?.tension } : {}),
      ...(beat.payoff ? { payoff: beat.payoff } : {}),
    });
  }
  return out;
}

/** After a re-steer: rewrites `calendar_slot.meta.story` (that key only) on the persona's still-planned slots. */
export async function refreshPlannedSlots(db: Db, personaId: string, now: Date): Promise<number> {
  const slots = await db.query<{ id: string; beat_id: string }>(
    `SELECT id, meta->'story'->>'beatId' AS beat_id FROM calendar_slot
      WHERE persona_id = $1 AND status = 'planned' AND slot_at > $2 AND meta ? 'story'`,
    [personaId, now],
  );
  let n = 0;
  for (const s of slots) {
    const beat = s.beat_id ? await db.maybeOne<BeatRow & { arc_status: string; chapter_title: string | null }>(
      `SELECT b.*, a.status AS arc_status, (SELECT c->>'title' FROM jsonb_array_elements(a.content->'chapters') c WHERE c->>'id' = b.chapter_id LIMIT 1) AS chapter_title
         FROM storyline_beat b JOIN storyline_arc a ON a.id = b.arc_id WHERE b.id = $1`,
      [s.beat_id],
    ) : null;
    if (!beat) continue;
    if (beat.status === 'dropped') {
      await db.query(`UPDATE calendar_slot SET meta = meta - 'story' WHERE id = $1`, [s.id]);
    } else {
      await db.query(`UPDATE calendar_slot SET meta = jsonb_set(meta, '{story}', (meta->'story') || $2::jsonb) WHERE id = $1`, [
        s.id,
        json({ beat: beat.text, chapter: beat.chapter_title ?? beat.chapter_id, ...(beat.tension ? { tension: beat.tension } : {}), ...(beat.payoff ? { payoff: beat.payoff } : {}) }),
      ]);
    }
    n++;
  }
  return n;
}

export interface SteerOp {
  readonly op: 'rewrite' | 'add' | 'drop';
  readonly beatId?: string;
  readonly week?: number;
  readonly kind?: BeatKind;
  readonly text?: string;
}

/** Applies steering ops to the active arc's upcoming beats (never to beats already used). */
export async function applySteer(db: Db, arc: ArcRow, ops: readonly SteerOp[], currentWeek: number): Promise<{ rewritten: number; added: number; dropped: number }> {
  const res = { rewritten: 0, added: 0, dropped: 0 };
  const beats = await arcBeats(db, arc.id);
  for (const op of ops) {
    if (op.op === 'add' && op.text) {
      const week = Math.max(Math.max(1, currentWeek), Math.min(arc.weeks, op.week ?? currentWeek));
      const chapter = arc.content.chapters.find((c) => week >= c.weeks[0] && week <= c.weeks[1]) ?? arc.content.chapters[arc.content.chapters.length - 1];
      const ord = (await db.one<{ n: number }>(`SELECT COALESCE(max(ord), 0)::int + 1 AS n FROM storyline_beat WHERE arc_id = $1`, [arc.id])).n;
      const key = `steer-${(await db.one<{ n: number }>(`SELECT count(*)::int + 1 AS n FROM storyline_beat WHERE arc_id = $1 AND beat_key LIKE 'steer-%'`, [arc.id])).n}`;
      await db.query(
        `INSERT INTO storyline_beat (arc_id, persona_id, chapter_id, beat_key, week, ord, kind, text, tension, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'steer')`,
        [arc.id, arc.persona_id, chapter?.id ?? 'extra', key, week, ord, op.kind ?? 'development', op.text.slice(0, 300), chapter?.tension ?? null],
      );
      // Keep the steer beat early in its week.
      await db.query(`UPDATE storyline_beat SET ord = (SELECT COALESCE(min(ord), 0) - 1 FROM storyline_beat WHERE arc_id = $1 AND week = $2) WHERE arc_id = $1 AND beat_key = $3`, [arc.id, week, key]);
      res.added++;
      continue;
    }
    const b = beats.find((x) => x.id === op.beatId || x.beat_key === op.beatId);
    if (!b || b.status === 'used') continue;
    if (op.op === 'rewrite' && op.text) {
      await db.query(`UPDATE storyline_beat SET text = $2, source = 'steer', updated_at = now() WHERE id = $1`, [b.id, op.text.slice(0, 300)]);
      res.rewritten++;
    } else if (op.op === 'drop') {
      await db.query(`UPDATE storyline_beat SET status = 'dropped', updated_at = now() WHERE id = $1`, [b.id]);
      res.dropped++;
    }
  }
  await db.query(`UPDATE storyline_arc SET updated_at = now() WHERE id = $1`, [arc.id]);
  return res;
}

/** Deterministic steering (fake mode): the Owner's instruction becomes the next beat; "drop/cut/skip …" drops the matching upcoming beat. */
export function fakeSteerOps(instruction: string, upcoming: readonly BeatRow[], currentWeek: number): SteerOp[] {
  const text = instruction.replace(/\s+/g, ' ').trim();
  const drop = /\b(?:drop|cut|skip|remove)\b\s+(?:the\s+)?(.{3,60}?)(?:\s+beat|\s+bit|[.!]|$)/i.exec(text);
  if (drop) {
    const words = drop[1]!.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const target = upcoming.find((b) => words.some((w) => b.text.toLowerCase().includes(w)));
    if (target) return [{ op: 'drop', beatId: target.id }];
  }
  const clean = text.replace(/^(?:please\s+)?(?:can you\s+|could you\s+)?(?:steer|change|make|have|let)\s+(?:the\s+)?(?:storyline|story|arc)\s*(?:so\s+(?:that\s+)?|to\s+)?/i, '');
  return [{ op: 'add', week: Math.max(1, currentWeek), kind: 'development', text: clean.charAt(0).toUpperCase() + clean.slice(1) }];
}

export function parseSteerOps(v: unknown): { ops: SteerOp[] } {
  const arr = v && typeof v === 'object' && Array.isArray((v as { ops?: unknown }).ops) ? (v as { ops: unknown[] }).ops : null;
  if (!arr) throw new Error('expected {"ops": [...]}');
  const kinds: BeatKind[] = ['setup', 'development', 'gag', 'callback', 'cliffhanger', 'payoff', 'milestone'];
  return { ops: arr.slice(0, 8).flatMap((raw): SteerOp[] => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const op = o.op === 'rewrite' || o.op === 'add' || o.op === 'drop' ? o.op : null;
    if (!op) return [];
    const text = typeof o.text === 'string' ? o.text.trim().slice(0, 300) : undefined;
    const beatId = typeof o.beat_id === 'string' ? o.beat_id : undefined;
    const week = typeof o.week === 'number' ? Math.round(o.week) : undefined;
    const kind = kinds.includes(o.kind as BeatKind) ? (o.kind as BeatKind) : undefined;
    if ((op === 'add' || op === 'rewrite') && !text) return [];
    if ((op === 'rewrite' || op === 'drop') && !beatId) return [];
    return [{ op, beatId, week, kind, text }];
  }) };
}

/** The arc with its beats, for tools and the dashboard. */
export async function storylineView(db: Db, personaId: string, now: Date): Promise<null | {
  arc: { id: string; season: number; title: string; premise: string; weeks: number; startsOn: string | null; currentWeek: number | null };
  chapters: Array<{ id: string; title: string; weeks: readonly [number, number]; tension: string; payoff: string; beats: Array<{ id: string; week: number; kind: string; text: string; status: string }> }>;
  runningGags: readonly string[];
  callbacks: readonly string[];
}> {
  const arc = await activeArc(db, personaId);
  if (!arc) return null;
  const beats = await arcBeats(db, arc.id);
  const week = weekOfArc(arc, now);
  return {
    arc: { id: arc.id, season: arc.season, title: arc.title, premise: arc.premise, weeks: arc.weeks, startsOn: dayStr(arc.starts_on), currentWeek: week },
    chapters: arc.content.chapters.map((c) => ({
      id: c.id,
      title: c.title,
      weeks: c.weeks,
      tension: c.tension,
      payoff: c.payoff,
      beats: beats.filter((b) => b.chapter_id === c.id).map((b) => ({ id: b.id, week: b.week, kind: b.kind, text: b.text, status: b.status })),
    })),
    runningGags: arc.content.runningGags ?? [],
    callbacks: arc.content.callbacks ?? [],
  };
}

/** Beats whose slot went live become 'used' (storyline upkeep). */
export async function markUsedBeats(db: Db, personaId: string): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `UPDATE storyline_beat b SET status = 'used', updated_at = now()
       FROM calendar_slot s
      WHERE b.persona_id = $1 AND b.status = 'assigned' AND s.persona_id = $1 AND s.meta->'story'->>'beatId' = b.id::text
        AND s.status IN ('scheduled','live')
     RETURNING b.id`,
    [personaId],
  );
  return rows.length;
}
