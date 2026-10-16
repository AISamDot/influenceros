<!--
PRODUCTION NOTES (not rendered)
- Product: The Drawer Audit (free lead magnet, keyword DRAWER). Matches bible §14: 3 pages = (1) 15-Minute Drawer Audit, (2) Tag Card worksheet, (3) Real-Worth Cheat Sheet (up to 20 that usually sell / up to 20 that usually sell for a fraction, after the gate). Pages 1 and 3 also appear in the paid Attic Audit (pages 44–45), so buyers who never took this sheet aren't missing anything the book points to.
- Render: US Letter and A4 from the same file. Palette: manila #E8D4A2 panels, safety orange #F26B1D rules and tick boxes, cobalt #2E5AA8 headings, black body. Marker-style display font for headings only.
- Render-time tokens (filled automatically by the pipeline; no human step):
  {{CHEAT_SHEET_MONTH}}   = the month of the Sold List research run the cheat sheet was checked against.
  {{CHEAT_SHEET_SOURCES_URL}} = public page listing the cited sources for every category on page 3.
  {{CHEAT_SHEET_SELL_COUNT}} / {{CHEAT_SHEET_FRACTION_COUNT}} = the number of confirmed lines in each column after the gate below.
- Render gate (automated; any failure blocks the render, the last passing PDF keeps serving, and nothing new ships):
  1. Category lines: the QC agent confirms each of the 40 category tendencies on page 3 against that month's cited, CLEAN-source research log. Any category it can't confirm is dropped and the two heading counts are recomputed ("18 that usually sell", etc.). Nothing ships with an unconfirmed line.
  2. Sources page exists and resolves: the pipeline publishes the {{CHEAT_SHEET_SOURCES_URL}} page from the same research log BEFORE this PDF renders, then fetches it. It must return HTTP 200 on the studio's own domain (no placeholder, redirect chain to a different host or "coming soon" page), carry the same month as {{CHEAT_SHEET_MONTH}}, and list at least one citation, with a live link, for every category printed on page 3. Each citation link is fetched too; a dead citation fails that category, which is then dropped under step 1.
  3. Single source: this page 3 and product-1.md page 45 render from the same confirmed category file in the same run, and the confirmed counts are passed to the email platform, so the free sheet, the paid book and the emails can't disagree.
  If there is no passing version at launch, the DRAWER opt-in page does not go live until one passes. No human step.
- No prices appear anywhere on this sheet. No brand logos. No maker's marks.
-->

# THE DRAWER AUDIT

**One drawer. Fifteen minutes. Three piles. One thing you keep.**

*Free from Walt · What It Sold For*

---

## PAGE 1 · The 15-Minute Drawer Audit

Every house has the drawer. Takeout menus. Twelve pens, two of them work. A key nobody can match to a lock. Somewhere in there is one thing worth something, and one thing worth keeping. Usually not the same thing.

You're not cleaning the house today. You're doing one drawer.

### What you need

- [ ] A timer (your phone's fine)
- [ ] Three spots on a table or the floor. Label them with paper: **SELL**, **GIVE**, **GONE**
- [ ] One small box or bag for **KEEP**
- [ ] A pen. Page 2 of this sheet.

### The rules

1. **One drawer only.** Not "the drawer and the cupboard above it." One.
2. **Everything comes out.** Tip it onto a towel. Empty drawer, then decide.
3. **KEEP gets one thing.** Just one from this drawer. The thing with a story.
4. **SELL is for things you think somebody would pay real money for.** You'll check that on page 2. For now, a guess is fine.
5. **GIVE is for things that work and somebody could use.**
6. **GONE is for broken, dried-up, expired, and "what is this."** Batteries and old electronics don't go in the kitchen bin. They go in a separate bag for the right drop-off.
7. **What goes back in the drawer has to have a job.** If you can't say its job in five words, it's not going back.

### The 15 minutes

| Minutes | Do this | Done |
|---|---|---|
| 0–2 | Empty the drawer onto a towel. Wipe the drawer out. | [ ] |
| 2–9 | Pick up each thing once. Put it straight on a pile. No second thoughts yet. | [ ] |
| 9–11 | Pick your ONE keep. Write down why on the line below. | [ ] |
| 11–13 | Put back only what has a job. Count what's left in each pile. | [ ] |
| 13–15 | Bag up GONE and GIVE. Put them by the door. Take the SELL pile to page 2. | [ ] |

### My count

| Pile | How many things |
|---|---|
| KEEP | 1 |
| Back in the drawer (has a job) | |
| SELL (to check on page 2) | |
| GIVE | |
| GONE | |
| **Total that came out** | |

**My one keep, and why:** ______________________________________________

**GIVE is going to (name a place or person):** _____________________________

**GONE needs a special drop-off for (batteries, electronics, anything else):** ______________________

> A normal drawer gives you one or two things worth checking. Sometimes none. That's still a good drawer. Now it closes.

---

## PAGE 2 · The Tag Card Worksheet

**Paid's a story. Sold's a fact.**

What you paid is history. What somebody will pay you is a different number, and the only honest way to find it is to look up what things like yours **actually sold for**. Not what they're listed for. Asking prices are wishes.

### The five steps (about 5 minutes per item)

1. **Name it exactly.** Maker, model, size, colour, condition. "Blue mixing bowl" won't find anything. "[Maker] 2.5 qt glass mixing bowl, used, small chip" will.
2. **Look up what it SOLD for.** On eBay, search your item, then switch on the **"Sold items"** filter (on the app: Filter, then "Sold items"; on a computer: tick "Sold items" in the left column). Green prices are completed sales. You can also use public auction results and price guides that report realized (sold) prices.
3. **Take the middle sale.** Line up the sold prices for items in the same condition as yours. Skip bundles and lots. Skip the one crazy-high sale. The middle number is your **WORTH**. Fewer than 10 sales? Write **"thin"** and use the low-to-high range instead.
4. **Subtract what it costs to sell.** Look up the platform's current fee page (fees change, so don't guess) and a shipping estimate. What's left is **POCKET**: what you'd actually keep.
5. **Write the tag.** PAID / WORTH / POCKET.

### Your Tag Cards

| # | Item (named exactly) | PAID | WORTH (middle sale, or range if thin) | How many sales? | Fees + shipping | POCKET | Over $10? |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | [ ] Yes [ ] No |
| 2 | | | | | | | [ ] Yes [ ] No |
| 3 | | | | | | | [ ] Yes [ ] No |
| 4 | | | | | | | [ ] Yes [ ] No |
| 5 | | | | | | | [ ] Yes [ ] No |
| 6 | | | | | | | [ ] Yes [ ] No |

### The Ten-Dollar Floor

**If POCKET is under $10 (about £8, C$14, A$15), don't list it.** Listing, photos, messages and the trip to the post office cost you an evening. Under the floor, it goes to GIVE or GONE. Over the floor, it's a listing.

### Illustrative example (not data)

> A 40 oz tumbler. PAID $45. Used, common colour: WORTH $22. After fees and shipping: POCKET about $12. Clears the floor, just. Verdict: sell it, or drink out of it. Your call.

*These numbers are made up to show the maths. Look up your own.*

> **Price check, not an appraisal.** For insurance, tax, an estate or a family dispute, get a qualified appraiser.

---

## PAGE 3 · The Real-Worth Cheat Sheet

Which way categories **usually** go, from public sold-price research. These are tendencies, not prices. There are always exceptions, which is why you look up **your exact item**, sold not listed.

*Category tendencies checked against cited public sales, {{CHEAT_SHEET_MONTH}}. Every source: {{CHEAT_SHEET_SOURCES_URL}}*

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

### Three things that move a price more than the name on it

1. **Condition.** Chips, stains, missing parts and "not sure if it works" take a big bite.
2. **Complete or not.** The box, the lid, the charger, the instructions.
3. **Can it ship?** Big and heavy means local buyers only, and fewer of them.

### Never list these

- **Recalled products and drop-side cribs.** It's illegal to sell them. Check cpsc.gov (US) before you list anything for kids.
- **Elephant ivory.** Federal and state bans apply.
- **Firearms, ammunition, prescription drugs, alcohol.** Not a marketplace job.
- **Fakes.** Not even the cute ones.

---

**Next:** over the next few days I'll send you how to price a whole room, not just a drawer. Same method, bigger pile.

*Walt is an AI character made by a small studio. The method and the sources are real; the stories are fiction. Price checks, not appraisals. What you get back depends on what you own and where you live. Nobody honest can promise a number.*

**Keep the story. Sell the stuff. Spend it on the people.**
