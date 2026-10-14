import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalError,
  approvalPolicy,
  budgetStatus,
  decide,
  DEFAULT_SETTINGS,
  OWNER,
  OWNER_ONLY_KINDS,
  propose,
  proposeKill,
  STUDIO_MANAGER,
  SYSTEM,
  sweepAutoApprovals,
  transition,
  updateSettings,
  withdraw,
} from '../src';
import { type Ctx, count, HOUR, makePersona, setup } from './helpers';

let ctx: Ctx;
afterEach(async () => ctx.db.close());

const state = async (id: string) => (await ctx.db.one<{ state: string }>('SELECT state FROM persona WHERE id = $1', [id])).state;

describe('approval engine: kill and retire (Owner only, no timeout)', () => {
  beforeEach(async () => {
    ctx = await setup();
  });

  it('a kill proposal never executes without the Owner and never auto-approves', async () => {
    const id = await makePersona(ctx, { state: 'TESTING' });
    const { approval, proposalId } = await proposeKill(ctx.db, { personaId: id, rationale: 'Day 30 failed', proposedBy: STUDIO_MANAGER });
    expect(approval).toMatchObject({ kind: 'persona_kill', mode: 'explicit', status: 'pending', auto_approve_at: null });

    // The persona keeps running while the proposal waits.
    expect(await state(id)).toBe('TESTING');

    // Agents and the system can only propose.
    await expect(decide(ctx.db, { approvalId: approval.id, decision: 'approve', actor: STUDIO_MANAGER })).rejects.toBeInstanceOf(ApprovalError);
    await expect(decide(ctx.db, { approvalId: approval.id, decision: 'approve', actor: SYSTEM })).rejects.toBeInstanceOf(ApprovalError);

    // A pending approval can't be used to force the transition.
    await expect(transition(ctx.db, { personaId: id, to: 'KILLED', actor: STUDIO_MANAGER, approvalId: approval.id })).rejects.toThrow(/pending/);

    // No timeout: a year of sweeps changes nothing.
    for (const days of [1, 2, 7, 30, 365]) {
      expect(await sweepAutoApprovals(ctx.db, { now: new Date(Date.now() + days * 24 * HOUR) })).toEqual([]);
    }
    expect(await state(id)).toBe('TESTING');
    expect((await ctx.db.one<{ status: string }>('SELECT status FROM approval WHERE id = $1', [approval.id])).status).toBe('pending');

    // The Owner taps Approve → executed, logged, audited.
    const done = await decide(ctx.db, { approvalId: approval.id, decision: 'approve', actor: OWNER, note: 'agreed' });
    expect(done).toMatchObject({ status: 'approved', decided_by: 'owner:hossam' });
    expect(done.executed_at).not.toBeNull();
    expect(await state(id)).toBe('KILLED');
    expect((await ctx.db.one<{ status: string }>('SELECT status FROM kill_scale_proposal WHERE id = $1', [proposalId])).status).toBe('executed');
    const actions = (await ctx.db.query<{ action: string }>('SELECT action FROM audit_log WHERE persona_id = $1 ORDER BY id', [id])).map((r) => r.action);
    expect(actions).toEqual(['approval.proposed', 'approval.approved', 'persona.transition', 'approval.executed']);

    // Decisions are final.
    await expect(decide(ctx.db, { approvalId: approval.id, decision: 'reject', actor: OWNER })).rejects.toThrow(/already approved/);
  });

  it('rejecting a kill keeps the persona running', async () => {
    const id = await makePersona(ctx, { state: 'TESTING' });
    const { approval, proposalId } = await proposeKill(ctx.db, { personaId: id, rationale: 'weak', proposedBy: STUDIO_MANAGER });
    await decide(ctx.db, { approvalId: approval.id, decision: 'reject', actor: OWNER, note: 'give it a re-angle' });
    expect(await state(id)).toBe('TESTING');
    expect((await ctx.db.one<{ status: string }>('SELECT status FROM kill_scale_proposal WHERE id = $1', [proposalId])).status).toBe('rejected');
  });

  it('the database itself refuses auto-approval or non-Owner approval of Owner-only kinds', async () => {
    const id = await makePersona(ctx, { state: 'TESTING' });
    const { approval } = await proposeKill(ctx.db, { personaId: id, rationale: 'x', proposedBy: STUDIO_MANAGER });
    await expect(ctx.db.query(`UPDATE approval SET status = 'auto_approved' WHERE id = $1`, [approval.id])).rejects.toThrow(/approval_owner_only_kinds/);
    await expect(ctx.db.query(`UPDATE approval SET status = 'approved', decided_by = 'agent:studio-manager' WHERE id = $1`, [approval.id])).rejects.toThrow(/approval_owner_only_kinds/);
    await expect(
      ctx.db.query(`UPDATE approval SET mode = 'auto_after', auto_approve_at = now() WHERE id = $1`, [approval.id]),
    ).rejects.toThrow(/approval_owner_only_kinds/);
    for (const kind of OWNER_ONLY_KINDS) {
      await expect(
        ctx.db.query(
          `INSERT INTO approval (studio_id, persona_id, kind, mode, title, proposed_by, auto_approve_at) VALUES ($1, $2, $3, 'auto_after', 't', 'agent:x', now())`,
          [ctx.studioId, id, kind],
        ),
      ).rejects.toThrow(/approval_owner_only_kinds/);
    }
  });

  it('allows one pending kill proposal per persona; agents may withdraw their own', async () => {
    const id = await makePersona(ctx, { state: 'TESTING' });
    const { approval } = await proposeKill(ctx.db, { personaId: id, rationale: 'x', proposedBy: STUDIO_MANAGER });
    await expect(proposeKill(ctx.db, { personaId: id, rationale: 'again', proposedBy: STUDIO_MANAGER })).rejects.toThrow();
    await expect(withdraw(ctx.db, approval.id, { type: 'agent', id: 'someone-else' })).rejects.toBeInstanceOf(ApprovalError);
    await withdraw(ctx.db, approval.id, STUDIO_MANAGER);
    await proposeKill(ctx.db, { personaId: id, rationale: 'again', proposedBy: STUDIO_MANAGER });
  });

  it('spend above caps, plan upgrades and disclosure/legal text are explicit even when cards auto-approve', () => {
    for (const kind of OWNER_ONLY_KINDS) {
      expect(approvalPolicy(kind, DEFAULT_SETTINGS)).toEqual({ mode: 'explicit', windowMs: null });
    }
  });

  it('an approved spend_over_cap grants headroom; disclosure changes apply only after approval', async () => {
    const id = await makePersona(ctx, { state: 'SCALING' });
    const a = await propose(ctx.db, { studioId: ctx.studioId, personaId: id, kind: 'spend_over_cap', title: '+400 credits', payload: { unit: 'hf_credits', amount: 400 }, proposedBy: STUDIO_MANAGER });
    expect((await budgetStatus(ctx.db, { studioId: ctx.studioId, personaId: id, unit: 'hf_credits' })).persona?.limit).toBe(1200);
    await decide(ctx.db, { approvalId: a.id, decision: 'approve', actor: OWNER });
    expect((await budgetStatus(ctx.db, { studioId: ctx.studioId, personaId: id, unit: 'hf_credits' })).persona?.limit).toBe(1600);

    const d = await propose(ctx.db, { studioId: ctx.studioId, kind: 'disclosure_change', title: 'New bio line', payload: { text: 'Openly AI · Studio X' }, proposedBy: STUDIO_MANAGER });
    const disclosure = async () => (await ctx.db.one<{ t: string }>(`SELECT settings->>'disclosure_text' AS t FROM studio WHERE id = $1`, [ctx.studioId])).t;
    expect(await disclosure()).toBe(DEFAULT_SETTINGS.disclosure_text);
    await decide(ctx.db, { approvalId: d.id, decision: 'approve', actor: OWNER });
    expect(await disclosure()).toBe('Openly AI · Studio X');
  });
});

describe('approval engine: 24 h one-tap cards', () => {
  it('a product v1 card auto-approves after 24 h, not before', async () => {
    ctx = await setup();
    const id = await makePersona(ctx, { state: 'TESTING' });
    const { id: productId } = await ctx.db.one<{ id: string }>(
      `INSERT INTO product (persona_id, name, slug, ladder_rung, status, price_cents) VALUES ($1, 'Planner', 'planner', 'entry', 'awaiting_approval', 1100) RETURNING id`,
      [id],
    );
    const t0 = new Date('2026-10-14T09:00:00Z');
    const card = await propose(ctx.db, { studioId: ctx.studioId, personaId: id, kind: 'product_v1', title: 'Planner v1', subjectType: 'product', subjectId: productId, proposedBy: { type: 'agent', id: 'monetization-agent' }, now: t0 });
    expect(card.mode).toBe('auto_after');
    expect(card.auto_approve_at?.toISOString()).toBe('2026-10-15T09:00:00.000Z');

    expect(await sweepAutoApprovals(ctx.db, { now: new Date(t0.getTime() + 24 * HOUR - 1000) })).toEqual([]);
    expect(await sweepAutoApprovals(ctx.db, { now: new Date(t0.getTime() + 24 * HOUR) })).toEqual([card.id]);
    const after = await ctx.db.one<{ status: string; decided_by: string; executed_at: Date | null }>('SELECT * FROM approval WHERE id = $1', [card.id]);
    expect(after).toMatchObject({ status: 'auto_approved', decided_by: 'system:auto-approve' });
    expect(after.executed_at).not.toBeNull();
    expect((await ctx.db.one<{ status: string }>('SELECT status FROM product WHERE id = $1', [productId])).status).toBe('approved');
    expect(await count(ctx.db, `SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'approval.auto_approved'`, [card.id])).toBe(1);
  });

  it('a persona launch card auto-approves and moves PROPOSED → SETUP; the Owner can still tap first', async () => {
    ctx = await setup();
    const a = await makePersona(ctx, { state: 'PROPOSED' });
    const b = await makePersona(ctx, { state: 'PROPOSED' });
    const t0 = new Date();
    const ca = await propose(ctx.db, { studioId: ctx.studioId, personaId: a, kind: 'persona_launch', title: 'Launch A', proposedBy: STUDIO_MANAGER, now: t0 });
    const cb = await propose(ctx.db, { studioId: ctx.studioId, personaId: b, kind: 'persona_launch', title: 'Launch B', proposedBy: STUDIO_MANAGER, now: t0 });
    await decide(ctx.db, { approvalId: cb.id, decision: 'reject', actor: OWNER });
    expect(await sweepAutoApprovals(ctx.db, { now: new Date(t0.getTime() + 25 * HOUR) })).toEqual([ca.id]);
    expect(await state(a)).toBe('SETUP');
    expect(await state(b)).toBe('PROPOSED');
  });

  it('respects the studio switch and the configured hours', async () => {
    ctx = await setup({ approvals: { auto_approve_cards: false, auto_approve_hours: 24, post_veto_window_minutes: 120 } });
    const id = await makePersona(ctx, { state: 'PROPOSED' });
    const off = await propose(ctx.db, { studioId: ctx.studioId, personaId: id, kind: 'persona_launch', title: 'Launch', proposedBy: STUDIO_MANAGER });
    expect(off).toMatchObject({ mode: 'explicit', auto_approve_at: null });
    expect(await sweepAutoApprovals(ctx.db, { now: new Date(Date.now() + 100 * HOUR) })).toEqual([]);

    // Turned on with a 6 h window.
    await updateSettings(ctx.db, ctx.studioId, { approvals: { auto_approve_cards: true, auto_approve_hours: 6, post_veto_window_minutes: 120 } }, OWNER);
    const p2 = await makePersona(ctx, { state: 'PROPOSED' });
    const t0 = new Date();
    const on = await propose(ctx.db, { studioId: ctx.studioId, personaId: p2, kind: 'persona_launch', title: 'Launch 2', proposedBy: STUDIO_MANAGER, now: t0 });
    expect(on.auto_approve_at?.getTime()).toBe(t0.getTime() + 6 * HOUR);

    // Switched off again before it fires → the card becomes explicit instead of auto-approving.
    await updateSettings(ctx.db, ctx.studioId, { approvals: { auto_approve_cards: false, auto_approve_hours: 6, post_veto_window_minutes: 120 } }, OWNER);
    expect(await sweepAutoApprovals(ctx.db, { now: new Date(t0.getTime() + 7 * HOUR) })).toEqual([]);
    expect(await ctx.db.one('SELECT mode, status, auto_approve_at FROM approval WHERE id = $1', [on.id])).toEqual({ mode: 'explicit', status: 'pending', auto_approve_at: null });
  });
});

describe('approval engine: posts and autonomy', () => {
  beforeEach(async () => {
    ctx = await setup();
  });

  it('L0 approves every post; L1 auto-publishes green after the veto window; amber waits; red is blocked', () => {
    const s = DEFAULT_SETTINGS;
    expect(approvalPolicy('post', s, { autonomy: 'L0', gate: 'green' }).mode).toBe('explicit');
    expect(approvalPolicy('post', s, { autonomy: 'L1', gate: 'green' })).toEqual({ mode: 'veto_window', windowMs: 120 * 60_000 });
    expect(approvalPolicy('post', s, { autonomy: 'L1', gate: 'amber' }).mode).toBe('explicit');
    expect(approvalPolicy('post', s, { autonomy: 'L2', gate: 'amber' }).mode).toBe('veto_window');
    expect(() => approvalPolicy('post', s, { autonomy: 'L2', gate: 'red' })).toThrow(/red/);
  });

  it('the Owner can veto a queued post inside the window; otherwise it schedules itself', async () => {
    const id = await makePersona(ctx, { state: 'TESTING', autonomy: 'L1' });
    const mkPost = async () =>
      (await ctx.db.one<{ id: string }>(`INSERT INTO post (persona_id, platform, format, status) VALUES ($1, 'tiktok', 'talking', 'awaiting_approval') RETURNING id`, [id])).id;
    const p1 = await mkPost();
    const p2 = await mkPost();
    const t0 = new Date();
    const a1 = await propose(ctx.db, { studioId: ctx.studioId, personaId: id, kind: 'post', title: 'p1', subjectType: 'post', subjectId: p1, proposedBy: { type: 'agent', id: 'publisher' }, gate: 'green', now: t0 });
    const a2 = await propose(ctx.db, { studioId: ctx.studioId, personaId: id, kind: 'post', title: 'p2', subjectType: 'post', subjectId: p2, proposedBy: { type: 'agent', id: 'publisher' }, gate: 'green', now: t0 });
    await decide(ctx.db, { approvalId: a2.id, decision: 'reject', actor: OWNER, note: 'veto' });
    expect(await sweepAutoApprovals(ctx.db, { now: new Date(t0.getTime() + 121 * 60_000) })).toEqual([a1.id]);
    const statuses = await ctx.db.query<{ id: string; status: string }>('SELECT id, status FROM post WHERE persona_id = $1', [id]);
    expect(Object.fromEntries(statuses.map((s) => [s.id, s.status]))).toEqual({ [p1]: 'scheduled', [p2]: 'vetoed' });
  });
});
