import { createHash } from 'node:crypto';
import { type Db, json } from '@troupe/db';
import { decide, propose, proposeKill } from '../approvals';
import { portraitUri, thumbnailUri } from '../art';
import { addMessage, ensureThreads, findThread } from '../chat';
import { debit } from '../governor';
import { transition } from '../lifecycle';
import { notify } from '../notifications';
import { weekStart } from '../queries';
import { updatePersonaControls } from '../settings';
import { DEFAULT_SETTINGS, OWNER, type PersonaRow, STUDIO_MANAGER } from '../types';
import type { LaunchPersona } from './launch';
import { seedLaunchStudio } from './launch-seed';
import { type SeedPersona, SEED_PERSONAS } from './personas';

export { SEED_PERSONAS } from './personas';
export * from './launch';
export * from './launch-seed';
export * from './markdown';
export * from './archive';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Deterministic PRNG so every seed looks the same. */
function rng(seed: string): () => number {
  let a = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (r: () => number, [lo, hi]: readonly [number, number]) => Math.round(lo + (hi - lo) * r());
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** Day offsets and UTC hours for the 10 weekly slots (staggered per persona, FR-7.3). */
const SLOT_DAYS = [0, 0, 1, 2, 2, 3, 4, 4, 5, 6];
const SLOT_HOURS = [13, 22, 17, 13, 22, 17, 13, 22, 15, 18];

export interface SeedSummary {
  /**
   * 'empty': the default since 16 Oct (a studio with no personas, slots or products; personas come from the Persona
   * Generator or an archive restore); 'launch': the persona documents passed in `personas`; 'samples': the IOS-1 demo.
   */
  kind: 'empty' | 'launch' | 'samples';
  studioId: string;
  personas: Array<{ slug: string; id: string; state: string }>;
}

export async function isSeeded(db: Db): Promise<boolean> {
  return (await db.maybeOne('SELECT 1 FROM studio LIMIT 1')) !== null;
}

/**
 * Seeds a fresh database. Default (Owner decision, 16 Oct): an empty studio, with no personas, slots or products.
 * New personas are co-created in the Persona Generator; the 14 Oct launch five are archived in
 * packages/knowledge/seed/archive/2026-10-16 and restored with `pnpm knowledge personas restore`. `personas` seeds
 * those documents as PROPOSED personas waiting for the Owner's launch approval; `samples` is the IOS-1 demo studio
 * (made-up metrics and orders).
 */
export async function seed(db: Db, opts: { now?: Date; personas?: readonly LaunchPersona[]; samples?: boolean } = {}): Promise<SeedSummary> {
  const now = opts.now ?? new Date();
  if (opts.samples) return seedSamples(db, now);
  if (opts.personas?.length) return { kind: 'launch', ...(await seedLaunchStudio(db, opts.personas, now)) };
  return seedEmptyStudio(db, now);
}

/** A studio with nothing in it yet: settings, QC standard, chat threads and a pointer to the Persona Generator. */
export async function seedEmptyStudio(db: Db, now: Date = new Date()): Promise<SeedSummary> {
  const studio = await db.one<{ id: string }>(
    `INSERT INTO studio (slug, name, settings) VALUES ('main', 'Troupe House Studio', $1::jsonb) RETURNING id`,
    [json(DEFAULT_SETTINGS)],
  );
  const studioId = studio.id;
  await db.query(`INSERT INTO qc_standard (studio_id, version, rules) VALUES ($1, 1, $2::jsonb)`, [
    studioId,
    json({ loudness_lufs: -14, true_peak_dbtp: -1, max_silence_s: 0.7, caption_drift_ms: 150, resolution: '1080x1920', fps: 30 }),
  ]);
  await ensureThreads(db, studioId);
  const thread = await findThread(db, studioId, 'studio');
  await addMessage(db, {
    threadId: thread.id,
    role: 'agent',
    author: 'agent:studio-manager',
    at: now,
    body: [
      'The studio is empty: no personas yet.',
      'Open the Persona Generator (/generator) and we\'ll build the first one together: I rank niche opportunities with evidence, draft three concepts, then the character, look, voice, content and products. You pick, edit or mix at every step, and you approve the launch.',
      'The 14 Oct launch five (Rosa, Margot, Dot, Walt, Ambrose) are archived with everything kept. Restore any of them from /archive.',
    ].join('\n\n'),
    meta: { kind: 'notice' },
  });
  return { kind: 'empty', studioId, personas: [] };
}

/** The IOS-1 sample studio (demo data: metrics, orders and approvals are made up). */
export async function seedSamples(db: Db, now: Date = new Date()): Promise<SeedSummary> {
  const studio = await db.one<{ id: string }>(
    `INSERT INTO studio (slug, name, settings) VALUES ('main', 'Troupe House Studio', $1::jsonb) RETURNING id`,
    [json(DEFAULT_SETTINGS)],
  );
  const studioId = studio.id;
  await db.query(`INSERT INTO qc_standard (studio_id, version, rules) VALUES ($1, 1, $2::jsonb)`, [
    studioId,
    json({ loudness_lufs: -14, true_peak_dbtp: -1, max_silence_s: 0.7, caption_drift_ms: 150, resolution: '1080x1920', fps: 30 }),
  ]);

  const personas: SeedSummary['personas'] = [];
  for (const [i, sp] of SEED_PERSONAS.entries()) {
    const p = await seedPersona(db, studioId, sp, i, now);
    personas.push({ slug: sp.slug, id: p.id, state: p.state });
  }
  const byslug = Object.fromEntries(personas.map((p) => [p.slug, p.id]));
  // Launch cards were approved during setup; their notifications are history.
  await db.query(`UPDATE notification SET read_at = now() WHERE studio_id = $1 AND title LIKE 'Launch %'`, [studioId]);

  // ── Approvals: kill proposal first, then Owner-only spend, then timed cards and posts ──
  await proposeKill(db, {
    personaId: byslug.theo!,
    proposedBy: STUDIO_MANAGER,
    score: 18,
    rationale:
      'Day-30 checkpoint failed: 0 sales, median views ~520 (bar: 2K), 162 followers (bar: 1K). The day-14 read also missed every bar and views are trending down. Recommend kill; the evergreen Active Recall Card Kit stays listed. Theo keeps posting until you approve.',
    evidence: { median_views: 520, followers: 162, sales: 0, day: 29, trend_7d: '-18%' },
  });
  await propose(db, {
    studioId,
    personaId: byslug.amos!,
    kind: 'spend_over_cap',
    title: 'Amos: +400 Higgsfield credits this month',
    summary: 'Amos is at 86% of his 2,000-credit cap with the Black Friday "Focus Stack" launch still to render. Revenue per clip is ~$11 vs ~$0.60 cost. Requesting a one-off 400-credit grant.',
    payload: { unit: 'hf_credits', amount: 400 },
    proposedBy: STUDIO_MANAGER,
  });

  // Sienna is L0: every post waits for a tap.
  await seedPendingPost(db, studioId, byslug.sienna!, 'The 5-minute evening reset', now, { gate: 'green' });
  // Vivian is L1: a green post publishes after the veto window unless vetoed.
  await seedPendingPost(db, studioId, byslug.vivian!, 'Walkthrough: the Zero-Based Budget Sheet', now, {
    gate: 'green',
    proposedAt: new Date(now.getTime() - 30 * 60_000),
  });

  // ── Escalation + digest notifications ──
  await db.query(
    `INSERT INTO escalation (persona_id, source_type, severity, category, sla_due_at, status)
     VALUES ($1, 'comment', 'S2', 'financial question', $2, 'open')`,
    [byslug.vivian, new Date(now.getTime() + 3 * HOUR)],
  );
  await notify(db, {
    studioId,
    personaId: byslug.vivian,
    kind: 'escalation',
    severity: 'warn',
    title: 'S2 · Vivian: "should I pay off my student loan or invest?"',
    body: 'Personal money question held for review with a holding reply. SLA 4 h.',
    link: '/personas/vivian',
  });
  await notify(db, {
    studioId,
    kind: 'digest',
    title: 'Daily digest is ready',
    body: 'Yesterday: 5 personas posted 9 times, $213 revenue, 0 Gate reds, 1 QC auto-fix.',
    link: '/',
  });

  await seedChat(db, studioId, byslug, now);
  return { kind: 'samples', studioId, personas };
}

async function seedPersona(db: Db, studioId: string, sp: SeedPersona, index: number, now: Date): Promise<PersonaRow> {
  const r = rng(sp.slug);
  const launchedAt = new Date(now.getTime() - sp.launchedDaysAgo * DAY);
  const lookPack = sp.looks.map((label, v) => ({ label, url: portraitUri(sp.name, sp.hue, { variant: v }) }));
  const persona = await db.one<PersonaRow>(
    `INSERT INTO persona (studio_id, slug, name, niche, sub_niche, state, autonomy, budget, portrait_url, look_pack,
                          accent_color, timezone, current_bible_version, created_at)
     VALUES ($1, $2, $3, $4, $5, 'PROPOSED', 'L0', $6::jsonb, $7, $8::jsonb, $9, $10, 1, $11) RETURNING *`,
    [
      studioId,
      sp.slug,
      sp.name,
      sp.niche,
      sp.subNiche,
      json(sp.budget ?? {}),
      portraitUri(sp.name, sp.hue),
      json(lookPack),
      `hsl(${sp.hue} 55% 45%)`,
      sp.timezone,
      new Date(launchedAt.getTime() - 4 * DAY),
    ],
  );
  await db.query(
    `INSERT INTO persona_bible (persona_id, version, content, status, created_by, approved_by, approved_at)
     VALUES ($1, 1, $2::jsonb, 'approved', 'agent:studio-manager', 'owner:hossam', $3)`,
    [persona.id, json(sp.bible), new Date(launchedAt.getTime() - 2 * DAY)],
  );
  for (const [platform, handle] of Object.entries(sp.handles)) {
    await db.query(
      `INSERT INTO account (persona_id, platform, handle, token_ref, ai_label_ok, two_fa_owner, status)
       VALUES ($1, $2, $3, $4, true, 'owner', 'active')`,
      [persona.id, platform, handle, `vault:zernio/${platform}/${handle}`],
    );
  }

  // Lifecycle through the real engine: launch card (Owner) → SETUP → TESTING → …
  const launch = await propose(db, {
    studioId,
    personaId: persona.id,
    kind: 'persona_launch',
    title: `Launch ${sp.name}`,
    summary: `${sp.niche}: ${sp.subNiche}`,
    proposedBy: STUDIO_MANAGER,
    subjectType: 'persona',
    subjectId: persona.id,
  });
  await decide(db, { approvalId: launch.id, decision: 'approve', actor: OWNER, note: 'seed' });
  await transition(db, { personaId: persona.id, to: 'TESTING', actor: STUDIO_MANAGER, reason: 'accounts created by the Owner' });
  if (sp.state === 'MONETISING' || sp.state === 'SCALING') {
    await transition(db, { personaId: persona.id, to: 'MONETISING', actor: STUDIO_MANAGER, reason: 'Day-30 checkpoint passed' });
  }
  if (sp.state === 'SCALING') {
    await transition(db, { personaId: persona.id, to: 'SCALING', actor: STUDIO_MANAGER, reason: 'Day-60: ≥ $500/month' });
  }
  await db.query('UPDATE persona SET launched_at = $2 WHERE id = $1', [persona.id, launchedAt]);
  await updatePersonaControls(db, persona.id, { autonomy: sp.autonomy }, OWNER);

  // Products
  const productIds: Array<{ id: string; sp: SeedPersona['products'][number] }> = [];
  for (const prod of sp.products) {
    const row = await db.one<{ id: string }>(
      `INSERT INTO product (persona_id, name, slug, ladder_rung, status, price_cents, store_product_id, cover_url, current_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1) RETURNING id`,
      [
        persona.id,
        prod.name,
        prod.slug,
        prod.rung,
        prod.status,
        prod.priceCents,
        prod.status === 'live' ? `ls_${prod.slug}` : null,
        thumbnailUri(prod.name, sp.hue + 15, prod.rung === 'membership' ? 'carousel' : 'static', productIds.length + 3),
      ],
    );
    await db.query(
      `INSERT INTO product_version (product_id, persona_id, version, file_url, status) VALUES ($1, $2, 1, $3, $4)`,
      [row.id, persona.id, `fake://products/${sp.slug}/${prod.slug}-v1.pdf`, prod.status],
    );
    if (prod.priceCents > 0) {
      await db.query(
        `INSERT INTO offer (persona_id, product_id, kind, ladder_rung, price_cents, price_band) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [persona.id, row.id, prod.rung === 'membership' ? 'membership' : prod.rung === 'addon' ? 'addon' : prod.rung === 'upsell' ? 'upsell' : prod.rung === 'core_bundle' ? 'bundle' : 'single', prod.rung, prod.priceCents, json({ min_cents: Math.round(prod.priceCents * 0.75), max_cents: Math.round(prod.priceCents * 1.35) })],
      );
    }
    if (prod.status === 'awaiting_approval') {
      await propose(db, {
        studioId,
        personaId: persona.id,
        kind: 'product_v1',
        title: `${sp.name.split(' ')[0]}: ${prod.name} v1`,
        summary: `${prod.rung.replace('_', ' ')} at $${(prod.priceCents / 100).toFixed(0)}. QC passed (QP), Gate green. Preview attached. Auto-approves unless you stop it.`,
        payload: { price_cents: prod.priceCents, preview: `fake://products/${sp.slug}/${prod.slug}-v1.pdf` },
        subjectType: 'product',
        subjectId: row.id,
        proposedBy: { type: 'agent', id: 'monetization-agent' },
        now: new Date(now.getTime() - 6 * HOUR),
      });
    }
    productIds.push({ id: row.id, sp: prod });
  }

  // Calendar (last week, this week, next week) + posts for published slots
  const accounts = await db.query<{ id: string; platform: 'tiktok' | 'instagram' | 'youtube' }>(
    'SELECT id, platform FROM account WHERE persona_id = $1 ORDER BY platform DESC',
    [persona.id],
  );
  const ws = weekStart(now);
  const [vlo, vhi] = sp.perf.viewsPerDay;
  for (const w of [-1, 0, 1]) {
    for (const [k, slot] of sp.slots.entries()) {
      const slotAt = new Date(ws.getTime() + w * 7 * DAY + SLOT_DAYS[k]! * DAY + SLOT_HOURS[k]! * HOUR + index * 17 * 60_000);
      if (slotAt < launchedAt) continue;
      const title = w === 0 ? slot.title : w === 1 ? `${slot.title} (part 2)` : slot.title;
      const thumb = thumbnailUri(title, sp.hue, slot.format, k + (w + 1) * 10);
      const past = slotAt < now;
      const status = past ? 'live' : slotAt.getTime() - now.getTime() < 48 * HOUR ? 'scheduled' : w === 0 ? 'scripted' : 'planned';
      const slotRow = await db.one<{ id: string }>(
        `INSERT INTO calendar_slot (persona_id, slot_at, format, purpose, pillar, title, status, thumbnail_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [persona.id, slotAt, slot.format, slot.purpose, slot.pillar, title, status, thumb],
      );
      if (!past) continue;
      const acc = accounts[k % accounts.length]!;
      const post = await db.one<{ id: string }>(
        `INSERT INTO post (persona_id, account_id, calendar_slot_id, platform, format, caption, media, thumbnail_url, status,
                           ai_flag, scheduled_at, published_at, external_id, url)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'live', true, $9, $9, $10, $11) RETURNING id`,
        [
          persona.id,
          acc.id,
          slotRow.id,
          acc.platform,
          slot.format,
          `${title} · ${slot.pillar} #${sp.slug}`,
          json([{ url: `fake://media/${sp.slug}/${slotRow.id}.mp4` }]),
          thumb,
          slotAt,
          `ext_${slotRow.id.slice(0, 8)}`,
          `https://fake.${acc.platform}.local/p/${slotRow.id.slice(0, 8)}`,
        ],
      );
      await db.query('UPDATE calendar_slot SET post_id = $2 WHERE id = $1', [slotRow.id, post.id]);
      await db.query(
        `INSERT INTO gate_result (persona_id, subject_type, subject_id, stage, verdict, checks) VALUES ($1, 'post', $2, 'pre_publish', 'green', $3::jsonb)`,
        [persona.id, post.id, json([{ check: 'ai_disclosure', ok: true }, { check: 'claims', ok: true }])],
      );
      await db.query(`INSERT INTO qc_report (persona_id, subject_type, subject_id, stage, score, pass) VALUES ($1, 'post', $2, 'Q4', $3, true)`, [
        persona.id,
        post.id,
        90 + Math.round(r() * 9),
      ]);
      const views = Math.round(((vlo + vhi) / 2) * (0.4 + r() * 1.4));
      await db.query(
        `INSERT INTO metric_snapshot (persona_id, post_id, platform, captured_on, views, likes, comments, saves, shares, follows, link_clicks)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [persona.id, post.id, acc.platform, dayKey(now), views, Math.round(views * 0.06), Math.round(views * 0.004), Math.round(views * 0.018), Math.round(views * 0.007), Math.round(views * 0.003), Math.round(views * 0.002)],
      );
    }
  }

  // Account-level daily metrics (last 14 days)
  const [f0, f1] = sp.perf.followers;
  const shares: Record<string, number> = { tiktok: 0.6, instagram: 0.4, youtube: 0.15 };
  const declining = sp.slug === 'theo';
  for (let d = 13; d >= 0; d--) {
    const day = new Date(now.getTime() - d * DAY);
    if (day < launchedAt) continue;
    const progress = (13 - d) / 13;
    const trend = declining ? 1.25 - progress * 0.5 : 0.85 + progress * 0.3;
    const dayViews = Math.round(between(r, [vlo, vhi]) * trend);
    const followers = Math.round(f0 + (f1 - f0) * progress);
    for (const acc of accounts) {
      const share = (shares[acc.platform] ?? 0.2) / accounts.reduce((a, x) => a + (shares[x.platform] ?? 0.2), 0);
      await db.query(
        `INSERT INTO metric_snapshot (persona_id, platform, captured_on, views, likes, saves, shares, followers, profile_visits)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [persona.id, acc.platform, dayKey(day), Math.round(dayViews * share), Math.round(dayViews * share * 0.06), Math.round(dayViews * share * 0.02), Math.round(dayViews * share * 0.008), Math.round(followers * share), Math.round(dayViews * share * 0.01)],
      );
    }
  }

  // Orders (last 14 days)
  const paid = productIds.filter((p) => p.sp.priceCents > 0 && p.sp.status === 'live');
  const totalWeight = paid.reduce((a, p) => a + (p.sp.weight ?? 1), 0);
  if (sp.perf.ordersPerDay[1] > 0 && paid.length) {
    for (let d = 13; d >= 0; d--) {
      const n = between(r, sp.perf.ordersPerDay);
      for (let o = 0; o < n; o++) {
        let pick = r() * totalWeight;
        const prod = paid.find((p) => (pick -= p.sp.weight ?? 1) < 0) ?? paid[0]!;
        const at = new Date(now.getTime() - d * DAY - Math.round(r() * 20) * HOUR);
        if (at > now) continue;
        await db.query(
          `INSERT INTO orders (persona_id, product_id, store_order_id, customer_email_hash, amount_cents, fee_cents, status, ordered_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'paid', $7)`,
          [persona.id, prod.id, `ls_ord_${sp.slug}_${d}_${o}`, createHash('sha256').update(`${sp.slug}${d}${o}`).digest('hex').slice(0, 16), prod.sp.priceCents, Math.round(prod.sp.priceCents * 0.05 + 50), at],
        );
      }
    }
  }

  // Audience
  await db.query(
    `INSERT INTO subscriber (persona_id, email, consent, consent_at, status)
     SELECT $1, 'reader' || g || '.' || $2 || '@example.test', true, now() - (g || ' hours')::interval, 'active'
       FROM generate_series(1, $3::int) g`,
    [persona.id, sp.slug, sp.perf.subscribers],
  );
  if (sp.perf.members) {
    await db.query(
      `INSERT INTO membership (persona_id, plan, price_cents, status, started_at)
       SELECT $1, 'Focus Club monthly', 800, 'active', now() - (g || ' days')::interval FROM generate_series(1, $2::int) g`,
      [persona.id, sp.perf.members],
    );
  }
  const commentTexts = ['Where can I get the template?', 'Saving this for Sunday', 'Are you an AI?', 'This is so calming', 'Can you do one for students?'];
  for (const [ci, text] of commentTexts.entries()) {
    await db.query(
      `INSERT INTO comment (persona_id, platform, author_ref, text, classification, action, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'handled', $7)`,
      [persona.id, accounts[ci % accounts.length]!.platform, `user_${ci}`, text, ci === 2 ? 'are_you_real' : ci === 0 ? 'purchase_intent' : 'praise', ci === 0 ? 'dm' : 'reply', new Date(now.getTime() - ci * 9 * HOUR)],
    );
  }

  // Plan
  await db.query(
    `INSERT INTO plan (persona_id, kind, period_start, period_end, content) VALUES ($1, 'timeline', $2, $3, $4::jsonb)`,
    [persona.id, dayKey(now), dayKey(new Date(now.getTime() + 365 * DAY)), json({ horizon: '6–12 months', milestones: sp.plan })],
  );

  // Spend so far this month, debited through the governor (crossing 80% raises an alert).
  for (const part of [0.4, 0.3, 0.2, 0.1]) {
    await debit(db, { studioId, personaId: persona.id, unit: 'llm_usd', amount: Math.round(sp.spend.llm * part * 100) / 100, provider: 'fake-llm', operation: 'complete:standard', now });
    await debit(db, { studioId, personaId: persona.id, unit: 'hf_credits', amount: Math.round(sp.spend.credits * part), provider: 'fake-higgsfield', operation: 'image_to_video', now });
  }

  return db.one<PersonaRow>('SELECT * FROM persona WHERE id = $1', [persona.id]);
}

async function seedPendingPost(
  db: Db,
  studioId: string,
  personaId: string,
  slotTitle: string,
  now: Date,
  opts: { gate: 'green' | 'amber'; proposedAt?: Date },
): Promise<void> {
  const slot = await db.maybeOne<{ id: string; format: string; thumbnail_url: string; slot_at: Date; title: string }>(
    `SELECT id, format, thumbnail_url, slot_at, title FROM calendar_slot WHERE persona_id = $1 AND slot_at > $2 ORDER BY (title = $3) DESC, slot_at LIMIT 1`,
    [personaId, now, slotTitle],
  );
  if (!slot) return;
  const acc = await db.one<{ id: string; platform: string }>(`SELECT id, platform FROM account WHERE persona_id = $1 ORDER BY platform DESC LIMIT 1`, [personaId]);
  const post = await db.one<{ id: string }>(
    `INSERT INTO post (persona_id, account_id, calendar_slot_id, platform, format, caption, media, thumbnail_url, status, scheduled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'awaiting_approval', $9) RETURNING id`,
    [personaId, acc.id, slot.id, acc.platform, slot.format, slot.title, json([{ url: `fake://media/${slot.id}.mp4` }]), slot.thumbnail_url, slot.slot_at],
  );
  await db.query('UPDATE calendar_slot SET post_id = $2, status = $3 WHERE id = $1', [slot.id, post.id, 'qc']);
  await db.query(`INSERT INTO gate_result (persona_id, subject_type, subject_id, stage, verdict) VALUES ($1, 'post', $2, 'pre_publish', $3)`, [personaId, post.id, opts.gate]);
  await db.query(`INSERT INTO qc_report (persona_id, subject_type, subject_id, stage, score, pass) VALUES ($1, 'post', $2, 'Q4', 96, true)`, [personaId, post.id]);
  const a = await propose(db, {
    studioId,
    personaId,
    kind: 'post',
    title: `Post: ${slot.title}`,
    summary: `${acc.platform} · ${slot.format.replace('_', ' ')} · QC pass · Gate ${opts.gate}`,
    payload: { thumbnail_url: slot.thumbnail_url, platform: acc.platform, scheduled_at: slot.slot_at },
    subjectType: 'post',
    subjectId: post.id,
    proposedBy: { type: 'agent', id: 'publisher' },
    gate: opts.gate,
    now: opts.proposedAt ?? now,
  });
  await db.query('UPDATE post SET approval_id = $2 WHERE id = $1', [post.id, a.id]);
}

async function seedChat(db: Db, studioId: string, byslug: Record<string, string>, now: Date): Promise<void> {
  await ensureThreads(db, studioId);
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * HOUR);
  const studio = await findThread(db, studioId, 'studio');
  await addMessage(db, {
    threadId: studio.id,
    role: 'agent',
    author: 'agent:studio-manager',
    at: at(20),
    body:
      'Sunday studio report.\n\nAmos is scaling (≈40K views a day, Focus Club at 64 members). Vivian is monetising with steady daily sales of the Budget Sheet. Sienna is on day 6 at L0, so her posts wait for your tap. Layla\'s Weekly Family Planner v1 is ready and auto-approves in 24 h unless you stop it.\n\nTheo failed the day-30 checkpoint (0 sales, median views ~520). I\'ve proposed a kill; he keeps posting until you approve.',
    meta: { cards: ['persona_kill:theo'] },
  });
  await addMessage(db, { threadId: studio.id, role: 'owner', author: 'owner:hossam', at: at(19.5), body: 'Why kill Theo instead of a re-angle?' });
  await addMessage(db, {
    threadId: studio.id,
    role: 'agent',
    author: 'agent:studio-manager',
    at: at(19.4),
    body:
      'His day-14 read already missed every bar, and the last 7 days are down 18%. A re-angle costs 14 more days and ~300 credits for a niche where two larger human creators dominate the same hooks. The study-skills slot is better reused for a new persona in the next launch wave. The Active Recall Card Kit stays listed either way. Your call in Approvals.',
  });

  const notes: Record<string, string> = {
    vivian: 'Yesterday: 12.4K views, 5 sales ($84). The "Walkthrough" post is queued and publishes after the 2-hour veto window. One S2 comment held (loan vs invest question).',
    amos: 'Yesterday: 47K views, 13 sales ($291), Focus Club +3. Higgsfield credits at 86% of cap: I\'ve asked for +400 for the Black Friday renders.',
    sienna: 'Day 6. Evening-reset hooks are beating morning hooks 2:1 on saves. One post waits for your approval (L0).',
    layla: 'Day 20. Views up 30% week on week. Weekly Family Planner v1 passed QC and the Gate; it\'s on a 24-hour card.',
    theo: 'Day 29. Median views ~520, no sales. The Studio Manager has proposed a kill; I\'ll keep posting the calendar until you decide.',
  };
  for (const [slug, body] of Object.entries(notes)) {
    const t = await findThread(db, studioId, 'persona', byslug[slug]);
    await addMessage(db, { threadId: t.id, role: 'agent', author: 'agent:persona-manager', personaId: byslug[slug], body, at: at(8) });
  }
  const money = await findThread(db, studioId, 'monetization');
  await addMessage(db, {
    threadId: money.id,
    role: 'agent',
    author: 'agent:monetization-agent',
    at: at(10),
    body: 'Top demand signals this week: "first apartment budget" (Vivian, 31 comments) and "Ramadan meal plan" (Layla, 18 comments + 42 waitlist sign-ups). Layla\'s planner v1 is on a 24 h card. Black Friday bundles are briefed for Amos and Vivian.',
  });
  const quality = await findThread(db, studioId, 'quality');
  await addMessage(db, {
    threadId: quality.id,
    role: 'agent',
    author: 'agent:quality-control',
    at: at(12),
    body: 'Standards v1 active: −14 LUFS, true peak ≤ −1 dBTP, silences ≤ 0.7 s, caption drift ≤ 150 ms, 1080×1920 at 30 fps. First-pass rate this week: 94% (seed data).',
  });
}
