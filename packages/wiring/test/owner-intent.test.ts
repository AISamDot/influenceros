import { ownerAsked } from '@ios/agents';
import { describe, expect, it } from 'vitest';
import { allTools } from '../src';

/**
 * In a run whose context holds untrusted text (news, comments, web research), a mutating tool runs only when the
 * Owner's own message asks for it: an action verb plus the tool's object, in a sentence that is not a question.
 */
const tools = new Map(allTools().map((t) => [t.name, t]));
const asked = (tool: string, ownerText: string, proposal: string | null = null) => {
  const def = tools.get(tool);
  if (!def) throw new Error(`no tool ${tool}`);
  return ownerAsked(def, { untrusted: true, ownerText, proposal });
};

describe('owner intent: verb + object, never a question', () => {
  it.each([
    // Ordinary questions and chat that used to unlock writes.
    ['bible.revise', 'Give me an update on the news'],
    ['bible.revise', 'How did the hooks do this week?'],
    ['playbook.add_rule', 'Never mind, what is new?'],
    ['persona.lower_controls', "What's the budget looking like?"],
    ['studio.delegate', 'What do you have on Vivian?'],
    // Not questions, but no action verb on the tool's object.
    ['bible.revise', 'The hooks did well this week.'],
    ['bible.revise', 'Update me on the news.'],
    ['playbook.add_rule', 'Rules are rules.'],
    ['persona.lower_controls', 'The budget is fine.'],
    ['persona.lower_controls', 'Set up a budget planner product.'],
    ['studio.delegate', 'I have nothing to add.'],
    ['studio.delegate', 'Tell me how to fix the hooks.'],
    ['approvals.withdraw', 'Pull up the numbers.'],
    ['pipeline.run_slot', 'Run the numbers for me.'],
    ['calendar.plan_week', 'The calendar looks thin.'],
    ['chat.notify_owner', 'Tell me about Vivian.'],
    ['studio.propose_kill', 'Is the kill switch on'],
    ['monetization.brief', 'Make sure the product page loads.'],
    ['knowledge.request_build', 'What does the field brain know about dating?'],
    // Questions without a "?" and requests for information.
    ['bible.revise', 'Did you update her voice'],
    ['bible.revise', "Update me on Vivian's voice."],
    ['bible.revise', 'Tell me what you would change about her tone.'],
    ['bible.revise', 'Walk me through how you would change her look.'],
    ['forecast.run', 'Run me through the forecast.'],
    ['persona.lower_controls', 'I wonder if we should lower the budget.'],
    ['persona.lower_controls', 'Should we lower the budget'],
    ['playbook.add_rule', 'Have you added a rule for hooks'],
    // Polite questions still don't unlock (the agent proposes; the Owner says yes).
    ['persona.lower_controls', "Can you lower Vivian's autonomy to L1?"],
    // Negated asks.
    ['bible.revise', "Don't change Vivian's voice."],
    ['persona.lower_controls', "Please don't lower her budget."],
  ])('%s stays locked for %j', (tool, text) => {
    expect(asked(tool, text)).toBe(false);
  });

  it.each([
    ['bible.revise', "Revise Vivian's bible: shorter sentences."],
    ['bible.revise', 'Change her tone to something warmer.'],
    ['bible.revise', 'Update the voice section with a rule about slang.'],
    ['bible.revise', "Edit Vivian's look so she wears glasses."],
    ['playbook.add_rule', 'Add a rule: question hooks beat stat hooks on TikTok.'],
    ['playbook.add_rule', 'Make it a playbook rule to open with a question.'],
    ['persona.lower_controls', "Lower Vivian's autonomy to L1."],
    ['persona.lower_controls', 'Reduce her budget to $20 a month.'],
    ['persona.lower_controls', 'Set Vivian to L0.'],
    ['studio.delegate', 'Ask Vivian to draft three new hooks.'],
    ['studio.delegate', "Tell Vivian's manager to check the comments."],
    ['studio.delegate', 'Have Vivian to look at the budgeting series.'],
    ['monetization.brief', 'Make a product brief for the budget planner.'],
    ['monetization.brief', 'Create a brief for a debt payoff tracker.'],
    ['knowledge.request_build', 'Rebuild the field brain for dating.'],
    ['knowledge.request_build', 'Refresh the knowledge base for personal finance.'],
    ['news.request_scan', 'Scan the news for personal finance now.'],
    ['monetization.listing_pack', 'Write the listing for the planner.'],
    ['monetization.launch_plan', 'Plan the launch for next Monday.'],
    ['monetization.run_cycle', 'Run the monetization cycle for Vivian.'],
    ['monetization.add_signal', 'Log this as a demand signal.'],
    ['calendar.plan_week', "Plan Vivian's week."],
    ['pipeline.run_slot', 'Retry the blocked slot.'],
    ['approvals.withdraw', 'Withdraw the kill proposal.'],
    ['studio.propose_kill', 'Kill Vivian.'],
    ['studio.pause_posting', 'Pause TikTok posting for today.'],
    ['profit.run_levers', 'Pull the levers now.'],
    ['forecast.run', 'Rerun the forecast.'],
    ['profit.weekly_report', 'Post the weekly report.'],
    ['chat.notify_owner', 'Remind me tomorrow.'],
    // A question first, then the command: the command sentence counts.
    ['bible.revise', 'How did the hooks do? Update her tone to warmer.'],
  ])('%s unlocks for %j', (tool, text) => {
    expect(asked(tool, text)).toBe(true);
  });

  it("a yes confirms the agent's own proposal, even when the proposal is a question", () => {
    expect(asked('persona.lower_controls', 'yes', "Shall I lower Vivian's autonomy to L1 until the hooks recover?")).toBe(true);
    expect(asked('persona.lower_controls', 'yes', 'Want me to look at the budget numbers?')).toBe(false);
    expect(asked('persona.lower_controls', 'yes', null)).toBe(false);
  });

  it('every mutating tool an agent can call has an owner intent', () => {
    const missing = allTools()
      .filter((t) => t.mutates && !t.ownerOnly && !t.ownerIntent)
      .map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it('marks reads that carry news-derived text as untrusted output', () => {
    for (const name of ['calendar.week', 'pipeline.board', 'script.get']) expect(tools.get(name)?.untrustedOutput, name).toBe(true);
  });
});
