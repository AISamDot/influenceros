import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@ios/db';
import { createTestDb } from '@ios/db/testing';
import { listPendingApprovals, personaPage, studioWall } from '../src';
import { BIBLE_SECTIONS, launchPersonaSlugs, loadArchivedPersonas, parseContentPlan, parseSlotWhen, seed, type SeedSummary } from '../src/seed';

const NOW = new Date('2026-10-14T12:00:00Z'); // a Wednesday, before the 1 Nov launch
const count = async (db: Db, sql: string, params: unknown[] = []) => (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) x`, params)).n;

// The launch five are archived (Owner decision, 16 Oct): the default seed is empty (packages/generator tests it), and
// seeding the archived documents explicitly still exercises the importer end to end.
describe('seed: persona documents (the archived launch five)', () => {
  let db: Db;
  let s: SeedSummary;
  const slugs = ['ambrose', 'dot', 'margot', 'rosa', 'sal'];

  beforeAll(async () => {
    db = await createTestDb();
    s = await seed(db, { now: NOW, personas: loadArchivedPersonas('2026-10-16') });
  });
  afterAll(async () => db.close());

  it('seeds the documents it is given; the live seed folder is empty', () => {
    expect(launchPersonaSlugs()).toEqual([]);
    expect(s.kind).toBe('launch');
    expect(s.personas.map((p) => p.slug)).toEqual(slugs);
  });

  it('leaves them PROPOSED behind Owner-only launch cards (no timer: the Owner approves every launch)', async () => {
    expect(s.personas.every((p) => p.state === 'PROPOSED')).toBe(true);
    const cards = await db.query<{ status: string; mode: string; auto_approve_at: Date | null; proposed_by: string; payload: Record<string, unknown> }>(`SELECT status, mode, auto_approve_at, proposed_by, payload FROM approval WHERE kind = 'persona_launch'`);
    expect(cards).toHaveLength(5);
    expect(cards.every((c) => c.status === 'pending' && c.mode === 'explicit' && c.auto_approve_at === null && c.proposed_by === 'agent:studio-manager' && c.payload.owner_only === true)).toBe(true);
    expect(await listPendingApprovals(db, s.studioId)).toHaveLength(5);
    const note = await db.one<{ title: string; read_at: Date | null }>(`SELECT title, read_at FROM notification WHERE title LIKE 'Launch wave%'`);
    expect(note).toMatchObject({ title: 'Launch wave: 5 personas waiting for your launch approval', read_at: null });
  });

  it('loads every bible with all Appendix A sections, approved by the Studio Manager', async () => {
    const rows = await db.query<{ content: Record<string, unknown>; status: string; approved_by: string }>('SELECT content, status, approved_by FROM persona_bible');
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r).toMatchObject({ status: 'approved', approved_by: 'agent:studio-manager' });
      for (const k of BIBLE_SECTIONS) expect(r.content[k], k).toBeTruthy();
      expect(r.content.source_document).toMatchObject({ file: expect.stringMatching(/\/bible\.md$/) });
      expect(JSON.stringify(r.content.voice).length).toBeGreaterThan(200);
    }
    const rosa = await db.one<{ name: string; niche: string; sub_niche: string; timezone: string; look_pack: Array<{ label: string }> }>(`SELECT name, niche, sub_niche, timezone, look_pack FROM persona WHERE slug = 'rosa'`);
    expect(rosa).toMatchObject({ name: 'Rosa Bellini', niche: 'dating', timezone: 'America/New_York' });
    expect(rosa.look_pack.map((l) => l.label)).toContain('Court Cardigan');
    const niches = await db.query<{ slug: string; niche: string; timezone: string }>('SELECT slug, niche, timezone FROM persona ORDER BY slug');
    expect(niches.map((n) => n.niche)).toEqual(['wealth', 'food', 'wealth', 'dating', 'wealth']);
    expect(niches.find((n) => n.slug === 'dot')!.timezone).toBe('Europe/London');
  });

  it('plans the launch fortnight from each content plan: 10 posts a week with the format and purpose mix', async () => {
    for (const p of s.personas) {
      const slots = await db.query<{ format: string; purpose: string; slot_at: Date; status: string; idea_id: string | null; thumbnail_url: string; n: number }>(
        `SELECT c.format, c.purpose, c.slot_at, c.status, c.idea_id, c.thumbnail_url, (i.source->>'post')::int AS n
           FROM calendar_slot c JOIN idea i ON i.id = c.idea_id WHERE c.persona_id = $1 ORDER BY n`,
        [p.id],
      );
      expect(slots, p.slug).toHaveLength(20);
      for (const week of [slots.slice(0, 10), slots.slice(10)]) {
        const by = (k: 'format' | 'purpose') => week.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x[k]]: (acc[x[k]] ?? 0) + 1 }), {});
        expect(by('format'), p.slug).toEqual({ talking: 3, activity_text: 3, voiceover: 2, static: 1, carousel: 1 });
        const purpose = by('purpose');
        expect(purpose.reach, p.slug).toBe(6);
        expect((purpose.trust ?? 0) + (purpose.sell ?? 0)).toBe(4);
        expect(purpose.sell).toBeGreaterThanOrEqual(1);
      }
      expect(slots.every((x) => x.status === 'planned' && new Date(x.slot_at) > NOW && x.thumbnail_url.startsWith('data:image/svg+xml'))).toBe(true);
      expect(new Date(slots[0]!.slot_at).toISOString().slice(0, 10) >= '2026-11-01').toBe(true);
    }
  });

  it('invents no results: no posts, metrics, orders, spend or audience', async () => {
    for (const table of ['post', 'metric_snapshot', 'orders', 'credit_ledger', 'subscriber', 'membership', 'comment', 'escalation']) {
      expect(await count(db, `SELECT 1 FROM ${table}`), table).toBe(0);
    }
    const cards = await studioWall(db, s.studioId, NOW);
    expect(cards).toHaveLength(5);
    for (const c of cards) {
      expect(c.totals.revenue7dCents).toBe(0);
      expect(c.next).toHaveLength(3);
      expect(c.persona.portrait_url).toMatch(/^data:image\/svg\+xml/);
    }
    expect((await personaPage(db, 'rosa', NOW))?.bible?.version).toBe(1);
  });

  it('lists the product ladder (ideas, real prices) and the planned accounts (pending, the Owner creates them)', async () => {
    const products = await db.query<{ name: string; ladder_rung: string; price_cents: number; status: string }>(
      `SELECT pr.name, pr.ladder_rung, pr.price_cents, pr.status FROM product pr JOIN persona p ON p.id = pr.persona_id WHERE p.slug = 'rosa' ORDER BY pr.price_cents`,
    );
    expect(products.every((p) => p.status === 'idea')).toBe(true);
    expect(products).toContainEqual({ name: 'The Situationship Exit Kit', ladder_rung: 'entry', price_cents: 1500, status: 'idea' });
    expect(products.find((p) => p.ladder_rung === 'lead_magnet')?.price_cents).toBe(0);
    const accounts = await db.query<{ platform: string; handle: string; status: string; ai_label_ok: boolean }>(
      `SELECT a.platform, a.handle, a.status, a.ai_label_ok FROM account a JOIN persona p ON p.id = a.persona_id WHERE p.slug = 'rosa' ORDER BY a.platform`,
    );
    expect(accounts).toEqual([
      { platform: 'instagram', handle: 'rosareadsyourtexts', status: 'pending', ai_label_ok: false },
      { platform: 'tiktok', handle: 'rosareadsyourtexts', status: 'pending', ai_label_ok: false },
    ]);
  });

  it('seeds each niche Field Brain: curriculum nodes, canon sources, News Desk feeds', async () => {
    const nodes = await db.query<{ niche: string; n: number; verified: number }>(
      `SELECT niche, count(*)::int AS n, count(last_verified_at)::int AS verified FROM knowledge_node GROUP BY niche ORDER BY niche`,
    );
    expect(nodes.map((r) => r.niche)).toEqual(['dating', 'food', 'wealth']);
    expect(nodes.find((r) => r.niche === 'wealth')!.n).toBeGreaterThanOrEqual(100); // three seeds share the wealth Field Brain
    expect(nodes.every((r) => r.n >= 30 && r.verified === 0)).toBe(true); // unverified until the Knowledge Builder researches them
    const scam = await db.one<{ synthesis: string; notes: { use: Record<string, string>; seed_citations: Array<{ url: string }> } }>(
      `SELECT synthesis, notes FROM knowledge_node WHERE niche = 'dating' AND title ILIKE '%romance-scam playbook%'`,
    );
    expect(scam.synthesis).toMatch(/FTC/);
    expect(scam.notes.use.rosa).toBeTruthy();
    expect(scam.notes.seed_citations.map((c) => c.url)).toContainEqual(expect.stringMatching(/ftc\.gov/));
    const sources = await db.query<{ kind: string; canon: boolean; credibility: number; url: string | null }>(`SELECT kind, canon, credibility, url FROM knowledge_source WHERE niche = 'dating'`);
    expect(sources.filter((x) => x.canon && x.kind !== 'rss').length).toBeGreaterThanOrEqual(10);
    expect(sources.every((x) => x.credibility >= 1 && x.credibility <= 5)).toBe(true);
    const feeds = sources.filter((x) => x.kind === 'rss').map((x) => x.url);
    expect(feeds).toContain('https://www.reddit.com/r/dating_advice/.rss');
    expect(feeds.some((u) => u?.startsWith('https://news.google.com/rss/search'))).toBe(true);
    expect(await count(db, `SELECT 1 FROM knowledge_source WHERE kind = 'expert'`)).toBeGreaterThan(0);
  });

  it('greets the Owner in the Studio chat and each persona thread without numbers it does not have', async () => {
    const msgs = await db.query<{ author: string; body: string; meta: { kind?: string } }>(`SELECT author, body, meta FROM chat_message ORDER BY created_at, author DESC`);
    expect(msgs.filter((m) => m.author === 'agent:studio-manager')).toHaveLength(1);
    expect(msgs.filter((m) => m.author === 'agent:persona-manager')).toHaveLength(5);
    expect(msgs.every((m) => m.meta.kind === 'notice')).toBe(true);
    expect(msgs.find((m) => m.author === 'agent:studio-manager')!.body).toMatch(/Launch wave imported: 5 personas, each waiting for your launch approval/);
  });
});

describe('seed: launch-plan parsing', () => {
  it('reads plan dates and times in every layout the plans use', () => {
    expect(parseSlotWhen('Sun 1 Nov · 8:00 pm', 2026)).toEqual({ date: '2026-11-01', time: '20:00' });
    expect(parseSlotWhen('Sun 1 Nov · 12:30 ET · **PIN 1** · speed A/B', 2026)).toEqual({ date: '2026-11-01', time: '12:30' });
    expect(parseSlotWhen('**Thu 5 Nov 20:00 (15:00 ET)**', 2026)).toEqual({ date: '2026-11-05', time: '20:00' });
    expect(parseSlotWhen('Sat 7 Nov', 2026)).toEqual({ date: '2026-11-07', time: null });
    expect(parseSlotWhen('no date', 2026)).toBeNull();
  });

  it('converts local slot times to UTC in the persona timezone', () => {
    const md = '| # | Date / time | Format | Purpose | Hook | CTA |\n|---|---|---|---|---|---|\n| 1 | Sun 1 Nov 18:00 | Talking | Reach | "Hi." | SQUASH |\n| 2 | Sun 1 Nov · 8:00 pm | Static | **Sell** | Two | READ |';
    const [a, b] = parseContentPlan(md, { year: 2026, timezone: 'Europe/London' });
    expect(a!.slotAt.toISOString()).toBe('2026-11-01T18:00:00.000Z'); // GMT after the clocks change
    expect(b).toMatchObject({ format: 'static', purpose: 'sell', title: 'Two', cta: 'READ' });
    const [ny] = parseContentPlan(md, { year: 2026, timezone: 'America/New_York' });
    expect(ny!.slotAt.toISOString()).toBe('2026-11-01T23:00:00.000Z'); // EST
  });

  it('parses all five archived launch folders', () => {
    const personas = loadArchivedPersonas('2026-10-16');
    expect(personas).toHaveLength(5);
    for (const p of personas) {
      expect(p.slots, p.slug).toHaveLength(20);
      expect(p.products.length, p.slug).toBeGreaterThanOrEqual(3);
      expect(p.fieldBrain.nodes.length, p.slug).toBeGreaterThanOrEqual(30);
      expect(p.handles.tiktok && p.handles.instagram, p.slug).toBeTruthy();
      expect(p.launchDate).toBe('2026-11-01');
    }
  });
});

describe('seed: sample fallback (no launch folders)', () => {
  let db: Db;
  let s: SeedSummary;
  beforeAll(async () => {
    db = await createTestDb();
    s = await seed(db, { now: NOW, samples: true });
  });
  afterAll(async () => db.close());

  it('keeps the IOS-1 sample studio: Testing ×3, Monetising ×1, Scaling ×1, one kill proposal', async () => {
    expect(s.kind).toBe('samples');
    expect(s.personas.map((p) => p.state).sort()).toEqual(['MONETISING', 'SCALING', 'TESTING', 'TESTING', 'TESTING']);
    const rows = await db.query<{ content: Record<string, unknown> }>('SELECT content FROM persona_bible');
    for (const r of rows) expect(Object.keys(r.content).sort()).toEqual([...BIBLE_SECTIONS].sort());
    const pending = await listPendingApprovals(db, s.studioId);
    expect(pending[0]).toMatchObject({ kind: 'persona_kill', persona_slug: 'theo', mode: 'explicit' });
    expect(pending.filter((a) => a.kind === 'persona_kill')).toHaveLength(1);
    expect(pending.some((a) => a.kind === 'product_v1' && a.mode === 'auto_after')).toBe(true);
  });

  it('plans 10 slots this week per sample persona and feeds the studio wall', async () => {
    for (const p of s.personas) {
      const page = await personaPage(db, p.slug, NOW);
      const slots = page!.week.days.flatMap((d) => d.slots);
      expect(slots).toHaveLength(10);
    }
    const cards = await studioWall(db, s.studioId, NOW);
    expect(cards.filter((c) => c.killProposed).map((c) => c.persona.slug)).toEqual(['theo']);
    expect(cards.find((c) => c.persona.slug === 'amos')!.totals.revenue7dCents).toBeGreaterThan(0);
  });
});
