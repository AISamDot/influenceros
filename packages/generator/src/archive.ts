import type { StudioServices } from '@ios/agents';
import { type Actor, ApprovalError, archivePersona, ensureThreads, NotFoundError, notify, portraitUri, restoreArchivedPersona } from '@ios/core';
import { type ArchivedPersonaInfo, archiveDir, archivedManuscripts, importLaunchPersona, type LaunchPersona, listArchivedPersonas, loadArchivedPersonas } from '@ios/core/seed';
import { nicheByKey, nicheForText, slugify } from './library';
import { computeReview } from './review';
import { textOf } from './score';
import { commit, insertDraft, listDrafts } from './store';
import { type CharacterProfile, type ConceptOption, type ContentPlanDraft, type DraftRow, type DraftState, emptyState, type OpportunityOption } from './types';

/**
 * The archive (Owner decision, 16 Oct). Archived persona documents on disk are restored as PROPOSED personas whose
 * launch waits for the Owner in the Persona Generator's review step (a draft at step 7 linked to the persona). Live
 * personas are archived softly in place (core archive.ts) and come back exactly as they were.
 */

const sentence = (s: string, max = 300) => {
  const t = s.replace(/\s+/g, ' ').trim();
  const cut = t.slice(0, max);
  const end = cut.lastIndexOf('. ');
  return end > 80 ? cut.slice(0, end + 1) : cut;
};
const listOf = (v: unknown, n = 6): string[] => {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : textOf(x, 200))).filter(Boolean).slice(0, n);
  if (v && typeof v === 'object') return Object.values(v).flatMap((x) => listOf(x, n)).slice(0, n);
  if (typeof v === 'string') return v.split(/\n|;\s/).map((x) => x.replace(/^[-*•\d.\s]+/, '').trim()).filter(Boolean).slice(0, n);
  return [];
};

/** Clips at a word boundary (never mid-word), with an ellipsis when it had to cut. */
const clip = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 20)).replace(/[,;:\s]+$/, '')}…`;
};
const firstSentence = (s: string): string => /^(.{20,}?[.!?])(?:\s|$)/.exec(s.replace(/\s+/g, ' ').trim())?.[1] ?? s.trim();

type Row = Record<string, unknown>;
/** Every table row (array of objects) under a bible section, depth-first. */
function rowsOf(v: unknown): Row[] {
  if (Array.isArray(v)) return v.flatMap((x) => (x && typeof x === 'object' && !Array.isArray(x) ? [x as Row] : rowsOf(x)));
  if (v && typeof v === 'object') return Object.values(v).flatMap(rowsOf);
  return [];
}
const cell = (r: Row, re: RegExp): string => {
  const k = Object.keys(r).find((x) => re.test(x));
  return k ? textOf(r[k], 400).trim() : '';
};

/** Pillars from the content DNA: table rows with a "Pillar" column, else "Name: why" points. */
function pillarsOf(dna: unknown): ContentPlanDraft['pillars'] {
  const rows = rowsOf(dna).filter((r) => Object.keys(r).some((k) => /^pillar$/i.test(k)));
  if (rows.length) {
    return rows.slice(0, 5).map((r) => ({ name: clip(cell(r, /^pillar$/i).replace(/^\d+\.\s*/, ''), 80), why: clip(cell(r, /what it (?:is|covers)|^purpose$|main purpose/i), 200) }));
  }
  return listOf(dna, 8)
    .filter((x) => !/^pillars?:?$/i.test(x.trim()))
    .slice(0, 4)
    .map((x) => {
      const i = x.search(/[:(]/);
      return i > 3 ? { name: clip(x.slice(0, i), 80), why: clip(x.slice(i + 1).replace(/\)$/, ''), 200) } : { name: clip(x, 80), why: '' };
    });
}

/** Recurring series from the content DNA: "Series 1: Name (cadence)" keys, rows with a "Series" column, or "(lead series)" pillars. */
function seriesOf(dna: unknown): ContentPlanDraft['series'] {
  const out: ContentPlanDraft['series'] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return;
    for (const [k, x] of Object.entries(v as Row)) {
      const m = /^series\s*\d*\s*[:.]\s*(.+)$/i.exec(k);
      if (m) {
        const cadence = /\(([^)]*)\)\s*$/.exec(m[1]!)?.[1] ?? '';
        out.push({ name: clip(m[1]!.replace(/\s*\([^)]*\)\s*$/, ''), 80), format: 'talking', cadence: clip(cadence, 60), pillar: '' });
      } else walk(x);
    }
  };
  walk(dna);
  for (const r of rowsOf(dna)) {
    const name = cell(r, /^series$|series name/i);
    if (name) out.push({ name: clip(name, 80), format: cell(r, /format/i) || 'talking', cadence: clip(cell(r, /cadence|frequency|when/i), 60), pillar: '' });
  }
  if (!out.length) {
    for (const p of pillarsOf(dna)) if (/series/i.test(`${p.name} ${p.why}`)) out.push({ name: p.name.replace(/\s*\([^)]*\)\s*$/, ''), format: 'talking', cadence: '', pillar: p.name });
  }
  return out.slice(0, 5);
}

/** Positions on debates: table rows with a "Debate" column and the persona's position. */
function positionsOf(v: unknown): CharacterProfile['positions'] {
  return rowsOf(v)
    .map((r) => ({ debate: clip(cell(r, /^debate$/i), 120), stance: clip(cell(r, /position|stance/i).replace(/^["“]|["”]$/g, ''), 240) }))
    .filter((x) => x.debate && x.stance)
    .slice(0, 8);
}

/** The sign-off line ('Sign-off: "…"', or '"…" (the sign-off)') from the voice section, else the whole bible, else the first catchphrase. */
function signOffOf(bible: Record<string, unknown>, catchphrases: readonly string[]): string {
  for (const t of [textOf(bible.voice, 8000), textOf(bible, 60000)]) {
    const m = /sign[- ]?off[*:\s|]{0,8}["“]([^"”]{3,90})["”]/i.exec(t) ?? /["“]([^"”]{3,90})["”][^"“\n]{0,40}\bsign[- ]?off\b/i.exec(t);
    if (m) return clip(m[1]!.trim(), 90);
  }
  return clip((catchphrases[0] ?? '').replace(/^["“]|["”]$/g, '').trim(), 90);
}

/** A draft whose every step is filled from a persona's documents (all steps done; the review is computed later). */
export function draftStateFromLaunchPersona(lp: LaunchPersona): DraftState {
  const b = lp.bible;
  const n = nicheByKey(lp.niche) ?? nicheForText(lp.niche);
  const identity = textOf(b.identity, 3000);
  // The documents' own one-line positioning ("One line: …", "Positioning in one line: …", "One-line premise: …").
  const oneLine = /(?:one[- ]line(?: premise)?|positioning in one line)\s*:\s*([^\n]{20,400})/i.exec(identity)?.[1]?.trim() ?? '';
  const ageText = `${oneLine} ${identity}`;
  const age = Number(/\b([5-9]\d)\s*\(born\b/.exec(identity)?.[1] ?? /\b([4-9]\d)(?:-year-old|,| years old)/.exec(ageText)?.[1] ?? 65);
  // No one-line positioning: "<Name>, 68, a …" in the identity, else its "… for N years" line ("School dinner lady
  // for 41 years"), else the lore without its heading words ("Origin.", "Backstory Early years:").
  const first = lp.name.split(/\s+/)[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new RegExp(`\\b(${first}[\\w .'-]{0,24}, \\d{2}, [^.]{10,220})`).exec(identity)?.[1]?.trim();
  const career = /(?:^|[.·|]\s*)([A-Z][^.·|]{3,80}?\bfor \d{1,2} years\b[^.·|]{0,160})/.exec(identity)?.[1]?.trim();
  const lore = textOf(b.character_lore, 1500).replace(/^(?:\s*(?:origin|backstory|early years|lore|history)\b[.:]?\s*)+/i, '');
  const premiseText =
    (oneLine && sentence(oneLine, 320)) ||
    (named && `${clip(named, 300).replace(/[.\s]*$/, '.')}`) ||
    (career && `${lp.name}, ${age}: ${clip(`${career.charAt(0).toLowerCase()}${career.slice(1)}`, 260).replace(/[.\s]*$/, '.')}`) ||
    sentence(lore, 320) ||
    sentence(identity, 320);
  const pronoun: 'she' | 'he' = (identity.match(/\b(she|her)\b/gi)?.length ?? 0) >= (identity.match(/\b(he|his|him)\b/gi)?.length ?? 0) ? 'she' : 'he';
  const fw = b.signature_frameworks && typeof b.signature_frameworks === 'object' && !Array.isArray(b.signature_frameworks) ? (b.signature_frameworks as Record<string, unknown>) : {};
  const fwKey = Object.keys(fw).find((k) => /^\d+\.\d+\s/.test(k)) ?? Object.keys(fw)[0] ?? '';
  const fwName = fwKey.replace(/^\d+\.\d+\s+/, '').replace(/\.\s.*$/, '').trim();
  const fwFirst = listOf(fw[fwKey], 1)[0] ?? '';
  // The contrast is the positioning line's second half ("…for 38 years. She retypes your texts…"), else an explicit
  // contrast/USP line, else the lore's opening; never the Field Brain link the expertise map starts with.
  const lead = firstSentence(premiseText);
  const rest = premiseText.slice(lead.length).trim();
  const usp = /(?:contrast|usp|unique selling|why (?:she|he|it) (?:wins|works)|the hook)\s*[:—-]\s*([^\n]{20,300})/i.exec(`${identity}\n${textOf(b.character_lore, 3000)}`)?.[1];
  const contrast = clip(rest.length >= 20 ? rest : (usp ?? firstSentence(sentence(lore, 300))), 260);
  const catchphrases = listOf((b.voice as Record<string, unknown> | undefined)?.catchphrases ?? [], 2);
  const voiceText = textOf(b.voice, 1500);
  const voiceLine = /prompt[^:]{0,80}:\s*([^\n]{20,})/i.exec(voiceText)?.[1] ?? voiceText;
  const hooks = lp.slots.map((s) => s.hook).filter((h): h is string => !!h);
  const entry = lp.products.find((p) => p.rung === 'entry') ?? lp.products[0];
  const opp: OpportunityOption = {
    id: 'A',
    niche: lp.niche,
    subNiche: lp.subNiche ?? n.subNiche,
    angle: lp.subNiche ?? n.angle,
    audience: sentence(textOf(b.audience, 1200)) || n.audience,
    evidence: [{ signal: 'gap', detail: 'Restored from the archive: the 14 Oct launch research applies', flag: 'S' }],
    buyingMoments: lp.seasonal.map((s) => s.moment).filter(Boolean).slice(0, 5),
    risks: n.risks,
    scores: { demand: n.base.demand, intent: n.base.intent, competition: n.base.competition, seasonality: n.base.seasonality, gap: 7, total: 0 },
  };
  opp.scores.total = Math.round(opp.scores.demand * 3 + opp.scores.intent * 3 + opp.scores.competition * 1.5 + opp.scores.seasonality + opp.scores.gap * 1.5);
  const concept: ConceptOption = {
    id: 'A',
    name: lp.name,
    pronoun,
    age,
    archetype: clip((lead.startsWith(lp.name) ? lead.slice(lp.name.length) : lead).replace(/^[,\s]+(?:is\s+)?/, '').replace(/\.$/, ''), 160),
    premise: premiseText,
    contrast,
    mechanic: fwName ? `${fwName}: ${sentence(fwFirst, 200)}` : sentence(textOf(b.signature_frameworks, 800), 260),
    hooks: hooks.slice(0, 5),
    firstProduct: { name: entry?.name ?? '', priceCents: entry?.priceCents ?? 0, format: 'PDF' },
    lookLine: lp.looks.slice(0, 3).join(', '),
    voiceLine: sentence(voiceLine, 160),
    signOff: signOffOf(b, catchphrases),
  };
  const content: ContentPlanDraft = {
    pillars: pillarsOf(b.content_dna),
    series: seriesOf(b.content_dna),
    hookBank: hooks.slice(0, 15),
    ladder: lp.products
      .filter((p) => ['lead_magnet', 'entry', 'addon', 'core_bundle', 'upsell', 'membership'].includes(p.rung))
      .map((p) => ({ rung: p.rung as ContentPlanDraft['ladder'][number]['rung'], name: p.name, priceCents: p.priceCents, when: p.note ?? '' })),
    firstProductBrief: { name: entry?.name ?? '', promise: '', format: 'PDF', priceCents: entry?.priceCents ?? 0, keyword: lp.slots.find((s) => s.cta)?.cta ?? '', sections: [] },
    ctaKeywords: [...new Set(lp.slots.map((s) => s.cta).filter((x): x is string => !!x))].slice(0, 5),
  };
  const state = emptyState({ mode: 'archive', launchDate: lp.launchDate, timezone: lp.timezone });
  const done = <T>(v: T) => ({ status: 'done' as const, generation: 1, options: [v], chosen: v, chosenFrom: 'A', advice: null });
  state.opportunity = done(opp);
  state.concept = done(concept);
  state.character = {
    status: 'done',
    generation: 1,
    options: [],
    chosen: {
      name: lp.name,
      age,
      ageRange: `${age - 3}–${age + 3}`,
      homeBase: '',
      handle: lp.handles.tiktok ?? lp.handles.instagram ?? slugify(lp.name).replace(/-/g, ''),
      identity: oneLine || sentence(identity, 800),
      personality: [],
      worldview: listOf(b.worldview, 8),
      lore: sentence(textOf(b.character_lore, 3000), 1500),
      positions: positionsOf(b.positions_on_debates),
      catchphrases,
    },
    chosenFrom: 'A',
    advice: null,
  };
  const variants = [{ id: 'A', label: 'Bible portrait', prompt: `${lp.name}: see the look prompts`, url: portraitUri(lp.name, lp.hue), provider: 'placeholder' as const }];
  const look = {
    profile: { anchors: lp.looks.slice(0, 3), wardrobe: lp.looks, palette: [], settings: [], stylisation: 'From the bible', framing: 'From the bible', hue: lp.hue },
    variants,
    chosenVariant: 'A',
    check: null,
  };
  state.look = { status: 'done', generation: 1, options: [look], chosen: look, chosenFrom: 'A', advice: null };
  const voice = { id: 'A', label: 'From the bible', description: sentence(textOf(b.voice, 800), 300), voiceId: '', sampleText: hooks[0] ?? '', url: '', durationS: 0, provider: 'bible', fake: true };
  state.voice = done(voice);
  state.content = done(content);
  return state;
}

export interface RestoreOutcome {
  slug: string;
  name: string;
  status: 'restored' | 'unarchived' | 'skipped';
  personaId?: string;
  draftId?: string;
  reason?: string;
  /** The archived product manuscripts (absolute paths): they stay files; build v1 from them, not from a new brief. */
  manuscripts?: string[];
  note?: string;
}

/** What a restore says about the product manuscripts: they are kept as files and are the product content. */
export function manuscriptNote(slug: string, files: readonly string[]): string | undefined {
  if (!files.length) return undefined;
  const entry = files.find((f) => /product-1\.md$/.test(f)) ?? files[0]!;
  return `The product manuscripts stay as files (${files.map((f) => f.split('/').pop()).join(', ')}); the products come back as names, rungs and prices. Build v1 from the manuscripts, not from a new brief: pnpm products import "${entry}" --persona ${slug}`;
}

async function reviewDraftFor(services: StudioServices, input: { studioId: string; personaId: string; lp: LaunchPersona; label: string | null; actor: Actor }): Promise<DraftRow> {
  const existing = (await listDrafts(services.db, input.studioId)).find((d) => d.persona_id === input.personaId && d.status !== 'launched');
  if (existing) {
    if (existing.status === 'archived') {
      return commit(services.db, existing.id, { step: 0, change: 'restored with its persona', actor: input.actor }, async (cur) => ({ state: cur.state, status: 'active', currentStep: 7 }));
    }
    return existing;
  }
  const state = draftStateFromLaunchPersona(input.lp);
  const d = await insertDraft(services.db, {
    studioId: input.studioId,
    title: input.lp.name,
    seed: { mode: 'archive' },
    source: 'archive',
    actor: input.actor,
    state,
    currentStep: 7,
    personaId: input.personaId,
    archiveRef: input.label ? { label: input.label, slug: input.lp.slug } : null,
  });
  const review = await computeReview(services, d, state);
  return commit(services.db, d.id, { step: 7, change: 'review computed', actor: input.actor }, async () => ({
    state: { ...state, review: { status: 'ready', generation: 1, options: [review], chosen: review, chosenFrom: 'A', advice: null } },
    scores: { ...review.scorecard, distinctness: review.distinctness.score },
  }));
}

/**
 * Restores archived personas (`slugs` or 'all') from an archive label or folder. A persona that isn't in the studio is
 * imported as PROPOSED with its exact documents (bible, products, launch plan, Field Brain seed) and an Owner-only
 * launch card, plus a review draft; one that was parked (ARCHIVED) is restored in place. Only the Owner restores.
 */
export async function restoreFromArchive(
  services: StudioServices,
  input: { studioId: string; slugs: readonly string[] | 'all'; from?: string; actor: Actor },
): Promise<RestoreOutcome[]> {
  if (input.actor.type !== 'owner') throw new ApprovalError('only the Owner restores archived personas');
  const dir = archiveDir(input.from);
  const label = /(\d{4}-\d{2}-\d{2})\/?$/.exec(dir)?.[1] ?? null;
  const all = loadArchivedPersonas(dir);
  const wanted = input.slugs === 'all' ? all : input.slugs.map((s) => all.find((p) => p.slug === s) ?? s);
  const out: RestoreOutcome[] = [];
  for (const lp of wanted) {
    if (typeof lp === 'string') {
      out.push({ slug: lp, name: lp, status: 'skipped', reason: `not in the archive (${all.map((p) => p.slug).join(', ') || 'empty'})` });
      continue;
    }
    const existing = await services.db.maybeOne<{ id: string; state: string }>('SELECT id, state FROM persona WHERE studio_id = $1 AND slug = $2', [input.studioId, lp.slug]);
    if (existing && existing.state === 'ARCHIVED') {
      const r = await restoreArchivedPersona(services.db, { personaId: existing.id, actor: input.actor, now: services.now() });
      const draft = r.persona.state === 'PROPOSED' ? await reviewDraftFor(services, { studioId: input.studioId, personaId: existing.id, lp, label, actor: input.actor }) : null;
      out.push({ slug: lp.slug, name: lp.name, status: 'unarchived', personaId: existing.id, ...(draft ? { draftId: draft.id } : {}) });
      continue;
    }
    if (existing) {
      out.push({ slug: lp.slug, name: lp.name, status: 'skipped', personaId: existing.id, reason: `already in the studio (${existing.state})` });
      continue;
    }
    const res = await importLaunchPersona(services.db, input.studioId, lp, {
      now: services.now(),
      source: 'archive',
      summary: `Restored from the archive${label ? ` (${label})` : ''}: ${lp.niche}${lp.subNiche ? `, ${lp.subNiche}` : ''}. Bible ${lp.bibleLabel ?? 'v1'} as archived. Review it in the Persona Generator and approve the launch there.`,
    });
    const draft = await reviewDraftFor(services, { studioId: input.studioId, personaId: res.personaId, lp, label, actor: input.actor });
    const manuscripts = archivedManuscripts(lp.slug, dir);
    const note = manuscriptNote(lp.slug, manuscripts);
    out.push({ slug: lp.slug, name: lp.name, status: 'restored', personaId: res.personaId, draftId: draft.id, ...(manuscripts.length ? { manuscripts, note } : {}) });
    if (note) await notify(services.db, { studioId: input.studioId, personaId: res.personaId, kind: 'system', title: `${lp.name}: product manuscripts kept as files`, body: note, link: '/archive' });
  }
  if (out.some((r) => r.status !== 'skipped')) await ensureThreads(services.db, input.studioId);
  return out;
}

export interface ArchiveOverview {
  /** Each archived persona, with its studio row when restored (and the review draft while it waits for launch). */
  files: Array<ArchivedPersonaInfo & { inStudio: { id: string; state: string; draftId: string | null } | null }>;
  parked: Array<{ id: string; slug: string; name: string; niche: string; from: string; archived_at: Date; reason: string | null; bible_versions: number; products: number; portrait_url: string | null }>;
  drafts: DraftRow[];
}

export async function archiveOverview(services: StudioServices, studioId: string): Promise<ArchiveOverview> {
  let files: ArchivedPersonaInfo[] = [];
  try {
    files = listArchivedPersonas();
  } catch {
    files = [];
  }
  const inStudio = await services.db.query<{ id: string; slug: string; state: string; draft_id: string | null }>(
    `SELECT p.id, p.slug, p.state,
            (SELECT d.id FROM persona_draft d WHERE d.persona_id = p.id AND d.status = 'active' ORDER BY d.updated_at DESC LIMIT 1) AS draft_id
       FROM persona p WHERE p.studio_id = $1`,
    [studioId],
  );
  const parked = await services.db.query<ArchiveOverview['parked'][number]>(
    `SELECT p.id, p.slug, p.name, p.niche, p.archived_from_state AS from, p.archived_at, p.archive_reason AS reason, p.portrait_url,
            (SELECT count(*) FROM persona_bible b WHERE b.persona_id = p.id)::int AS bible_versions,
            (SELECT count(*) FROM product pr WHERE pr.persona_id = p.id)::int AS products
       FROM persona p WHERE p.studio_id = $1 AND p.state = 'ARCHIVED' ORDER BY p.archived_at DESC`,
    [studioId],
  );
  return {
    files: files.map((f) => {
      const p = inStudio.find((x) => x.slug === f.slug);
      return { ...f, inStudio: p ? { id: p.id, state: p.state, draftId: p.draft_id } : null };
    }),
    parked,
    drafts: await listDrafts(services.db, studioId, 'archived'),
  };
}

/**
 * Archives a studio persona (dashboard/agent path). A never-launched persona (or one still in review) needs nothing
 * more; a launched one needs the Owner's typed name (core enforces it). Its open review draft is archived with it.
 */
export async function archiveStudioPersona(services: StudioServices, input: { personaId: string; actor: Actor; confirmName?: string; reason?: string }) {
  const p = await archivePersona(services.db, { personaId: input.personaId, actor: input.actor, confirmName: input.confirmName, reason: input.reason });
  for (const d of (await listDrafts(services.db, p.studio_id, 'active')).filter((x) => x.persona_id === p.id)) {
    // From the locked row (a chat revision may have landed since the list); commit sets archived_at with the status.
    await commit(services.db, d.id, { step: 0, change: 'archived with its persona', actor: input.actor }, async (cur) => ({ state: cur.state, status: cur.status === 'active' ? 'archived' : cur.status }));
  }
  return p;
}

/**
 * A persona's documents as a LaunchPersona: the archived files when the archive holds this slug (exact: hue, looks,
 * launch plan), else rebuilt from the studio's rows (the current bible, products and accounts).
 */
async function launchPersonaOf(services: StudioServices, personaId: string): Promise<{ lp: LaunchPersona; studioId: string; label: string | null }> {
  const persona = await services.db.maybeOne<{ id: string; studio_id: string; slug: string; name: string; niche: string; sub_niche: string | null; timezone: string; accent_color: string | null }>(
    'SELECT id, studio_id, slug, name, niche, sub_niche, timezone, accent_color FROM persona WHERE id = $1',
    [personaId],
  );
  if (!persona) throw new NotFoundError('persona not found');
  let file: ArchivedPersonaInfo | undefined;
  try {
    file = listArchivedPersonas().find((f) => f.slug === persona.slug);
  } catch {
    file = undefined;
  }
  if (file) {
    const lp = loadArchivedPersonas(file.label, [persona.slug])[0];
    if (lp) return { lp, studioId: persona.studio_id, label: file.label };
  }
  const bible = await services.db.maybeOne<{ content: Record<string, unknown> }>(`SELECT content FROM persona_bible WHERE persona_id = $1 ORDER BY version DESC LIMIT 1`, [persona.id]);
  const products = await services.db.query<{ slug: string; name: string; ladder_rung: string; price_cents: number }>('SELECT slug, name, ladder_rung, price_cents FROM product WHERE persona_id = $1 ORDER BY price_cents', [persona.id]);
  const accounts = await services.db.query<{ platform: 'tiktok' | 'instagram'; handle: string }>(`SELECT platform, handle FROM account WHERE persona_id = $1 AND platform IN ('tiktok','instagram')`, [persona.id]);
  const hue = Number(/hsl\((\d+)/.exec(persona.accent_color ?? '')?.[1] ?? 210);
  return {
    studioId: persona.studio_id,
    label: null,
    lp: {
      slug: persona.slug,
      name: persona.name,
      niche: persona.niche,
      subNiche: persona.sub_niche,
      timezone: persona.timezone,
      hue,
      launchDate: null,
      handles: Object.fromEntries(accounts.map((a) => [a.platform, a.handle])),
      looks: [],
      bible: bible?.content ?? {},
      bibleLabel: null,
      sourceHash: '',
      products: products.map((p) => ({ slug: p.slug, name: p.name, rung: p.ladder_rung as LaunchPersona['products'][number]['rung'], priceCents: p.price_cents, note: null })),
      slots: [],
      seasonal: [],
      fieldBrain: { title: '', sources: [], feeds: [], experts: [], nodes: [] },
      dir: '',
    },
  };
}

/**
 * The review draft for a persona waiting for its Owner-only launch (PROPOSED): the existing one, reactivated if it
 * was archived, or a new one built from its documents. A launch that only the Owner approves is always decided there,
 * never from a generic Approve button (`pnpm knowledge personas import` creates personas with no draft).
 */
export async function ensureReviewDraft(services: StudioServices, input: { personaId: string; actor: Actor }): Promise<DraftRow> {
  if (input.actor.type !== 'owner') throw new ApprovalError('only the Owner opens a launch review');
  const p = await services.db.maybeOne<{ state: string; name: string }>('SELECT state, name FROM persona WHERE id = $1', [input.personaId]);
  if (!p) throw new NotFoundError('persona not found');
  if (p.state !== 'PROPOSED') throw new ApprovalError(`${p.name} is ${p.state}, not waiting for a launch`);
  const { lp, studioId, label } = await launchPersonaOf(services, input.personaId);
  return reviewDraftFor(services, { studioId, personaId: input.personaId, lp, label, actor: input.actor });
}

/** The Owner restores a parked persona; one archived before launch comes back to its review draft. */
export async function restoreStudioPersona(services: StudioServices, input: { personaId: string; actor: Actor }): Promise<{ state: string; draftId: string | null }> {
  const r = await restoreArchivedPersona(services.db, { personaId: input.personaId, actor: input.actor, now: services.now() });
  if (r.persona.state !== 'PROPOSED') return { state: r.persona.state, draftId: null };
  const draft = await ensureReviewDraft(services, input);
  return { state: r.persona.state, draftId: draft.id };
}
