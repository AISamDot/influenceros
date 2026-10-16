<!--
PRODUCTION NOTES (not rendered)
- Product: The Attic Audit: 30 Days to Sell What You Own. First paid product, bible §14. Price $17; early-bird $12 to Mon 30 Nov 2026, 23:59 ET (see listing-pack.md).
- Format: 46-page PDF (US Letter + A4), a Google Sheet (Bonus 1), printable tags (Bonus 2), 4 audio pep talks (Bonus 3, generated in Walt's locked ElevenLabs voice from the scripts on page 40; each file's ID3 comment and the download page say "AI character voice").
- Folder slug `sal` is intentional (bible header: kept so pipeline paths don't break). The character in every file is Walt Novak. Never render "Sal".
- Page breaks: each "---" followed by a "PAGE" heading starts a new page.
- Pages 44 (15-Minute Drawer Audit) and 45 (Real-Worth Cheat Sheet) are in the paid book so Etsy and direct buyers who never took the free DRAWER sheet still have them (pages 33 and 34 point to them). Page 45 is rendered from the SAME gated category file as lead-magnet.md page 3, in the same pipeline run, so the two can never differ. Render-time tokens (filled automatically; no human step): {{CHEAT_SHEET_MONTH}}, {{CHEAT_SHEET_SOURCES_URL}}, {{CHEAT_SHEET_SELL_COUNT}}, {{CHEAT_SHEET_FRACTION_COUNT}}.
- Render gate (automated, blocks the build on any failure; the last passing version stays on sale and nothing new ships):
  1. Cheat-sheet lines: the QC agent confirms every category on page 45 against that month's cited, CLEAN-source research log. Unconfirmed categories are dropped and the counts in the column headings are recomputed (the tokens above). Nothing ships with an unconfirmed line.
  2. Sources page: the pipeline publishes the public sources page for {{CHEAT_SHEET_SOURCES_URL}} from the same research log BEFORE rendering, then fetches it: it must return HTTP 200 on the studio's own domain, carry the same month as {{CHEAT_SHEET_MONTH}}, and list at least one citation for every category printed on page 45. If any check fails, the PDF does not render.
  3. Link check: every URL in the book (pages 9, 23, 27, 29, 34, 35, 45 and the page 46 credits) is fetched; it must resolve to a live page whose title matches the source named. Deep paths are checked first: the CPSC "Stopping the Online Sale of Recalled Products" page and the IRS "Form 1099-K FAQs: Common situations" page (both resolved, with matching titles, on 16 Oct 2026). A failed link swaps automatically to the agency's search page (e.g. "search 'recalled products' on cpsc.gov") rather than shipping a dead link.
- Shipping: from Day 18 the Daily Ship Check (page 22) is a standing daily job, so every sale ships inside the handling time the listing states. Day 28 is a confirmation pass, not the first time anything ships.
- Palette: cobalt #2E5AA8 headings, manila #E8D4A2 panels, safety orange #F26B1D for tick boxes and rules, shop khaki #A39A78 table headers. No logos, no maker's marks, no generated branded products.
- Every dollar figure in this manuscript is either a house rule (the $10 floor) or a clearly labelled illustrative example. No result claims. No testimonials. No user totals.
- Lore appears as colour only, never as proof. QC lint list: investment, asset (except the ATO page name), profit (about the reader), side hustle, guaranteed, expert, appraise/appraisal (except "not an appraisal" / "qualified appraiser"), certified, tested, hidden treasure, worth thousands, "nobody's coming".
- Spelling: US (Walt's voice), with UK/CA/AU equivalents where money or rules differ.
-->

# PAGE 1 · Cover

# THE ATTIC AUDIT

## 30 Days to Sell What You Own

**Find it. Price it off what it sold for. List what's worth listing. Clear the rest properly.**

Week 1 FIND · Week 2 PRICE · Week 3 LIST · Week 4 CLEAR

*with Walt · What It Sold For*

*Workbook · Sold Log spreadsheet · printable tags · four audio pep talks*

---

# PAGE 2 · Before You Start (read this one, bud)

Here's what this is. A 30-day plan for getting the stuff you don't use out of your house: what's worth selling, sold; what isn't, given to someone who'll use it; the rest, gone properly. About 20 to 40 minutes a day. Some days less.

Here's what this isn't. It isn't a promise of money. **What you get back depends on what you own and your market. I can't promise a number. Nobody honest can.** You might finish with a few good sales. You might finish with a clean garage and a trunk full of donations. Both are a finished Attic Audit.

**Three things to know about me.**

1. **I'm an AI character** made by a small studio. The stories I tell are fiction. The method in this book doesn't lean on them. It leans on one idea you can check yourself: look up what things actually *sold* for, then decide.
2. **I give price checks, not appraisals.** For insurance, tax, an estate, a divorce or a family disagreement, get a qualified appraiser.
3. **I don't do flipping.** This book is about selling what you already own. It's housekeeping, not a business.

**What you need**

- [ ] This workbook (print it, or fill it in on a tablet)
- [ ] The Sold Log spreadsheet (Bonus 1), or the paper logs on pages 13 and 21
- [ ] One banker's box (the Keep Box)
- [ ] Painter's tape or three sheets of paper for pile labels: **SELL · GIVE · GONE**
- [ ] A phone with a camera
- [ ] Bags and boxes. Free ones are fine.
- [ ] A calendar. You're going to put 30 short appointments in it.

**What's in here**

| Section | Pages |
|---|---|
| How to use this, the Nine Rules, the 30-Day Tracker, your Starting Line | 3–6 |
| Week 1 · FIND | 7–11 |
| Week 2 · PRICE | 12–17 |
| Week 3 · LIST | 18–25 |
| Week 4 · CLEAR | 26–31 |
| Final Scorecard, the Measurement Loop, the Slip Page | 32–34 |
| Tax notes, After Day 30 | 35–36 |
| Bonuses (including the 15-Minute Drawer Audit and the Real-Worth Cheat Sheet) | 37–45 |
| Credits and sources | 46 |

---

# PAGE 3 · How to Use This

**One rule above all the others: you do today's page, not the whole book.**

**The rhythm**

- **Every day:** open to the day's page, do the job, tick the box on the 30-Day Tracker (page 5). If you only have ten minutes, do ten minutes and tick it anyway. A half day is a day.
- **From Day 18, every day:** the Daily Ship Check (page 22). Anything that sold since yesterday gets packed and shipped inside the handling time your listing promised, and the tracking goes up. Five minutes on most days, nothing on days nobody buys.
- **Every 7th day:** fill in the Weekly Scorecard (pages 11, 17, 25, 31). It takes five minutes. It tells you what to change next week.
- **Day 30:** the Keep Box review and the Final Scorecard.

**The measurement loop.** You'll track six numbers all month. Not money first. Things first.

| Number | What it means | Why it matters |
|---|---|---|
| **Found** | Items you pulled out and decided on | Shows you're moving |
| **Priced** | Items you looked up on the Tag Card | Stops guessing |
| **Listed** | Items live for sale | Only listed things sell |
| **Sold** | Items that actually sold | The honest result |
| **Cleared** | Items given or gone properly | The house result |
| **Hours** | Time you spent | Tells you if the Floor is set right for you |

You'll also write down **POCKET**: the money you actually received after fees and shipping. It's your own number, for you. Nobody else needs it.

**If you fall behind:** go to the Slip Page (page 34). Don't restart. Don't double up. Pick up today's page.

**Living with other people?** Only sell what's yours. Anything shared, or anything that belongs to someone else, gets asked about first. There's a script on page 8.

**Rather do it with a group?** The January group start (Mon 11 Jan 2027) uses this same book on a shared calendar. Each Monday an automated email brings that week's one-page focus sheet with the group's real dates filled in, a calendar file for the week's seven appointments, and that week's scorecard prompt. It's a light-touch extra, not coaching. Included if you buy by Sun 10 Jan 2027, 11:59 pm ET (page 37).

---

# PAGE 4 · The Nine Rules

Tear this page out. Tape it inside the garage door.

| # | Rule | In one line |
|---|---|---|
| 1 | **Keep Box First.** | Before you sell a thing, fill one banker's box with what matters. Then everything else gets easier. |
| 2 | **The Ten-Dollar Floor.** | If POCKET is under $10 (about £8, C$14, A$15), it doesn't get listed. GIVE or GONE. |
| 3 | **Sold, Not Listed.** | Only completed sales count. Asking prices are wishes. |
| 4 | **Price It Like It's Tuesday.** | Price at the middle sale, not the best day ever. |
| 5 | **The Window-Light Rule.** | Daylight, a plain background, six angles, show the flaws. |
| 6 | **The 14-Day Drop.** | No sale in 14 days: drop 20%. No sale at 28 days: it goes to GIVE. |
| 7 | **The Porch Rule.** | Local pickups on the porch, the driveway or a public spot. Never inside. Never accept overpayment. No shipping-label "favors." |
| 8 | **The Bread-Maker Test.** | For these 30 days, nothing new comes home unless you can name three days you'll use it. |
| 9 | **One In, Two Out.** | After Day 30: one thing comes in, two things leave within 7 days. Same room or same job. |

**Paid's a story. Sold's a fact.**

---

# PAGE 5 · The 30-Day Tracker

Tick a box when you've done the day's page, even if you only did part of it. Write the date in the middle column.

**Standing rule from Day 18 to Day 30 (and after, while anything is listed): ship every sale within the handling time your listing states.** That's the Daily Ship Check on page 22. It runs on top of the day's job, every day, so nothing waits for Day 28. Tick the **Ship** column each day from 18 on: ✓ if you shipped everything that sold, or "0" if nothing sold.

| Day | Job | Date | Done | Ship |
|---|---|---|---|---|
| 1 | Keep Box | | [ ] | — |
| 2 | Zone 1: Closets and wardrobes | | [ ] | — |
| 3 | Zone 2: Kitchen and dining | | [ ] | — |
| 4 | Zone 3: Garage, shed, car | | [ ] | — |
| 5 | Zone 4: Attic, basement, storage | | [ ] | — |
| 6 | Zone 5: The drawers | | [ ] | — |
| 7 | Three piles + Week 1 Scorecard | | [ ] | — |
| 8 | Name it exactly | | [ ] | — |
| 9 | Tag Cards: first 10 items | | [ ] | — |
| 10 | Tag Cards: next 10 items | | [ ] | — |
| 11 | POCKET maths | | [ ] | — |
| 12 | Furniture and big local-only items | | [ ] | — |
| 13 | The Floor sort | | [ ] | — |
| 14 | Week 2 Scorecard | | [ ] | — |
| 15 | Pick where to sell | | [ ] | — |
| 16 | Window-Light photos, batch 1 | | [ ] | — |
| 17 | Write titles and descriptions | | [ ] | — |
| 18 | List batch 1 + first Daily Ship Check | | [ ] | [ ] |
| 19 | Porch Rule setup + buyer scripts | | [ ] | [ ] |
| 20 | Photos and listing, batch 2 | | [ ] | [ ] |
| 21 | Week 3 Scorecard | | [ ] | [ ] |
| 22 | GIVE run: call first, then drop off | | [ ] | [ ] |
| 23 | GONE run: e-waste, paint, batteries, medicines | | [ ] | [ ] |
| 24 | Bulk pickup or haul | | [ ] | [ ] |
| 25 | Check: things you can't sell | | [ ] | [ ] |
| 26 | Set up the 14-Day Drop | | [ ] | [ ] |
| 27 | The sweep: one more pass | | [ ] | [ ] |
| 28 | Shipping check: everything sold has shipped, tracking uploaded | | [ ] | [ ] |
| 29 | Week 4 Scorecard | | [ ] | [ ] |
| 30 | Keep Box review + Final Scorecard | | [ ] | [ ] |

**Days ticked: ____ / 30 · Ship checks done: ____ / 13**

---

# PAGE 6 · Your Starting Line

Fill this in before Day 1. Five minutes.

**Why are you doing this?** (Tick all that are true.)

- [ ] I'm moving or downsizing
- [ ] I want my space back
- [ ] I'm doing a no-buy month and want to pair it with a sell
- [ ] I'd like some money back from things I don't use
- [ ] I'm clearing out before someone else has to
- [ ] Other: ______________________________

**My finish line, in one sentence. Make it about the house, not about money.**

*Examples: "I can park in the garage." "The spare room is a room again." "Nothing in the attic I haven't decided on."*

______________________________________________________________

**The zones I'm doing** (cross out any you don't have):

| Zone | How bad, 1–5 | Notes |
|---|---|---|
| Closets and wardrobes | | |
| Kitchen and dining | | |
| Garage, shed, car | | |
| Attic, basement, storage unit | | |
| The drawers | | |
| Other: | | |

**My 30 appointments.** Pick a daily time and set it as a repeating alarm now: ______ : ______

**Who else lives here, and what's theirs?** (So you don't sell it.)

______________________________________________________________

**Before photo.** Take one photo of your worst zone right now. Don't tidy first. You'll take the after photo on Day 30.

- [ ] Before photo taken

---

# PAGE 7 · WEEK 1 · FIND · Day 1: The Keep Box

**Rule 1: Keep Box First.**

You don't start with what to sell. You start with what to keep. Here's why: the moment you know the important things are safe in one box, every other decision gets lighter. You stop holding the gravy boat hostage for a memory that's already in the box.

**The job (30 minutes)**

1. Get one banker's box. Write your name on it.
2. Walk the house. Pick up only things you'd grab in a fire, or that someone in the family would be hurt to lose.
3. Put them in the box. Photos, letters, one small thing per person who matters.
4. Stop when it's full. If it won't close, something comes out.

**The Keep Box rules**

- [ ] One box per person. Not one box per room.
- [ ] It has to close.
- [ ] Small things only. If the thing doesn't fit, the story does: take a photo, write the story on the back.
- [ ] Nobody else's things go in your box. They get their own.

**My Keep Box list**

| # | Item | Whose story is it? | Why it stays (one line) |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |
| 6 | | | |
| 7 | | | |
| 8 | | | |

**Things too big for the box (photograph them, keep the story):**

| Item | Photo taken | Story written down |
|---|---|---|
| | [ ] | [ ] |
| | [ ] | [ ] |
| | [ ] | [ ] |

> Keep the story. Sell the stuff.

---

# PAGE 8 · Days 2–6: One Zone a Day

**The method is the same in every zone.** Three piles, a ten-second rule, and four questions.

**Set up:** tape three squares on the floor or label three bags: **SELL · GIVE · GONE**. Anything that belongs to someone else goes in a fourth box: **ASK**.

**The ten-second rule:** pick it up, decide in ten seconds, put it on a pile. Don't put it down on the "think about it" chair. There is no think-about-it chair.

**The four questions (in order):**

1. **Is it mine to decide?** No: ASK box.
2. **Have I used it in the last 12 months, and will I in the next 12?** Yes: it stays, and it goes back with a job.
3. **Would somebody pay real money for it?** Maybe: SELL. (You'll check in Week 2. A guess is fine today.)
4. **Does it work, and could somebody use it?** Yes: GIVE. No: GONE.

**The "Is it mine?" script** (for the ASK box)

> "I'm clearing out [zone] this week. I found your [item]. Do you want to keep it, or can it go? If I don't hear by [day], I'll put it back in your room, not in the sale."

*Never sell someone else's things on a guess. If you don't hear back, it goes back to their space.*

**Zone tracker (tick when the zone is done)**

| Day | Zone | SELL | GIVE | GONE | ASK | Done |
|---|---|---|---|---|---|---|
| 2 | Closets and wardrobes | | | | | [ ] |
| 3 | Kitchen and dining | | | | | [ ] |
| 4 | Garage, shed, car | | | | | [ ] |
| 5 | Attic, basement, storage | | | | | [ ] |
| 6 | Drawers | | | | | [ ] |
| | **Week 1 totals** | | | | | |

---

# PAGE 9 · Zone Checklists (Days 2–6)

Tick each spot when you've cleared it. Skip what you don't have.

**Day 2 · Closets and wardrobes**

- [ ] Coats and outerwear
- [ ] Shoes and boots (gym shoes count)
- [ ] Clothes that haven't fit in a year
- [ ] Bags, belts, scarves
- [ ] The top shelf (the stuff you can't see)
- [ ] Linen closet: sheets for beds you don't own any more
- [ ] Hangers (wire ones are GONE; some dry cleaners take them back)

*Watch for:* quality outerwear and boots, vintage denim and workwear. These usually sell. Fast fashion usually doesn't.

**Day 3 · Kitchen and dining**

- [ ] Small appliances (anything you haven't plugged in this year)
- [ ] Single-job gadgets
- [ ] Mugs and cups past the number of people in the house × 2
- [ ] Bakeware and cast iron
- [ ] The good china and the stemware
- [ ] Serving pieces: silverplate vs sterling (sterling has a melt-value floor; look for the mark)
- [ ] Plastic containers without lids, lids without containers

*Food isn't part of this audit. Don't sell or give away opened food or home-canned jars. If you're not sure whether something in the pantry is still safe to keep, use the USDA FoodKeeper app (US) or the Food Standards Agency's guidance (UK).*

**Day 4 · Garage, shed, car**

- [ ] Hand tools (older quality tools usually sell)
- [ ] Power tools: do the batteries and charger match?
- [ ] Sports and camping gear
- [ ] Bikes
- [ ] Paint, chemicals, old fuel: **these go to GONE through a hazardous-waste drop-off, never the bin or the drain**
- [ ] The trunk of the car

**Day 5 · Attic, basement, storage**

- [ ] Holiday décor (sells best Oct–Dec; out of season, tag it and list it then)
- [ ] Boxes you haven't opened since the last move
- [ ] Furniture under sheets
- [ ] Media: VHS, DVDs, CDs, vinyl
- [ ] Books
- [ ] Baby and kids' gear (check recalls before anything goes to SELL or GIVE: page 29)

*Safety: read page 10 before you go into an attic or a damp basement.*

**Day 6 · The drawers**

- [ ] Kitchen junk drawer
- [ ] Bedside drawers
- [ ] Desk drawers
- [ ] Bathroom drawers (expired medicines have their own disposal route: page 27)
- [ ] Old phones, cables, chargers (wipe phones before anything else: page 27)
- [ ] Keys that don't fit anything

---

# PAGE 10 · Safety Before You Lift Anything

Read this once. It's short.

- **Lift with help.** Anything heavy, awkward or up a ladder is a two-person job. Bend your knees, keep it close, don't twist.
- **Attics get hot.** Go early in the day. Take water. Watch where you step: stay on the joists or the boards.
- **Mold, old insulation, damaged tiles and old pipe lagging:** stop. Don't disturb anything that might be asbestos-era material. Call a professional.
- **Droppings or nests:** don't sweep them up dry. Check your local health department's (or council's) guidance first, or call pest control.
- **Ladders:** three points of contact. Someone at the bottom.
- **Sharp stuff:** gloves for the garage and the drawers. Old blades, glass, nails.
- **Kids and pets:** keep them away from the GONE pile. Batteries, chemicals and medicines especially.
- **Your body has a vote.** If something hurts, stop. Tomorrow's page will still be there.

---

# PAGE 11 · Day 7: The Three Piles + Week 1 Scorecard

**The job (30–40 minutes)**

1. Bring every SELL pile from the week into one place. A table, a corner, the garage floor.
2. Do a fast second pass. Anything that's obviously not worth a listing now that you see it next to the rest: move it to GIVE.
3. Bag GIVE. Bag GONE. Put both by the door or in the car. They leave in Week 4, or sooner if you want.
4. Count.

**Week 1 Scorecard**

| Number | This week |
|---|---|
| Found (total items decided on) | |
| In the SELL pile | |
| In the GIVE pile | |
| In the GONE pile | |
| In the ASK box | |
| Hours spent this week | |
| Days ticked on the tracker (out of 7) | |

**The loop: what does this tell you?**

| If… | Then next week… |
|---|---|
| SELL is over 60 items | Price the 20 you think are best first. The left column of the Real-Worth Cheat Sheet (page 45) shows which categories usually sell. The rest wait. |
| SELL is under 5 items | Good. Price them, and use the spare time to get GIVE and GONE out early. |
| You ticked fewer than 4 days | Shorten the appointment to 15 minutes. Don't skip it. |
| ASK has things in it | Send the "Is it mine?" script today, with a date. |

**One sentence: what surprised me this week?**

______________________________________________________________

> **Audio pep talk 1 ("Week 1's the hard one") is in your downloads.** Ninety seconds. Play it before Day 8.

---

# PAGE 12 · WEEK 2 · PRICE · Day 8: Name It Exactly

**Rule 3: Sold, Not Listed.**

Here's the thing about prices online. Most of what you see is somebody *asking*. Asking is free. Anybody can ask four hundred bucks for a cup. The market is what people actually *paid*. That's the only number this book uses.

And you can't look up what something sold for until you know exactly what it is. "Old camera" finds ten thousand cameras. Maker, model and condition find yours.

**The job (20–30 minutes):** for every item in the SELL pile, find and write down the five facts below. Look on the bottom, the back, inside the lid, the label in the collar, the plate on the motor. Take a phone photo of any label so you don't have to turn it over twice.

**The five facts**

| Fact | Where to look | Example (illustrative) |
|---|---|---|
| **Maker** | Base, label, plate, inside lid | [Maker name] |
| **Model / pattern / style** | Model number, pattern name, size tag | Model 1234, "Blue Garland" pattern |
| **Size / quantity** | Tape measure, count the pieces | 8 dinner plates, 10.5 in |
| **Colour / finish** | Just look | Cobalt enamel |
| **Condition** | Honest eyes, good light | Used, works, small chip on rim |

**Condition words (use the same ones buyers search with)**

| Word | Means |
|---|---|
| New with tags / New in box | Never used, original packaging |
| Used, excellent | Barely used, no visible wear |
| Used, good | Normal wear, works perfectly |
| Used, fair | Clear wear or a small flaw, works |
| For parts or repair | Doesn't work, or you can't check it |

**"Not checked" means "for parts" to a buyer.** If you can plug it in, plug it in.

**Can't identify something?** Take a clear photo and use a reverse image search to find its name. Don't price it until you know what it is. If you still can't tell, it goes to GIVE or to a local auction house, not to a guess.

**Day 8 checklist**

- [ ] Every SELL item has its five facts written down (Sold Log or page 13)
- [ ] Label photos saved in one phone album called "Attic Audit"
- [ ] Anything I couldn't identify is marked "ID?"

---

# PAGE 13 · Days 9–10: Tag Cards (the paper Sold Log)

**How to look up what your item sold for (your own lookup, about 5 minutes each)**

**eBay's sold filter**

1. Search your item using the five facts: maker, model, size, colour.
2. On a computer: scroll the left column and tick **"Sold items."** On the app: tap **Filter** and switch on **"Sold items."**
3. Sold prices show in green. Open a few and check the condition matches yours.
4. If you sell on eBay, Seller Hub's **Product Research** shows up to three years of sold data.

**Other places that report sold (realized) prices**

- Public auction-house results pages (search "[item] realized price" or "[item] auction results")
- Price guides that report realized prices, not "estimated values"
- Pattern-matching services for china, crystal and silver (they sell at retail, so treat their price as a ceiling)

**How to read what you find**

1. Write down every sold price for the **same thing in the same condition.**
2. **Skip:** bundles and lots, broken ones (unless yours is broken), and the one sale that's way higher than the rest.
3. **Count them.** 10 or more: line them up low to high and take the one in the middle. That's the **middle sale**, and it's your **WORTH.**
4. **Under 10:** write **"thin"** and the low-to-high range. Don't pretend there's a middle number when there isn't.
5. **Zero sales:** that tells you something too. Usually it means GIVE.

**Paper Sold Log (Days 9–10: first 20 items)**

| # | Item (five facts) | Sold prices found | n | WORTH (middle) or range if thin | Source(s) | Date checked |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| 4 | | | | | | |
| 5 | | | | | | |
| 6 | | | | | | |
| 7 | | | | | | |
| 8 | | | | | | |
| 9 | | | | | | |
| 10 | | | | | | |
| 11 | | | | | | |
| 12 | | | | | | |
| 13 | | | | | | |
| 14 | | | | | | |
| 15 | | | | | | |
| 16 | | | | | | |
| 17 | | | | | | |
| 18 | | | | | | |
| 19 | | | | | | |
| 20 | | | | | | |

*More than 20 items? Use the Sold Log spreadsheet (Bonus 1). It works out the middle sale for you.*

---

# PAGE 14 · Reading the Numbers Without Fooling Yourself

**Rule 4: Price It Like It's Tuesday.** Not the best day ever. Tuesday. An ordinary day, an ordinary buyer.

**Six ways people fool themselves (and the fix)**

| The trap | What it sounds like | The fix |
|---|---|---|
| **The asking price** | "They're going for $300 online." | Are they *going*, or *sitting*? Sold filter only. |
| **The one big sale** | "One sold for $500!" | One sale isn't a price. Use the middle. |
| **The wrong condition** | "That one's the same." | Is it new in box? Yours isn't. Match condition. |
| **The lot price** | "Twelve sold for $60, so mine's $5 each." | Lots sell cheaper per piece, and singles sometimes don't sell at all. Find single sales. |
| **Paid-price anchoring** | "But I paid $200." | Paid's a story. Sold's a fact. |
| **Waiting for it to go up** | "It might be worth more next year." | Maybe. Most common things don't. This book looks at what things sold for, never what they will. |

**Thin markets**

When there are fewer than 10 sales:

- [ ] Write the range, not a middle number.
- [ ] Widen the window to 12 months and write "12 mo" next to it.
- [ ] Look for the nearest match (same maker, similar size) and write "nearest match."
- [ ] Price toward the lower half of the range. Thin markets are slow markets.

**Seasonal items: list them in season**

| Category | Usually sells best |
|---|---|
| Holiday décor | Oct–Dec |
| Fitness gear | January |
| Outdoor, garden, bikes, camping | Spring |
| Back-to-school, desks, dorm stuff | Jul–Aug |

If it's off-season, price it now, tag it, and write on the box the month to list it.

---

# PAGE 15 · Day 11: POCKET Maths

**WORTH is what it sells for. POCKET is what you keep.** The gap is fees, shipping and packing. Sometimes it's most of the money.

**Step 1: look up the real fees.** Fees change. Don't use a number from a video or from memory, including mine. Go to the platform's own fee page and write it here today.

| Platform | Selling fee (% or flat) | Payment/processing fee | Who pays shipping by default | Date I checked |
|---|---|---|---|---|
| | | | | |
| | | | | |
| | | | | |
| Local cash sale | none | none | buyer collects | n/a |

**Step 2: the POCKET worksheet**

| Line | Item: ____________ | Item: ____________ | Item: ____________ |
|---|---|---|---|
| A. WORTH (middle sale) | | | |
| B. Platform fees on A | | | |
| C. Shipping cost (if you pay) | | | |
| D. Packing (box, tape, padding) | | | |
| E. Travel (post office or drop-off) | | | |
| **POCKET = A − B − C − D − E** | | | |
| Over my floor? | [ ] Yes [ ] No | [ ] Yes [ ] No | [ ] Yes [ ] No |

**Illustrative example (not data; made-up numbers to show the maths)**

| Line | Amount |
|---|---|
| A. WORTH | $30.00 |
| B. Fees (15%, just for the example) | −$4.50 |
| C. Shipping you pay | −$9.00 |
| D. Packing | −$1.50 |
| E. Travel | $0 (dropped off on the way to work) |
| **POCKET** | **$15.00** |

Thirty on the screen. Fifteen in your pocket. Still clears the floor. If shipping had been $14, it wouldn't.

**Two ways to raise POCKET without raising the price**

1. **Sell big or heavy things locally.** No shipping, no box.
2. **Bundle small things that go together** (a set of tools, a stack of matching bowls). One listing, one box, one fee.

---

# PAGE 16 · Day 12: Furniture and Big Local-Only Items

Furniture, treadmills, pianos, big rugs, sofas. You can't ship them, so you're selling to whoever's within driving distance with a truck. Fewer buyers. Less sold data. Price for that.

**The knock test (and three better checks)**

1. **Knock on it.** Solid wood thunks. Veneer taps. Pressboard sounds like a cracker.
2. **Look at the edge** of a top or a shelf. Grain that runs over the edge: likely solid. A thin line or a strip: veneer. A crumbly brown core: pressboard.
3. **Pull out a drawer.** Interlocking joints at the corners usually mean better construction than staples and glue.
4. **Look underneath and on the back** for a maker's label. Write it down.

**Measure before you list.** Width × depth × height. Buyers ask first, and leave if you don't know.

| Item | W | D | H | Solid / veneer / pressboard | Maker label? | Condition |
|---|---|---|---|---|---|---|
| | | | | | | |
| | | | | | | |
| | | | | | | |
| | | | | | | |

**Pricing local-only items**

- [ ] Search sold prices for the maker and style. Write "thin" if there are fewer than 10.
- [ ] Search local listings to see what you're up against. These are *asking* prices, so they're a ceiling, not a target.
- [ ] Price toward the lower half. Big things that don't move cost you floor space every day.
- [ ] **No sold comparables at all?** Price it to move, or list it free for collection. A sofa that's gone this weekend beats a sofa that's still for sale in March.

**What usually goes for little (category tendencies; check yours):** brown dining sets, entertainment centers, upright pianos, used upholstered sofas, pressboard flat-pack.
**What usually sells:** solid-wood mid-century pieces, good outdoor furniture in season, quality desks and office chairs.

---

# PAGE 17 · Day 13: The Floor Sort · Day 14: Week 2 Scorecard

**Rule 2: The Ten-Dollar Floor.** If POCKET is under **$10** (about £8, C$14, A$15), it doesn't get listed.

Why? Because listing isn't free. Photos, a description, three messages from a buyer who vanishes, the box, the tape, the post office line. That's an hour of your life. Under ten bucks, give it to somebody who'll use it and have your evening back.

**Set your own floor if $10 doesn't fit you.** Short on time? Raise it to $20. Enjoy it and live near the post office? Lower it. Write your floor here and use it all month: **$ ______**

**Day 13: the sort**

| Move | Count |
|---|---|
| POCKET over my floor: stays in **SELL** | |
| POCKET under my floor, works: moves to **GIVE** | |
| POCKET under my floor, broken: moves to **GONE** | |
| Thin or "ID?", can't decide: moves to **GIVE** (or a local auction house) | |

- [ ] The SELL pile only holds things over my floor
- [ ] Every SELL item has a tag on it: PAID / WORTH / POCKET (Bonus 2)

**Day 14: Week 2 Scorecard**

| Number | Week 1 | Week 2 |
|---|---|---|
| Found | | |
| Priced (Tag Cards done) | — | |
| Cleared the floor (stays in SELL) | — | |
| Moved to GIVE or GONE this week | | |
| Hours | | |
| Days ticked (out of 7) | | |

**The loop**

| If… | Then… |
|---|---|
| Fewer than 5 items cleared the floor | Common. Week 3 will be short for you. Use the spare days to get GIVE and GONE out of the house early. |
| More than 40 cleared the floor | List the top 20 by POCKET first. The rest go in batch 2 (Day 20). |
| Pricing took more than 10 minutes an item | Stop researching edge cases. Thin? Use the range and move on. |
| You found something that might be fine jewelry, art, coins or anything signed | Don't price it from this book. Take it to a qualified appraiser or a reputable auction house. |

> **Audio pep talk 2 ("Paid's a story") is in your downloads.** Play it before you list anything.

---

# PAGE 18 · WEEK 3 · LIST · Day 15: Where to Sell (the decision tree)

Match the item to the buyer. Answer the questions in order and stop at the first "yes."

**1. Is it big, heavy, fragile or awkward to box?**
→ **YES: sell locally.** Local marketplace apps, a local buy-and-sell group, a local consignment shop, or a local auction house for good furniture. Use the Porch Rule (page 23).

**2. Is it something only a few people hunt for** (cameras, tools, records, cards, parts, a particular china pattern)?
→ **YES: sell where buyers search nationally.** A big general marketplace with a sold filter is usually best, because the people looking for exactly that thing are spread out.

**3. Is it clothing, shoes or accessories?**
→ **YES: a clothing resale app.** Pick by your style and your country (page 19). Or a consignment service if you want somebody else to photograph and list it.

**4. Might it be worth a lot, or are you not sure what it is?**
→ **YES: a local auction house or a qualified appraiser first.** Don't list a possibly good piece at a guessed price.

**5. Is it a group of low-value things that go together** (a box of craft supplies, a set of kids' books)?
→ **YES: sell it as one lot locally, or GIVE.** One listing, one pickup.

**6. Do you want zero hassle, and you'll accept a smaller share?**
→ **YES: consignment** (they list it and keep a cut), a **live-selling consignor** (they sell it on a live-auction app and keep a cut), or **a buyout** for a whole roomful.

**7. None of the above?**
→ Default: a big general marketplace if it ships, local if it doesn't.

**My choices**

| Item | Ship or local | Where I'll list it | Backup if no sale in 28 days |
|---|---|---|---|
| | | | |
| | | | |
| | | | |
| | | | |
| | | | |
| | | | |

---

# PAGE 19 · The Channel Chooser

The usual places to sell, what each is good for, and what to watch out for. Which ones you can use depends on your country, so check before you sign up. **Look up each one's current fees on its own fee page** (page 15).

| Channel | Good for | Ship or local | Watch out for |
|---|---|---|---|
| **eBay** | Niche items, parts, cameras, tools, media, collectibles | Ship (local pickup option too) | Fees and shipping eat small sales; photograph flaws to avoid returns |
| **Mercari** (US) | Everyday household items, small electronics | Ship | Small items under the floor won't be worth it |
| **Poshmark** | Clothing, shoes, bags | Ship | Offers come in low; know your floor before you answer |
| **Vinted** | Clothing and small household items | Ship | Buyers compare closely; price at the middle |
| **Depop** | Younger, vintage and streetwear styles | Ship | Style matters more than the label; good photos win |
| **Facebook Marketplace / local groups** | Furniture, big items, kids' gear, garden | Local | No-shows and scams: Porch Rule, always |
| **Local consignment shop** | Furniture, décor, clothing in good condition | Local | Read the split, the timeline and what happens to unsold items |
| **Live-selling consignor** | Quick turnover of collectibles and smalls | Ship (they handle it) | Their cut and their timeline; get it in writing |
| **Local auction house** | Better furniture, art, jewelry, collections | Local | Commission and buyer's premium; ask what they turn away |
| **Yard or garage sale** | Lots of low-value items at once | Local | A full day of your time; check your town's permit rules |

*Company names are here only so you know what to search for. None of these companies is connected to this book.*

**Questions to ask any consignor or auction house (tick when answered):**

- [ ] What percentage do you keep?
- [ ] Are there listing, photo, pickup or storage fees?
- [ ] How long do you hold an item before it comes back to me, or gets donated?
- [ ] When and how do I get paid?
- [ ] Is my item insured while you have it?
- [ ] Can I see all of this in writing before I hand anything over?

---

# PAGE 20 · Day 16: The Window-Light Photo Guide

**Rule 5: The Window-Light Rule.** Daylight, a plain background, six angles, show the flaws.

Photos sell the item. The best photo setup costs nothing: a window, a plain sheet, and the middle of the day.

**Set-up (10 minutes, once)**

- [ ] A spot next to a big window, out of direct sun. Overcast days are best.
- [ ] Flash **off.** Overhead lights **off.**
- [ ] A plain background: a white sheet, a grey wall, a wooden floor. Nothing else in the frame.
- [ ] Wipe the item. Dust shows up in photos more than in life.
- [ ] Phone lens wiped with your shirt.

**The six angles (tick for every item)**

| # | Angle | Done |
|---|---|---|
| 1 | Straight on, whole item, filling the frame | [ ] |
| 2 | The back | [ ] |
| 3 | A side, or the top | [ ] |
| 4 | Underneath, or the inside | [ ] |
| 5 | The label or model number, readable | [ ] |
| 6 | **Every flaw, close up** | [ ] |

**Furniture:** add one photo with something for scale (a chair beside it, a tape measure along the front).
**Working electronics:** one photo of it switched on.
**Clothing:** laid flat or on a hanger against a plain wall, plus the size and care labels.

**Why you show the flaws:** a buyer who sees the chip and buys anyway doesn't send it back. A buyer who finds the chip at home does. Flaws in the photo are cheaper than returns.

**Never in the photo:** your house number, mail, family photos, kids, your car's plate, anything with your address on it.

**Batch 1 photo list**

| Item | 6 angles done | Flaws shown | Photos saved to album |
|---|---|---|---|
| | [ ] | [ ] | [ ] |
| | [ ] | [ ] | [ ] |
| | [ ] | [ ] | [ ] |
| | [ ] | [ ] | [ ] |
| | [ ] | [ ] | [ ] |
| | [ ] | [ ] | [ ] |
| | [ ] | [ ] | [ ] |
| | [ ] | [ ] | [ ] |

---

# PAGE 21 · Day 17: Titles, Descriptions and the Listing Tracker

**The title formula**

**Maker + Model/Pattern + What It Is + Key Detail (size, colour, count) + Condition**

| Weak title | Strong title (illustrative) |
|---|---|
| Old camera | [Maker] [Model] 35mm Film Camera Body, Black, Working, Shutter Fires |
| Nice bowls | [Maker] [Pattern] Glass Mixing Bowls, Set of 3, Used Good, One Small Chip |
| Drill | [Maker] 18V Cordless Drill with 2 Batteries and Charger, Used, Works |
| Coat | [Maker] Wool Overcoat, Men's Size 42, Camel, Used Excellent |

Use the words a buyer would type. Skip "L@@K," "rare," "vintage" (unless it really is) and "must see." The search box skips them too.

**The description template (copy, fill, paste)**

> **What it is:** [Maker] [Model / pattern] [item], [size / count].
> **Condition:** [Used good / excellent / fair]. Flaws: [list every one, matching the photos]. [Working, checked on (date) / Can't check it: sold for parts.]
> **Measurements:** [W × D × H, or size label].
> **What's included:** [everything in the photos / only the item shown].
> **Pickup or shipping:** [Ships within 2 business days, packed with care / Local pickup only, from my porch or a public spot].
> **Payment:** [Through the platform only / Cash or platform payment at pickup].
> [Only if true:] From a smoke-free home.

**Only promise a handling time you can keep every single day.** "Ships within 2 business days" is a promise, and platforms count a late shipment against you even if the buyer doesn't mind. If you're out at work all week or the post office is a drive, set the platform's handling time to 3 days and write 3 in the description. The two must match.

**Price format**

| Format | Use it when | Set it like this |
|---|---|---|
| **Fixed price + accept offers** | Most things | List at WORTH. Auto-decline offers below the price that still gives you your floor. |
| **Fixed price, no offers** | You're already at the bottom of the range | List at WORTH. |
| **Auction** | Only when there are 10+ recent sales and steady demand | Start at a price you'd be fine with. Never start an auction at a price that would upset you. |

**Listing tracker (paper version; the spreadsheet fills in the dates for you)**

| # | Item | Where | Listed price | Date listed | Day 14 date (drop 20%) | Day 28 date (to GIVE) | Sold date | Sold for | POCKET |
|---|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | | |
| 2 | | | | | | | | | |
| 3 | | | | | | | | | |
| 4 | | | | | | | | | |
| 5 | | | | | | | | | |
| 6 | | | | | | | | | |
| 7 | | | | | | | | | |
| 8 | | | | | | | | | |
| 9 | | | | | | | | | |
| 10 | | | | | | | | | |
| 11 | | | | | | | | | |
| 12 | | | | | | | | | |
| 13 | | | | | | | | | |
| 14 | | | | | | | | | |
| 15 | | | | | | | | | |

---

# PAGE 22 · Day 18: List Batch 1 + the Daily Ship Check

**The job (40 minutes):** list every item from photo batch 1. Copy the template, change the details, post. Done beats perfect.

**Before you press "list," check:**

- [ ] Title follows the formula
- [ ] Every flaw is in the photos **and** the description
- [ ] Price is the middle sale (the Tuesday price), not the best day ever
- [ ] Offers below my floor are set to auto-decline (where the platform allows it)
- [ ] Shipping weight and box size are right (weigh it in the box; don't guess)
- [ ] The handling time in the description matches the platform setting, and it's one I can keep every day
- [ ] No address, faces or mail anywhere in the photos
- [ ] Date listed, Day 14 and Day 28 dates are in my tracker (page 21)

**Packing kit (gather once, keep it in one box)**

- [ ] Boxes in three sizes (free ones from shops are fine; cover or remove old labels)
- [ ] Tape and a tape gun
- [ ] Padding: paper, bubble wrap, clean plastic bags
- [ ] A kitchen or luggage scale
- [ ] A black marker

**Packing breakables:** wrap each piece on its own. Two inches of padding on every side. Shake the box. If anything moves, add padding.

**After you list:** don't sit there refreshing it. The 14-Day Drop does the waiting for you. Check messages twice a day, morning and evening, and that's it.

**The standing rule from today: the Daily Ship Check.** From the moment batch 1 goes live, things can sell. Whatever else today's page says, do this every day from now to Day 30, and every day after that while anything is still listed. Tick the **Ship** column on the tracker (page 5).

1. Open each platform's orders page. Anything sold since yesterday?
2. Pack it (two inches of padding, shake test, tape).
3. Buy the label through the platform, to the order address only.
4. Drop it off or book the collection **inside the handling time the listing states.**
5. Upload the tracking number the same day.
6. Mark it Sold in your tracker (page 21) or the Sold Log, with what you actually got.

**Local sale?** Same rule, different job: confirm the pickup time within a day, and mark it Sold the evening it goes.

**Can't ship today?** Message the buyer this morning with the day it will go, and make sure that's still inside the handling time. If it can't be, raise the handling time on your other live listings now, before the next one sells.

| Day | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Orders checked | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| Sold since yesterday (count) | | | | | | | | | | | | | |
| All shipped on time + tracking up | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |

---

# PAGE 23 · Day 19: The Porch Rule (and the 8 scams to know)

**Rule 7: The Porch Rule.** Local pickups happen on the porch, the driveway or a public spot. Never inside. Never accept overpayment. No shipping-label "favors."

**Your Porch Rule setup**

- [ ] Big things go out to the garage or porch **before** the buyer arrives, so nobody needs to come in.
- [ ] Smaller items: meet in a public, busy, well-lit place. Many police stations offer a "safe exchange" spot; check yours.
- [ ] Daylight hours.
- [ ] Someone else knows the time, the place and the buyer's name. Better: someone's home with you.
- [ ] Payment in hand, and checked, **before** the item changes hands.
- [ ] Cash, or payment through the platform. Not a check. Not a payment-app transfer from a stranger that can be reversed.

**The 8 scams to know**

| # | Scam | What it looks like | What you do |
|---|---|---|---|
| 1 | **Overpayment** | "I sent you $500 for the $200 table by mistake, please refund the difference." | Never refund "extra." Cancel the sale. Real buyers don't overpay. |
| 2 | **Fake payment proof** | A screenshot, or an email that says "payment pending, ship first." | Only trust a payment you can see in your own account, logged in yourself. |
| 3 | **"My courier will collect"** | A buyer far away who's sending a mover, a cousin or a "shipping agent." | Decline. Local sales are cash or platform payment, face to face. |
| 4 | **QR-code payment** | "Scan this code to receive your money." | You never need to scan a code to *receive* money. Decline. |
| 5 | **The verification code** | "Send me the code I just texted you, to prove you're real." | Never share a code. It's how they take over your number or your account. |
| 6 | **Shipping-label "favor"** | "Use my prepaid label" or "ship it to this other address." | Ship only to the address on the order, with a label bought through the platform. |
| 7 | **Move off the platform** | "Text me / email me / pay outside the app, it's cheaper." | Stay on the platform. You lose its protection the moment you leave. |
| 8 | **The phishing link** | A message "from the platform" with a link to "accept payment" or "verify your account." | Don't click. Open the app yourself and check there. |

**If something feels off, it is.** Block, report it to the platform, move on. You can also report scams to the FTC at reportfraud.ftc.gov (US), Report Fraud, formerly Action Fraud (UK), the Canadian Anti-Fraud Centre (Canada) or Scamwatch (Australia).

---

# PAGE 24 · Buyer Scripts (copy and paste)

Short, polite, final. You don't owe anybody a debate.

**"Is this still available?"**
> Yes, it is. It's $[price]. Pickup is from [my porch / a public spot near X], [days/times]. Let me know a time that works.

**A lowball offer**
> Thanks for the offer. The lowest I can do is $[floor price]. If that works, it's yours.

**They push again**
> I understand. I'll stay at $[floor price] for now. If it's still here in a couple of weeks, I'll lower it.

**"Can you hold it for me?"**
> I can hold it until [time today/tomorrow]. After that it goes to the next person who can pick up.

**They want your address before agreeing to anything**
> Happy to share the pickup spot once we've agreed on a price and a time.

**They want to come inside, or look at other things**
> Everything I'm selling is listed. I'll have the [item] on the porch for you.

**No-show (send once, then move on)**
> Looks like today didn't work out. I'll offer it to the next person. If you're still interested, let me know.

**"Can you ship it?" (local-only item)**
> Sorry, it's local pickup only. It's too big to ship safely.

**Haggling at pickup**
> The price we agreed was $[price]. If that's changed, no problem. I'll keep it for the next buyer.

**After a local sale, they want to return it**
> It was sold as-is after you looked it over in person, so I'm not able to take returns. Thanks again.
*(For shipped sales, the platform's own return rules apply. Follow them.)*

**Any of the 8 scams**
> No thanks. Cash or platform payment at pickup only.
*Then block and report.*

---

# PAGE 25 · Day 20: Batch 2 · Day 21: Week 3 Scorecard

**Day 20: photos and listing, batch 2.** Same as Days 16–18, faster. Use the template. Don't rewrite descriptions from scratch: change the details, keep the bones.

- [ ] Batch 2 photographed (six angles, flaws shown)
- [ ] Batch 2 listed
- [ ] Tracker dates filled in

**Day 21: Week 3 Scorecard**

| Number | Week 1 | Week 2 | Week 3 |
|---|---|---|---|
| Found | | | |
| Priced | — | | |
| Listed (live right now) | — | — | |
| Sold | — | — | |
| Given or gone | | | |
| Hours | | | |
| POCKET received so far (your number, for you) | — | — | |
| Messages from buyers | — | — | |
| Sales shipped inside the handling time (on time / sold) | — | — | / |
| Days ticked (out of 7) | | | |

**The loop**

| If… | Then… |
|---|---|
| Lots of views, no messages | Price is above the middle sale, or the photos don't show enough. Check both. |
| Lots of messages, no sales | The listing is missing something buyers ask about (size, condition, pickup). Add it to the description. |
| Most messages were lowballs | Normal. Use the script. Don't drop early: the 14-Day Drop handles it. |
| More than 3 hours spent listing fewer than 5 things | Raise your floor for the rest of the month, and bundle more. |
| Nothing listed yet | List one thing today. Just one. The best one. |
| Any sale shipped late | Raise the handling time on every live listing today, and do the Daily Ship Check before anything else each morning. |

> **Audio pep talk 3 ("Clear it properly") is in your downloads.** Play it before Day 22.

---

# PAGE 26 · WEEK 4 · CLEAR · Day 22: The GIVE Run

GIVE is not a failure pile. GIVE is where your stuff goes to get used, which is what it was for in the first place.

**Call first.** Donation centers turn things away all the time: big furniture, china, anything stained or broken. Five minutes on the phone saves you a wasted trip and a guilty U-turn back into your driveway.

**The call-first script**

> Hi, I've got some things to donate this week. Do you take [furniture / kitchenware / clothes / books / kids' items]? Is there anything you're not taking right now? What are your drop-off hours, and do you do pickup for big items?

**What donation centers usually turn down (call to check yours)**

- Mattresses and box springs
- Cribs, car seats and other kids' safety gear
- Large or heavy furniture, especially upholstered (in the UK, upholstered furniture usually needs its fire-safety label to be accepted)
- Formal china and big sets of dishes (often)
- Old TVs and computer monitors
- Encyclopedias and old textbooks
- Anything stained, broken, smelly or missing parts
- Recalled products (never donate these; see page 29)

**Where the "no" items can go instead**

| Item | Try |
|---|---|
| Furniture in good shape | A furniture bank, a building-materials reuse store, a local "free" listing |
| Towels, blankets, old bedding | An animal shelter (call first) |
| Books | A library's friends group, a school, a little free library |
| Working tools | A community tool library, a school shop class, a makerspace |
| Craft supplies | A school, a senior center, a scout group |
| Business clothes | A job-readiness charity |
| Anything usable | A local "free" or "buy nothing" group: post it, set a pickup time, porch it |

**GIVE log**

| Where it went | How many items / bags | Date | Receipt? (US: keep it if you'll claim a deduction) |
|---|---|---|---|
| | | | [ ] |
| | | | [ ] |
| | | | [ ] |
| | | | [ ] |

*US donation receipts are general info, not advice: for noncash donations over $500 in total, the IRS asks for Form 8283, and a single item or group of similar items claimed at over $5,000 needs a qualified appraisal. See irs.gov, Publication 561.*

---

# PAGE 27 · Days 23–24: GONE, Done Properly

**GONE gets done properly.** Some things can't go in the bin. Some can't go on the tree lawn. Look up your own town's rules once, write them here, and you've got them forever.

**The special stuff**

| What | Why it's special | What to do | My local drop-off (write it in) |
|---|---|---|---|
| **Batteries** (especially lithium: phones, tools, laptops, vapes) | Fire risk in trucks and bins | Tape the ends. Take to a battery drop-off (many hardware and electronics stores have one). | |
| **Electronics** (e-waste) | Metals and chemicals | E-waste drop-off, a retailer take-back program, or your town's e-waste day | |
| **Old phones, tablets, laptops** | Your data | **Before anything else:** back up, sign out of every account, factory reset, take out the SIM and memory card. Then sell, give or recycle. | |
| **Paint, solvents, chemicals, old fuel** | Hazardous waste | Your household hazardous waste site. Never down a drain. (Some towns let you dry out latex paint and bin it; check yours.) | |
| **Medicines** | Safety and water | US: a pharmacy take-back kiosk or a DEA Take Back Day; if there's none, follow FDA disposal guidance at fda.gov. UK: take them back to a pharmacy. | |
| **Light bulbs (CFL), thermostats with mercury** | Mercury | Hazardous waste site or a retailer take-back | |
| **Tires, appliances with refrigerant** | Special handling | Town rules vary; many need a scheduled pickup or a fee | |

**Bulk pickup and haul-away (Day 24): fill this in once**

| Question | My town's answer |
|---|---|
| Is there bulk pickup? How often? | |
| What does it take? | |
| What does it refuse? | |
| Do I need to book it? | |
| How much can I put out? | |
| When can it go out (the night before, the morning of)? | |
| Is there a dump/tip/transfer station, and what does it charge? | |
| Website or phone number where I found this | |

**Day 23 checklist**
- [ ] Phones and computers wiped
- [ ] Batteries taped and bagged
- [ ] E-waste bagged
- [ ] Hazardous waste boxed and dropped off (or date booked: ________)
- [ ] Medicines dropped off

**Day 24 checklist**
- [ ] Bulk pickup booked or hauled
- [ ] Everything else in GONE out of the house

---

# PAGE 28 · The GONE Pile: Bulk Day Rules

Bulk pickup only takes what your city says it takes. Not what you hope it takes.

**Before it goes to the curb (tree lawn, verge, kerb):**
- [ ] It's on my town's "yes" list (page 27).
- [ ] It's not hazardous, not e-waste, not anything with refrigerant (unless my town says so).
- [ ] Doors are off anything a child could climb into: old fridges, freezers, chests. **Always.**
- [ ] Nothing has personal papers, photos or mail inside (check every drawer of every dresser).
- [ ] It goes out in the window my town allows, not three days early.

**Usable things on the curb**
In a lot of places, people pick through bulk pickup and take what works. If your town allows it, put working things a little apart from the broken ones, with a "FREE: WORKS" sign. If your town doesn't allow it, don't.

**Shredding**
Old bank statements, tax papers, medical letters: shred them, or use a community shred day. Check how long you need to keep tax records first (US: generally at least 3 years; UK: generally at least 22 months after the end of the tax year for personal returns, longer in some cases; check the official guidance).

**GONE log**

| What | How it left (bin, recycling, hazardous site, bulk pickup, e-waste, shred) | Date |
|---|---|---|
| | | |
| | | |
| | | |
| | | |
| | | |

---

# PAGE 29 · Day 25: Things You Can't (or Shouldn't) Sell

Check every item in your SELL and GIVE piles against this page. It's the most important ten minutes of the month.

| Item | Why | What to do |
|---|---|---|
| **Recalled products** | It's illegal to sell recalled products in the US. | Search the item at cpsc.gov/recalls (US) or the UK Product Safety Database. Follow the recall's instructions (often a free repair, refund or disposal). |
| **Drop-side cribs, and cribs made before 28 Jun 2011 without proof they meet the current standard** | Banned from resale under CPSC rules. | Take it apart so nobody can use it, then dispose of it. |
| **Car seats** | Many platforms and charities won't take them; you can't show crash history, and seats expire. | Check the expiry label. Many retailers run trade-in events for recycling. |
| **Elephant ivory** (and rhino horn) | A US federal near-total ban on commercial sale, plus state bans; similar rules in the UK. | Don't list it. If it's an old family piece, keep it or get specialist advice. |
| **Firearms and ammunition** | Strict laws. | Not a marketplace job. A licensed dealer or your local police can advise. |
| **Prescription medicines** | Illegal to sell. | Take-back (page 27). |
| **Alcohol** | Needs a licence in most places. | Drink it with someone you like, or give it to a friend. |
| **Opened cosmetics and toiletries** | Hygiene and platform rules. | GONE. |
| **Counterfeits or "inspired by" items** | Illegal to sell as genuine; banned on platforms. | Don't sell fakes. Not even the cute ones. |
| **Items platforms ban** (e.g. hate-symbol memorabilia) | Platform rules. | Check the platform's prohibited items page before listing anything unusual. |
| **Anything that isn't yours** | Obvious, but it happens. | Back to the owner (page 8). |

**My recall checks**

| Item | Checked on (site) | Date | Clear? |
|---|---|---|---|
| | | | [ ] Yes [ ] Recalled |
| | | | [ ] Yes [ ] Recalled |
| | | | [ ] Yes [ ] Recalled |
| | | | [ ] Yes [ ] Recalled |

---

# PAGE 30 · Days 26–28: The 14-Day Drop · The Sweep · The Shipping Check

**Rule 6: The 14-Day Drop.** No sale in 14 days: drop 20%. No sale at 28 days: it goes to GIVE.

Why 20%? Because a small drop doesn't change anything and a big one throws money away. Why 28 days? Because a thing that's been for sale for a month is taking up room in your house *and* your head.

**Day 26: set up the drop (the drop runs past Day 30, and that's fine; the calendar does the remembering)**

1. For every listed item, put two alarms in your phone: **Day 14 (drop 20%)** and **Day 28 (to GIVE)**. Or let the Sold Log spreadsheet flag them.
2. Anything that's already been listed 14 days: drop it today.

**Drop calculator**

| Item | Listed at | × 0.8 = Day 14 price | Below my floor now? (then it goes to GIVE instead) | Day 28: still here? → GIVE |
|---|---|---|---|---|
| | | | [ ] | [ ] |
| | | | [ ] | [ ] |
| | | | [ ] | [ ] |
| | | | [ ] | [ ] |
| | | | [ ] | [ ] |
| | | | [ ] | [ ] |
| | | | [ ] | [ ] |
| | | | [ ] | [ ] |

**Day 27: the sweep.** Pick the zone you rushed in Week 1. Do one more pass with the three piles. Ten-second rule. You'll find things. You always do.

- [ ] Sweep done in: ______________________

**Day 28: the shipping check.** You've been shipping every day since Day 18 (page 22). Today you make sure nothing slipped through.

- [ ] Every platform's orders page: no order says "awaiting shipment"
- [ ] Every shipped order has a tracking number uploaded
- [ ] Every local sale is collected, or has a pickup time agreed in writing
- [ ] Every sale is marked Sold in my tracker, with what I actually got (POCKET)
- [ ] Every Ship box on the tracker (page 5) from Day 18 is ticked, or the slip is fixed today
- [ ] Any buyer message about delivery answered

*Found one that's late? Ship it today, upload the tracking, and send the buyer one line: "Sorry for the delay. It went out today; tracking is on the order." Then check the Slip Page (page 34).*

> There she goes.

---

# PAGE 31 · Days 29–30: The Keep Box Review

**Day 29: Week 4 Scorecard**

| Number | Week 1 | Week 2 | Week 3 | Week 4 |
|---|---|---|---|---|
| Found | | | | |
| Priced | — | | | |
| Listed | — | — | | |
| Sold | — | — | | |
| Given or gone | | | | |
| Shipped on time (on time / sold) | — | — | / | / |
| Hours | | | | |
| Days ticked (out of 7) | | | | |

**Day 30: open the Keep Box**

Take everything out. One at a time, ask:

| Item | Still belongs in the box? | If not: who'd want it, or what's its story? |
|---|---|---|
| | [ ] Yes [ ] No | |
| | [ ] Yes [ ] No | |
| | [ ] Yes [ ] No | |
| | [ ] Yes [ ] No | |
| | [ ] Yes [ ] No | |
| | [ ] Yes [ ] No | |
| | [ ] Yes [ ] No | |
| | [ ] Yes [ ] No | |

**Write one story down.** Pick one thing in the box. Write who it belonged to, where it came from, and why it matters, on a card. Put the card in the box with it. A thing without its story is just a thing to whoever opens the box next.

______________________________________________________________

______________________________________________________________

**The after photo.** Same spot as the before photo on page 6. Same angle.

- [ ] After photo taken

> **Audio pep talk 4 ("Keep the story") is in your downloads.**

---

# PAGE 32 · Your Final Scorecard

| | Total for 30 days |
|---|---|
| **Found** (items decided on) | |
| **Priced** (Tag Cards done) | |
| **Listed** | |
| **Sold** | |
| **Given** | |
| **Gone (properly)** | |
| **Still listed** (the Drop is working on these) | |
| **Hours** | |
| **Days ticked** | ___ / 30 |
| **POCKET received** (your number, for you) | |

**The house result**

My finish line from page 6 was: ________________________________________

- [ ] Done
- [ ] Mostly done
- [ ] Not yet: here's what's left: ________________________________

**Three numbers that tell you how it went**

| Measure | How to work it out | Mine |
|---|---|---|
| **Clear rate** | (Sold + Given + Gone) ÷ Found | % |
| **Sell-through** | Sold ÷ Listed | % |
| **Hours per item cleared** | Hours ÷ (Sold + Given + Gone) | |

There's no passing grade. These are for next time.

---

# PAGE 33 · The Measurement Loop: What to Change Next Time

Read your Final Scorecard against this table. Change one thing, not five.

| What you see | What it usually means | The one change |
|---|---|---|
| Sell-through under 30% | Prices above the middle sale, or the wrong channel | Re-check the sold filter for your unsold items, and try the channel's second choice from page 18 |
| Sell-through over 80% | Your prices may be on the low side, or you only listed sure things | Fine either way. Next time, check the top of the range on items with 10+ sales. |
| Lots of hours, few items cleared | Too much research or too many small listings | Raise your floor. Bundle more. Give more. |
| Clear rate under 50% | Decisions put off ("maybe" piles) | Next round, use a 90-day "maybe" box with a date on it. When the date comes, it goes. |
| Days ticked under 15 | The appointment time doesn't fit your life | Move it. Mornings, lunch, right after dinner. Pick the one you'd actually keep. |
| Most POCKET came from 2 or 3 items | Normal. A few things carry most houses. | Next time, price the likely ones first (the Real-Worth Cheat Sheet, page 45, left column). |
| GIVE and GONE didn't leave the house | The last mile is the hardest | Book the drop-off on Day 1 next time, so the date is already set. |

**The Quarterly Audit (keep it going without starting over)**

Every three months, run a mini version. Put the dates in your calendar now.

| Quarter | Date | Zone | Done |
|---|---|---|---|
| 1 | | | [ ] |
| 2 | | | [ ] |
| 3 | | | [ ] |
| 4 | | | [ ] |

Day 1: one zone, three piles. Day 2: Tag Cards for anything over the floor. Day 3: list. Day 4: GIVE and GONE out the door. That's it.

---

# PAGE 34 · The Slip Page: What to Do When You Slip

Everybody slips. The plan expects it. Find your slip below and do what it says. **Don't restart from Day 1. Don't do two days at once.**

| The slip | What to do today |
|---|---|
| **I missed a few days.** | Do today's page. Mark the missed days "skipped," not "failed." If you missed 7 or more, do the 3-Day Catch-Up below, then carry on. |
| **I bought something that didn't pass the Bread-Maker Test.** | Check the return window first. If you're keeping it, run One In, Two Out today: two things from the same room or job leave this week. Write down what set it off (a sale email, a bad day, a scroll). Unsubscribe from that one. |
| **Nothing's selling.** | Normal for the first week of a listing. Let the 14-Day Drop work. If it's been 14 days, check the price against the middle sale and the photos against page 20. If it hits 28 days, GIVE it, and count that as a win. |
| **I can't let go of something.** | Put it in the Keep Box, and take something else out. Or photograph it, write the story, and give it to someone who'll use it. Or put it in a "maybe" box with a date 90 days out. When the date comes, it goes. |
| **Someone in the house is upset I'm getting rid of things.** | Stop selling anything that isn't clearly yours. Use the "Is it mine?" script (page 8). Give them the ASK box and a date. |
| **A buyer got weird.** | You owe them nothing. Block, report, move on. Re-read the Porch Rule (page 23). |
| **I sold something and now I regret it.** | It happens. Write down the story of it tonight. That's the part you were really keeping. |
| **Things sold for less than I hoped.** | Paid's a story. The money in your hand is more than the money in the attic. And the space is back. |
| **I'm overwhelmed.** | Shrink it. Fifteen minutes. One drawer. Do the 15-Minute Drawer Audit on page 44 and stop. Tomorrow, one more drawer. |
| **I shipped something late, or I'm about to.** | Ship it today and upload the tracking. Send the buyer one line: "Sorry for the delay. It went out today; tracking is on the order." Then raise the handling time on your other live listings so it can't happen twice, and do the Daily Ship Check (page 22) first thing each morning. |
| **I'm stuck at the same zone for days.** | Skip to the next zone. Come back to it on Day 27, the sweep. |
| **Life happened (illness, work, family).** | Pause. Write today's date here: ________. When you're back, start at the day you stopped. The book doesn't expire. |

**The 3-Day Catch-Up (if you missed 7 or more days)**
- **Day A:** Keep Box check (is it done?) + one zone, three piles, 20 minutes.
- **Day B:** Tag Cards for your best five SELL items only.
- **Day C:** List one thing. Take one bag to GIVE. Then rejoin the plan on today's date.

**If letting go of things causes you real distress, or the clutter is affecting your health or safety, that's not a willpower problem and it's not something this book is for. The International OCD Foundation has hoarding resources at hoarding.iocdf.org. If you're in crisis, call or text 988 (US), Samaritans on 116 123 (UK), 988 (Canada) or Lifeline on 13 11 14 (Australia).**

---

# PAGE 35 · Tax Notes (general information, not advice)

Selling your own used things is usually not a tax event. But "usually" isn't "always," so here are the official pages. Check your own situation, or ask a qualified tax professional.

**United States**
- Personal items sold **for less than you paid** aren't taxable income. Items sold **for more than you paid** can be a taxable gain.
- Payment platforms send a **Form 1099-K** when you're paid **over $20,000 and over 200 transactions** in a year (the threshold restored by the 2025 law). Some states have lower thresholds. Getting a 1099-K for personal items sold at a loss doesn't make them taxable; the IRS FAQs explain how to report it.
- Official page: **IRS, Form 1099-K FAQs** (irs.gov/newsroom/form-1099-k-faqs-common-situations)
- Keep a simple record of what you paid (a receipt, a bank statement, or your best note) for anything that might sell for more than you paid.

**United Kingdom**
- Selling your own possessions usually needs no report to HMRC.
- **Capital Gains Tax may apply** if you sell a single possession, or a set (such as matching vases), **for £6,000 or more**; the gain is then worked out separately. Cars, and items with a limited lifespan (such as clocks), are usually exempt.
- Online platforms report sellers with **30 or more sales, or about €2,000 (about £1,700)** in a year to HMRC. That's a report, not a tax bill. If you're only selling your own things, you usually won't owe anything.
- Official pages: **GOV.UK, Capital Gains Tax on personal possessions** (gov.uk/capital-gains-tax-personal-possessions) and **GOV.UK, Check if you need to tell HMRC about income from online platforms** (gov.uk/guidance/check-if-you-need-to-tell-hmrc-about-your-income-from-online-platforms)

**Canada**
- Official page: **Canada Revenue Agency, personal-use property** (search "personal-use property" on canada.ca).

**Australia**
- Official page: **Australian Taxation Office, personal use assets** (search "personal use assets" on ato.gov.au).

*This page describes the official guidance in general terms as of October 2026. It isn't tax advice. Rules change; the official pages are the final word.*

---

# PAGE 36 · After Day 30: Keep It Clear

You just spent a month getting things out. Here's how they don't come back in.

**Rule 8: The Bread-Maker Test (before you buy anything)**

| Step | Your answer |
|---|---|
| 1. Name the one job it does. | |
| 2. Name three specific days in the next 30 when you'll use it. | 1. ________ 2. ________ 3. ________ |
| 3. Look up its used exit price (sold filter). | $ |
| 4. Cost of owning it = (price − exit price) ÷ the uses you named. | $ per use |
| 5. **Can't name three days? It's a bread maker. Don't buy it.** | [ ] Buy [ ] Borrow [ ] Skip |

*Illustrative example (not data): a $129 steamer, a used exit price of about $25, one named use (a wedding in March). That's $104 for one use. Borrow one.*

**Rule 9: One In, Two Out**

1. Something new passes the Bread-Maker Test and comes home.
2. Within 7 days, two things leave: sold, given or gone.
3. Same room or same job. A pan for a pan. A throw for a throw.

**One In, Two Out tracker**

| Date in | What came in | Out #1 | Out #2 | Within 7 days? |
|---|---|---|---|---|
| | | | | [ ] |
| | | | | [ ] |
| | | | | [ ] |
| | | | | [ ] |
| | | | | [ ] |
| | | | | [ ] |

> Spend it on the people.

---

# PAGE 37 · Your Bonus Stack

Everything below is included. Nothing to unlock, nothing to upgrade.

| # | Bonus | What it does | Where it is |
|---|---|---|---|
| 1 | **The Sold Log spreadsheet** | Works out the middle sale, flags "thin," does POCKET maths, sets your Day 14 and Day 28 dates and keeps your scorecard | Google Sheets copy link + Excel file, in your download email |
| 2 | **Printable tags and pile signs** | PAID / WORTH / POCKET tags, SELL / GIVE / GONE / ASK signs, a "FREE: WORKS" curb sign | Page 39 + a print-ready PDF |
| 3 | **Four audio pep talks** | 90 seconds each, one per week | MP3s in your downloads; scripts on page 40 |
| 4 | **The Bread-Maker wallet card + 30-day no-buy squares** | Pairs the sell with a no-buy, so the space stays clear | Page 41 |
| 5 | **Eight listing templates by category** | Fill-in titles and descriptions for the things people sell most | Page 42 |
| 6 | **The Seven-Day Sprint** | The whole plan squeezed into one week, for when you're moving soon | Page 43 |
| 7 | **The January group start** | A light-touch extra, not coaching. Start on Mon 11 Jan 2027 on a shared calendar. Each Monday for four weeks, an automated email brings that week's one-page focus sheet (the seven jobs with the group's real dates filled in), a calendar file that drops the week's seven appointments into your phone, and the week's scorecard prompt with its if-then loop | Included if you buy by Sun 10 Jan 2027, 11:59 pm ET, when the group list closes. The invitation arrives Mon 4 Jan 2027, or straight away if you buy after that. Bought later? The book works the same at your own pace. |
| 8 | **The 15-Minute Drawer Audit** | One drawer, fifteen minutes, three piles, one keep. For the overwhelmed days and the Quarterly Audit | Page 44 |
| 9 | **The Real-Worth Cheat Sheet** | Which categories usually sell and which usually sell for a fraction, checked against cited public sales. Tendencies, not prices | Page 45 |

---

# PAGE 38 · Bonus 1: The Sold Log Spreadsheet

**Get it:** open the link in your download email, then **File → Make a copy.** It's yours. Prefer Excel? The .xlsx is in the same email.

**Tab 1: Tag Cards** (one row per item)

| Column | What you type | What the sheet does |
|---|---|---|
| Item (five facts) | Maker, model, size, colour, condition | — |
| Sold price 1 to 15 | Each sold price you found | Counts them (n) |
| n | — | `=COUNT(sold prices)` |
| WORTH | — | Middle sale if n ≥ 10; otherwise shows "thin: low–high" |
| Fee % / flat fee | From the platform's fee page | — |
| Shipping + packing | Your estimate | — |
| POCKET | — | WORTH − fees − shipping − packing |
| Over my floor? | — | YES / NO against the floor you set on the Settings tab |
| Pile | — | SELL if YES; "GIVE?" if NO |

**Tab 2: Listings**

| Column | What you type | What the sheet does |
|---|---|---|
| Item | Picked from Tab 1 | — |
| Where | Platform or local | — |
| Listed price | Your price | — |
| Date listed | The date | Day 14 date (= date + 14) and Day 28 date (= date + 28) |
| Day 14 price | — | Listed price × 0.8; flags red if that's below your floor |
| Status | Live / Sold / Given | Turns the row orange on Day 14 and grey on Day 28 if still live |
| Sold for, fees, shipping | Your actual numbers | Your actual POCKET |

**Tab 3: Scorecard.** Pulls your weekly numbers automatically: found, priced, listed, sold, given, gone, hours (you type hours), clear rate, sell-through, hours per item cleared.

**Tab 4: Settings.** Your floor (default $10), your currency, your drop percentage (default 20%).

**Tab 5: Fee notes.** A blank table for the fees you looked up on Day 11, with the date you checked. Fees change; the sheet reminds you to re-check after 90 days.

*The sheet works offline once copied. Nothing you type is sent anywhere.*

---

# PAGE 39 · Bonus 2: Printable Tags and Pile Signs

Print on card stock if you have it, plain paper if you don't. Cut on the dotted lines. Punch a hole, add string or a rubber band.

**The Tag (print 12 per sheet)**

```
 _________________________________
|  o                              |
|  ITEM: ________________________ |
|  PAID:   $______                |
|  WORTH:  $______  (n = ___)     |
|  POCKET: $______                |
|  [ ] SELL   [ ] GIVE   [ ] GONE |
|  Listed: __/__   Drop: __/__    |
|_________________________________|
```

**Pile signs (one per sheet, landscape, big letters)**

- **SELL** · *over my floor, priced, tagged*
- **GIVE** · *works, somebody can use it*
- **GONE** · *broken, expired, done (special stuff separate)*
- **ASK** · *not mine to decide*
- **KEEP BOX** · *one box. It has to close.*

**Curb sign (only where your town allows curbside taking)**

- **FREE · WORKS · PLEASE TAKE**

**Door sign for donation bags**

- **GIVE RUN: [place] · [day]** *(so the bags leave on the day you wrote)*

---

# PAGE 40 · Bonus 3: The Four Audio Pep Talks (scripts)

*These are generated in Walt's AI character voice. About 90 seconds each.*

**Pep talk 1 · Week 1's the hard one** *(play before Day 8)*

> It's Walt. Quick one. Week one's the hard one, and you're through it or close to it. Here's the thing. Most of what you pulled out this week isn't worth much money. That's not bad news. That's normal. A house is mostly ordinary things, and ordinary things are for using, not for selling. Next week you find out which few are worth a listing. You'll look up what they actually sold for. Not what somebody's asking. What somebody paid. Some of it'll surprise you. Most of it won't. Either way you'll know, and knowing beats guessing every time. If you missed a day or three, don't start over. Turn to today's page. A half day is a day. And if the Keep Box isn't full yet, that's fine too. It doesn't have to be full. It has to close. Go put your GIVE bags by the door so you see them every morning. That's it. Week two. Let's go look some prices up.

**Pep talk 2 · Paid's a story** *(play before Day 15)*

> Walt again. You've got numbers now. Some of them stung. You paid two hundred for something and it sells for forty. Look. That's not you getting it wrong. That's just what happens to most things the minute they come home. What you paid is history. Paid's a story. Sold's a fact. The only question left is the one in front of you: is it worth your evening to sell it? If what you'd keep is under your floor, give it to somebody who'll use it, and have your evening back. If it's over, it's a listing. This week you list. Daylight, plain background, six angles, show the flaws. Price it like it's Tuesday. The middle sale, not the best day ever. And bud, don't sit there refreshing the listing. The fourteen-day drop does the waiting for you.

**Pep talk 3 · Clear it properly** *(play before Day 22)*

> It's Walt. Week four. Some things sold. Some things didn't. Some things got a message from somebody who wanted it for a third of the price and a ride home. That's selling. Here's this week. You clear. Call before you donate. It saves you a trip and a guilty drive back up the driveway. Batteries get taped. Paint goes to the hazardous drop-off, never the drain. Phones get wiped before anything else. And whatever your town's bulk pickup takes, that's what goes out. Not what you hope it takes. The things still listed? They'll drop twenty percent at fourteen days. At twenty-eight, they go to give. That's not giving up. That's the rule doing its job, so you don't have to stand there arguing with a lamp.

**Pep talk 4 · Keep the story** *(play on Day 30)*

> Walt. Day thirty. Go take your after photo before you listen to the rest of this. … Okay. Here's the last job, and it's the one that matters. Open the Keep Box. Take each thing out. Ask if it still belongs. Then pick one, and write its story on a card. Who it belonged to. Where it came from. Why you kept it. Put the card in with it. Because a thing without a story is just a thing to whoever opens that box next. Whatever you sold, whatever you gave away, whatever went to the curb, the space is back now, and the stuff that mattered is in one box with its stories. Next time something new wants to come home, ask it the bread-maker question. Can you name three days you'll use it? No? Then it's a bread maker. Keep the story. Sell the stuff. Spend it on the people.

---

# PAGE 41 · Bonus 4: The Bread-Maker Wallet Card + 30 No-Buy Squares

**Wallet card** (cut out, fold in half, keep it behind your bank card)

```
 ____________________________________________
| THE BREAD-MAKER TEST                       |
| 1. What's its ONE job?                     |
| 2. Name 3 days in the next 30 I'll use it. |
| 3. What does it sell for used?             |
| 4. (Price − used price) ÷ uses = cost/use  |
| 5. Can't name 3 days? It's a bread maker.  |
|    Walk away.                              |
|____________________________________________|
```

**30 No-Buy Squares**

Pair the sell with a no-buy. Every day you don't buy something you don't need, tick the square. Write in the box anything you *almost* bought, and what you did instead.

| | | | | |
|---|---|---|---|---|
| 1 [ ] | 2 [ ] | 3 [ ] | 4 [ ] | 5 [ ] |
| 6 [ ] | 7 [ ] | 8 [ ] | 9 [ ] | 10 [ ] |
| 11 [ ] | 12 [ ] | 13 [ ] | 14 [ ] | 15 [ ] |
| 16 [ ] | 17 [ ] | 18 [ ] | 19 [ ] | 20 [ ] |
| 21 [ ] | 22 [ ] | 23 [ ] | 24 [ ] | 25 [ ] |
| 26 [ ] | 27 [ ] | 28 [ ] | 29 [ ] | 30 [ ] |

**The ones I almost bought** (this is the useful list; it shows you your triggers)

| Day | What | What set it off (ad, sale email, bad day, scroll) | What I did instead |
|---|---|---|---|
| | | | |
| | | | |
| | | | |
| | | | |

**Allowed during the 30 days:** food, medicine, bills, replacing something that broke and that you need, gifts you'd already planned, and anything that passes the Bread-Maker Test.

---

# PAGE 42 · Bonus 5: Eight Listing Templates

Fill the brackets. Delete what doesn't apply. Every template includes the flaws line on purpose.

**1. Hand tools**
> **Title:** [Maker] [Tool type] [Size/No.], [Material], Used, [Condition]
> [Maker] [tool], [size or number]. Used, [good/fair]. Flaws: [surface rust / handle wear / none visible]. [Sharp / needs sharpening]. Ships within 2 business days. Photos show the exact item.

**2. Cordless power tools**
> **Title:** [Maker] [Voltage] [Tool], with [number] Batteries and Charger, Used, Works
> [Maker] [voltage] [tool]. Includes [number] batteries ([Ah] each) and charger. Working, checked on [date]. Flaws: [scuffs / none]. Batteries charge and hold [describe]. Local pickup or shipped.

**3. Kitchen machines**
> **Title:** [Maker] [Model] [Appliance], [Colour], [Capacity], Used, Works
> [Maker] [model] [appliance], [colour]. Includes [bowl / attachments / manual]. Working, checked on [date]. Flaws: [list]. Clean and ready to use.

**4. Glass bakeware and kitchenware**
> **Title:** [Maker] [Pattern] [Item], [Size], [Count], Used, [Condition]
> [Pattern name] [item], [size]. [Count] pieces. Flaws: [chips / scratches / fading, each shown in photos]. Wrapped individually, double-boxed.

**5. Film cameras and lenses**
> **Title:** [Maker] [Model] [Format] Camera [Body / with Lens], [Condition], [Working / For Parts]
> [Maker] [model]. [Shutter fires at all speeds / meter works / not checked]. Lens: [clean / light haze / fungus]. Flaws: [list]. [Sold for parts if not checked.]

**6. Furniture (local)**
> **Title:** [Material] [Item], [Style], [W × D × H], Local Pickup
> [Solid wood / veneer] [item]. Measures [W × D × H]. Flaws: [scratches / water ring / loose drawer]. Pickup from my porch/garage, [days/times]. Please bring help to lift. Cash or platform payment at pickup.

**7. Clothing and outerwear**
> **Title:** [Maker] [Item], [Gender] Size [X], [Colour], [Material], Used, [Condition]
> [Maker] [item], size [X] (measures [pit to pit / length]). [Material]. Flaws: [list or "none visible"]. From a [smoke-free / pet-free] home [only if true].

**8. Media (records, games)**
> **Title:** [Artist / Title] [Format], [Pressing / Edition if known], [Media condition] / [Sleeve or case condition]
> [Title], [format]. Media: [condition]. Sleeve/case: [condition]. [Plays without skips, checked on [date] / not played]. Packed flat and stiff.

---

# PAGE 43 · Bonus 6: The Seven-Day Sprint (when you're moving soon)

Same rules, one week. You'll sell less and give more, and that's the right trade when the truck's booked.

| Day | Job | Done |
|---|---|---|
| 1 | Keep Box (30 min). Then every zone, fast, three piles. Ten-second rule. | [ ] |
| 2 | Tag Cards for the SELL pile. **Raise your floor to $25** this week. | [ ] |
| 3 | Photos and list everything over the floor. Local-only for big items, priced at the low end of the range. | [ ] |
| 4 | GIVE run (call first). Book bulk pickup or a haul-away. | [ ] |
| 5 | GONE run: e-waste, batteries, paint, medicines. Wipe phones and computers. | [ ] |
| 6 | Drop anything unsold by 20%. Answer messages twice a day. Porch Rule. | [ ] |
| 7 | Anything unsold goes to GIVE or a buyout. Keep Box review. Pack the box first. | [ ] |

**Shipping in a sprint:** from Day 3, the Daily Ship Check (page 22) runs every day. Set every listing's handling time to one you can keep while you pack a house (3 business days is safer than 1), and make sure everything sold has shipped, with tracking, before the truck comes. If a sale lands after the move, ship it from the new address inside the same handling time.

**For a whole house** (a parent's, or your own, with family involved): you'll want a plan for dividing things fairly before anything gets sold. That's a separate, bigger job.

---

# PAGE 44 · Bonus 8: The 15-Minute Drawer Audit

**One drawer. Fifteen minutes. Three piles. One thing you keep.** Use it on the days the full page is too much (the Slip Page sends you here), for the Quarterly Audit (page 33), or to get someone else in the house started.

**What you need**

- [ ] A timer (your phone's fine)
- [ ] Three spots on a table or the floor, labelled **SELL**, **GIVE**, **GONE** (the pile signs on page 39 work)
- [ ] One small box or bag for **KEEP**
- [ ] A pen

**The rules**

1. **One drawer only.** Not "the drawer and the cupboard above it." One.
2. **Everything comes out.** Tip it onto a towel. Empty drawer, then decide.
3. **KEEP gets one thing.** Just one from this drawer. The thing with a story. (If it's important enough, it goes in the Keep Box.)
4. **SELL is for things you think somebody would pay real money for.** You'll check that with a Tag Card (page 13). For now, a guess is fine.
5. **GIVE is for things that work and somebody could use.**
6. **GONE is for broken, dried-up, expired, and "what is this."** Batteries and old electronics don't go in the kitchen bin. They go in a separate bag for the right drop-off (page 27).
7. **What goes back in the drawer has to have a job.** If you can't say its job in five words, it's not going back.

**The 15 minutes**

| Minutes | Do this | Done |
|---|---|---|
| 0–2 | Empty the drawer onto a towel. Wipe the drawer out. | [ ] |
| 2–9 | Pick up each thing once. Put it straight on a pile. No second thoughts yet. | [ ] |
| 9–11 | Pick your ONE keep. Write down why on the line below. | [ ] |
| 11–13 | Put back only what has a job. Count what's left in each pile. | [ ] |
| 13–15 | Bag up GONE and GIVE. Put them by the door. SELL items go on the Tag Card page (page 13) or the Sold Log. | [ ] |

**My count (four drawers, one column each)**

| Pile | Drawer 1: ______ | Drawer 2: ______ | Drawer 3: ______ | Drawer 4: ______ |
|---|---|---|---|---|
| KEEP | 1 | 1 | 1 | 1 |
| Back in the drawer (has a job) | | | | |
| SELL (to check) | | | | |
| GIVE | | | | |
| GONE | | | | |
| **Total that came out** | | | | |
| Date | | | | |

**My one keep, and why:** ______________________________________________

> A normal drawer gives you one or two things worth checking. Sometimes none. That's still a good drawer. Now it closes.

---

# PAGE 45 · Bonus 9: The Real-Worth Cheat Sheet

Which way categories **usually** go, from public sold-price research. These are tendencies, not prices. There are always exceptions, which is why you look up **your exact item**, sold not listed (page 13).

*Category tendencies checked against cited public sales, {{CHEAT_SHEET_MONTH}}. Every source: {{CHEAT_SHEET_SOURCES_URL}}*

<!-- Rendered from the same gated category file as lead-magnet.md page 3. Any line the QC agent can't confirm is dropped and both heading counts are recomputed. -->

| **{{CHEAT_SHEET_SELL_COUNT}} that usually SELL** (check yours) | **{{CHEAT_SHEET_FRACTION_COUNT}} that usually sell for a FRACTION of what they cost** |
|---|---|
| 1. Older quality hand tools: planes, chisels, wrenches | 1. Formal china sets |
| 2. Cast-iron cookware | 2. Crystal stemware |
| 3. Working film cameras and lenses | 3. Brown dining sets |
| 4. Solid-wood mid-century furniture | 4. Entertainment centers built for tube TVs |
| 5. Some vintage patterned glass bakeware (certain patterns only) | 5. Mass-made figurines |
| 6. Working vintage stereo gear: receivers, turntables, speakers | 6. Encyclopedias and matching book sets |
| 7. Video game consoles and games, working | 7. Exercise machines: treadmills, bikes |
| 8. Complete building-brick sets with instructions | 8. Bread makers |
| 9. Cordless power tools with battery and charger | 9. VHS tapes (almost all) |
| 10. Quality camping and outdoor gear | 10. "Collector" plates |
| 11. Bicycles in good working order | 11. Upright pianos |
| 12. Musical instruments and amps, working | 12. Used upholstered sofas and recliners |
| 13. Vinyl records in good condition (some, not all) | 13. Pressboard flat-pack furniture |
| 14. Vintage denim and workwear | 14. Silverplate serving pieces (not sterling) |
| 15. Recent phones, tablets and laptops (wiped first) | 15. Fast-fashion clothing |
| 16. Sterling silver (it has a melt-value floor; weigh it) | 16. DVDs and CDs (most) |
| 17. Stand mixers and quality kitchen machines, working | 17. Single-job kitchen gadgets |
| 18. Mid-century lamps and lighting | 18. Craft-supply stashes |
| 19. Key trading cards in good condition (commons rarely) | 19. Tube TVs and old printers (mostly e-waste) |
| 20. Quality outerwear and boots from known makers | 20. Souvenir spoons, thimbles and bells |

**How to use it in the plan**

- [ ] **Day 7:** if the SELL pile is big, Tag Card the left-column items first.
- [ ] **Days 9–10:** anything from the right column, check it fast. If the sold prices confirm it, it's a Floor-sort GIVE (page 17), not an evening of research.
- [ ] **Next time** (page 33): price the left column first.

**Three things that move a price more than the name on it**

1. **Condition.** Chips, stains, missing parts and "not sure if it works" take a big bite.
2. **Complete or not.** The box, the lid, the charger, the instructions.
3. **Can it ship?** Big and heavy means local buyers only, and fewer of them.

**Never list these:** recalled products, drop-side cribs, elephant ivory, firearms, ammunition, prescription drugs, alcohol, fakes. The full list and what to do instead is on page 29.

> Price check, not an appraisal. For insurance, tax, an estate or a family dispute, get a qualified appraiser.

---

# PAGE 46 · Credits, Sources and the Small Print

**Made by** a small studio. **Walt Novak is an AI character.** His stories are fiction and are not offered as evidence that this method works. The method stands on its own: look up what things actually sold for, then decide.

**No promises.** What you get back depends on what you own and your market. I can't promise a number. Nobody honest can.

**Price checks, not appraisals.** Nothing in this book is an appraisal. For insurance, tax, an estate, probate, a divorce or a family dispute, get a qualified appraiser.

**Not tax, legal or financial advice.** The tax page is general information with links to the official sources.

**No connection to any platform.** Marketplace and company names are used only so you know what to search for. None of them has endorsed or sponsored this book. There are no affiliate links in it.

**Sources (official pages referenced in this book; checked October 2026)**

- US Consumer Product Safety Commission: recalled products and resale (cpsc.gov/Business--Manufacturing/Business-Education/ResaleThrift-Stores-Information-Center/Stop-Online-Sale-of-Recalled-Products); Resellers Guide (cpsc.gov); recall search (cpsc.gov/recalls)
- US Department of the Interior / US Fish and Wildlife Service: 2016 African elephant ivory rule (doi.gov)
- Internal Revenue Service: Form 1099-K FAQs (irs.gov/newsroom/form-1099-k-faqs-common-situations); Publication 561, Determining the Value of Donated Property; Form 8283 instructions
- GOV.UK: Capital Gains Tax on personal possessions (gov.uk/capital-gains-tax-personal-possessions); Check if you need to tell HMRC about income from online platforms (gov.uk/guidance/check-if-you-need-to-tell-hmrc-about-your-income-from-online-platforms)
- Canada Revenue Agency: personal-use property (canada.ca)
- Australian Taxation Office: personal use assets (ato.gov.au)
- US Food and Drug Administration: disposal of unused medicines (fda.gov); US Drug Enforcement Administration: Take Back Day (dea.gov)
- USDA FoodKeeper app (foodsafety.gov); UK Food Standards Agency (food.gov.uk)
- US Federal Trade Commission: report fraud (reportfraud.ftc.gov); Report Fraud, formerly Action Fraud (UK); Canadian Anti-Fraud Centre; Scamwatch (Australia)
- International OCD Foundation: hoarding resources (hoarding.iocdf.org)
- Real-Worth Cheat Sheet (page 45): every category's cited public sales are listed at {{CHEAT_SHEET_SOURCES_URL}}, checked {{CHEAT_SHEET_MONTH}}
- eBay: "Sold items" search filter and Seller Hub Product Research (described as a tool for your own lookups; eBay has no connection to this book)

**Refunds.** If this isn't useful, reply to your receipt email within 30 days for a full refund. No forms, no questions.

**Licence.** For your personal use. Print as many copies of the worksheets as you need for your own household. Please don't resell or share the files.

*The Attic Audit · version 1.0 · November 2026*

**Keep the story. Sell the stuff. Spend it on the people.**
