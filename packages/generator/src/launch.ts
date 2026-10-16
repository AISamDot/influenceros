import { createHash } from 'node:crypto';
import { DEFAULT_CADENCE, enqueueOnceFor, type FormatPlan, type StudioServices } from '@ios/agents';
import { type Actor, actorRef, addMessage, ApprovalError, type ApprovalRow, decide, ensureThreads, findThread, isOptionalFormat, notify, payloadHash, POST_FORMATS, type PostFormat, type PostPurpose } from '@ios/core';
import { BIBLE_SECTIONS, type FieldBrainSeed, importLaunchPersona, type LaunchPersona, type LaunchProduct, type LaunchSlot, listArchivedPersonas, zonedTimeToUtc } from '@ios/core/seed';
import { type Db, json } from '@ios/db';
import { archetypeFor } from './fake';
import { firstName, nicheByKey, slugify } from './library';
import { nicheOf } from './steps';
import { computeReview } from './review';
import { commit, DraftError, requireDraft } from './store';
import type { DraftRow, DraftState, ReviewState } from './types';

/**
 * Launch (PRD §3.12 step 7): only the Owner approves it, explicitly. The draft becomes a persona through the same
 * importer the archive and the seed use (PROPOSED + an Owner-only launch card), and the Owner's approval of that
 * card moves it to SETUP at once. The deep profile (all 16 Appendix A sections), the launch calendar (the first
 * fortnight, 10 posts a week), the product ladder, the Field Brain seed and its build request come with it.
 */

const SLOT_DAYS = [0, 0, 1, 2, 2, 3, 4, 4, 5, 6];
const SLOT_TIMES = ['08:00', '19:00', '12:30', '08:00', '19:30', '12:30', '08:00', '19:00', '10:00', '18:00'];
const PURPOSES: PostPurpose[] = ['reach', 'reach', 'trust', 'reach', 'reach', 'trust', 'reach', 'sell', 'trust', 'reach'];

/**
 * (IOS-5 integration) The launch fortnight's 10 formats a week follow the draft's Format Plan (step 6), or the studio
 * default (DEFAULT_CADENCE) when there is none: the plan's weekly counts are scaled to 10 (each core format ≥ 1, each
 * optional format that is on ≥ 1 while there is room) and interleaved so the same format never runs back to back
 * when it can be avoided.
 */
export function launchFormats(plan: FormatPlan | null | undefined, n = SLOT_DAYS.length): PostFormat[] {
  const mix: Partial<Record<PostFormat, number>> = plan
    ? Object.fromEntries(plan.lines.filter((l) => l.enabled && l.perWeek > 0).map((l) => [l.format, l.perWeek]))
    : { ...DEFAULT_CADENCE.formatMix };
  const keys = POST_FORMATS.filter((f) => !isOptionalFormat(f) || (mix[f] ?? 0) > 0);
  const w = (f: PostFormat) => Math.max(0, mix[f] ?? 0);
  const wsum = keys.reduce((a, f) => a + w(f), 0) || keys.length;
  const ideal = new Map(keys.map((f) => [f, ((w(f) || (wsum === keys.length ? 1 : 0)) / wsum) * n]));
  const count = new Map(keys.map((f) => [f, isOptionalFormat(f) ? 0 : 1]));
  const total = () => [...count.values()].reduce((a, b) => a + b, 0);
  // Optional formats that are on get one post each while the week has room, heaviest first.
  for (const f of keys.filter(isOptionalFormat).sort((a, b) => w(b) - w(a))) if (total() < n) count.set(f, 1);
  while (total() < n) {
    const f = [...keys].sort((a, b) => ideal.get(b)! - count.get(b)! - (ideal.get(a)! - count.get(a)!))[0]!;
    count.set(f, count.get(f)! + 1);
  }
  const out: PostFormat[] = [];
  const left = new Map(count);
  while (out.length < n) {
    const f = [...keys].filter((k) => left.get(k)! > 0).sort((a, b) => Number(a === out.at(-1)) - Number(b === out.at(-1)) || left.get(b)! - left.get(a)!)[0]!;
    out.push(f);
    left.set(f, left.get(f)! - 1);
  }
  return out;
}

export function launchCalendar(state: DraftState, review: ReviewState): LaunchSlot[] {
  const FORMATS = launchFormats(state.formatPlan);
  const content = state.content.chosen!;
  const hooks = content.hookBank.length ? content.hookBank : state.concept.chosen!.hooks;
  const start = new Date(`${review.launchDate}T00:00:00Z`);
  const slots: LaunchSlot[] = [];
  for (let n = 0; n < 20; n++) {
    const i = n % 10;
    const day = new Date(start.getTime() + ((n >= 10 ? 7 : 0) + SLOT_DAYS[i]!) * 86_400_000);
    const [hh, mm] = SLOT_TIMES[i]!.split(':').map(Number) as [number, number];
    const localDate = day.toISOString().slice(0, 10);
    const purpose = PURPOSES[i]!;
    const series = content.series.find((s) => s.format === FORMATS[i]) ?? content.series[0];
    const hook = hooks[n % hooks.length]!;
    slots.push({
      n: n + 1,
      localDate,
      localTime: SLOT_TIMES[i]!,
      slotAt: zonedTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, review.timezone),
      format: FORMATS[i]!,
      purpose,
      pillar: series?.pillar ?? content.pillars[n % content.pillars.length]?.name ?? null,
      title: purpose === 'sell' ? `${content.firstProductBrief.name}: ${hook}` : hook,
      hook,
      cta: purpose === 'sell' ? content.firstProductBrief.keyword : content.ctaKeywords[n % content.ctaKeywords.length] ?? null,
    });
  }
  return slots;
}

function fieldBrainSeed(state: DraftState, slug: string): FieldBrainSeed {
  const n = nicheOf(state);
  const pillars = state.content.chosen?.pillars ?? n.pillars;
  return {
    title: `${n.key} Field Brain seed (Persona Generator)`,
    sources: [],
    feeds: n.feeds.map((f) => ({
      name: f.name,
      url: `https://news.google.com/rss/search?q=${encodeURIComponent(f.query)}&hl=en-US&gl=US&ceid=US:en`,
      feed: true,
      why: `News Desk watch for ${n.subNiche}`,
    })),
    experts: [],
    nodes: n.fieldTopics.map((t, i) => ({
      path: `${slugify(pillars[i % pillars.length]?.name ?? 'fundamentals')}/${slugify(t)}`,
      title: t,
      level: i < 3 ? 'fundamental' : i < 6 ? 'intermediate' : 'debate',
      module: pillars[i % pillars.length]?.name ?? 'Fundamentals',
      synthesis: '',
      facts: null,
      use: `${slug}: background for ${pillars[i % pillars.length]?.name ?? 'content'}`,
      sourceRefs: [],
    })),
  };
}

/** The deep profile: all 16 Appendix A sections, plus a palette table the persona kit reads. */
export function deepProfile(d: Pick<DraftRow, 'id' | 'version'>, state: DraftState, review: ReviewState): Record<string, unknown> {
  const c = state.concept.chosen!;
  const ch = state.character.chosen!;
  const look = state.look.chosen!;
  const voice = state.voice.chosen;
  const content = state.content.chosen!;
  const opp = state.opportunity.chosen!;
  const n = nicheOf(state);
  const a = archetypeFor(c);
  const first = firstName(ch.name);
  const variant = look.variants.find((v) => v.id === look.chosenVariant) ?? look.variants[0];
  const bible: Record<string, unknown> = {
    identity: {
      name: ch.name,
      handles: { tiktok: `@${ch.handle}`, instagram: `@${ch.handle}` },
      age_range_shown: ch.ageRange,
      home_base: ch.homeBase,
      summary: ch.identity,
      ai_label: 'Openly AI: the platform AI flag on every post and the AI profile label wherever it exists. Never denies being AI when sincerely asked.',
    },
    character_lore: { premise: c.premise, backstory: ch.lore, quirks: ch.personality, note: 'Character lore and first-person stories are allowed as character content; never used as proof that a product works.' },
    worldview: { principles: ch.worldview },
    expertise_map: {
      field_brain: `${n.key} (${n.subNiche})`,
      depth_areas: n.fieldTopics.slice(0, 6),
      blind_spots: ['Individual medical, legal or financial cases (refers out)', 'Anything needing a credential: never claims one'],
      known_for: c.mechanic,
    },
    signature_frameworks: [
      { name: a.ritual, steps: [`Look at the viewer's ${n.object}`, `Call it: "${a.verdicts[0]}" or "${a.verdicts[1]}"`, 'Give the one fix that changes the call'], example: c.hooks[2] ?? c.hooks[0] },
      { name: `${first}'s Rules`, steps: ch.worldview.slice(0, 4), example: content.hookBank[0] ?? '' },
      { name: content.firstProductBrief.name, steps: content.firstProductBrief.sections, example: content.firstProductBrief.promise },
    ],
    positions_on_debates: ch.positions,
    news_beats: {
      topics: n.fieldTopics.slice(0, 5),
      sources: n.feeds.map((f) => f.name),
      stance_rules: ['Rate the trend, not the person', 'Facts from the Field Brain or a cited news item only', `React in ${first}'s voice, within the positions above`],
      never_comment_on: ['Specific politicians or elections', 'Individual medical, legal or financial cases', 'Tragedies for engagement'],
    },
    audience: { icp: opp.audience, pains: n.myths.map((m) => `Believes "${m}"`), desires: [opp.angle], objections: ['Is this just another AI account?', 'Will it shame me?'], buying_triggers: opp.buyingMoments },
    voice: {
      voice_id: voice?.voiceId ?? null,
      voice_provider: voice?.provider ?? null,
      description: voice?.description ?? c.voiceLine,
      line: c.voiceLine,
      catchphrases: ch.catchphrases.slice(0, 2),
      sign_off: c.signOff,
      avoid: ['Credential words (Dr., nutritionist, adviser)', 'Guarantees', '"I lost / I made" results'],
    },
    look: {
      anchors: look.profile.anchors,
      wardrobe: look.profile.wardrobe,
      settings: look.profile.settings,
      palette: look.profile.palette.map((p) => `${p.name} ${p.hex}`),
      stylisation: look.profile.stylisation,
      framing: look.profile.framing,
      character_sheet: variant ? { label: variant.label, prompt: variant.prompt, provider: variant.provider, ...(variant.provider === 'higgsfield' ? { url: variant.url } : {}) } : null,
      checks: look.check ?? null,
    },
    content_dna: {
      pillars: content.pillars,
      series: content.series,
      hook_library: content.hookBank,
      purpose_mix: `About 6 reach / 3 trust / 1 sell a week; 10 posts (${launchMixLabel(state.formatPlan)})`,
      banned_hook_styles: ['A story used as proof that a product works', 'Real people or brands as endorsers', 'Income or result guarantees', 'Credential claims', 'Fake scarcity'],
    },
    engagement_style: { reply_tone: `${a.personality.slice(0, 2).join(', ')}; ${c.voiceLine}`, keywords: content.ctaKeywords, boundaries: ['No personal advice in replies: general information only', 'Never denies being AI'] },
    products: {
      philosophy: 'Finite, tick-box tools that do one job; never a reading list.',
      ladder: content.ladder.map((r) => ({ rung: r.rung, name: r.name, price: `$${(r.priceCents / 100).toFixed(0)}`, when: r.when })),
      first_product_brief: content.firstProductBrief,
    },
    community: { rules: ['Kind or quiet', 'No selling in the comments', 'Safety first'], rituals: [`Weekly ${a.ritual}`, `${first}'s Sunday check-in`] },
    compliance: { inherited: 'Studio rules (legal and platform lines; AI labels)', niche: n.risks, credentials: 'Never claims a degree, licence or credential.' },
    metrics: { checkpoints: 'Studio defaults: day 14, day 30, day 60', scorecard: review.scorecard, distinctness: review.distinctness.score },
    palette_table: ['| Name | Hex | Use |', '|---|---|---|', ...look.profile.palette.map((p, i) => `| ${p.name} | ${p.hex} | ${i === 0 ? 'primary' : i === 1 ? 'accent' : 'support'} |`)].join('\n'),
    source_document: {
      file: `generator/${d.id}`,
      version: 'v1',
      sha256: createHash('sha256').update(json(state)).digest('hex').slice(0, 16),
      draft_id: d.id,
      draft_version: d.version,
    },
  };
  for (const k of BIBLE_SECTIONS) if (!(k in bible)) throw new Error(`deep profile is missing ${k}`);
  return bible;
}

export function draftToLaunchPersona(d: DraftRow, state: DraftState, review: ReviewState, slug: string): LaunchPersona {
  const ch = state.character.chosen!;
  const opp = state.opportunity.chosen!;
  const look = state.look.chosen!;
  const content = state.content.chosen!;
  // Two rungs can share a name (and so a slug): the second one gets its rung appended so no ladder product is dropped.
  const seen = new Set<string>();
  const products: LaunchProduct[] = content.ladder.map((r) => {
    let slug = slugify(r.name) || r.rung;
    if (seen.has(slug)) slug = `${slug}-${r.rung}`;
    for (let i = 2; seen.has(slug); i++) slug = `${slugify(r.name) || r.rung}-${r.rung}-${i}`;
    seen.add(slug);
    return { slug, name: r.name, rung: r.rung, priceCents: r.priceCents, note: r.when };
  });
  const bible = deepProfile(d, state, review);
  return {
    slug,
    name: ch.name,
    niche: (nicheByKey(opp.niche)?.key ?? opp.niche).toLowerCase(),
    subNiche: opp.subNiche,
    timezone: review.timezone,
    hue: look.profile.hue,
    launchDate: review.launchDate,
    handles: { tiktok: ch.handle, instagram: ch.handle },
    looks: look.profile.wardrobe.slice(0, 3),
    bible,
    bibleLabel: 'v1',
    sourceHash: String((bible.source_document as { sha256: string }).sha256),
    products,
    slots: launchCalendar(state, review),
    seasonal: opp.buyingMoments.map((m) => ({ date: m, moment: m, play: `Sell ${content.firstProductBrief.name}` })),
    fieldBrain: fieldBrainSeed(state, slug),
    dir: '',
  };
}

async function uniqueSlug(db: Db, studioId: string, name: string): Promise<string> {
  const base = slugify(firstName(name)) || 'persona';
  // Archived personas keep their slugs (their documents live under them): a new persona never takes one.
  let archived = new Set<string>();
  try {
    archived = new Set(listArchivedPersonas().map((p) => p.slug));
  } catch {
    /* no archive on disk */
  }
  for (let i = 1; i < 50; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (archived.has(slug)) continue;
    if (!(await db.maybeOne('SELECT 1 FROM persona WHERE studio_id = $1 AND slug = $2', [studioId, slug]))) return slug;
  }
  throw new DraftError('could not find a free slug');
}

export interface LaunchResult {
  persona: { id: string; slug: string; name: string; state: string };
  approval: ApprovalRow;
  slots: number;
  nodes: number;
  fieldBrainQueued: boolean;
  draft: DraftRow;
}

/**
 * The Owner approves the launch. Agents and the system are refused here, by the tool registry and by the database.
 * Atomic: the draft row is locked for the whole launch (import, approval, Field Brain build, the draft's own commit),
 * so a double submit or a retry waits and then finds the draft launched, and a failure part-way leaves nothing behind.
 */
export async function launchDraft(services: StudioServices, draftId: string, ctx: { actor: Actor; expectVersion?: number }): Promise<LaunchResult> {
  if (ctx.actor.type !== 'owner') throw new ApprovalError('only the Owner approves a persona launch (agents draft and recommend)');
  const { db } = services;
  const d = await requireDraft(db, draftId);
  if (d.status !== 'active') throw new DraftError(`this draft is ${d.status}`);
  if (ctx.expectVersion !== undefined && ctx.expectVersion !== d.version) throw new DraftError('this draft changed since you opened it: reload and check it again');
  const review = await computeReview(services, d, d.state);
  if (!review.ready) {
    const why = [...review.missing.map((m) => (m.includes('(') ? m : `${m} not chosen`)), ...review.risks.filter((r) => r.startsWith('Line:') || r.startsWith('Too close'))];
    throw new DraftError(`not ready to launch: ${why.join('; ')}`);
  }
  const now = services.now();
  const done = await db.transaction(async (tx) => {
    const cur = await tx.maybeOne<DraftRow>('SELECT * FROM persona_draft WHERE id = $1 FOR UPDATE', [draftId]);
    if (!cur) throw new DraftError('draft not found');
    if (cur.status !== 'active') throw new DraftError(`this draft is ${cur.status}`);
    if (cur.version !== d.version) throw new DraftError('this draft changed while the launch was being checked: reload and check it again');
    let personaId = cur.persona_id;
    let slots = 0;
    let nodes = 0;
    let niche: string;
    if (personaId) {
      // Restored from the archive: the persona is already PROPOSED with its documents; approve its launch card.
      const p = await tx.one<{ state: string; niche: string }>('SELECT state, niche FROM persona WHERE id = $1 FOR UPDATE', [personaId]);
      if (p.state !== 'PROPOSED') throw new DraftError(`the persona is ${p.state}, not waiting for a launch`);
      niche = p.niche;
    } else {
      const ch = cur.state.character.chosen!;
      const slug = await uniqueSlug(tx, cur.studio_id, ch.name);
      const lp = draftToLaunchPersona(cur, cur.state, review, slug);
      niche = lp.niche;
      const res = await importLaunchPersona(tx, cur.studio_id, lp, {
        now,
        source: 'generator',
        createdBy: 'agent:studio-manager',
        approvedBy: actorRef(ctx.actor),
        summary: `Co-created in the Persona Generator: ${lp.niche} (${lp.subNiche}). Scorecard ${review.scorecard.total}/100, distinctness ${review.distinctness.score}/100. First posts ${lp.launchDate}.`,
      });
      personaId = res.personaId;
      slots = res.slots;
      nodes = res.nodes;
      const look = cur.state.look.chosen!;
      const variant = look.variants.find((v) => v.id === look.chosenVariant);
      if (variant?.provider === 'higgsfield') await tx.query('UPDATE persona SET portrait_url = $2 WHERE id = $1', [personaId, variant.url]);
      const voice = cur.state.voice.chosen;
      if (voice && !voice.fake) {
        await tx.query(
          `INSERT INTO media_profile (persona_id, voice_provider, voice_id) VALUES ($1, $2, $3) ON CONFLICT (persona_id) DO UPDATE SET voice_provider = EXCLUDED.voice_provider, voice_id = EXCLUDED.voice_id`,
          [personaId, voice.provider, voice.voiceId],
        );
      }
    }
    // (IOS-5) The approved Format Plan (stream L) and World Bible + storyline (stream J) go live with the launch.
    if (cur.state.formatPlan) await services.formatPlans.adoptPlan(tx, { personaId: personaId!, studioId: cur.studio_id, plan: cur.state.formatPlan, actor: ctx.actor });
    if (cur.state.world) await services.world.adoptWorld(tx, { personaId: personaId!, studioId: cur.studio_id, draft: cur.state.world, actor: ctx.actor });
    const card = await tx.maybeOne<ApprovalRow>(`SELECT * FROM approval WHERE persona_id = $1 AND kind = 'persona_launch' AND status = 'pending'`, [personaId]);
    if (!card) throw new DraftError('no pending launch card for this persona');
    const approval = await decide(tx, { approvalId: card.id, decision: 'approve', actor: ctx.actor, payloadHash: payloadHash(card.payload), note: `Approved in the Persona Generator (draft v${cur.version})` });
    const job = await enqueueOnceFor(tx, { kind: 'knowledge.build', key: `build:${cur.studio_id}:${niche.toLowerCase()}`, payload: { studioId: cur.studio_id, niche: niche.toLowerCase() }, studioId: cur.studio_id, priority: 130 });
    const persona = await tx.one<{ id: string; slug: string; name: string; state: string }>('SELECT id, slug, name, state FROM persona WHERE id = $1', [personaId]);
    const draft = await commit(tx, draftId, { step: 7, change: `launched ${persona.name} (${persona.state})`, actor: ctx.actor, expectVersion: cur.version }, async (row) => ({ state: row.state, status: 'launched', personaId }));
    await tx.query('UPDATE persona_draft SET launched_by = $2, launched_at = now() WHERE id = $1', [draftId, actorRef(ctx.actor)]);
    return { personaId: personaId!, slots, nodes, niche, approval, job, persona, draft: { ...draft, launched_by: actorRef(ctx.actor), launched_at: now } };
  });
  const { personaId, slots, nodes, niche, approval, job, persona, draft } = done;
  await ensureThreads(db, d.studio_id);
  const thread = await findThread(db, d.studio_id, 'studio');
  await addMessage(db, {
    threadId: thread.id,
    role: 'agent',
    author: 'agent:studio-manager',
    body: `Launch approved: ${persona.name} is in setup. ${slots ? `${slots} launch posts are on the calendar from ${review.launchDate}; ` : ''}the ${niche} Field Brain build is ${job ? 'queued' : 'already queued'}. Next for you: create the TikTok and Instagram accounts from the setup sheet (Settings → Accounts) and switch on the AI profile labels.`,
    meta: { kind: 'notice', draftId, personaId },
  });
  await notify(db, {
    studioId: d.studio_id,
    personaId,
    kind: 'system',
    severity: 'warn',
    title: `${persona.name}: create the accounts`,
    body: 'Launch approved. Create the TikTok and Instagram accounts (handles are in the Profile) and switch on the AI profile labels.',
    link: '/settings/accounts',
  });
  return { persona, approval, slots, nodes, fieldBrainQueued: !!job, draft };
}

/** e.g. "2 talking, 2 activity_text, 1 voiceover, 2 static, 2 carousel, 1 photo_dump" for the deep profile. */
function launchMixLabel(plan: FormatPlan | null | undefined): string {
  const counts = new Map<PostFormat, number>();
  for (const f of launchFormats(plan)) counts.set(f, (counts.get(f) ?? 0) + 1);
  return POST_FORMATS.filter((f) => counts.has(f)).map((f) => `${counts.get(f)} ${f}`).join(', ');
}
