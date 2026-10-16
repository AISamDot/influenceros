---
sequence: "Below Stairs" welcome sequence
persona: ambrose
trigger: opt-in for the free Gift Ledger + Holiday Tipping Card (keyword LEDGER, or the PLAN/BOOK DM, which also delivers the ledger)
live: Sun 1 Nov 2026 to Fri 1 Jan 2027 (from Sat 2 Jan the lead magnet switches to The Butler's Count; this sequence stops enrolling)
schedule: Email 1 at D0 (immediately) · Email 2 at D1 · Email 3 at D2 · Email 4 at D3 · Email 5 at D5. Send time 7:30 am in the subscriber's time zone (fallback 7:30 am ET).
from: Ambrose Hale <{{sender_address}}>
merge_tags: {{first_name|there}}, {{gift_ledger_download_url}}, {{gift_ledger_sheet_copy_url}}, {{holiday_plan_url}}, {{butlers_book_waitlist_url}}, {{butlers_book_url}}, {{business_address}}, {{unsubscribe_url}}, {{window_block_E3}}, {{window_block_E5}}. The send fails closed: an email with any unfilled {{...}} after merge is held and alerted, never sent (build-spec.md, Gate G1).
suppression: anyone who buys The Butler's Holiday Plan leaves the sequence at once and gets the buyer onboarding instead; Emails 3–5 never send to buyers
compliance: no results, savings or testimonials claimed; no lore used as a reason to buy or as proof (Email 2 leads with the five steps; its story is labelled colour, states no outcome and carries no offer; the offers in Emails 3 and 5 name the process only); every deadline is a real date chosen automatically from the send date (table below); AI character disclosed in every footer; CAN-SPAM/PECR footer with address and one-click unsubscribe
---

# The "Below Stairs" Sequence

## How the deadlines are chosen (fully automated)

Emails 3 and 5 contain one merge block each. The email platform picks the block by **the date the email is sent**, so every deadline a subscriber reads is real on the day they read it. No block ever invents a deadline.

| Window | Send date (ET) | {{window_block_E3}} (soft offer) | {{window_block_E5}} (final offer, real deadline) |
|---|---|---|---|
| **A** | Sun 1 Nov – Thu 12 Nov | Block E3-A | Block E5-A: early-bird ends **Thu 12 Nov, 11:59 pm ET** |
| **B** | Fri 13 Nov – Thu 3 Dec | Block E3-B | Block E5-B: the Christmas clock starts **Fri 4 Dec** |
| **C** | Fri 4 Dec – Fri 18 Dec | Block E3-C | Block E5-C: **Fri 18 Dec** is T-7, the last day with a full week on the Christmas clock |
| **D** | Sat 19 Dec – Tue 5 Jan | Block E3-D | Block E5-D: The Butler's Book opens **Wed 6 Jan**; founders' price ends **Sun 31 Jan 2027, 11:59 pm ET** (waitlist link) |
| **E** | Wed 6 Jan – Thu 7 Jan | Block E3-D (Email 3 can't fall here: enrolment stops Fri 1 Jan, so its last send is Sun 3 Jan) | Block E5-E: The Butler's Book is open; founders' price ends **Sun 31 Jan 2027, 11:59 pm ET** (live link) |

*Note for window A: Email 1 cannot go out before Sun 1 Nov and the Plan goes on sale Thu 5 Nov. If Email 3 or 5 would send before Thu 5 Nov at 12:30 pm ET, the platform holds it until Thu 5 Nov at 12:30 pm ET.*

## Footer (every email)

> Ambrose Hale is an AI character, made up, gloves and all. The stories are composites; the methods are real, and yours to test. Nothing here is financial, tax or legal advice.
> You're receiving this because you asked for the Gift Ledger. {{business_address}} · [Unsubscribe in one click]({{unsubscribe_url}})

---

## Email 1 · D0 · The ledger

**Subject:** Your Gift Ledger, as promised
**Preview:** Three sittings, fifteen minutes each. Start with the drawer.

**Body:**

Very good, {{first_name|there}}. Here it is.

**[Download the Gift Ledger + Holiday Tipping Card]({{gift_ledger_download_url}})**
**[Make your own copy of the Google Sheet]({{gift_ledger_sheet_copy_url}})**

A gift season goes wrong in one of three ways: you buy what you already own, you spend without a ceiling, or you forget someone who carried your bins (trash) out all year. The ledger closes all three doors, in three sittings of fifteen minutes.

**Sitting 1: the Gift Drawer Count.** Empty the drawer, the cupboard under the stairs and the top of the wardrobe onto one table, and count. Unopened gifts, candles, cards, wrap, tape, stamps. Write down only the gap. That's your whole supplies list.

**Sitting 2: the ledger.** Decide the season's total first. Then every name gets a ceiling, in ink, and the ceilings add up to the total or less. Every idea must pass the Three-Gift Test: they'll **use** it, **eat** it, or **keep** it ten years. If it passes none, it's clutter with a bow on it.

**Sitting 3: the Tipping Card.** Nine people who serve you by hand all year, with typical guidance for each and the one actual rule (US mail carriers: a non-cash gift worth $20 or less, never cash). Done by 15 December.

Do sitting one this week. Before you buy a single thing.

Tomorrow: the five-step count to do before you buy anything else this season.

Very good. Now, about your spending.

**Ambrose Hale**

P.S. The last column of the ledger is "Thanked". A gift isn't finished until the thank-you is.

---

## Email 2 · D1 · Value: the count

**Subject:** Count before you buy
**Preview:** Five steps, before any "holiday deal" email gets to you.

**Body:**

{{first_name|there}}, before you buy a single thing this season (glasses, napkins, chairs, wrapping paper, candles), count.

The method is called **Inventory Before Purchase**, and it's five steps:

1. **Count** every one you own.
2. **Mark** each one: good, mendable, or gone.
3. **Set the par**: how many the house actually needs. For a gathering, that's guests plus two.
4. **Find the gap**: par, minus good, minus mendable. That's the only number you may buy.
5. **Buy the gap once, properly**, or borrow it.

Why it holds: you decide the number at the kitchen table, so the shop never gets to suggest one.

Try it today on one category. Glasses are a good start: they're easy to count and easy to over-buy.

A little colour, since you've read this far. In the houses of my stories (composites, as all of them are), the glasses were counted every January, each one held up to the window and marked good, chipped or gone. It's a pleasing ritual, and that's all it is here: the five steps above are the part to test in your own house.

If you haven't done page one of your ledger yet, the Gift Drawer Count is exactly this method, for gifts and supplies. **[Your ledger is here]({{gift_ledger_download_url}})**.

Tomorrow: the number to write down before you choose a single dish.

Very good. Now, about your spending.

**Ambrose Hale**

---

## Email 3 · D2 · Value + soft offer: the Per-Plate Number

**Subject:** The number before the menu
**Preview:** Budget ÷ guests. Then, and only then, the menu.

**Body:**

{{first_name|there}}, most hosts choose the menu and meet the cost at the till.

Try it the other way round. Before you choose a single dish, write one number: **the Per-Plate Number.**

**Total you're willing to spend on food, drink and the table ÷ guests, host included.**

Then split it. A starting split (move it to suit your menu, as long as it adds up to 100):

| Share | Starting % |
|---|---|
| The one showpiece | 35% |
| Sides and bread | 25% |
| Nibbles or a starter (appetizers) | 10% |
| Pudding (dessert) | 10% |
| Drinks, including the non-alcoholic option and ice | 15% |
| The table: candles, napkins, greenery | 5% |

An illustration of the arithmetic, not a prediction: ten people and $150 is **$15 a plate**, so the showpiece has $52.50 to work with and the drinks $22.50. If a guest brings a side, that line comes back to you.

Two rules make the number hold:

- **One showpiece.** Only one dish may be difficult (or dear). Everything else is made ahead or bought well.
- **Assign dishes, not dollars.** Never send a guest an invoice. Ask for one specific dish: "the green beans, for ten."

If the menu doesn't fit the number, change the menu, not the number.

{{window_block_E3}}

Very good. Now, about your spending.

**Ambrose Hale**

### Block E3-A (send date Sun 1 Nov – Thu 12 Nov)

> If you'd like the whole clock: **The Butler's Holiday Plan** puts this calculator on page twelve, with a spend log beside it, a twenty-one-day clock already dated for Thanksgiving and Christmas, and the scripts for every awkward guest. Fifteen minutes a day. $15, with a 14-day refund. Until Thursday 12 November, 11:59 pm ET, the Table Pack (place cards, menu cards, a laying poster) comes with it. **[Have a look]({{holiday_plan_url}})**. No need to decide today.

### Block E3-B (Fri 13 Nov – Thu 3 Dec)

> If you'd like the whole clock: **The Butler's Holiday Plan** puts this calculator on page twelve, with a spend log beside it, a twenty-one-day clock dated for Thanksgiving and Christmas, a Late-Start Rescue if Thanksgiving is closer than you'd like, and the scripts for every awkward guest. $15, with a 14-day refund. **[Have a look]({{holiday_plan_url}})**. No need to decide today.

### Block E3-C (Fri 4 Dec – Fri 18 Dec)

> If you'd like the whole clock: **The Butler's Holiday Plan** puts this calculator on page twelve, with a spend log, the Christmas clock dated day by day to Friday 25 December, a Late-Start Rescue for anyone joining it late, and the scripts for every awkward guest. $15, with a 14-day refund. **[Have a look]({{holiday_plan_url}})**. No need to decide today.

### Block E3-D (Sat 19 Dec – Thu 7 Jan)

> If you've a gathering still to come (New Year's, a birthday, a first dinner party in the spring), **The Butler's Holiday Plan** has a blank clock for any date, with this calculator, the spend log and every script. $15, with a 14-day refund. **[Have a look]({{holiday_plan_url}})**. No need to decide today.

---

## Email 4 · D3 · Proof of usefulness (no story)

**Subject:** Three pages, so you can judge for yourself
**Preview:** The first week of the clock, the sum, and a script. Use them as they are.

**Body:**

{{first_name|there}}, no stories today. Just three pages from **The Butler's Holiday Plan**, so you can judge whether it's useful before anyone asks you to buy anything. Use them as they are; they work on their own.

**1 · The first week of the clock (the decisions)**

Paper only in week one. You buy nothing until day five before. The decisions are what make the shopping short.

| Day | Fifteen minutes | Write down |
|---|---|---|
| T-21 | Fill in the gathering at a glance; write the guest list (count yourself) | Guests: ___ |
| T-20 | Set the Per-Plate Number | Per plate: $___ |
| T-19 | Count chairs, plates, glasses, napkins, serving dishes: good, mendable, gone | Chairs short: ___ |
| T-18 | Choose one showpiece, then a make-ahead menu around it | Dishes: ___ |
| T-17 | Draft the oven timetable: which dish needs the oven, when | Oven dishes in the last hour: ___ |
| T-16 | Set the gift total and a ceiling per name | Gift total: $___ |
| T-15 | Write the Staff & Service list; count the week's ticks | Ticks: ___ / 7 |

**2 · The drinks sum (for buying, not a target for drinking)**

A 750 ml bottle pours about five 150 ml glasses. Plan about two drinks per guest who drinks for the first hour, then one per hour after. **Drinks per drinking guest = 2 + (hours − 1). Bottles = total drinks ÷ 5, rounded up.** Plan the non-alcoholic drink with the same care, and put it first on the table. Ice: about 1 lb (0.5 kg) per guest.

**3 · The late-guest script**

The table waits fifteen minutes for a late guest, never longer. Then a text:

> "No rush at all. We're sitting down now and I'm keeping you a plate."

And when they arrive: "There you are. Sit, sit; your plate's warm." Never mention the time again.

The full plan has twenty-five dated tasks like the first seven, eleven House Rules, the table at three levels, twenty-plus scripts, a page for when you slip, a seven-day Reckoning to see where the time and money went, a Google Sheet that does the sums, and five short audio Briefings. **[The full contents are here]({{holiday_plan_url}})**, page by page.

Very good. Now, about your spending.

**Ambrose Hale**

P.S. Hosting your first one? Do T-21 today, even without the plan. The guest list, counted with you in it, is the start of everything.

---

## Email 5 · D5 · The Guest Brief (free) + final offer with a real deadline

**Subject:** The six-line message that gets guests there on time
**Preview:** Send it 48 hours before. Copy it now.

**Body:**

{{first_name|there}}, one more thing for free, because it does more for an evening than any centrepiece.

**The Guest Brief.** Six lines, sent forty-eight hours before the gathering. A guest who knows what to expect relaxes before they arrive.

> **Thursday, all set!**
> **Time:** 3 pm for 3:30. We'll sit down at 4:00 sharp.
> **Door:** the side door by the bins; ring once.
> **Dress:** whatever you'd wear to a friend's on a Sunday. It's warm inside.
> **Parking:** on the street past the post box; the drive is for Gran.
> **Bring:** your [beans, for ten] in its own dish. Nothing else, truly.
> **Ends:** tea and coffee at 7:30; we'll wrap up around 8.

Copy it into your phone now, change the details, and set a reminder for two days before. The last line is the one most hosts leave out, and it's the kindest: everyone knows when the evening ends, so nobody has to engineer a departure.

{{window_block_E5}}

Either way, keep the ledger going: Bought, Wrapped, Sent, **Thanked**.

Very good. Now, about your spending.

**Ambrose Hale**

### Block E5-A (send date Sun 1 Nov – Thu 12 Nov)

> **The Butler's Holiday Plan** has this brief on page twenty-two, with the invitation, the RSVP chase, the one-week note and the late version for anyone starting short of time. Around it: the twenty-one-day clock, the sums, the table and the close. Fifteen minutes a day. $15.
>
> **The real deadline:** until **Thursday 12 November, 11:59 pm ET**, the Table Pack (place cards and menu cards in three styles, a table-laying poster and a napkin-fold card) comes with the Plan. From Friday 13 November the Plan is still $15, and the Table Pack is $7 on its own. That date is T-14 to Thanksgiving: the day the plan sends the invitations.
>
> **[Start the clock · $15]({{holiday_plan_url}})** · Refunds within 14 days, by replying to your receipt.

### Block E5-B (Fri 13 Nov – Thu 3 Dec)

> **The Butler's Holiday Plan** has this brief on page twenty-two, with the invitation, the RSVP chase, the one-week note and the late version for anyone starting short of time. Around it: the twenty-one-day clock, the sums, the table and the close. $15. The price doesn't change.
>
> **The real date:** the Christmas clock starts on **Friday 4 December** (twenty-one days before the 25th). Order by **Thursday 3 December, 11:59 pm ET** and you start on day one of the clock with nothing to catch up. After that you can still join it; the Late-Start Rescue shows you how.
>
> **[Start the clock · $15]({{holiday_plan_url}})** · Refunds within 14 days, by replying to your receipt.

### Block E5-C (Fri 4 Dec – Fri 18 Dec)

> **The Butler's Holiday Plan** has this brief on page twenty-two, with the invitation, the RSVP chase and the late version. Around it: the Christmas clock dated day by day, the sums, the table and the close. $15. The price doesn't change.
>
> **The real date:** **Friday 18 December** is T-7, the last day the Christmas clock still has a full week to run. Join by then and the Late-Start Rescue (page seven) turns the remaining days into a plan that fits. After the 18th, it's still useful for New Year's and any gathering, but it won't give you a full Christmas week.
>
> **[Start the clock · $15]({{holiday_plan_url}})** · Refunds within 14 days, by replying to your receipt.

### Block E5-D (Sat 19 Dec – Tue 5 Jan)

> This brief, and everything around it, is in **The Butler's Holiday Plan** ($15) if you've a gathering still to come. Its blank clock fits any date.
>
> But the season's nearly done, so here's what comes next. **The Butler's Book** opens on **Wednesday 6 January**: the Seven House Accounts and a calendar of the year's irregular costs, the Butler's Count, the Standing Orders and thirty days of fifteen-minute tasks to turn the house. Your cooking, your saving and your investing stay your own business; this is the household's calendar.
>
> **The real deadline:** the founders' price is **$29 until Sunday 31 January 2027, 11:59 pm ET**, then it's $35.
>
> **[Join the waitlist: free, and you'll get the link on 6 January]({{butlers_book_waitlist_url}})**

### Block E5-E (Wed 6 Jan – Thu 7 Jan)

> This brief, and everything around it, is in **The Butler's Holiday Plan** ($15) if you've a gathering still to come. Its blank clock fits any date.
>
> And as of Wednesday, **The Butler's Book is open**: the Seven House Accounts and a calendar of the year's irregular costs, the Butler's Count, the Standing Orders and thirty days of fifteen-minute tasks to turn the house, starting on Monday 11 January. Your cooking, your saving and your investing stay your own business; this is the household's calendar.
>
> **The real deadline:** the founders' price is **$29 until Sunday 31 January 2027, 11:59 pm ET**, then it's $35.
>
> **[Open the Book · $29 founders' price]({{butlers_book_url}})** · Refunds within 14 days, by replying to your receipt.

## How the dated offers are enforced (fully automated, no manual steps)

Lemon Squeezy can't schedule a product or variant to end, and its products and variants API is read-only, so no deadline here depends on one. Each is enforced three ways by the studio worker:

| Offer | What makes it real | Scheduled job (UTC) | Self-check after the job |
|---|---|---|---|
| **Table Pack free with the Plan** (until Thu 12 Nov, 11:59 pm ET) | The Plan is one $15 variant all season. The worker's `order_created` webhook handler sends the Table Pack download to every Plan order whose Lemon Squeezy `created_at` is before **2026-11-13T04:59:00Z**. Later orders don't get it. The cut-off is the order's own timestamp, so no setting has to change at midnight, and the Lemon Squeezy product's own description never mentions the early-bird (it's the one text the API can't change). | `2026-11-13T04:59:00Z`: swap every early-bird CTA on the persona's landing page and checkout button text to the standard version (listing-pack.md); stop selecting Block E3-A / E5-A | At 05:05Z: fetch the landing page and fail on any early-bird phrase; replay a test-mode order stamped 04:58Z (gets the pack) and 05:00Z (doesn't); alert the Owner only if any check fails |
| **Founders' price $29** (until Sun 31 Jan 2027, 11:59 pm ET) | The Book's variant is listed at $35. The worker creates a Lemon Squeezy discount through the API (`POST /v1/discounts`, $6 fixed, limited to the Book's variant, `expires_at` **2027-02-01T04:59:00Z**) and a checkout (`POST /v1/checkouts`) with that code pre-applied (`checkout_data.discount_code`) and the same `expires_at`. {{butlers_book_url}} is the persona's own link (the landing page's /book path), which redirects to that checkout until the deadline. Lemon Squeezy itself refuses the code after it expires. Holiday Plan buyers' code is a separate API discount: $16 fixed (the founders' $29 less $10), same variant, same `expires_at`. | `2027-02-01T04:59:00Z`: point {{butlers_book_url}} at a standard $35 checkout; remove the founders' line from the landing page | At 05:05Z: `GET /v1/discounts/{id}` shows status expired; a test-mode checkout with the code is refused; the landing page has no "$29"; alert only on failure |

The jobs run from the worker queue with retries every minute for an hour. If a self-check still fails, the worker takes the offer's page offline (it shows the standard price) rather than leave an expired offer live, and alerts the Owner.
