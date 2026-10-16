# Welcome Sequence: "Letters from Old You" (5 emails, 10 days)

**Persona:** Margot from 2075 · **Platform:** Resend (Margot's audience) · **Triggers:** a 2075 Calculator submission (tag `calc`), or an opt-in through the RAISE keyword freebie (tag `raise`, `lead-magnet.md` §I), from Sun 1 Nov 2026
**Shape:** 1 delivers the lead magnet → 2 value → 3 value + soft offer → 4 story-free proof of usefulness → 5 final offer with a real deadline (plus the Who We Marry clue and the Pay Old Me First waitlist, per bible §14.1)
**Voice:** Margot, Irish/UK spelling, at most one Irish-ism per email beyond the sign-off. Lore carries regret, never payoff, and never sits next to a sum or the offer as its result.

## Automation rules (no manual steps)

| Email | Sends | Notes |
|---|---|---|
| 1 | Immediately (after double opt-in for EU/EEA/UK) | The calculator result. Same template as `lead-magnet.md` §D, reproduced below |
| 2 | Day 2, 10:00 am in the subscriber's time zone (geo-IP; fallback US Eastern) | Value |
| 3 | Day 4, 10:00 am | Value + soft offer. Never sends before **Thu 5 Nov 2026, 9:00 am US Eastern** (held until then) |
| 4 | Day 7, 10:00 am | Story-free proof of usefulness |
| 5 | Day 10, 10:00 am | Final offer. **Deadline logic below** |

**Two paths (the RAISE path is the primary route into the pack):**

| Path | Who | What they get |
|---|---|---|
| **RAISE path** (primary) | Tag `raise` (they asked for the pay-meeting email, so a pay conversation is on their mind) | Day 0: the freebie page from `lead-magnet.md` §I. Then Email 3 (**RAISE variant**, below) on day 1, Email 4 on day 4, Email 5 on day 7. Emails 1 and 2 are skipped. The same 9:00 am Thu 5 Nov hold applies to Email 3 |
| **Saver path** | Tag `calc` | Emails 1 to 5 as scheduled. Email 2 ends with a one-click question (below) |

**The one-question branch (end of Email 2, saver path):** "Is a pay conversation coming up in the next six months? [Yes, soon]({{q_yes}}) · [Not yet]({{q_no}})". A click tags `pay_soon` or `pay_later`; no click is treated as `pay_soon`.
- `pay_soon`: Emails 3 to 5 as written.
- `pay_later`: Email 3 sends with its offer paragraph replaced by the **Not-yet line** (below); Email 4 sends with its last two paragraphs replaced by the same line; Email 5 does not send. Instead, a tag `pay_later_followup` re-enters them ninety days later, at most once: the Email 3 RAISE variant, then Email 5 three days after it (they've had Email 4 already). The one-code rule still applies.

**Not-yet line:** "No pay conversation on the horizon? Keep this email for when there is. When the time comes, the Raise Script Pack has the rest of it: the words for the room, the replies and the email after. [Bookmark it →]({{pack_link}})"

**Contacts with both tags** follow the RAISE path only, and never receive any email twice.

**Deadline logic for email 5 (real deadlines only):**
- **If email 5 sends before Sun 15 Nov 2026, 11:59 pm US Eastern:** use the **Launch** block. The deadline is the store-wide launch price end: the `LAUNCH` code expires at 2026-11-16T04:59:00Z.
- **Otherwise:** use the **Welcome** block. Just before sending, the function creates a unique, single-use Lemon Squeezy discount code ($3 off, `max_redemptions` 1, `expires_at` = send time + 72 h) and fills `{{personal_code}}` and `{{expiry_local}}` (the subscriber's local time and date). The code really stops working at that time; no resends, no extensions.
- **One code per email address, for life.** Before creating a code, the function normalises the address (trimmed, lower-cased, `+tag` removed) and looks up its SHA-256 hash in the Supabase table `welcome_codes`. If a row exists, no new code is made and Email 5 uses the **Standard** block (no code, no deadline). Rows are never deleted on unsubscribe, resubscribe, a re-entered calculator, a new RAISE opt-in or a tag change; only the hash is kept, so a deletion request removes the contact but keeps the hash as a suppression record. This stops the 72-hour window turning into a rolling deadline.
- **Issuance log:** every code writes one row to `welcome_codes`: `email_hash`, `code_id`, `issued_at`, `expires_at`, `email5_message_id`, `redeemed_at` (filled by the `order_created` webhook). A daily check alerts the studio agent if any hash has more than one row or any code has an `expires_at` other than `issued_at` + 72 h.
- **Re-entry:** a contact who has already received Email 5 never restarts the sequence. A re-entered calculator sends Email 1 (their new sums) only.

**Buyer suppression:** a Lemon Squeezy `order_created` webhook tags buyers `bought_raise`. Buyers skip the offer blocks in emails 3–5 (each email has a buyer variant line, marked below) and email 5 sends its **Buyer** version.

**Every email footer:**
<small>Margot is a fictional AI character. The maths is real, and the postmark means illustrative. General info, not advice for your situation. [Unsubscribe]({{unsubscribe}}) · Margot from 2075, {{postal_address}}</small>

---

## Email 1 · Day 0 · Delivers the lead magnet

**Subject:** A letter from Old You
**Preview:** Your sums, franked. Read it with the kettle on.

Dear you,

It's me. You. From 2075. The Office let this one through, so here are your sums, done properly, on paper.

You told me you're **{{age}}**, you set aside about **{{monthly}}** a month, and you've **{{savings}}** put by so far. I've assumed **{{rate}}%** a year after fees{{#if inflation_on}}, shrunk into today's money at an assumed 2.5% a year of rising prices{{/if}}.

**What Old You is working with (on paper)**

| At age | What you'd have, roughly | With one percent more ({{one_pct}} a month) |
|---|---|---|
{{#each milestones}}| {{age}} | {{plain}} | {{plus}} |
{{/each}}

That one percent is worth about **{{gap_67}}** by {{gap_age}}, on paper. Of the {{plain_67}} at 67, about **{{paid_in_67}}** is money you put in yourself. The rest is time doing the work.

`[The rust Tempo Office frank: ILLUSTRATIVE · TEMPO OFFICE · 2075]`
<small>Illustrative. Assumes {{rate}}% a year after fees, compounded monthly; contributions stop at {{stop_age}}; no withdrawals assumed after{{#if inflation_on}}; adjusted for 2.5% a year assumed inflation{{else}}; not adjusted for inflation{{/if}}. Real returns vary and can be negative. Not a promise.</small>

**Three things to do before your next payday**
1. **Set up the Three-Transfer Payday:** Cushion, Old Me, Joy. [The one-page guide →]({{link_step1}})
2. **Check the match.** If your employer adds money when you do, take all of it. [What it's called where you are →]({{link_step2}})
3. **Hold a Subscription Funeral** on the last Sunday of the month. [How →]({{link_step3}})

Nobody can do it from 2075, a stór. Only you can, on payday.

Pay me first. I'm still here.
**Margot**

P.S. In two days: the payday set-up, step by step. Ten minutes, once.

---

## Email 2 · Day 2 · Value: the ten-minute payday

**Subject:** Ten minutes, once
**Preview:** The boring Tuesday thing, step by step. Do it before payday.

Dear you,

Here's the thing I'd do first if I had my thirties back. Not a budget. Not an app. Three transfers.

**The Three-Transfer Payday**

Open your banking app now (I'll wait) and make three pots or savings accounts. Name them:

- **Cushion:** emergency cash. Boring and easy to reach.
- **Old Me:** long-term. Your workplace plan first, then long-term saving.
- **Joy:** guilt-free spending. Yes, it gets its own pot.

Then schedule three repeating transfers for payday, before you can see the money. Start where it doesn't sting. One shape:

| Pot | Start with | On a 3,200 take-home |
|---|---|---|
| Cushion | 3% | 96 |
| Old Me | enough to get any full employer match, through payroll | 128 |
| Joy | 2% | 64 |

`[FRANK]` *Illustrative example. Your pay, your pots, your percentages.*

It feels like nothing. That's the point. The money you never see is the money you never miss.

**Two rules that keep it working**
1. **Ratchet.** Every six months, add 1% to Old Me. Put the reminder in your calendar now.
2. **The 48-Hour Hold.** Want to take money out of Old Me? Wait 48 hours. If you still need it, take it, no guilt. That's what it's for.

**Juggling debt as well?** The order that makes sense for most people: a one-month Cushion, then any employer match, then high-interest debt like cards, then Old Me. If debt's keeping you up at night, there's free non-profit help: NFCC (US), StepChange or MoneyHelper (UK), Credit Counselling Canada, or the National Debt Helpline on 1800 007 007 (Australia).

**Your one job this week:** three pots, three transfers, one calendar reminder. Reply "DONE" if you like; the Office lets me read replies.

I'm not cross. I'm just older.

Pay me first. I'm still here.
**Margot**

**One quick question:** is a pay conversation coming up in the next six months? [Yes, soon]({{q_yes}}) · [Not yet]({{q_no}}) (One click. It just tells me which letters are useful to you.)

P.S. Next letter is about a lever that's often bigger than saving, and it isn't a budget.

---

## Email 3 · Day 4 · Value + soft offer: the meeting email

**Subject:** Your raise is being decided without you
**Preview:** Not the ask. Just the meeting. Here's the email.

Dear you,

You can save a percent here and a percent there, and you should. But in your thirties, your pay is often the bigger lever. Depending on your employer, one well-prepared ask can be worth more than years of skipping coffees. It can also be a no. Either way, it starts with a meeting.

Here's the bit we didn't know in 2029: in a lot of companies, next year's pay budget is set weeks or months before reviews. We waited politely for March. By then, the jar was already divided.

So this week, don't ask for the money. **Ask for the meeting.** Copy this:

> **Subject:** Twenty minutes to talk about my pay
>
> Hi [Manager],
>
> Thanks again for [one specific recent thing]. Before next year's budgets are set, I'd like to book twenty minutes to talk about my pay and how my role has grown this year.
>
> Would [day] or [day] work? I'll bring a short summary of the year so we can keep it focused.
>
> Thanks,
> [Your name]

Three things it does on purpose:
- **It asks for time, not a number.** The number is for the room, said once, then hush.
- **"Before budgets are set"** explains why now, without pressure.
- **"A short summary"** tells them you'll be prepared, which makes yes easier.

Not sure when budgets are set where you work? Ask HR one question: "When are next year's pay budgets usually decided?" Timing varies a lot.

**If you want the rest of it:** what to say in the room, what to say when they say "there's no budget" or "let's revisit in six months", how to find a number you can defend, and the email after, it's all in *What We Should've Said: The Raise Script Pack*. 14 scripts, the worksheets and six rehearsal audios. {{#if launch_window}}$12 until Sun 15 Nov, then $15.{{else}}$15.{{/if}} [Have a look →]({{pack_link}})

No pressure. The email above is yours either way. Send it.

Pay me first. I'm still here.
**Margot**

<small>Scripts, not promises. What you get depends on your job, your market and your manager.</small>

*RAISE variant (RAISE path, day 1): subject "Did you send it?", preview "The meeting email, and what comes after it." Replace everything from "You can save a percent" down to the end of the quoted email with: "You've the meeting email already. If it isn't sent, send it this week, before next year's budget is set. Not sure when that is? Ask HR one question: 'When are next year's pay budgets usually decided?'" Then carry on from "Three things it does on purpose" as written.*

*Buyer variant (tag `bought_raise`): replace the "If you want the rest of it" paragraph with: "You've the pack already, so: page 13 has the calendar for working out when to send this, and page 17 has the replies for when they answer."*

---

## Email 4 · Day 7 · Proof of usefulness (no story, no testimonials)

**Subject:** "There's no budget." Say this.
**Preview:** One full page from the pack. Use it whether or not you buy it.

Dear you,

No letter from 2075 today. Just something useful. This is a whole page from the Raise Script Pack, word for word, so you can judge it on what it does. (The letters in brackets point to other scripts in the pack; script h is the non-salary asks, script m is the follow-up email.)

---

**Script c: "There's no budget"** (page 19)

**Use when:** they say there's no money, the budget's spent, or "my hands are tied".
**Rule:** 3. No Is a Date.

**Say**
> "Understood. What would need to be true for this to happen, and by when?"
>
> ⏸ **Hush.**

**Then, depending on the answer:**

| They say | You say |
|---|---|
| "Next budget cycle." | "Great. When does that get set? Could we meet two weeks before that, and can we agree now what I'd need to show by then?" |
| "If you hit [target]." | "Let's write that down. If I hit [target] by [date], we'd move to [number]. Can you confirm that in an email after this?" |
| "I don't know." | "That's fair. Could you find out what the options are and come back to me by [date]?" |
| "Nothing, really." | "Thanks for being straight with me. In the meantime, could we look at [non-salary ask: title, training budget, an extra day's leave, remote days]?" (Script h.) |

**Then:** script m (confirm in writing) the same day.

**Don't say:** "Oh, no worries." It's worry-shaped. It's okay to have worries.

**Why it works:** "No budget" is often "not yet" or "not without a reason I can take upstairs". Asking for conditions turns a closed door into a list, and a date turns a list into a plan.

---

**Also free, from the pack: the receipt formula.** Before any ask, write three wins like this: *I [did a specific thing], which [changed a number].* For example: "I rebuilt the rota template, which cut the weekly scheduling job from about 4 hours to 1." (Made up, for shape.) If you can't find a number, count something: hours, tickets, people, weeks covered.

**What the rest of the pack has, so you can decide:**

| Part | What's in it | Pages |
|---|---|---|
| Before | The Raise Ladder, the Five Rules, a 21-Day Countdown, the Receipts Sheet, the Range Worksheet (country notes for the US, UK, Canada, Australia and the EU), a budget-timing calendar, a rehearsal drill | 5–15 |
| During | 14 scripts with "if they say… you say…" branches, and a one-page Objection Bank | 16–31 |
| After | Meeting Log, a 90-day Raise Ledger with an Ask Score, a two-page Slip Page with repair scripts, the Raise Ratchet, your One-Page Plan (the follow-up email is script m, page 29) | 32–37 |
| Bonuses | 6 rehearsal audios, an offer comparison sheet, a pocket card and wallpaper, a giftable card, a monthly brag habit with a calendar file | 38–43 |

44 pages: fillable PDF, editable Google Doc and six MP3s. {{#if launch_window}}$12 until Sun 15 Nov, 11:59 pm US Eastern; $15 after.{{else}}$15.{{/if}} 30-day refund if it isn't useful. [See the pack →]({{pack_link}})

**Margot**

<small>Scripts, not promises. What you get depends on your job, your market and your manager.</small>

*Buyer variant: replace the last two paragraphs with: "That's script c in your pack (page 19). If you've a meeting coming, rehearsal audio 3 practises exactly this one."*

---

## Email 5 · Day 10 · Final offer with a real deadline

**Subject (Launch block):** The $12 price ends Sunday night
**Subject (Welcome block):** Your $12 code ends in 72 hours
**Subject (Standard block):** The last letter of this batch
**Preview:** Then it's $15. Plus: the first clue, and a letter about January. (Standard block preview: The scripts, the first clue, and a letter about January.)

Dear you,

Last letter of this batch, and a short one.

If you've a pay conversation anywhere in the next few months (a review, an offer, a "great year" chat in the corridor), the Raise Script Pack is the preparation I'd want you to have. Receipts, a number you can defend, the words for the room, and the email after.

**What you get:** 14 scripts with replies for the common answers, the Receipts and Range worksheets, six rehearsal audios, the Objection Bank, a Meeting Log, a Raise Ledger, the Slip Page, and five bonuses. 44 pages, PDF and Google Doc.

**Launch block:**
> **The launch price is $12 until Sun 15 Nov, 11:59 pm US Eastern.** After that it's $15, and it won't be discounted for Black Friday or Cyber Monday. [Get the scripts · $12 →]({{pack_link_launch}})

**Welcome block:**
> **Your code `{{personal_code}}` takes it to $12 until {{expiry_local}}.** It's yours only, it works once, and after that time it stops working and the pack is $15, same as everyone. [Get the scripts · $12 →]({{pack_link_with_code}})

**Standard block** (this address has already had a welcome code, see the one-code rule):
> **The pack is $15.** [Get the scripts · $15 →]({{pack_link}})

30-day refund if it isn't useful: reply to the receipt. No forms.

And if now isn't the time, that's grand. Keep the meeting email from my last-but-one letter. Send it before the budget locks.

I'm not cross. I'm just older.

Pay me first. I'm still here.
**Margot**

P.S. **Who We Marry**, the thing everyone asks. {{#if before_clue_1}}The Office lets me send you one clue a month. The first comes through the tube on Saturday the 14th of November. I won't confirm anything. Desmond's watching.{{else}}This month's clue: *{{latest_clue}}*. I won't confirm anything. Desmond's watching.{{/if}}

P.P.S. In January I'm running **Pay Old Me First: The 30-Day System**, a daily letter with a 3–10 minute task, starting Mon 4 Jan. [Join the waitlist →]({{waitlist_link}}) (One line. That's all the selling it gets today.)

<small>Scripts, not promises. What you get depends on your job, your market and your manager.</small>

**Buyer version of email 5**
**Subject:** One clue, and January
**Preview:** No selling. Well, one line.

Dear you,

You've the pack, so here's the only nudge you need: if your meeting's booked, do the full run-through on page 15 the night before, ten-second hush and all. If it isn't booked, page 17 is waiting.

P.S. and P.P.S. as above (Who We Marry clue; Pay Old Me First waitlist).

Pay me first. I'm still here.
**Margot**

---

## Sequence QA checklist (automated, before Sun 1 Nov)
- [ ] Send each email to seed inboxes (Gmail, Outlook, Apple Mail) in both Launch and Welcome modes, and as a buyer
- [ ] Email 3 send-time hold verified: a test contact created on Sat 31 Oct receives email 3 no earlier than Thu 5 Nov, 9:00 am US Eastern
- [ ] Welcome-block code created with `max_redemptions` 1 and `expires_at` exactly 72 h after send; checkout rejects it one minute after expiry
- [ ] `LAUNCH` code rejected after 2026-11-16T04:59:00Z
- [ ] One-code rule: the same address (also with different case, spaces or a `+tag`) unsubscribed, resubscribed and re-entered through the calculator and through RAISE never gets a second code; Email 5 sends the Standard block instead, and `welcome_codes` holds exactly one row for the hash
- [ ] Issuance log row written for every code; the daily duplicate check alerts on a seeded duplicate
- [ ] RAISE path: a `raise` contact skips Emails 1 and 2, gets the Email 3 RAISE variant on day 1 (or at the 5 Nov hold), and never receives the meeting email twice
- [ ] Branch: a `pay_later` click swaps in the Not-yet line in Emails 3 and 4, suppresses Email 5, and re-enters once at 90 days
- [ ] Email 4's script c block matches page 19 of the rendered PDF character for character (automated diff)
- [ ] Clue logic: `before_clue_1` true until Sat 14 Nov 2026; `latest_clue` pulls from the lore table after that
- [ ] Compliance Gate phrase check passes on all five (no "guaranteed", no outcome claims, no lore beside a sum or the offer, no adviser/expert wording)
- [ ] Unsubscribe and postal address present in every footer
