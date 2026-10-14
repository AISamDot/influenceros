import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalError,
  ApprovalRequiredError,
  canTransition,
  decide,
  InvalidTransitionError,
  OWNER,
  type PersonaState,
  PERSONA_STATES,
  propose,
  proposeKill,
  STUDIO_MANAGER,
  transition,
  TRANSITIONS,
  updateSettings,
} from '../src';
import { type Ctx, count, makePersona, setup } from './helpers';

let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => ctx.db.close());

describe('persona lifecycle state machine', () => {
  it('encodes the PRD §4 graph', () => {
    expect(canTransition('PROPOSED', 'SETUP')).toBe(true);
    expect(canTransition('SETUP', 'TESTING')).toBe(true);
    for (const to of ['MONETISING', 'RE_ANGLE', 'KILLED'] as const) expect(canTransition('TESTING', to)).toBe(true);
    expect(canTransition('MONETISING', 'SCALING')).toBe(true);
    expect(canTransition('SCALING', 'BRAND')).toBe(true);
    expect(canTransition('KILLED', 'RETIRED')).toBe(true);
    // Not allowed
    expect(canTransition('PROPOSED', 'TESTING')).toBe(false);
    expect(canTransition('TESTING', 'BRAND')).toBe(false);
    expect(canTransition('TESTING', 'SCALING')).toBe(false);
    expect(canTransition('RETIRED', 'TESTING')).toBe(false);
    expect(canTransition('KILLED', 'TESTING')).toBe(false);
    // Every state has an entry; RETIRED is terminal.
    for (const s of PERSONA_STATES) expect(TRANSITIONS[s]).toBeDefined();
    expect(TRANSITIONS.RETIRED).toEqual([]);
  });

  it('runs a valid path and logs every transition in persona_state_log and audit_log', async () => {
    const id = await makePersona(ctx, { state: 'PROPOSED', autonomy: 'L0' });
    const launch = await propose(ctx.db, { studioId: ctx.studioId, personaId: id, kind: 'persona_launch', title: 'Launch', proposedBy: STUDIO_MANAGER });
    await decide(ctx.db, { approvalId: launch.id, decision: 'approve', actor: OWNER });
    const testing = await transition(ctx.db, { personaId: id, to: 'TESTING', actor: STUDIO_MANAGER, reason: 'accounts ready' });
    expect(testing.state).toBe('TESTING');
    expect(testing.autonomy).toBe('L1'); // the studio default (posts default to L1), not a permanent L0
    expect(testing.launched_at).not.toBeNull();
    await transition(ctx.db, { personaId: id, to: 'MONETISING', actor: STUDIO_MANAGER });
    await transition(ctx.db, { personaId: id, to: 'SCALING', actor: STUDIO_MANAGER });
    await transition(ctx.db, { personaId: id, to: 'BRAND', actor: STUDIO_MANAGER });

    const log = await ctx.db.query<{ from_state: string | null; to_state: string }>(
      'SELECT from_state, to_state FROM persona_state_log WHERE persona_id = $1 ORDER BY created_at, to_state',
      [id],
    );
    expect(log.map((l) => `${l.from_state}→${l.to_state}`)).toEqual([
      'PROPOSED→SETUP',
      'SETUP→TESTING',
      'TESTING→MONETISING',
      'MONETISING→SCALING',
      'SCALING→BRAND',
    ]);
    expect(await count(ctx.db, `SELECT 1 FROM audit_log WHERE persona_id = $1 AND action = 'persona.transition'`, [id])).toBe(5);
  });

  it('rejects invalid transitions and changes nothing', async () => {
    const id = await makePersona(ctx, { state: 'TESTING' });
    await expect(transition(ctx.db, { personaId: id, to: 'BRAND', actor: STUDIO_MANAGER })).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(transition(ctx.db, { personaId: id, to: 'SETUP', actor: OWNER })).rejects.toBeInstanceOf(InvalidTransitionError);
    const p = await ctx.db.one<{ state: PersonaState }>('SELECT state FROM persona WHERE id = $1', [id]);
    expect(p.state).toBe('TESTING');
    expect(await count(ctx.db, 'SELECT 1 FROM persona_state_log WHERE persona_id = $1', [id])).toBe(0);
  });

  it('needs the launch card to leave PROPOSED', async () => {
    const id = await makePersona(ctx, { state: 'PROPOSED' });
    await expect(transition(ctx.db, { personaId: id, to: 'SETUP', actor: STUDIO_MANAGER })).rejects.toBeInstanceOf(ApprovalRequiredError);
    const card = await propose(ctx.db, { studioId: ctx.studioId, personaId: id, kind: 'persona_launch', title: 'Launch', proposedBy: STUDIO_MANAGER });
    // Pending card is not enough.
    await expect(transition(ctx.db, { personaId: id, to: 'SETUP', actor: STUDIO_MANAGER, approvalId: card.id })).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('never kills or retires without an Owner-approved approval, and each approval is single-use', async () => {
    const id = await makePersona(ctx, { state: 'TESTING' });
    const other = await makePersona(ctx, { state: 'TESTING' });
    await expect(transition(ctx.db, { personaId: id, to: 'KILLED', actor: OWNER })).rejects.toBeInstanceOf(ApprovalRequiredError);

    const { approval } = await proposeKill(ctx.db, { personaId: id, rationale: 'day 30 failed', proposedBy: STUDIO_MANAGER });
    // An approval for another persona can't be borrowed.
    await expect(transition(ctx.db, { personaId: other, to: 'KILLED', actor: OWNER, approvalId: approval.id })).rejects.toBeInstanceOf(ApprovalRequiredError);

    await decide(ctx.db, { approvalId: approval.id, decision: 'approve', actor: OWNER });
    expect((await ctx.db.one<{ state: string }>('SELECT state FROM persona WHERE id = $1', [id])).state).toBe('KILLED');

    // The kill approval completes the wind-down into RETIRED once…
    await transition(ctx.db, { personaId: id, to: 'RETIRED', actor: STUDIO_MANAGER, approvalId: approval.id });
    expect((await ctx.db.one<{ state: string }>('SELECT state FROM persona WHERE id = $1', [id])).state).toBe('RETIRED');

    // …but retiring a live winner needs its own Owner-approved retire approval.
    const winner = await makePersona(ctx, { state: 'MONETISING' });
    await expect(transition(ctx.db, { personaId: winner, to: 'RETIRED', actor: STUDIO_MANAGER })).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('going live applies the studio default autonomy, and new personas default to L1 in the schema', async () => {
    const live = async (id: string) => {
      const launch = await propose(ctx.db, { studioId: ctx.studioId, personaId: id, kind: 'persona_launch', title: 'Launch', proposedBy: STUDIO_MANAGER });
      await decide(ctx.db, { approvalId: launch.id, decision: 'approve', actor: OWNER });
      return transition(ctx.db, { personaId: id, to: 'TESTING', actor: STUDIO_MANAGER });
    };
    await updateSettings(ctx.db, ctx.studioId, { default_autonomy: 'L2' }, OWNER);
    expect((await live(await makePersona(ctx, { state: 'PROPOSED', autonomy: 'L0' }))).autonomy).toBe('L2');
    await updateSettings(ctx.db, ctx.studioId, { default_autonomy: 'L0' }, OWNER);
    expect((await live(await makePersona(ctx, { state: 'PROPOSED', autonomy: 'L1' }))).autonomy).toBe('L0');

    const { autonomy } = await ctx.db.one<{ autonomy: string }>(
      `INSERT INTO persona (studio_id, slug, name, niche) VALUES ($1, 'fresh', 'Fresh', 'x') RETURNING autonomy`,
      [ctx.studioId],
    );
    expect(autonomy).toBe('L1');
  });

  it('refuses lifecycle proposals that could never execute (no edge from the current state)', async () => {
    const testing = await makePersona(ctx, { state: 'TESTING' });
    const reAngle = await makePersona(ctx, { state: 'RE_ANGLE' });
    const proposed = await makePersona(ctx, { state: 'PROPOSED' });
    const setup = await makePersona(ctx, { state: 'SETUP' });
    const brand = await makePersona(ctx, { state: 'BRAND' });
    await expect(proposeKill(ctx.db, { personaId: testing, action: 'retire', rationale: 'x', proposedBy: STUDIO_MANAGER })).rejects.toThrow(/TESTING → RETIRED/);
    await expect(proposeKill(ctx.db, { personaId: reAngle, action: 'retire', rationale: 'x', proposedBy: STUDIO_MANAGER })).rejects.toBeInstanceOf(ApprovalError);
    await expect(proposeKill(ctx.db, { personaId: proposed, rationale: 'x', proposedBy: STUDIO_MANAGER })).rejects.toThrow(/PROPOSED → KILLED/);
    await expect(proposeKill(ctx.db, { personaId: brand, rationale: 'x', proposedBy: STUDIO_MANAGER })).rejects.toThrow(/BRAND → KILLED/);
    await expect(propose(ctx.db, { studioId: ctx.studioId, personaId: setup, kind: 'persona_launch', title: 'Launch', proposedBy: STUDIO_MANAGER })).rejects.toThrow(/SETUP → SETUP/);
    expect(await count(ctx.db, 'SELECT 1 FROM approval')).toBe(0);
    expect(await count(ctx.db, 'SELECT 1 FROM kill_scale_proposal')).toBe(0);

    // Valid ones still go through: a kill in TESTING, a retire of a live winner, a retire after a kill.
    await proposeKill(ctx.db, { personaId: testing, rationale: 'x', proposedBy: STUDIO_MANAGER });
    await proposeKill(ctx.db, { personaId: brand, action: 'retire', rationale: 'x', proposedBy: STUDIO_MANAGER });
  });
});
