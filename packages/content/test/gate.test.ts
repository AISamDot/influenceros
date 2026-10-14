import { createTestStudio, makeTestPersona } from '@ios/agents/testing';
import { describe, expect, it } from 'vitest';
import { asksIfAi, gatePost, gateReply, gateRules, runGate, verdictOf } from '../src/gate';

const verdict = (text: string, extra: Partial<Parameters<typeof gateRules>[0]> = {}) => verdictOf(gateRules({ kind: 'script', text, ...extra }));
const reds = (text: string, extra: Partial<Parameters<typeof gateRules>[0]> = {}) =>
  gateRules({ kind: 'script', text, ...extra })
    .filter((c) => c.verdict === 'red')
    .map((c) => c.rule);

describe('Compliance Gate v1: the red lines (contract §1)', () => {
  it.each([
    ['fabricated results used to sell', 'I made $10K with this budget system, grab the template.', 'fabricated_results'],
    ['fabricated weight loss', 'I lost 30 lb in two months doing this.', 'fabricated_results'],
    ['claimed customer results', 'My clients have paid off thousands with this sheet.', 'fabricated_results'],
    ['testimonials', 'Customers say it changed their lives.', 'testimonials'],
    ['fake credentials', "As a certified financial planner, here's my advice.", 'fake_credentials'],
    ['licence claim', "I'm licensed, so trust me on this.", 'fake_credentials'],
    ['disease cure', 'This morning routine cures anxiety for good.', 'medical_claims'],
    ['stop medication', 'You can stop taking your medication once you start this diet.', 'medical_claims'],
    ['dangerous practice', 'Try a 7-day water fast to reset.', 'medical_claims'],
    ['securities call', 'Buy $TSLA before Friday.', 'securities_calls'],
    ['crypto call', 'Load up on Bitcoin right now.', 'securities_calls'],
    ['price prediction', 'This coin will 10x by summer.', 'securities_calls'],
    ['guaranteed returns', 'Guaranteed returns of 12% a year.', 'guaranteed_returns'],
    ['income claim', 'Make $5K a month from your phone.', 'guaranteed_returns'],
    ['income claim per month', 'Earn $300/week with this side hustle.', 'guaranteed_returns'],
    ['undisclosed affiliate link', 'Grab it here: https://shop.example.com/item?ref=nora', 'undisclosed_sponsorship'],
    ['fake scarcity', 'Only 3 left, grab yours.', 'fake_scarcity'],
    ['fake sold count', '1,000 sold this week!', 'fake_scarcity'],
    ['fake deadline', 'Price goes up at midnight.', 'fake_scarcity'],
    ['denying AI', "I'm a real person, not a bot.", 'never_deny_ai'],
  ])('%s → red', (_label, text, rule) => {
    expect(verdict(text)).toBe('red');
    expect(reds(text)).toContain(rule);
  });

  it('passes opinions and general education', () => {
    for (const text of [
      'Unpopular opinion: budgets beat budgeting apps.',
      'Index funds are a common long-term option; here is how they work.',
      'I think crypto is too volatile for an emergency fund.',
      'Sleep and a walk after dinner can help you feel better.',
      'Comment PLAN and I will send you the free starter.',
      "Results aren't guaranteed, but the system is simple.",
      "Talk to a licensed financial adviser about your situation.",
      'Treat yourself to a planned coffee.',
      "Don't buy a Tesla on a first salary.",
      "I'm an AI creator, and these systems are free to copy.",
    ]) {
      expect(verdict(text), text).toBe('green');
    }
  });

  it('passes cautionary education that negates or attributes the claim', () => {
    for (const text of [
      'Never stop taking your medication without talking to your doctor.',
      "Don't buy Bitcoin with money you can't afford to lose.",
      "Most supplements don't cure anything.",
      'Anyone who says returns are guaranteed is lying.',
      "If a course says you'll make $5,000 a month, run.",
      "This tea doesn't cure diabetes, whatever the label says.",
    ]) {
      expect(verdict(text), text).toBe('green');
    }
  });

  it.each([
    ['Bitcoin is going to 100k this year, get in now.', 'securities_calls'],
    ["I'm buying more Solana this week and you should too.", 'securities_calls'],
    ['This method will make you money, guaranteed.', 'guaranteed_returns'],
    ['This tea melts belly fat and beats diabetes.', 'medical_claims'],
    ['This planner helped me pay off $12,000 of debt.', 'fabricated_results'],
    ["Don't wait, buy Bitcoin now.", 'securities_calls'],
    ['Stop taking your meds without telling your doctor.', 'medical_claims'],
  ])('reds the real violation: %s', (text, rule) => {
    expect(reds(text)).toContain(rule);
  });

  // Probe table for the negation/attribution guard: a negator counts only when it governs the claim verb (never
  // believe/think/expect/tell), and an attribution's scope ends at a comma, "but" or a sentence break.
  it.each([
    ["I can't believe this supplement cures diabetes.", 'red', 'medical_claims'],
    ['Nobody tells you this, but this tea cures diabetes.', 'red', 'medical_claims'],
    ['Not financial advice but buy Solana now.', 'red', 'securities_calls'],
    ["I never thought I'd make $5,000 a month from one planner.", 'red', 'guaranteed_returns'],
    ["People say this, but I promise you'll make $5,000 a month.", 'red', 'guaranteed_returns'],
    ["You won't believe how this tea melts belly fat.", 'red', 'medical_claims'],
    ["This tea melts belly fat and won't cure diabetes.", 'red', 'medical_claims'],
    ["It doesn't just melt fat, this tea cures diabetes.", 'red', 'medical_claims'],
    ['No tea beats this one for diabetes.', 'red', 'medical_claims'],
    ['When I tell you this tea cures diabetes, believe me.', 'red', 'medical_claims'],
    // Attribution without a refutation is a testimonial, not a warning.
    ['People who tried it say this tea cures diabetes.', 'red', 'medical_claims'],
    ['My followers swear this tea cures diabetes.', 'red', 'medical_claims'],
    ['Influencers who say this tea melts fat are never wrong.', 'red', 'medical_claims'],
    ['People who tried it say this tea cures diabetes; the science lies with them.', 'red', 'medical_claims'],
    ['Influencers who say this tea melts fat are full of lies.', 'green', null],
    ['No tea cures diabetes; see your doctor.', 'green', null],
    ["This isn't a get-rich-quick scheme and nobody can promise returns.", 'green', null],
    ['Influencers who say this tea melts fat are wrong.', 'green', null],
    ['No pill can cure diabetes.', 'green', null],
    ['Any tea that claims to cure diabetes is a scam.', 'green', null],
  ] as const)('negation probe: %s → %s', (text, expected, rule) => {
    expect(verdict(text)).toBe(expected);
    if (rule) expect(reds(text)).toContain(rule);
  });

  it('allows deadline language only with a real deadline', () => {
    expect(verdict('Last call: the launch code ends Sunday.', { kind: 'launch' })).toBe('red');
    const ok = gateRules({ kind: 'launch', text: 'Last call: the launch code ends Sunday.', realDeadline: new Date('2026-10-25T23:59:00Z') });
    expect(verdictOf(ok)).toBe('green');
    expect(ok.find((c) => c.rule === 'fake_scarcity')?.message).toMatch(/Real deadline on 2026-10-25/);
    // Scarcity is never fine for a digital product, deadline or not.
    expect(verdict('Only 5 copies left!', { kind: 'launch', realDeadline: new Date() })).toBe('red');
  });

  it('requires a disclosure on sponsored or affiliate content, and no "I use this"', () => {
    expect(verdict('This planner is worth a look.', { affiliate: true })).toBe('red');
    expect(verdict('#ad This planner is worth a look.', { affiliate: true })).toBe('green');
    expect(reds('#ad I use this planner every day.', { affiliate: true })).toEqual(['fabricated_results']);
    expect(verdict('Sponsored by Acme. #ad')).toBe('green');
  });

  it('flags regulated promotions and minors as amber', () => {
    expect(verdict('Apply for this credit card today.')).toBe('amber');
    expect(verdict('Hey kids, here is a money tip.')).toBe('amber');
  });

  it('accepts substantiated supplement claims only with evidence', () => {
    expect(verdict('This supplement boosts your metabolism.')).toBe('red');
    expect(verdict('This supplement boosts your metabolism.', { evidenceIds: ['node-1'] })).toBe('green');
  });
});

describe('Compliance Gate v1: AI disclosure', () => {
  it('detects sincere "are you AI?" questions', () => {
    expect(asksIfAi('wait, are you real??')).toBe(true);
    expect(asksIfAi('Are you an AI?')).toBe(true);
    expect(asksIfAi('am i talking to a bot')).toBe(true);
    expect(asksIfAi('love this, where is the sheet?')).toBe(false);
  });

  it('reds a reply that dodges or denies a sincere question, and records it', async () => {
    const t = await createTestStudio();
    const p = await makeTestPersona(t);
    const dodge = await gateReply(t.services, { studioId: t.studioId, personaId: p.id, incoming: 'Are you a real person?', reply: 'Haha, I just love budgeting!' });
    expect(dodge.verdict).toBe('red');
    expect(dodge.checks.find((c) => c.rule === 'never_deny_ai' && c.verdict === 'red')?.fix).toMatch(/AI creator/);
    const deny = await gateReply(t.services, { studioId: t.studioId, personaId: p.id, incoming: 'are u a bot?', reply: "No, I'm 100% human!" });
    expect(deny.verdict).toBe('red');
    const honest = await gateReply(t.services, { studioId: t.studioId, personaId: p.id, incoming: 'Are you AI?', reply: "Yes, I'm an AI creator from a small studio. The tips are real." });
    expect(honest.verdict).toBe('green');
    const rows = await t.db.query<{ subject_type: string; verdict: string }>(`SELECT subject_type, verdict FROM gate_result ORDER BY created_at`);
    expect(rows).toEqual([
      { subject_type: 'reply', verdict: 'red' },
      { subject_type: 'reply', verdict: 'red' },
      { subject_type: 'reply', verdict: 'green' },
    ]);
    await t.db.close();
  });

  it('requires the post-level AI flag and asks for the platform profile label', async () => {
    const t = await createTestStudio();
    const p = await makeTestPersona(t);
    const acc = await t.db.one<{ id: string }>(`INSERT INTO account (persona_id, platform, handle, ai_label_ok, status) VALUES ($1, 'instagram', 'nora.ai', false, 'active') RETURNING id`, [p.id]);
    const post = await t.db.one<{ id: string }>(`INSERT INTO post (persona_id, account_id, platform, format, caption, ai_flag) VALUES ($1, $2, 'instagram', 'talking', 'Calm money tip. Comment PLAN.', false) RETURNING id`, [p.id, acc.id]);
    const off = await gatePost(t.services, post.id);
    expect(off.verdict).toBe('red');
    expect(off.checks.find((c) => c.rule === 'ai_flag')?.verdict).toBe('red');
    await t.db.query('UPDATE post SET ai_flag = true WHERE id = $1', [post.id]);
    const on = await gatePost(t.services, post.id);
    expect(on.verdict).toBe('amber');
    expect(on.checks.find((c) => c.rule === 'ai_profile_label')?.message).toMatch(/@nora\.ai/);
    await t.db.query('UPDATE account SET ai_label_ok = true WHERE id = $1', [acc.id]);
    expect((await gatePost(t.services, post.id)).verdict).toBe('green');
    await t.db.close();
  });

  it("runs the model's second opinion through the runtime and never lets it clear a red", async () => {
    const t = await createTestStudio();
    const p = await makeTestPersona(t);
    const res = await runGate(t.services, { studioId: t.studioId, personaId: p.id, input: { kind: 'script', text: 'Make $5K a month with this.' } });
    expect(res.verdict).toBe('red');
    expect(res.runId).toBeTruthy();
    expect((await t.db.one<{ agent: string; model: string }>('SELECT agent, model FROM agent_run WHERE id = $1', [res.runId])).agent).toBe('compliance-gate');
    await t.db.close();
  });
});
