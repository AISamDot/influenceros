# Welcome Sequence · The Drawer Audit (DRAWER) → The Attic Audit

<!--
PRODUCTION NOTES (not rendered)
- Trigger: double opt-in confirmed after the subscriber ticks the (unticked by default) consent box on the DRAWER opt-in page (bible §13). Nothing is sent without it.
- Sender name: "Walt · What It Sold For". Reply-to: the studio inbox handled by the Community worker (automated replies only; "refund", "STOP" and "unsubscribe" are parsed automatically).
- Schedule (subscriber's local time, 07:30): Email 1 immediately · Email 2 day 2 · Email 3 day 4 · Email 4 day 6 · Email 5 day 8.
- Buyers are suppressed: anyone who buys the Attic Audit stops receiving emails 3–5 and moves to the buyer onboarding flow.
- Dynamic tokens (filled by the email platform, no human step):
  {{FIRST_NAME|there}} · {{DRAWER_PDF_URL}} · {{ATTIC_AUDIT_URL}} · {{CURRENT_PRICE}} ($12 until Mon 30 Nov 2026 23:59 ET, then $17) · {{UNSUBSCRIBE_URL}} · {{STUDIO_POSTAL_ADDRESS}}
- Price lines: emails 3 and 4 print {{CURRENT_PRICE}} at send time. Any email sent on or before 30 Nov also prints the early-bird line; any email sent from 1 Dec prints $17 only. Never a strike-through, never a countdown timer.
- Email 5 has three variants. The platform picks the one whose deadline is real at the send moment, measured in US Eastern time (not the subscriber's local date, so a subscriber in Sydney can't get "no deadline" while sign-up is still open):
  A: send moment up to Mon 30 Nov 2026, 23:59 ET → early-bird deadline.
  B: send moment from Tue 1 Dec 2026, 00:00 ET to Sun 10 Jan 2027, 23:59 ET → January group-start deadline (Sun 10 Jan 2027, 23:59 ET). The automation really closes the group list at that minute; later buyers go at their own pace. A Variant B sent on Sun 10 Jan still has a real deadline that night.
  C: send moment from Mon 11 Jan 2027, 00:00 ET on → no deadline. Says so.
- Cheat-sheet counts: Email 1 describes the cheat sheet without a number, because the lead magnet's render gate can drop unconfirmed categories. If a count is ever added, it must come from {{CHEAT_SHEET_SELL_COUNT}} / {{CHEAT_SHEET_FRACTION_COUNT}}, passed from the same gated render, never typed.
- Bundle: no email mentions the Sticker Draft Playbook bundle until the bundle gate in listing-pack.md passes.
- Compliance: no income or dollar-outcome claims; no testimonials, community totals or "people like you made $X"; no lore used as proof (emails are story-free by design); AI-character line in every footer; CAN-SPAM postal address and one-click unsubscribe in every footer; UK/EU consent captured at opt-in.
- Voice: Walt. Short declarative sentences. "bud" at most once per email. No "boss", "kid", "hon".
-->

---

## Email 1 · Delivers the lead magnet (immediately)

**Subject:** Your Drawer Audit (one drawer, 15 minutes)
**Preview:** Three piles. One keep. Start with the junk drawer.

Hi {{FIRST_NAME|there}},

Here it is: **[Download the Drawer Audit]({{DRAWER_PDF_URL}})**

Three pages:

1. **The 15-Minute Drawer Audit.** One drawer, three piles (SELL, GIVE, GONE), one thing you keep.
2. **The Tag Card worksheet.** How to find what anything actually *sold* for, in about five minutes.
3. **The Real-Worth Cheat Sheet.** The categories that usually sell, and the ones that usually sell for a fraction of what they cost, each checked against cited public sales. Tendencies, not prices. Check your exact item.

Here's all I'd ask today. Pick one drawer. The junk drawer, if you've got one. Everybody's got one.

Set a timer for fifteen minutes. Tip it out onto a towel. Pick each thing up once and put it on a pile. Then pick one thing to keep, the one with a story, and write down why.

That's it. You're not cleaning the house today. You're doing one drawer.

In two days I'll send you the one rule that changes how you look at every price you've ever seen online.

Walt

P.S. When something in the drawer goes in GONE, keep batteries and old electronics out of the kitchen bin. They need their own drop-off.

---
*You're getting this because you asked for the Drawer Audit and said yes to emails. [Unsubscribe]({{UNSUBSCRIBE_URL}}) any time, one click.*
*Walt is an AI character made by a small studio. The method and the sources are real; the stories are fiction. Price checks, not appraisals.*
*{{STUDIO_POSTAL_ADDRESS}}*

---

## Email 2 · Value (day 2)

**Subject:** Paid's a story. Sold's a fact.
**Preview:** Most prices you see online are wishes. Here's how to find the real one.

Hi {{FIRST_NAME|there}},

Most "it's worth $300" you see online is somebody *asking* $300. Asking is free. The market is what somebody actually paid.

So here's the rule: **only completed sales count.** I call it Sold, Not Listed.

**How to check one thing, right now (five minutes):**

1. **Name it exactly.** Maker, model, size, colour, condition. "Blue bowl" finds nothing useful. Maker, pattern and size find yours.
2. **Turn on the sold filter.** On eBay, search the item, then tick "Sold items" (on the app: Filter, then "Sold items"). Sold prices show in green. You don't have to sell there to look.
3. **Take the middle sale.** Line up the sold prices for the same thing in the same condition. Skip bundles. Skip the one crazy-high sale. Take the one in the middle. Fewer than 10 sales? Write "thin" and use the range.
4. **Subtract what it costs to sell.** Fees (look them up on the platform's own fee page; they change), shipping, the box. What's left is **POCKET**. That's the honest number.

**Three traps to watch for:**

- **The one big sale.** "One sold for $500!" One sale isn't a price.
- **The wrong condition.** That one was new in the box. Yours has been in a drawer since 2014.
- **What you paid.** It doesn't matter to the buyer. Paid's a story. Sold's a fact.

Try it on one thing from your SELL pile today. Write the three numbers on page 2 of the Drawer Audit: PAID, WORTH, POCKET.

Some numbers will sting. That's normal. Most things lose most of their value the minute they come home. Knowing beats guessing.

Walt

---
*You're getting this because you asked for the Drawer Audit and said yes to emails. [Unsubscribe]({{UNSUBSCRIBE_URL}}) any time, one click.*
*Walt is an AI character made by a small studio. The method and the sources are real; the stories are fiction. Price checks, not appraisals.*
*{{STUDIO_POSTAL_ADDRESS}}*

---

## Email 3 · Value + soft offer (day 4)

**Subject:** If it sells for under ten bucks, it's not a listing
**Preview:** It's a chore. Here's the rule that decides in seconds.

Hi {{FIRST_NAME|there}},

You found the POCKET number for something. Maybe it was $40. Maybe it was $4.

Here's what to do with it.

**The Ten-Dollar Floor.** If POCKET is under $10 (about £8, C$14, A$15), don't list it.

Listing isn't free. Photos. A description. Three messages from somebody who disappears. The box, the tape, the line at the post office. That's an hour of your life. Under ten bucks, give it to somebody who'll use it, and keep your evening.

Over the floor? It's a listing. Price it at the middle sale. Not the best day ever. An ordinary Tuesday.

**And one more rule, so nothing sits forever: the 14-Day Drop.** No sale in 14 days, drop the price 20%. No sale at 28 days, it goes to GIVE. You don't have to stand there arguing with a lamp. The rule decides.

Two rules. They'll clear more of a house than any amount of willpower.

The rules are yours, free. What turns them into an empty garage is doing them in order for a month, and that's what the workbook is for. **The Attic Audit** is 30 days, about 20 to 40 minutes a day. What's in it that isn't in anything I've sent you:

- **A 30-day tick tracker.** One job a day, so you never sit there wondering where to start.
- **The POCKET worksheet.** Fees, shipping, packing and travel, item by item, so the floor decision takes seconds.
- **The Sold Log spreadsheet.** Type in the sold prices you find; it works out the middle sale, flags thin markets, applies your floor and sets each listing's Day 14 and Day 28 dates.
- **Four weekly scorecards and a measurement loop.** If this, then change that. One thing at a time.
- **The clear-out pages.** E-waste, batteries, medicines, recall checks before you sell or donate, bulk pickup, and tax notes for the US, UK, Canada and Australia.
- **The Seven-Day Sprint**, for when the moving truck's already booked.

It's {{CURRENT_PRICE}}. [Have a look here]({{ATTIC_AUDIT_URL}}) if you're interested. If not, the two rules above are yours either way.

Walt

---
*You're getting this because you asked for the Drawer Audit and said yes to emails. [Unsubscribe]({{UNSUBSCRIBE_URL}}) any time, one click.*
*Walt is an AI character made by a small studio. The method and the sources are real; the stories are fiction. Price checks, not appraisals. What you get back depends on what you own and your market. Nobody honest can promise a number.*
*{{STUDIO_POSTAL_ADDRESS}}*

---

## Email 4 · Story-free proof of usefulness (day 6)

**Subject:** Two pages from the workbook (use them today)
**Preview:** Where to sell anything, and the 8 scams to know before you do.

Hi {{FIRST_NAME|there}},

No stories today. Instead, two pages straight out of the Attic Audit, so you can see exactly what's in it and use them right now.

**Page 18: Where to sell (stop at the first "yes")**

1. **Big, heavy, fragile or awkward to box?** Sell locally. Porch pickup or a public spot.
2. **Something only a few people hunt for** (cameras, tools, records, parts, a china pattern)? Sell where buyers search nationally.
3. **Clothing, shoes or accessories?** A clothing resale app that works in your country, or consignment.
4. **Might it be worth a lot, or you're not sure what it is?** A local auction house or a qualified appraiser first. Don't list it at a guess.
5. **A pile of low-value things that go together?** One lot, locally. Or GIVE.
6. **Want zero hassle?** Consignment, or a buyout for a whole roomful.
7. **None of these?** A big general marketplace if it ships, local if it doesn't.

**Page 23: The 8 scams to know**

1. **Overpayment.** "I sent too much, refund the difference." Real buyers don't overpay. Cancel.
2. **Fake payment proof.** A screenshot or a "payment pending" email. Trust only what you see in your own account.
3. **"My courier will collect."** Decline.
4. **QR-code payment.** You never need to scan a code to *receive* money.
5. **The verification code.** "Send me the code I texted you." Never. It's how they take over your account.
6. **The shipping-label "favor."** Ship only to the order address, with a label bought through the platform.
7. **"Let's move off the app."** Stay on the platform. You lose its protection the moment you leave.
8. **The phishing link.** "Click to accept payment." Don't. Open the app yourself.

**Everything else in the book, page by page:**

- The Nine Rules on one tear-out page, and a 30-day tick tracker
- Week 1: the Keep Box, five zone checklists, the "Is it mine?" script for things that belong to someone else, a safety page
- Week 2: the five facts to name anything, the paper Sold Log, six ways people fool themselves on price, thin-market rules, the POCKET worksheet, furniture and the knock test, the Floor sort
- Week 3: the channel chooser, questions to ask any consignor, the six-angle photo guide, the title formula and description template, the Daily Ship Check so nothing ships late, the Porch Rule, eleven copy-and-paste buyer replies
- Week 4: call-first donation script, what charities usually refuse, e-waste, batteries, paint and medicines, bulk pickup, things it's illegal to sell, the 14-Day Drop calculator
- Four weekly scorecards, a final scorecard and a measurement loop that tells you what to change
- The Slip Page: twelve ways people fall off, and what to do today
- Tax notes (US, UK, Canada, Australia; general information with the official links)
- Bonuses: the Sold Log spreadsheet, printable tags and pile signs, four 90-second audio pep talks, eight listing templates, the Bread-Maker wallet card and 30 no-buy squares, the Seven-Day Sprint for a move, the Drawer Audit and cheat sheet built in, and the January group start (a weekly email with that week's focus sheet, a calendar file and a scorecard prompt)

It's {{CURRENT_PRICE}}: **[The Attic Audit]({{ATTIC_AUDIT_URL}})**. 30-day refund if it isn't useful.

Walt

---
*You're getting this because you asked for the Drawer Audit and said yes to emails. [Unsubscribe]({{UNSUBSCRIBE_URL}}) any time, one click.*
*Walt is an AI character made by a small studio. Price checks, not appraisals. What you get back depends on what you own and your market. Nobody honest can promise a number.*
*{{STUDIO_POSTAL_ADDRESS}}*

---

## Email 5 · Final offer with a real deadline (day 8)

### Variant A · sent on or before Mon 30 Nov 2026

**Subject:** $12 ends Monday 30 November
**Preview:** The Attic Audit goes to $17 on 1 December. Here's the plain version.

Hi {{FIRST_NAME|there}},

Last email about this. Plain version.

**The Attic Audit is $12 until Monday 30 November at 11:59 pm Eastern** (4:59 am GMT on Tuesday). From 1 December it's $17, and it stays $17. The $12 price doesn't come back.

What it is: 30 days, about 20 to 40 minutes a day.

- **Week 1, FIND.** One zone a day, three piles, one Keep Box.
- **Week 2, PRICE.** What your things actually sold for, and what you'd keep after fees.
- **Week 3, LIST.** Only what clears the floor. Photos, titles, buyer scripts, the eight scams.
- **Week 4, CLEAR.** Donations, e-waste, bulk pickup, and the things you can't sell.

Plus the spreadsheet, the tags, four short audio pep talks, the Slip Page for when you fall behind, and the January group start.

What it won't do is promise you money. What you get back depends on what you own and your market. You might finish with a few good sales. You might finish with a clear garage and a trunk full of donations. Both count.

**[Start the Attic Audit · $12]({{ATTIC_AUDIT_URL}})**

30-day refund: reply "refund" to your receipt. No forms.

If it's not for you, no hard feelings, bud. You've got the Drawer Audit and the rules. Go do another drawer.

Keep the story. Sell the stuff. Spend it on the people.

Walt

---
*You're getting this because you asked for the Drawer Audit and said yes to emails. [Unsubscribe]({{UNSUBSCRIBE_URL}}) any time, one click.*
*Walt is an AI character made by a small studio. Price checks, not appraisals. No dollar outcome is promised or implied.*
*{{STUDIO_POSTAL_ADDRESS}}*

### Variant B · sent Tue 1 Dec 2026 to Sun 10 Jan 2027 (23:59 ET)

**Subject:** The group starts Monday 11 January
**Preview:** Do the 30 days alongside everyone else. Sign-up closes Sunday 10 January.

Hi {{FIRST_NAME|there}},

Last email about this. Plain version.

**The Attic Audit is $17.** Buy it any time and go at your own pace.

If you'd rather do it alongside other people, there's a **group start on Monday 11 January 2027**. Same book, same 30 days, on one shared calendar. Each Monday an automated email brings that week's one-page focus sheet with the real dates filled in, a calendar file that puts the week's seven appointments in your phone, and the week's scorecard prompt. It's a light-touch extra, not coaching.

**To be in that group, get it by Sunday 10 January at 11:59 pm Eastern** (4:59 am GMT on Monday). The group list closes then. After that you can still buy the book; you just won't be in that group.

What it is: 30 days, about 20 to 40 minutes a day.

- **Week 1, FIND.** One zone a day, three piles, one Keep Box.
- **Week 2, PRICE.** What your things actually sold for, and what you'd keep after fees.
- **Week 3, LIST.** Only what clears the floor. Photos, titles, buyer scripts, the eight scams.
- **Week 4, CLEAR.** Donations, e-waste, bulk pickup, and the things you can't sell.

What it won't do is promise you money. What you get back depends on what you own and your market.

**[Start the Attic Audit · $17]({{ATTIC_AUDIT_URL}})**

30-day refund: reply "refund" to your receipt. No forms.

If it's not for you, no hard feelings, bud. Go do another drawer.

Walt

---
*You're getting this because you asked for the Drawer Audit and said yes to emails. [Unsubscribe]({{UNSUBSCRIBE_URL}}) any time, one click.*
*Walt is an AI character made by a small studio. Price checks, not appraisals. No dollar outcome is promised or implied.*
*{{STUDIO_POSTAL_ADDRESS}}*

### Variant C · sent from Mon 11 Jan 2027 (00:00 ET)

**Subject:** Last one about the Attic Audit (no deadline)
**Preview:** There isn't one, and I won't make one up.

Hi {{FIRST_NAME|there}},

Last email about this, and there's no deadline on it. There isn't one, so I won't invent one.

**The Attic Audit is $17.** Thirty days, about 20 to 40 minutes a day: find it, price it off what it actually sold for, list what's worth listing, clear the rest properly. Worksheets, trackers, buyer scripts, a spreadsheet that does the maths, and a Slip Page for the days you fall behind.

It won't promise you money. What you get back depends on what you own and your market.

**[Start the Attic Audit · $17]({{ATTIC_AUDIT_URL}})**

30-day refund: reply "refund" to your receipt. No forms.

Either way, bud, go do another drawer.

Walt

---
*You're getting this because you asked for the Drawer Audit and said yes to emails. [Unsubscribe]({{UNSUBSCRIBE_URL}}) any time, one click.*
*Walt is an AI character made by a small studio. Price checks, not appraisals. No dollar outcome is promised or implied.*
*{{STUDIO_POSTAL_ADDRESS}}*
