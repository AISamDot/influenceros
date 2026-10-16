# Dot's Christmas Dinner Countdown Card

**Lead magnet for Operation Sprout** · Keyword: **DINNER** · Live Sun 1 Nov – Thu 24 Dec 2026 (23:59 UK) · 2 pages, A4 and US Letter, print and phone versions
**Bible match:** §14.1. A Christmas Day oven timeline for 4 (turkey crown, whole bird or a bought veggie main), a defrost calculator quoting FSA (UK) and USDA (US), a "nothing new on the day" checklist, and a Thanksgiving Day version on page 2. Food-safety timings only. No recipes on this card.

**Render notes (not printed: the render step deletes everything above `## PAGE 1`, including the title lines and this block)**
- Palette: lilac `#B9A7D1` headers, custard `#F2C14E` tick boxes, stamp red `#C8312B` for the SECONDS stamp graphic on the page-1 title only.
- Every `____` is a fill-in line. Every `[ ]` is a printed tick box. On the phone version, `[ ]` becomes a tappable checkbox.
- Oven settings always use the house format: fan / conventional / °F / gas.
- Quoted lines in "quotes" are the source's own words. All were checked word for word on Fri 16 Oct 2026 against the GOV.UK copy of FSA "Christmas food hygiene" and archived copies of the FSIS turkey pages (see product-1.md, production note 5). The QC agent re-checks them on render day, and any changed wording stops the build.
- **Render gate (automated):** the build fails if the rendered card or the phone version contains `[RV`, `[LINK`, `[PC`, `===`, "Render notes" or any unresolved merge token. `{{plan_link}}` is resolved by the email/opt-in platform to the live checkout URL. On the downloadable PDF it renders as the printed short link to the plan, and that link must return HTTP 200 before publishing.
- Footer on both pages: `Dot is an AI character. The food-safety lines come from the UK Food Standards Agency (FSA) and the US Department of Agriculture (USDA), credited where they're used. Not medical advice.`

---

## PAGE 1: CHRISTMAS DAY

### Dot's Christmas Dinner Countdown Card

**Christmas dinner for 4. One oven. Count back from the plate.**

Right, love. You don't plan a Christmas dinner forwards. You plan it backwards from the time you want bums on seats. Write that time in the box, write your bird's cooking time from the label, and the card does the rest.

| | Fill in |
|---|---|
| **D** = what time dinner goes on the table | `____ : ____` |
| **B** = your bird's cooking time, from its label (UK) or the USDA chart on page 2 (US) | `____ h ____ min` |
| **Oven temperature for the bird**, from its label (UK); USDA says no lower than 325°F (US) | `________` |

### The Christmas Day oven timeline (for 4)

Pick your column. Work out each clock time once, on Christmas Eve, and write it in. Then set a phone alarm for every line.

| When | Turkey crown | Whole turkey | Bought veggie main (no bird) | Clock time |
|---|---|---|---|---|
| D minus (B + 1 h) | Oven on to the bird's temperature | Oven on to the bird's temperature | Nothing yet. Have a brew. | `____` |
| D minus (B + 40 min) | **Crown in** | **Bird in** | — | `____` |
| D minus 1 h 10 min (30 min before the bird's time is up) | Start checking it's cooked (see the box below) | Start checking it's cooked | — | `____` |
| D minus 1 h | Spuds peeled and in cold water; veg prepped | Same | Same | `____` |
| D minus 40 min | **Bird out.** Check it's cooked. Cover with foil and rest. Oven to your spuds' temperature. | **Bird out.** Check, cover, rest. Oven to your spuds' temperature. | Oven to the pack temperature for your veggie main | `____` |
| D minus 40 min | Spuds in (pack or recipe time) | Spuds in | Spuds in; veggie main in, per its pack | `____` |
| D minus 20 min | Veg on the hob (pack times) | Veg on the hob | Veg on the hob | `____` |
| D minus 15 min | Gravy on (pack instructions) | Gravy on | Gravy on | `____` |
| D minus 10 min | Carve | Carve | Check the veggie main is steaming hot all the way through | `____` |
| D minus 5 min | Spuds out. Plates warm. | Same | Same | `____` |
| **D** | **Dinner.** Sit down. You've earned it. | **Dinner.** | **Dinner.** | `____` |

**Why 40 minutes?** The bird rests under foil while the oven does your roast potatoes, and you carve in the last 10. USDA advises letting a roast turkey stand for 20 minutes before carving; this card plans 30, so there's slack.

**Is it cooked? (UK: FSA)**
> "cut into the thickest part of the meat and check that none of the meat is pink"

With a food thermometer, the FSA's time-and-temperature combinations for the thickest part are "60°C for 45 minutes", "65°C for 10 minutes", "70°C for 2 minutes", "75°C for 30 seconds" or "80°C for 6 seconds".

**Is it cooked? (US: USDA)** 165°F minimum internal temperature, checked in the thickest part of the breast, the innermost part of the thigh and the innermost part of the wing.

### The defrost calculator

**UK (FSA):** "In a fridge, allow around 10-12 hours per kg." Defrost "in the fridge (on the bottom shelf)", in a covered container big enough to catch drips. "Do not defrost your turkey at room temperature." Check the label first: if it gives a defrosting time, use that.

| Your bird's weight | Fridge time (12 h per kg, the slow end) | Into the fridge by | Done by |
|---|---|---|---|
| 2 kg | 24 h | Thu 24 Dec, 06:00 | Fri 25 Dec, 06:00 |
| 3 kg | 36 h | Wed 23 Dec, 18:00 | Fri 25 Dec, 06:00 |
| 4 kg | 48 h | Wed 23 Dec, 06:00 | Fri 25 Dec, 06:00 |
| 5 kg | 60 h | Tue 22 Dec, 18:00 | Fri 25 Dec, 06:00 |
| 6 kg | 72 h | Tue 22 Dec, 06:00 | Fri 25 Dec, 06:00 |
| 7 kg | 84 h | Mon 21 Dec, 18:00 | Fri 25 Dec, 06:00 |
| 8 kg | 96 h | Mon 21 Dec, 06:00 | Fri 25 Dec, 06:00 |
| Your bird: `____` kg | `____` kg × 12 = `____` h | `________` | Christmas morning |

Why "done by 06:00 Christmas morning"? The FSA says to eat defrosted food within 24 hours. Even a bird that thaws at the quick end (10 hours per kg) stays within that window, as long as it's **in the oven by 10:00 on Christmas morning**. Cooking later than that? Check the bird on Christmas Eve morning. If it's already fully defrosted, cook it within 24 hours of that time.

**US (USDA):** allow about 24 hours for every 4 to 5 pounds in a refrigerator at 40°F or below. A turkey thawed in the fridge can stay there 1 to 2 days before cooking.

| Your bird's weight | USDA fridge time | Into the fridge by (for Fri 25 Dec) |
|---|---|---|
| 4 to 12 lb | 1 to 3 days | Tue 22 Dec |
| 12 to 16 lb | 3 to 4 days | Mon 21 Dec |
| 16 to 20 lb | 4 to 5 days | Sun 20 Dec |
| 20 to 24 lb | 5 to 6 days | Sat 19 Dec |

**And whichever side of the pond you're on:** don't wash the raw bird. The FSA says "Do not wash raw turkey before cooking", because "Washing raw meat spreads germs onto your hands, clothes, utensils, and worktops." USDA agrees.

### Nothing New on the Day: the checklist

Tick each one before Christmas Eve. If you can't tick it, swap it for something you can.

- [ ] I have cooked every dish on my menu at least once before.
- [ ] My bird fits my oven, in its tin, with the door shut. (Measure it.)
- [ ] I know my bird's weight and I've written my defrost date on the calendar.
- [ ] I own a food thermometer, or I know how to do the FSA "no pink meat" check.
- [ ] My fridge is at 5°C or below (FSA) / 40°F or below (USDA), and there's a bottom shelf free for the bird.
- [ ] I've cut the veg list to three. Sprouts, carrots and one more. Done.
- [ ] Every clock time on this card is written in and has a phone alarm.
- [ ] Somebody else has been given the washing-up. In writing.
- [ ] I've asked every guest about allergies and dietary needs. (Text them today.)
- [ ] The stuffing is cooked in its own dish, not in the bird. FSA: "Cook the stuffing in a separate roasting tin, not inside the turkey."

---

## PAGE 2: THANKSGIVING DAY (US)

### Dot's Thanksgiving Countdown Card

**Thursday 26 November 2026. One oven. Count back from the plate.**

America, here's your Thanksgiving, planned the same way: backwards from dinner. Your food-safety lines on this page come from USDA only.

| | Fill in |
|---|---|
| **D** = dinner time | `____ : ____` |
| **B** = roasting time for your bird (USDA chart below, or the label) | `____ h ____ min` |
| Oven: USDA says no lower than **325°F** | `140°C fan · 160°C · 325°F · gas 3` |

### Thaw Day: when your bird goes in the fridge

USDA: about 24 hours for every 4 to 5 pounds, in the refrigerator. Keep it in its wrapper, on a tray.

| Bird weight | USDA fridge thaw time | Thaw Day for Thu 26 Nov | Tick when it's in |
|---|---|---|---|
| 4 to 12 lb | 1 to 3 days | Mon 23 Nov | [ ] |
| 12 to 16 lb | 3 to 4 days | Sun 22 Nov | [ ] |
| 16 to 20 lb | 4 to 5 days | **Sat 21 Nov** | [ ] |
| 20 to 24 lb | 5 to 6 days | Fri 20 Nov | [ ] |

**Missed it?** USDA's cold-water method: keep the bird in its wrapper, submerge it in cold water, change the water every 30 minutes, allow about 30 minutes per pound, and cook it straight away once thawed.

### USDA roasting times (unstuffed, 325°F)

| Turkey | Approximate time |
|---|---|
| 4 to 8 lb (breast) | 1½ to 3¼ hours |
| 8 to 12 lb | 2¾ to 3 hours |
| 12 to 14 lb | 3 to 3¾ hours |
| 14 to 18 lb | 3¾ to 4¼ hours |
| 18 to 20 lb | 4¼ to 4½ hours |
| 20 to 24 lb | 4½ to 5 hours |

These are guides. The thermometer decides: **165°F** in the thickest part of the breast, the innermost part of the thigh and the innermost part of the wing. USDA doesn't recommend stuffing the bird; bake the stuffing in its own dish to 165°F.

### The Thanksgiving Day timeline

| When | Job | Clock time |
|---|---|---|
| D minus (B + 1 h) | Oven on to 325°F | `____` |
| D minus (B + 40 min) | **Bird in** | `____` |
| D minus 1 h 30 min | Make-ahead casseroles out of the fridge, ready to bake | `____` |
| D minus 1 h 10 min (30 min before B is up) | Start checking with the thermometer | `____` |
| D minus 40 min | **Bird out at 165°F.** Tent with foil and let it stand. Oven to your sides' temperature. | `____` |
| D minus 40 min | Sides in (their own recipe times) | `____` |
| D minus 15 min | Gravy on | `____` |
| D minus 10 min | Carve | `____` |
| **D** | **Dinner.** | `____` |

### The two-hour rule (for after)

USDA: refrigerate leftovers within **2 hours** of cooking (1 hour if it's above 90°F). Start counting when the bird comes out of the oven, not when you sit down. Carve the meat off the bone and store it in small, shallow containers. Eat within **3 to 4 days**, or freeze. Reheat leftovers to **165°F**.

- [ ] Leftovers in the fridge by: `____ : ____` (bird-out time + 2 hours, which is dinner time + 1 hour 20 minutes)

---

**Want the full six weeks?** *Operation Sprout: Dot's Christmas Dinner Battle Plan* has a one-job-a-day countdown from 13 November, costed shopping lists in £ and $, make-ahead freezer recipes adapted from public US government sources (credited on every page), Oven Tetris timelines for 2 to 10+, job cards, Boxing Day leftovers and a Thanksgiving page. It's a timing-and-prep system that works with your own classics, too. **$9 until Sunday 15 November, 23:59 UK. $12 after that.** {{plan_link}}

*Sources: UK Food Standards Agency, "Christmas food hygiene" and "How to chill, freeze and defrost food safely" on GOV.UK. Contains public sector information licensed under the Open Government Licence v3.0. USDA Food Safety and Inspection Service, "Let's Talk Turkey" and leftovers guidance (US government works, public domain). Dot Pickering is a fictional AI character.*
