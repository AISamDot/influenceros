import { type Db, json } from '@ios/db';
import { propose, sweepAutoApprovals } from '../approvals';
import { portraitUri, thumbnailUri } from '../art';
import { audit } from '../audit';
import { addMessage, ensureThreads, findThread } from '../chat';
import { notify } from '../notifications';
import { type Actor, DEFAULT_SETTINGS, STUDIO_MANAGER } from '../types';
import type { FieldBrainSeed, LaunchPersona } from './launch';

/**
 * Writes the launch personas. Used by the seed (a fresh studio) and by the `personas.import` job (an existing
 * studio picking up new folders or edited documents). Nothing here invents results: no metrics, orders, spend or
 * followers. Personas start in SETUP via the normal launch card, which the Studio Manager proposes and the
 * auto-approve timer executes (persona creation is delegated to the Studio Manager; the Owner is notified).
 */

const HOUR = 3_600_000;
const IMPORTER: Actor = { type: 'agent', id: 'studio-manager' };

export interface ImportResult {
  slug: string;
  personaId: string;
  created: boolean;
  /** A new bible version was written (document changed). */
  updated: boolean;
  bibleVersion: number;
  slots: number;
  nodes: number;
}

export async function importLaunchPersona(
  db: Db,
  studioId: string,
  lp: LaunchPersona,
  opts: { now: Date; proposeAt?: Date },
): Promise<ImportResult> {
  const existing = await db.maybeOne<{ id: string; current_bible_version: number | null }>(
    'SELECT id, current_bible_version FROM persona WHERE studio_id = $1 AND slug = $2',
    [studioId, lp.slug],
  );
  if (existing) return refreshPersona(db, studioId, existing.id, existing.current_bible_version ?? 0, lp, opts.now);

  const lookPack = lp.looks.map((label, v) => ({ label, url: portraitUri(lp.name, lp.hue, { variant: v, label }) }));
  const persona = await db.one<{ id: string }>(
    `INSERT INTO persona (studio_id, slug, name, niche, sub_niche, state, budget, portrait_url, look_pack, accent_color,
                          timezone, current_bible_version)
     VALUES ($1, $2, $3, $4, $5, 'PROPOSED', '{}'::jsonb, $6, $7::jsonb, $8, $9, 1) RETURNING id`,
    [studioId, lp.slug, lp.name, lp.niche, lp.subNiche, portraitUri(lp.name, lp.hue), json(lookPack), `hsl(${lp.hue} 55% 45%)`, lp.timezone],
  );
  const personaId = persona.id;
  await db.query(
    `INSERT INTO persona_bible (persona_id, version, content, status, created_by, approved_by, approved_at)
     VALUES ($1, 1, $2::jsonb, 'approved', 'agent:studio-manager', 'agent:studio-manager', $3)`,
    [personaId, json(lp.bible), opts.now],
  );
  // Accounts are created by the Owner (never automatically); these rows hold the chosen handles until then.
  for (const platform of ['tiktok', 'instagram'] as const) {
    const handle = lp.handles[platform];
    if (!handle) continue;
    await db.query(
      `INSERT INTO account (persona_id, platform, handle, ai_label_ok, two_fa_owner, status)
       VALUES ($1, $2, $3, false, 'owner', 'pending') ON CONFLICT (platform, handle) DO NOTHING`,
      [personaId, platform, handle],
    );
  }
  await upsertProducts(db, personaId, lp);
  if (lp.seasonal.length) {
    await db.query(
      `INSERT INTO plan (persona_id, kind, period_start, period_end, content) VALUES ($1, 'timeline', $2, $3, $4::jsonb)`,
      [personaId, lp.launchDate, null, json({ horizon: 'Launch season (from the bible)', milestones: monthlyMilestones(lp.seasonal) })],
    );
  }
  const slots = await seedSlots(db, personaId, lp, opts.now);
  const nodes = await upsertFieldBrainSeed(db, studioId, lp.niche, lp.fieldBrain, lp.slug);
  await propose(db, {
    studioId,
    personaId,
    kind: 'persona_launch',
    title: `Launch ${lp.name}`,
    summary: `${lp.niche}${lp.subNiche ? `: ${lp.subNiche}` : ''}. Bible ${lp.bibleLabel ?? 'v1'} imported; first post ${lp.launchDate ?? 'TBC'}.`,
    proposedBy: STUDIO_MANAGER,
    subjectType: 'persona',
    subjectId: personaId,
    now: opts.proposeAt ?? opts.now,
  });
  await audit(db, { studioId, personaId, actor: IMPORTER, action: 'persona.imported', entityType: 'persona', entityId: personaId, data: { slug: lp.slug, source: lp.bible.source_document as Record<string, unknown> } });
  return { slug: lp.slug, personaId, created: true, updated: false, bibleVersion: 1, slots, nodes };
}

/** An existing persona: a changed document set becomes bible vN+1 (delegated: approved by the Studio Manager). */
async function refreshPersona(db: Db, studioId: string, personaId: string, version: number, lp: LaunchPersona, now: Date): Promise<ImportResult> {
  const latest = await db.maybeOne<{ content: Record<string, unknown> }>(
    'SELECT content FROM persona_bible WHERE persona_id = $1 ORDER BY version DESC LIMIT 1',
    [personaId],
  );
  const prevHash = (latest?.content?.source_document as { sha256?: string } | undefined)?.sha256 ?? null;
  const nextHash = (lp.bible.source_document as { sha256: string }).sha256;
  let bibleVersion = version;
  let updated = false;
  if (prevHash !== nextHash) {
    updated = true;
    bibleVersion = await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM persona WHERE id = $1 FOR UPDATE', [personaId]);
      const max = await tx.one<{ v: number }>('SELECT COALESCE(MAX(version), 0)::int AS v FROM persona_bible WHERE persona_id = $1', [personaId]);
      const next = Math.max(version, max.v) + 1;
      const content = carryOverRules(latest?.content ?? null, lp.bible, { version: next, label: lp.bibleLabel ?? null });
      await tx.query(`UPDATE persona_bible SET status = 'superseded' WHERE persona_id = $1 AND status = 'approved'`, [personaId]);
      await tx.query(
        `INSERT INTO persona_bible (persona_id, version, content, status, created_by, approved_by, approved_at)
         VALUES ($1, $2, $3::jsonb, 'approved', 'agent:studio-manager', 'agent:studio-manager', $4)`,
        [personaId, next, json(content), now],
      );
      await tx.query('UPDATE persona SET current_bible_version = $2, updated_at = now() WHERE id = $1', [personaId, next]);
      await audit(tx, { studioId, personaId, actor: IMPORTER, action: 'bible.imported', entityType: 'persona', entityId: personaId, data: { version: next } });
      return next;
    });
    await notify(db, {
      studioId,
      personaId,
      kind: 'system',
      title: `${lp.name}: bible v${bibleVersion} imported`,
      body: `The Persona Architect's updated documents (${lp.bibleLabel ?? 'new version'}) are now live for ${lp.name}'s manager. No action needed.`,
      link: `/personas/${lp.slug}`,
    });
  }
  await upsertProducts(db, personaId, lp);
  const nodes = await upsertFieldBrainSeed(db, studioId, lp.niche, lp.fieldBrain, lp.slug);
  return { slug: lp.slug, personaId, created: false, updated, bibleVersion, slots: 0, nodes };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uniq = <T>(xs: readonly T[]): T[] => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = JSON.stringify(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * A re-imported bible keeps what the feedback loop added on top of the documents: each section's `owner_rules` and
 * `agent_rules`, the top-level ones and the `changelog` (plus an entry for this import). Without this, a doc edit would silently
 * drop rules the Owner was told are live.
 */
export function carryOverRules(prev: Record<string, unknown> | null, next: Record<string, unknown>, at: { version: number; label: string | null }): Record<string, unknown> {
  const content = structuredClone(next);
  for (const field of ['owner_rules', 'agent_rules'] as const) {
    const topRules: unknown[] = Array.isArray(content[field]) ? [...(content[field] as unknown[])] : [];
    if (prev) {
      for (const [key, sec] of Object.entries(prev)) {
        const rules = isObj(sec) ? sec[field] : undefined;
        if (!Array.isArray(rules) || !rules.length) continue;
        const target = content[key];
        if (isObj(target)) target[field] = uniq([...(Array.isArray(target[field]) ? (target[field] as unknown[]) : []), ...rules]);
        else if (target === undefined) content[key] = { [field]: [...rules] };
        else topRules.push(...rules.map((rule) => ({ section: key, rule })));
      }
      if (Array.isArray(prev[field])) topRules.push(...(prev[field] as unknown[]));
    }
    if (topRules.length) content[field] = uniq(topRules);
  }
  content.changelog = [
    ...(prev && Array.isArray(prev.changelog) ? prev.changelog : []),
    ...(Array.isArray(next.changelog) ? next.changelog : []),
    { version: at.version, section: 'all', change: `Persona Architect documents re-imported${at.label ? ` (${at.label})` : ''}; earlier rules kept` },
  ];
  return content;
}

async function upsertProducts(db: Db, personaId: string, lp: LaunchPersona): Promise<void> {
  for (const [i, p] of lp.products.entries()) {
    await db.query(
      `INSERT INTO product (persona_id, name, slug, ladder_rung, status, price_cents, cover_url)
       VALUES ($1, $2, $3, $4, 'idea', $5, $6) ON CONFLICT (persona_id, slug) DO NOTHING`,
      [personaId, p.name, p.slug, p.rung, p.priceCents, thumbnailUri(p.name, lp.hue + 15, p.rung === 'membership' ? 'carousel' : 'static', i + 3)],
    );
  }
}

function monthlyMilestones(seasonal: LaunchPersona['seasonal']): Array<{ month: string; goal: string }> {
  const byMonth = new Map<string, string[]>();
  for (const s of seasonal) {
    const month = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(?:\s+(\d{4}))?/.exec(s.date);
    const key = month ? `${month[1]}${month[2] ? ` ${month[2]}` : ''}` : s.date;
    byMonth.set(key, [...(byMonth.get(key) ?? []), s.moment]);
  }
  return [...byMonth.entries()].slice(0, 8).map(([month, moments]) => ({ month, goal: moments.filter(Boolean).join('; ').slice(0, 280) }));
}

/** The Monday (YYYY-MM-DD) of a YYYY-MM-DD calendar date. */
function mondayOfDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** The content plan's launch fortnight as planned slots (future ones only), each with its idea. */
async function seedSlots(db: Db, personaId: string, lp: LaunchPersona, now: Date): Promise<number> {
  let n = 0;
  for (const s of lp.slots) {
    if (s.slotAt.getTime() <= now.getTime()) continue;
    const idea = await db.one<{ id: string }>(
      `INSERT INTO idea (persona_id, title, pillar, format, purpose, hook_options, source, status)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'new') RETURNING id`,
      [
        personaId,
        s.title,
        s.pillar,
        s.format,
        s.purpose,
        json(s.hook ? [s.hook] : []),
        json({ type: 'content_plan', post: s.n, cta: s.cta, local: `${s.localDate} ${s.localTime}`, file: `${lp.slug}/content-plan.md` }),
      ],
    );
    // week_start is the Monday of the post's local date (the calendar's week membership), so a Sunday-evening post
    // west of UTC stays in its own week instead of making the next week look planned.
    await db.query(
      `INSERT INTO calendar_slot (persona_id, slot_at, format, purpose, pillar, title, status, idea_id, thumbnail_url, week_start)
       VALUES ($1, $2, $3, $4, $5, $6, 'planned', $7, $8, $9::date)`,
      [personaId, s.slotAt, s.format, s.purpose, s.pillar, s.title, idea.id, thumbnailUri(s.title, lp.hue, s.format, s.n), mondayOfDate(s.localDate)],
    );
    n += 1;
  }
  return n;
}

/**
 * The niche's Field Brain seed: canon sources, the feeds the News Desk polls, the expert map and the curriculum
 * skeleton with the seed synthesis. Nodes stay unverified (last_verified_at null) until the Knowledge Builder
 * researches them; embeddings are filled by the knowledge.embed job. Idempotent.
 */
export async function upsertFieldBrainSeed(db: Db, studioId: string, niche: string, fb: FieldBrainSeed, personaSlug: string): Promise<number> {
  const refIds = new Map<string, { id: string; url: string | null; name: string }>();
  for (const s of fb.sources) {
    const row = await db.one<{ id: string; url: string | null; name: string }>(
      `INSERT INTO knowledge_source (studio_id, niche, name, url, kind, canon, credibility, notes, meta)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8::jsonb)
       ON CONFLICT (studio_id, niche, name) DO UPDATE SET url = COALESCE(knowledge_source.url, EXCLUDED.url)
       RETURNING id, url, name`,
      [studioId, niche, s.name, s.url, s.kind, s.credibility, s.notes, json({ origin: 'seed', persona: personaSlug, ref: s.ref })],
    );
    if (s.ref) refIds.set(s.ref, row);
  }
  for (const f of fb.feeds) {
    await db.query(
      `INSERT INTO knowledge_source (studio_id, niche, name, url, kind, canon, credibility, notes, meta)
       VALUES ($1, $2, $3, $4, $5, $6, 3, $7, $8::jsonb)
       ON CONFLICT (studio_id, niche, name) DO NOTHING`,
      [studioId, niche, `Feed: ${f.name}`.slice(0, 200), f.url, f.feed ? 'rss' : 'publication', f.feed, f.why, json({ origin: 'seed', persona: personaSlug, feed: f.feed, watch: true })],
    );
  }
  for (const e of fb.experts) {
    await db.query(
      `INSERT INTO knowledge_source (studio_id, niche, name, kind, canon, credibility, notes, meta)
       VALUES ($1, $2, $3, 'expert', false, 3, $4, $5::jsonb)
       ON CONFLICT (studio_id, niche, name) DO NOTHING`,
      [studioId, niche, e.name, e.why, json({ origin: 'seed', persona: personaSlug, school: e.school })],
    );
  }
  let nodes = 0;
  for (const n of fb.nodes) {
    const citations = n.sourceRefs
      .map((ref) => refIds.get(ref))
      .filter((x): x is { id: string; url: string | null; name: string } => !!x)
      .map((s) => ({ source_id: s.id, url: s.url, title: s.name }));
    const res = await db.query(
      `INSERT INTO knowledge_node (studio_id, niche, path, title, level, synthesis, origin, notes)
       VALUES ($1, $2, $3, $4, $5, $6, 'seed', $7::jsonb)
       ON CONFLICT (studio_id, niche, path) DO UPDATE
         SET notes = knowledge_node.notes || jsonb_build_object('use', COALESCE(knowledge_node.notes->'use', '{}'::jsonb) || (EXCLUDED.notes->'use'))
       RETURNING (xmax = 0) AS inserted`,
      [
        studioId,
        niche,
        n.path,
        n.title.slice(0, 200),
        n.level,
        n.synthesis || null,
        json({ module: n.module, use: n.use ? { [personaSlug]: n.use } : {}, seed_facts: n.facts, seed_refs: n.sourceRefs, seed_citations: citations }),
      ],
    );
    if ((res[0] as { inserted?: boolean } | undefined)?.inserted) nodes += 1;
  }
  return nodes;
}

/** A fresh studio holding the launch personas (`pnpm db:seed` when the persona folders exist). */
export async function seedLaunchStudio(db: Db, personas: readonly LaunchPersona[], now: Date): Promise<{ studioId: string; personas: Array<{ slug: string; id: string; state: string }> }> {
  const studio = await db.one<{ id: string }>(
    `INSERT INTO studio (slug, name, settings) VALUES ('main', 'Influencer OS Studio', $1::jsonb) RETURNING id`,
    [json(DEFAULT_SETTINGS)],
  );
  const studioId = studio.id;
  await db.query(`INSERT INTO qc_standard (studio_id, version, rules) VALUES ($1, 1, $2::jsonb)`, [
    studioId,
    json({ loudness_lufs: -14, true_peak_dbtp: -1, max_silence_s: 0.7, caption_drift_ms: 150, resolution: '1080x1920', fps: 30 }),
  ]);
  const results: ImportResult[] = [];
  // The Studio Manager proposed the launch wave a day ago; the 24 h card timer has run, so the personas are in SETUP.
  for (const lp of personas) results.push(await importLaunchPersona(db, studioId, lp, { now, proposeAt: new Date(now.getTime() - 25 * HOUR) }));
  await sweepAutoApprovals(db, { now });
  await db.query(`UPDATE notification SET read_at = now() WHERE studio_id = $1 AND title LIKE 'Launch %'`, [studioId]);

  const launch = personas.map((p) => p.launchDate).filter(Boolean).sort()[0] ?? null;
  await notify(db, {
    studioId,
    kind: 'system',
    severity: 'warn',
    title: `Launch wave: ${personas.length} personas in setup`,
    body: `Create the TikTok and Instagram accounts (handles are in each Profile) and switch on the AI profile labels${launch ? ` before ${launch}` : ''}. Everything else runs automatically.`,
    link: '/',
  });
  await ensureThreads(db, studioId);
  const thread = await findThread(db, studioId, 'studio');
  const lines = personas.map((p) => `• ${p.name} (${p.niche}${p.subNiche ? `: ${p.subNiche}` : ''}), bible ${p.bibleLabel ?? 'v1'}, ${p.slots.length} posts planned for the launch fortnight`);
  await addMessage(db, {
    threadId: thread.id,
    role: 'agent',
    author: 'agent:studio-manager',
    at: new Date(now.getTime() - HOUR),
    body: [
      `Launch wave imported: ${personas.length} personas, all in setup${launch ? `, first posts on ${launch}` : ''}.`,
      lines.join('\n'),
      'Next, automatically: the Knowledge Builder researches each niche\'s Field Brain from the seeds, the News Desk starts daily briefings, and the content pipeline scripts the launch posts. The one thing I need from you is the accounts (see the notification). No results yet, so no numbers to report.',
    ].join('\n\n'),
    meta: { kind: 'notice' },
  });
  for (const [i, p] of personas.entries()) {
    const r = results[i]!;
    const t = await findThread(db, studioId, 'persona', r.personaId);
    const lead = p.products.find((x) => x.rung === 'lead_magnet');
    const entry = p.products.find((x) => x.rung === 'entry');
    await addMessage(db, {
      threadId: t.id,
      role: 'agent',
      author: 'agent:persona-manager',
      personaId: r.personaId,
      at: new Date(now.getTime() - HOUR),
      body: [
        `${p.name}'s bible ${p.bibleLabel ?? 'v1'} is loaded (all 16 sections). ${r.slots} launch posts are on the calendar${p.launchDate ? ` from ${p.launchDate}` : ''}.`,
        [lead ? `Lead magnet: ${lead.name}.` : '', entry ? `First product: ${entry.name} ($${(entry.priceCents / 100).toFixed(0)}).` : ''].filter(Boolean).join(' '),
        `Field Brain seed: ${p.fieldBrain.nodes.length} nodes and ${p.fieldBrain.sources.length} canon sources for ${p.niche}.`,
      ].filter(Boolean).join('\n\n'),
      meta: { kind: 'notice' },
    });
  }
  const rows = await db.query<{ slug: string; id: string; state: string }>('SELECT slug, id, state FROM persona WHERE studio_id = $1 ORDER BY slug', [studioId]);
  return { studioId, personas: rows };
}
