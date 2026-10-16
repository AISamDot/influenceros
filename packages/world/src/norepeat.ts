import type { ConceptFingerprint, NoRepeatResult, QcCheck, ServiceBase } from '@ios/agents';

/**
 * The no-repeat engine (PRD §3.14.5). Every concept gets a fingerprint (premise + hook type + topic + format + key
 * line), embedded (providers.embeddings, pgvector) and stored per persona:
 * - a concept too close to the persona's history is blocked;
 * - a series episode must add a new beat (its premise + key line, minus the series name, can't match an earlier episode);
 * - near-duplicate wording is blocked across the studio (the Originality Ledger): another persona's wording always,
 *   the same persona's only when it is practically a copy (persona-level repeats are the concept check's job).
 */

export const NO_REPEAT = {
  /** Cosine similarity of concept fingerprints within a persona at or above which a concept is a repeat. */
  persona: 0.9,
  /** Studio scope (no persona given: Viral Remix briefs before a persona is chosen). */
  studio: 0.92,
  /** Series episodes: the episode's own beat vs earlier episodes. */
  series: 0.85,
  /** Wording embeddings across personas. */
  wording: 0.93,
  /** 5-word shingle overlap (Jaccard) across personas / within the persona. */
  shingle: 0.5,
  shingleSamePersona: 0.8,
} as const;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** "Dinner Lady Diaries #3", "Budget Week: Day 4", "Part 2 – the freezer" → the series name, or null. */
export function seriesOf(premise: string): string | null {
  const m = /^(.*?)\s*(?:[:\-–—|]\s*)?(?:#|\bep(?:isode)?\.?\s*|\bpart\s+|\bday\s+|\bweek\s+)(\d{1,3})\b/i.exec(premise);
  const name = m?.[1]?.replace(/[:\-–—|,\s]+$/, '').trim();
  return name && name.length >= 3 ? name : null;
}

export function fingerprintText(fp: ConceptFingerprint): string {
  return [fp.premise, fp.hookType ?? '', fp.topic, fp.format.replace(/_/g, ' '), fp.keyLine].map((x) => x.trim()).filter(Boolean).join(' | ');
}

/** The episode's own beat: premise + key line without the series name and episode number. */
export function beatText(fp: ConceptFingerprint, series: string): string {
  const strip = (s: string) =>
    norm(s)
      .replace(new RegExp(`\\b${norm(series).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), ' ')
      .replace(/\b(?:episode|ep|part|day|week)\s*\d+\b|#\d+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return `${strip(fp.premise)} | ${strip(fp.keyLine)}`;
}

/** Wording for the Originality Ledger: the audience-facing text without hashtags. */
export const wordingOf = (text: string): string => text.replace(/#[\w-]+/g, ' ').replace(/\s+/g, ' ').trim();

export function shingles(text: string, n = 5): Set<string> {
  const w = norm(text).split(' ').filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export const toVector = (v: readonly number[]): string => `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : '0')).join(',')}]`;

interface Near {
  id: string;
  premise: string;
  persona_id: string | null;
  series: string | null;
  sim: number;
}

export interface NoRepeatSubject {
  readonly type: string;
  readonly id: string | null;
}

/** Embeds `texts` with the studio's embedder; returns the vectors and the model name. */
async function embed(base: ServiceBase, texts: readonly string[]): Promise<{ vectors: number[][]; model: string }> {
  const vectors = await base.providers.embeddings.embed(texts);
  return { vectors, model: base.providers.embeddings.name };
}

const notSelf = (subject: NoRepeatSubject | null, i: number) =>
  subject?.id ? `AND NOT (subject_type = $${i} AND subject_id = $${i + 1})` : '';
const selfParams = (subject: NoRepeatSubject | null) => (subject?.id ? [subject.type, subject.id] : []);

/** The concept check (persona history, series beat). */
export async function checkConceptFingerprint(
  base: ServiceBase,
  q: { studioId: string; personaId: string | null; fingerprint: ConceptFingerprint; subject?: NoRepeatSubject | null },
): Promise<NoRepeatResult & { series?: { name: string; ok: boolean; similarity: number; nearest: string | null } }> {
  const fp = q.fingerprint;
  const subject = q.subject ?? null;
  const series = fp.series ?? seriesOf(fp.premise);
  const texts = [fingerprintText(fp), ...(series ? [beatText(fp, series)] : [])];
  const { vectors, model } = await embed(base, texts);
  const vec = toVector(vectors[0]!);
  const scope: 'persona' | 'studio' = q.personaId ? 'persona' : 'studio';
  const params: unknown[] = [vec, model, q.personaId ?? q.studioId, ...selfParams(subject)];
  const rows = await base.db.query<Near>(
    `SELECT id, premise, persona_id, series, (1 - (embedding <=> $1::vector))::float8 AS sim
       FROM concept_fingerprint
      WHERE embedding_model = $2 AND ${scope === 'persona' ? 'persona_id = $3' : 'studio_id = $3'} ${notSelf(subject, 4)}
      ORDER BY embedding <=> $1::vector LIMIT 5`,
    params,
  );
  // An exact key line repeat is a repeat whatever the vectors say.
  const keyRepeat = q.personaId
    ? await base.db.maybeOne<{ id: string; premise: string }>(
        `SELECT id, premise FROM concept_fingerprint WHERE persona_id = $1 AND lower(regexp_replace(key_line, '[^a-zA-Z0-9]+', '', 'g')) = $2 ${notSelf(subject, 3)} LIMIT 1`,
        [q.personaId, norm(fp.keyLine).replace(/[^a-z0-9]+/g, ''), ...selfParams(subject)],
      )
    : null;
  const top = rows[0] ?? null;
  const threshold = scope === 'persona' ? NO_REPEAT.persona : NO_REPEAT.studio;
  // Earlier episodes of the same series share the series name, so they're judged on their own beat below instead.
  const conceptHit = rows.find((r) => r.sim >= threshold && !(series && r.series && norm(r.series) === norm(series)));
  let result: NoRepeatResult & { series?: { name: string; ok: boolean; similarity: number; nearest: string | null } } = {
    ok: !conceptHit && !(keyRepeat && fp.keyLine.trim().length >= 12),
    similarity: Math.max(0, Math.min(1, top?.sim ?? 0)),
    nearest: top ? { id: top.id, title: top.premise, scope, similarity: Math.max(0, Math.min(1, top.sim)) } : null,
    ...(conceptHit
      ? { reason: `too close to "${conceptHit.premise}" (${Math.round(conceptHit.sim * 100)}% similar): find a new premise, hook or key line` }
      : keyRepeat && fp.keyLine.trim().length >= 12
        ? { reason: `the key line repeats "${keyRepeat.premise}": write a new one` }
        : {}),
  };
  if (series && q.personaId) {
    const bvec = toVector(vectors[1]!);
    const eps = await base.db.query<Near>(
      `SELECT id, premise, persona_id, series, (1 - (beat_embedding <=> $1::vector))::float8 AS sim
         FROM concept_fingerprint
        WHERE persona_id = $2 AND embedding_model = $3 AND beat_embedding IS NOT NULL AND lower(series) = lower($4) ${notSelf(subject, 5)}
        ORDER BY beat_embedding <=> $1::vector LIMIT 3`,
      [bvec, q.personaId, model, series, ...selfParams(subject)],
    );
    const hit = eps.find((e) => e.sim >= NO_REPEAT.series);
    result = {
      ...result,
      ok: result.ok && !hit,
      // The series verdict explains a repeated episode best (its key line usually repeats too).
      ...(hit ? { reason: `series "${series}": this episode repeats "${hit.premise}" (${Math.round(hit.sim * 100)}%); every episode must add a new beat` } : {}),
      series: { name: series, ok: !hit, similarity: eps[0]?.sim ?? 0, nearest: eps[0]?.premise ?? null },
    };
  }
  return result;
}

/** The studio-wide wording check (Originality Ledger). */
export async function checkWording(
  base: ServiceBase,
  q: { studioId: string; personaId: string | null; text: string; subject?: NoRepeatSubject | null },
): Promise<{ ok: boolean; similarity: number; overlap: number; nearest: { id: string; premise: string; samePersona: boolean } | null }> {
  const wording = wordingOf(q.text);
  if (wording.split(' ').length < 8) return { ok: true, similarity: 0, overlap: 0, nearest: null };
  const { vectors, model } = await embed(base, [wording]);
  const subject = q.subject ?? null;
  const rows = await base.db.query<Near & { wording: string }>(
    `SELECT id, premise, persona_id, series, wording, (1 - (wording_embedding <=> $1::vector))::float8 AS sim
       FROM concept_fingerprint
      WHERE studio_id = $2 AND embedding_model = $3 AND wording_embedding IS NOT NULL ${notSelf(subject, 4)}
      ORDER BY wording_embedding <=> $1::vector LIMIT 8`,
    [toVector(vectors[0]!), q.studioId, model, ...selfParams(subject)],
  );
  const mine = shingles(wording);
  let worst: { id: string; premise: string; samePersona: boolean; sim: number; overlap: number } | null = null;
  for (const r of rows) {
    const samePersona = !!q.personaId && r.persona_id === q.personaId;
    const overlap = jaccard(mine, shingles(r.wording));
    const bad = samePersona ? overlap >= NO_REPEAT.shingleSamePersona : r.sim >= NO_REPEAT.wording || overlap >= NO_REPEAT.shingle;
    if (bad && (!worst || overlap > worst.overlap)) worst = { id: r.id, premise: r.premise, samePersona, sim: r.sim, overlap };
  }
  const top = rows[0];
  return worst
    ? { ok: false, similarity: worst.sim, overlap: worst.overlap, nearest: { id: worst.id, premise: worst.premise, samePersona: worst.samePersona } }
    : { ok: true, similarity: top?.sim ?? 0, overlap: top ? jaccard(mine, shingles(top.wording)) : 0, nearest: null };
}

/** Stores the fingerprint of an approved subject (idempotent per subject). */
export async function recordFingerprint(
  base: ServiceBase,
  q: { studioId: string; personaId: string | null; subject: { type: string; id: string }; fingerprint: ConceptFingerprint; text: string },
): Promise<void> {
  const fp = q.fingerprint;
  const series = fp.series ?? seriesOf(fp.premise);
  const wording = wordingOf(q.text);
  const texts = [fingerprintText(fp), wording || fp.keyLine, ...(series ? [beatText(fp, series)] : [])];
  const { vectors, model } = await embed(base, texts);
  await base.db.query(
    `INSERT INTO concept_fingerprint (studio_id, persona_id, subject_type, subject_id, premise, hook_type, topic, format, key_line, series, wording,
                                      embedding, wording_embedding, beat_embedding, embedding_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector, $13::vector, $14::vector, $15)
     ON CONFLICT (subject_type, subject_id) DO NOTHING`,
    [
      q.studioId,
      q.personaId,
      q.subject.type,
      q.subject.id,
      fp.premise.slice(0, 300),
      fp.hookType,
      fp.topic.slice(0, 200),
      fp.format,
      fp.keyLine.slice(0, 400),
      series,
      wording.slice(0, 4000),
      toVector(vectors[0]!),
      toVector(vectors[1]!),
      series ? toVector(vectors[2]!) : null,
      model,
    ],
  );
}

export async function logBlock(
  base: ServiceBase,
  q: { studioId: string; personaId: string | null; subject: NoRepeatSubject; check: string; similarity?: number | null; nearestId?: string | null; reason: string },
): Promise<void> {
  await base.db.query(
    `INSERT INTO concept_block (studio_id, persona_id, subject_type, subject_id, check_name, similarity, nearest_id, reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [q.studioId, q.personaId, q.subject.type, q.subject.id, q.check, q.similarity ?? null, q.nearestId ?? null, q.reason.slice(0, 500)],
  );
}

export function noRepeatChecks(
  concept: Awaited<ReturnType<typeof checkConceptFingerprint>> | null,
  wording: Awaited<ReturnType<typeof checkWording>> | null,
): QcCheck[] {
  const out: QcCheck[] = [];
  if (concept) {
    const seriesFail = concept.series && !concept.series.ok;
    if (!concept.ok && !(seriesFail && concept.reason?.startsWith('series'))) {
      out.push({ check: 'no_repeat', pass: false, severity: 'blocker', message: `No-repeat: ${concept.reason ?? 'concept too close to an earlier post'}` });
    }
    if (seriesFail) out.push({ check: 'no_repeat_series', pass: false, severity: 'blocker', message: `No-repeat: ${concept.reason?.startsWith('series') ? concept.reason : `series "${concept.series!.name}": this episode adds no new beat`}` });
    if (concept.ok) out.push({ check: 'no_repeat', pass: true, severity: 'minor', message: `new concept (nearest ${Math.round(concept.similarity * 100)}% similar)` });
  }
  if (wording) {
    out.push(
      wording.ok
        ? { check: 'near_duplicate_wording', pass: true, severity: 'minor', message: 'original wording across the studio' }
        : {
            check: 'near_duplicate_wording',
            pass: false,
            severity: 'blocker',
            message: `Originality: the wording is a near-duplicate of "${wording.nearest?.premise}"${wording.nearest?.samePersona ? ' (an earlier post)' : ' (another persona)'}: rewrite it in this persona's own words.`,
          },
    );
  }
  return out;
}

