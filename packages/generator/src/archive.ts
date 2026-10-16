import type { StudioServices } from '@ios/agents';
import { type Actor, ApprovalError, archivePersona, ensureThreads, NotFoundError, portraitUri, restoreArchivedPersona } from '@ios/core';
import { type ArchivedPersonaInfo, archiveDir, importLaunchPersona, type LaunchPersona, listArchivedPersonas, loadArchivedPersonas } from '@ios/core/seed';
import { nicheByKey, nicheForText, slugify } from './library';
import { computeReview } from './review';
import { textOf } from './score';
import { commit, insertDraft, listDrafts } from './store';
import { type ConceptOption, type ContentPlanDraft, type DraftRow, type DraftState, emptyState, type OpportunityOption } from './types';

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

/** A draft whose every step is filled from a persona's documents (all steps done; the review is computed later). */
export function draftStateFromLaunchPersona(lp: LaunchPersona): DraftState {
  const b = lp.bible;
  const n = nicheByKey(lp.niche) ?? nicheForText(lp.niche);
  const identity = textOf(b.identity, 3000);
  // The documents' own one-line positioning ("One line: …", "Positioning in one line: …", "One-line premise: …").
  const oneLine = /(?:one[- ]line(?: premise)?|positioning in one line)\s*:\s*([^\n]{20,400})/i.exec(identity)?.[1]?.trim() ?? '';
  const premiseText = (oneLine && sentence(oneLine, 320)) || sentence(textOf(b.character_lore, 1500), 320) || sentence(identity, 320);
  const age = Number(/\b([4-9]\d)(?:-year-old|,| years old)/.exec(`${oneLine} ${identity}`)?.[1] ?? 65);
  const pronoun: 'she' | 'he' = (identity.match(/\b(she|her)\b/gi)?.length ?? 0) >= (identity.match(/\b(he|his|him)\b/gi)?.length ?? 0) ? 'she' : 'he';
  const fw = b.signature_frameworks && typeof b.signature_frameworks === 'object' && !Array.isArray(b.signature_frameworks) ? (b.signature_frameworks as Record<string, unknown>) : {};
  const fwKey = Object.keys(fw).find((k) => /^\d+\.\d+\s/.test(k)) ?? Object.keys(fw)[0] ?? '';
  const fwName = fwKey.replace(/^\d+\.\d+\s+/, '').replace(/\.\s.*$/, '').trim();
  const fwFirst = listOf(fw[fwKey], 1)[0] ?? '';
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
    archetype: sentence(premiseText.startsWith(lp.name) ? premiseText.slice(lp.name.length).replace(/^[,\s]+(?:is\s+)?/, '') : premiseText, 120),
    premise: premiseText,
    contrast: sentence(textOf(b.expertise_map, 800), 260),
    mechanic: fwName ? `${fwName}: ${sentence(fwFirst, 200)}` : sentence(textOf(b.signature_frameworks, 800), 260),
    hooks: hooks.slice(0, 5),
    firstProduct: { name: entry?.name ?? '', priceCents: entry?.priceCents ?? 0, format: 'PDF' },
    lookLine: lp.looks.slice(0, 3).join(', '),
    voiceLine: sentence(voiceLine, 160),
    signOff: '',
  };
  const content: ContentPlanDraft = {
    pillars: listOf(b.content_dna, 3).map((p) => ({ name: p.slice(0, 80), why: '' })),
    series: [],
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
      positions: [],
      catchphrases: listOf((b.voice as Record<string, unknown> | undefined)?.catchphrases ?? [], 2),
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
}

async function reviewDraftFor(services: StudioServices, input: { studioId: string; personaId: string; lp: LaunchPersona; label: string | null; actor: Actor }): Promise<DraftRow> {
  const existing = (await listDrafts(services.db, input.studioId)).find((d) => d.persona_id === input.personaId && d.status !== 'launched');
  if (existing) {
    if (existing.status === 'archived') {
      return commit(services.db, existing.id, { step: 0, change: 'restored with its persona', actor: input.actor }, async () => ({ state: existing.state, status: 'active', currentStep: 7 }));
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
    out.push({ slug: lp.slug, name: lp.name, status: 'restored', personaId: res.personaId, draftId: draft.id });
  }
  if (out.some((r) => r.status !== 'skipped')) await ensureThreads(services.db, input.studioId);
  return out;
}

export interface ArchiveOverview {
  files: Array<ArchivedPersonaInfo & { inStudio: { id: string; state: string } | null }>;
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
  const inStudio = await services.db.query<{ id: string; slug: string; state: string }>('SELECT id, slug, state FROM persona WHERE studio_id = $1', [studioId]);
  const parked = await services.db.query<ArchiveOverview['parked'][number]>(
    `SELECT p.id, p.slug, p.name, p.niche, p.archived_from_state AS from, p.archived_at, p.archive_reason AS reason, p.portrait_url,
            (SELECT count(*) FROM persona_bible b WHERE b.persona_id = p.id)::int AS bible_versions,
            (SELECT count(*) FROM product pr WHERE pr.persona_id = p.id)::int AS products
       FROM persona p WHERE p.studio_id = $1 AND p.state = 'ARCHIVED' ORDER BY p.archived_at DESC`,
    [studioId],
  );
  return {
    files: files.map((f) => ({ ...f, inStudio: inStudio.find((p) => p.slug === f.slug) ?? null })),
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
    await commit(services.db, d.id, { step: 0, change: 'archived with its persona', actor: input.actor }, async () => ({ state: d.state, status: 'archived' }));
  }
  return p;
}

/** The Owner restores a parked persona; one archived before launch comes back to its review draft. */
export async function restoreStudioPersona(services: StudioServices, input: { personaId: string; actor: Actor }): Promise<{ state: string; draftId: string | null }> {
  const persona = await services.db.maybeOne<{ id: string; studio_id: string; slug: string; name: string; niche: string; sub_niche: string | null; timezone: string }>(
    'SELECT id, studio_id, slug, name, niche, sub_niche, timezone FROM persona WHERE id = $1',
    [input.personaId],
  );
  if (!persona) throw new NotFoundError('persona not found');
  const r = await restoreArchivedPersona(services.db, { personaId: input.personaId, actor: input.actor, now: services.now() });
  if (r.persona.state !== 'PROPOSED') return { state: r.persona.state, draftId: null };
  const bible = await services.db.maybeOne<{ content: Record<string, unknown> }>(`SELECT content FROM persona_bible WHERE persona_id = $1 ORDER BY version DESC LIMIT 1`, [persona.id]);
  const products = await services.db.query<{ slug: string; name: string; ladder_rung: string; price_cents: number }>('SELECT slug, name, ladder_rung, price_cents FROM product WHERE persona_id = $1 ORDER BY price_cents', [persona.id]);
  const lp: LaunchPersona = {
    slug: persona.slug,
    name: persona.name,
    niche: persona.niche,
    subNiche: persona.sub_niche,
    timezone: persona.timezone,
    hue: 210,
    launchDate: null,
    handles: {},
    looks: [],
    bible: bible?.content ?? {},
    bibleLabel: null,
    sourceHash: '',
    products: products.map((p) => ({ slug: p.slug, name: p.name, rung: p.ladder_rung as LaunchPersona['products'][number]['rung'], priceCents: p.price_cents, note: null })),
    slots: [],
    seasonal: [],
    fieldBrain: { title: '', sources: [], feeds: [], experts: [], nodes: [] },
    dir: '',
  };
  const draft = await reviewDraftFor(services, { studioId: persona.studio_id, personaId: persona.id, lp, label: null, actor: input.actor });
  return { state: r.persona.state, draftId: draft.id };
}
