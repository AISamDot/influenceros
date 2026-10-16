# Welcome Sequence: DINNER (Countdown Card → Operation Sprout)

**Persona:** `dot` · **Trigger:** email opt-in from the DINNER keyword DM flow or the link-in-bio · **Live:** Sun 1 Nov – Thu 24 Dec 2026
**Rules applied:** product emails carry no backstory (no "41 years", no school kitchen, no two million dinners, no Thursday Dinners, no Dot's own Christmas). Proof is the pages themselves, never a result. Real deadline only. Dot's voice, UK spelling, Americans addressed directly where it helps.

---

## Automation (fully automated, no manual steps)

| Email | Sends | Notes |
|---|---|---|
| 1 | Immediately on opt-in | Delivers the card |
| 2 | Day 2, 09:00 UK (US contacts: 09:00 ET) | Value |
| 3 | Day 4, 09:00 UK / ET | Soft offer |
| 4 | Day 6, 09:00 UK / ET | Proof of usefulness: the pages |
| 5A | **Sun 15 Nov 2026, 10:00 UK** to every non-buyer who opted in before then, whatever email they're up to | Final offer, early-bird deadline |
| 5B | Day 8, 09:00 UK / ET, for anyone who opted in on or after Sat 7 Nov and didn't get 5A | Final offer, no price deadline (the price is already $12) |

- **Buyers leave the sequence** the moment the purchase webhook fires.
- **Merge tokens:** `{{first_name|"love"}}`, `{{card_link}}`, `{{plan_link}}`, `{{price_line}}`.
- **`{{price_line}}`** renders as `It's $9 until Sunday 15 November, 23:59 UK. Then it's $12.` until Sun 15 Nov 23:59 UK, and as `It's $12.` from Mon 16 Nov 00:00 UK. The switch is automatic and happens at the same minute as the checkout price change.
- **Pre-order fallback** (only if the 28 Oct recipe gate slips): append `Pre-order: delivered by email by Mon 9 Nov. If we miss that date, you're refunded automatically and you still get the plan.` under every `{{plan_link}}` until 9 Nov.
- **US segment** (contact country = US): emails 2 and 4 swap in their US P.S.
- **Stop date:** no sequence emails send after Thu 24 Dec 23:59 UK. Anyone mid-sequence then moves to the PROPER (January) flow.
- **Footer on every email:** `You're getting this because you asked for Dot's Christmas Dinner Countdown Card. Dot Pickering is a fictional AI character; the food-safety lines come from the FSA and USDA. Not medical advice. {{business_postal_address}} · Unsubscribe in one click: {{unsubscribe_link}}`

---

## Email 1: Delivery

**Subject:** Your Countdown Card's here, love
**Preview:** Two pages. One oven. Start with the defrost box.

Now then, {{first_name|"love"}}.

Here's your **Christmas Dinner Countdown Card**: `{{card_link}}`

Two pages. Page 1 is Christmas Day, page 2 is Thanksgiving for our American lot. Print it or keep it on your phone. Both work.

Do three things with it today. It'll take ten minutes.

1. **Write your dinner time in the box at the top.** Everything counts back from that. Not "about two-ish". A time.
2. **Find your bird's weight in the defrost calculator.** Write the date and hour it goes in the fridge on your calendar, in red. This is the one job on Christmas Day you can't rush, so you do it now.
3. **Read the "Nothing New on the Day" checklist** and circle anything you can't tick yet. Those are your jobs for November.

That's it. You've started.

In two days I'll send you the trick that makes one oven enough for a full Christmas dinner. It's about 40 minutes and a bit of foil.

Eat your greens, love, and put that powder down.
Dot

---

## Email 2: Value

**Subject:** The 40 minutes that save Christmas dinner
**Preview:** Your oven can't do two jobs at once. So don't ask it to.

{{first_name|"love"}}, here's the whole trick.

**Your oven can only do one job at a time.** Most Christmas dinners go wrong because the bird, the potatoes, the stuffing, the pigs in blankets and somebody's sister's dish all want the oven at a quarter to two. So:

**1. The bird gets the oven to itself.** Nothing else goes in with it.

**2. The bird comes out 40 minutes before dinner.** Check it's cooked first. In the UK, the FSA says to cut into the thickest part and check none of the meat is pink. In the US, USDA says 165°F in the thickest part of the breast, the innermost thigh and the innermost wing. Then it rests under foil. USDA advises letting it stand 20 minutes before carving; give it 30 and carve in the last 10.

**3. The roast potatoes get the oven for those 40 minutes.** That's what resting is for. It isn't wasted time. It's the potatoes' turn.

**4. Everything else lives somewhere else.** Veg on the hob. Gravy on the hob. Stuffing in the slow cooker, or made weeks ago, frozen and reheated in the microwave until steaming hot (in a microwave-safe dish, never foil).

Write it on your Countdown Card like this:

- Bird in: dinner time minus (bird's cooking time + 40 minutes)
- Bird out: dinner time minus 40 minutes
- Spuds in: straight after
- Carve: dinner time minus 10 minutes

Now do the sum for your own dinner time and your own bird. Put an alarm on every line. That's a Christmas Day clock, and you've built it in five minutes.

One more rule while I've got you: **don't stuff the bird.** The FSA says to cook the stuffing in a separate tin, because a stuffed turkey takes longer to cook and may not cook thoroughly. USDA doesn't recommend it either.

Dot

**P.S. (UK, CA, AU):** How much bird? USDA's buying guide is about 450 g of whole turkey per person. Want leftovers? Go up a size.
**P.S. (US):** Thanksgiving's Thursday 26 November. A 16 to 20 lb bird goes in the fridge to thaw on **Saturday 21 November** (USDA: about 24 hours for every 4 to 5 pounds). Put it in your phone now.

---

## Email 3: Soft offer

**Subject:** Want the other six weeks?
**Preview:** The card's the day. The plan's everything before it.

{{first_name|"love"}}, the card you've got covers Christmas Day. It doesn't cover the six weeks before it, and that's where Christmas dinner actually gets made.

So I've written that bit down. It's called **Operation Sprout: Dot's Christmas Dinner Battle Plan**, and here's what's in it:

- **A countdown from Friday 13 November.** One job a day. On weekdays, 20 minutes or less (Christmas Eve is about an hour, spread out). Catch-up days built in.
- **Pick your battle size**, 2, 4, 6, 8 or 10+, and it sets your bird size, your batches and your shopping list, costed in £ and $ with the date the prices were checked.
- **Freezer pages.** Stuffing and pudding made in November and early December, with the FSA and USDA rules for freezing, defrosting and reheating.
- **Oven Tetris, the full version.** A fill-in Christmas Day clock, worked examples for small, medium and large tables, a big-print sheet for the oven door, and the Rest-Window Rule for fitting your own roasties, pigs in blankets and Yorkshires in around the bird.
- **Job cards and scripts.** Including the one for when somebody wants to "just pop this in the oven".
- **Boxing Day.** Leftover rules and five leftover teas.
- **A Thanksgiving section, a hot-day Aussie table, vegetarian and vegan mains, an allergen chart**, a weekly check-in page, and a page for when it all goes wrong.

It's a timing-and-prep system that works with your own classics. There's no turkey recipe and no gravy recipe; those follow your label and the pack. The recipes that are in it are light ones, adapted from published US government sources and credited on every page. The safety lines are quoted from the FSA and USDA.

{{price_line}}

Have a look: `{{plan_link}}`

No pressure. The card works on its own. The plan's for anyone who'd rather not do the thinking.

Dot

---

## Email 4: Proof of usefulness (the pages, word for word)

**Subject:** Here's page 41
**Preview:** What to do when Christmas goes wrong. No story, just the page.

{{first_name|"love"}}, I'm not going to tell you a story about why the plan works. I'll just show you a page and you can decide.

This is from **page 41, "When You Slip"**, word for word:

> **I missed a day or two of the countdown.** Don't redo the missed days. Do today's job, then use the next catch-up day (Thu 10 Dec, Fri 11 Dec). Only the bold jobs really matter: the bird order, Defrost Day, the stuffing, the crisp.

> **The bird's not cooked at "bird out" time.** Back in. Check every 15 minutes (p. 16). Spuds wait in the fridge; everything else on the hob can be held on its lowest heat or turned off and reheated until steaming hot. Dinner's late. Nobody ever died of a late dinner; people have of an undercooked one.

> **Leftovers were left out more than 2 hours.** Bin them. FSA: one to two hours. USDA: 2 hours. That's the rule, not a suggestion.

And this is **week −4 of the countdown (page 8)**, the first three days, trimmed to fit an email:

| Day | Job | Mins |
|---|---|---|
| Fri 27 Nov | Buy the stuffing ingredients. | 20 |
| Sat 28 Nov | Cube the bread for tomorrow and keep it in a sealed bag. Chop the celery and onion and fridge them, covered. | 15 |
| Sun 29 Nov | COOK AND FREEZE: Make-Ahead Stuffing. Slow cooker on in the morning. Cool, portion into lidded freezer-and-microwave-safe tubs, label, freeze. | 30 hands-on |

That's the whole plan: a job, a time, and what to do when it goes sideways. Forty-three pages of it.

{{price_line}}
`{{plan_link}}`

Dot

**P.S. (US):** Page 34 is your Thanksgiving week, Saturday Thaw Day to Friday leftovers, with USDA lines only.

---

## Email 5A: Final offer (sends Sun 15 Nov 2026, 10:00 UK)

**Subject:** Early-bird ends tonight at 23:59 UK
**Preview:** $9 until midnight UK time. Then it's $12. That's all.

{{first_name|"love"}}, short one.

The early-bird price for **Operation Sprout** ends **tonight, Sunday 15 November, at 23:59 UK time** (that's 18:59 Eastern, 15:59 Pacific). Tomorrow it's $12. The checkout changes on its own at midnight, and it doesn't come back.

If you've been meaning to:

- The countdown started on Friday. You'd start on today's line, and catching up the first two days takes about half an hour.
- The first cooking job is the stuffing, on Sunday 29 November.
- Defrost Day for a 7 to 8 kg bird is Monday 21 December. The calculator tells you yours.

**$9 until 23:59 UK tonight:** `{{plan_link}}`

And if it's not for you, that's fine. Keep the card, write your dinner time on it, and put that defrost date in red.

Dot

---

## Email 5B: Final offer (for anyone who joins after the early-bird; sends day 8)

**Subject:** The only deadline left is the 25th
**Preview:** No countdown timer. Just Christmas Day, which is a Friday.

{{first_name|"love"}}, last email about the plan, I promise.

There's no sale on and no timer ticking. The price is $12 and it's staying $12. The only real deadline is **Christmas Day, Friday 25 December**, and the jobs that lead up to it:

- **Defrost Day** depends on your bird. A 7 to 8 kg bird goes in the fridge on **Monday 21 December**; a 4 kg crown on **Wednesday 23 December**. The calculator on page 10 gives you the exact hour.
- **The freezer weeks** are the end of November and early December. If you've missed them, page 41 has the Christmas Eve version.
- **Christmas Eve** is about an hour of jobs, and they're all on one page.

Start on today's line. The plan's built for people who start late.

**Operation Sprout, $12:** `{{plan_link}}`

If you'd rather go it alone, keep using the card. Write your dinner time on it today.

Eat your greens, love, and put that powder down.
Dot
