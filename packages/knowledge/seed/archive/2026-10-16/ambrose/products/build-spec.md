---
spec: Build, gates and QC for Ambrose's Holiday 2026 product line
persona: ambrose
covers: product-1.md (The Butler's Holiday Plan + Bonus 7), table-pack.md, lead-magnet.md, welcome-sequence.md, listing-pack.md
rule: fully automated. Every job below runs on the studio worker from the queue, with retries. The only human step anywhere is the one-time Lemon Squeezy listing setup the PRD already sets (FR-10.1: its products API is read-only), done once with the rest of Phase 0 setup.
hard deadline: everything for the Plan launch passes the full release gate by **Wed 4 Nov 2026, 6:00 pm ET**; the Plan goes live **Thu 5 Nov 2026, 12:30 pm ET**
---

# Build Spec · Holiday 2026

## 1 · Every deliverable, where it comes from, and its state today (Fri 16 Oct)

| Deliverable | Promised in | Source | Job | State on 16 Oct | Due (ET) |
|---|---|---|---|---|---|
| The Plan, PDF, 46 pages, US Letter + A4, fillable | listing "Included" | product-1.md | J1 | Manuscript final | Mon 2 Nov |
| Bonus 7, The Gift Drawer Count, 1-page PDF, Letter + A4 | product-1.md p.15 and p.41 | product-1.md, the `---FILE---` section | J1 | Manuscript final | Mon 2 Nov |
| The Planner Sheet, Excel, 13 tabs | listing "Included"; p.41 | build/make_planner.py → build/planner-sheet.xlsx | J2 | **Built.** Formulas recalculated and checked (section 4) | Built |
| The Planner Sheet, Google copy link | p.41 ({{planner_sheet_copy_url}}) | build/planner-sheet.xlsx | J2 | Waits for the Google connection | Fri 30 Oct |
| Next Year's Clock | p.39, p.41 | Planner Sheet: Reckoning!B27 feeds 'At a Glance'!B13, which dates the Clock tab | J2 | **Built and tested:** a T-0 of 25 Nov 2027 gives T-21 = Thu 4 Nov 2027 | Built |
| Five Butler's Briefings, MP3 | listing; p.3, p.41 | product-1.md, transcripts pp.43–45 | J3 | Transcripts final | Fri 30 Oct |
| The Script File, .txt | listing; p.41 | build/make_script_file.py → build/script-file.txt | J4 | **Built:** 40 scripts (fails if fewer than 20) | Built; rebuilt on every manuscript change |
| The Table Pack, PDF, 12 pages, Letter + A4, fillable; poster 18 × 24 in and A2 | listing price table; E3-A, E5-A; p.26 | table-pack.md | J5 | Manuscript final | Wed 4 Nov, 6:00 pm |
| Gift Ledger + Tipping Card, PDF, 6 pages | lead magnet | lead-magnet.md | J1 | Manuscript final | Thu 29 Oct |
| Gift Ledger sheet, Google copy link | lead magnet p.6; Email 1 | build/make_gift_ledger.py → build/gift-ledger-sheet.xlsx | J2 | **Built:** 3 tabs, checked (section 4) | Thu 29 Oct |

## 2 · Jobs

**J1 · Render the PDFs.** Markdown → HTML → PDF (headless Chromium, print CSS), then form fields added with pypdf.
- One page per `---PAGE---`; each `---FILE---` section is its own PDF. Two builds each: US Letter (8.5 × 11 in) and A4.
- Fonts are pinned by version and SHA-256 in `build/fonts.lock` and embedded: EB Garamond, Source Sans 3, DejaVu Sans (fallback for symbols such as ◇ ← →), DejaVu Sans Mono (the Pocket Card box only). All are OFL or free licences.
- Tick boxes: every `☐` becomes a drawn 9 pt square (0.75 pt Silver stroke) with a fillable checkbox field on top. The glyph is never set in a font, so it can't come out as tofu.
- Fill-ins: every `____` becomes a drawn line with a text field on top.
- `:::footer` blocks are set as small print at the foot of their page. The marker words never print.
- Merge tokens are filled by Gate G1 before rendering, never inside the renderer.

**J2 · Build the sheets and their Google copy links.**
1. Run `build/make_planner.py` and `build/make_gift_ledger.py` (openpyxl). This writes the .xlsx files that ship in the downloads.
2. Upload each .xlsx to the studio's Google Drive through the Drive API with conversion to Google Sheets (`mimeType: application/vnd.google-apps.spreadsheet`). Set sharing to "anyone with the link can view".
3. Write `https://docs.google.com/spreadsheets/d/{fileId}/copy` into the release values file (`release-values.json`) as `planner_sheet_copy_url` and `gift_ledger_sheet_copy_url`.
4. QC through the Sheets API: write the section 4 sample inputs into a scratch copy, read back every checked cell, compare against the expected values, then delete the scratch copy. The job fails on any mismatch.

**J3 · Record the five Briefings.**
- Text: the five transcripts from product-1.md pp.43–45, with the quote markers stripped. "…" becomes a 600 ms pause (SSML break). "U S D A" stays spelled out.
- Voice: ElevenLabs, the approved Ambrose voice ID from the vault. Model and settings are pinned in `build/tts.lock`, so a re-render sounds the same.
- Output: MP3, 44.1 kHz, mono, 128 kbps, loudness normalised to −16 LUFS integrated. ID3 tags: title "Briefing N · …", artist "Ambrose Hale (AI character)", comment "Synthetic voice".
- QC, all automatic. Each length must sit within ±25 s of the length printed on the page (3:20, 3:30, 3:30, 3:00, 3:00). A Whisper transcription of each file is compared with its transcript, and the word error rate must be 3% or less. No clipping, and at most 2.5 s of silence anywhere. One automatic retry; if it still fails, the job fails.
- Dependency: the ElevenLabs key is in the vault (PRD Phase 0 sign-ups). This is a credential, not a build step.

**J4 · Export the Script File.** `build/make_script_file.py ../product-1.md script-file.txt` takes every blockquote and every quoted table line on pages 1–42 (the transcripts are excluded), in page order, numbered and labelled. Runs on every manuscript change.

**J5 · Render the Table Pack.** Runs J1's renderer on table-pack.md, plus:
- The poster file is drawn at 18 × 24 in and A2.
- Every `[field: …]` becomes a named text field (`name_1` … `name_6`, `menu_showpiece`, and so on) that auto-shrinks to fit, in the style's font and size.
- The 1-inch scale bar is measured in the PDF and must be 72 pt (Letter build) or 70.87 pt, which is 2.5 cm (A4 build).
- Each card sheet is checked to keep at least 0.25 in (6 mm) of margin on every side.

**J6 · Browser re-check for links that block scripts.** Any URL that Gate G4 lists as 403 or 429 (today: emilypost.com, FoodSafety.gov, www.fsis.usda.gov, which all block scripted fetches) is fetched again through the Knowledge Builder's browser fetcher. The release fails on anything but a 200 with the expected page title.

## 3 · Release gates (all automatic; any failure blocks the release)

| Gate | What it checks | How | State on 16 Oct |
|---|---|---|---|
| **G1 · Tokens** | No `{{…}}` is left unfilled or filled with an empty value in any PDF manuscript; emails are held, not sent, if any token is unfilled after merge | `gate_check.py merge <md> release-values.json <out>`; the email platform's merge check is set to fail closed | **Works.** It correctly fails today on product-1.md (`planner_sheet_copy_url`) and lead-magnet.md (`gift_ledger_sheet_copy_url`, `holiday_plan_url`), because J2 and the landing page haven't run yet |
| **G2 · Lint** | No layout direction printed as text ("Small print…"); balanced `:::footer` blocks; no lore-as-authority phrases ("great house", "the staff always knew"); no `studio_legal_name`; every box drawing the same width on every line; the Plan is exactly 46 pages | `gate_check.py lint *.md` | **Passes** on all five files. On the old versions it caught all eight defects the review found |
| **G3 · Glyphs** | Every non-ASCII character in a manuscript (today: £ © ° · ¼ × é ÷ – — … ← → − ◇ and the box-drawing set) exists in at least one embedded font | `gate_check.py glyphs <md> <fonts…>` against the fonts in `fonts.lock` | Runs in J1 once the fonts are fetched and pinned |
| **G4 · Links** | Every printed URL and domain answers 200 after redirects, trying the `www.` form for bare domains; 403s are queued for J6 | `gate_check.py links *.md` | **Passes:** 7 checked; the USPS ethics FAQ page answers 200; 3 queued for J6 |
| **G5 · PDF** | Page counts (Plan 46, Drawer Count 1, Table Pack 12, poster 1, lead magnet 6); no `{{`, `☐`, `:::footer` or "Small print, foot" in the extracted text; no U+FFFD (tofu); fillable-field count equals the `☐` + `____` + `[field:]` count in the manuscript | `gate_check.py pdf <file> <pages>` plus a pypdf field count | Runs after J1 and J5 |
| **G6 · Visual QC** | Each page rendered to PNG at 100 dpi and checked by the QC agent (vision): nothing overflows or clips; the footer and AI-character line are present; tick boxes are visible squares; the Pocket Card box is closed on all four sides; tables fit the page; no generated imagery in the Table Pack | QC agent, with a per-page checklist | Runs after J1 and J5 |

**If anything for the Table Pack misses Wed 4 Nov, 6:00 pm ET:** the worker switches the landing page, the checkout button text and welcome Blocks E3-A and E5-A to their standard versions (no Table Pack offer) before launch. Nothing ever promises a file that hasn't passed the gates. The same rule applies to any line in the listing's "Included" table: an item that fails its gate is removed from the listing before launch, and the Owner is notified.

## 4 · Sheet QC (run 16 Oct on the built files, recalculated with the `formulas` engine)

**Planner Sheet.** Sample inputs: T-0 Thu 26 Nov 2026; doorbell 3:00 pm; end 8:00 pm; 10 guests; $150 budget; 7 drinkers and 3 non-drinkers; a 16 lb / 6 kg bird; UK oven time 9:00 am on the day; two receipts; two overlapping oven dishes; two clock ticks.

| Check | Expected | Got |
|---|---|---|
| Per-Plate Number | $15.00 | $15.00 |
| Hours, doorbell to end | 5.0 | 5.0 |
| Clock: T-21 / T-1 / T+7 | Thu 5 Nov / Wed 25 Nov / Thu 3 Dec 2026 | Thu 5 Nov / Wed 25 Nov / Thu 3 Dec 2026 |
| Clock ticks | 2 / 25 | 2 / 25 |
| Showpiece share; per plate | $52.50; $5.25 | $52.50; $5.25 |
| Shares add to 100% | "Adds up to 100%. Good." | as expected |
| Spend Log: Showpiece spent $60 against a $52.50 line | Left −$7.50 (row turns amber) | −$7.50 |
| Drinks: C, D, E, G, ice, jugs | 6, 42, 9 bottles, 21, 10 lb, 3 | 6, 42, 9, 21, 10, 3 |
| Thaw, US (16 lb) | 96 h; 4 days + 1 spare = 5; into the fridge **Sat 21 Nov** (matches Dot's US Thaw Day) | 96; 5; Sat 21 Nov |
| Thaw, UK (6 kg, oven 9:00 am Thu 26 Nov) | 72 h; into the fridge **Mon 23 Nov, 9:00 am**, no spare day; cook by Thu 26 Nov, 9:00 pm | 72; Mon 23 Nov 9:00; Thu 26 Nov 21:00 |
| Oven clash (11:00–15:00 and 14:00–14:45) | Both rows flagged | Both flagged |
| Thank-you deadline (Thanksgiving) | T+2, Sat 28 Nov | Sat 28 Nov |
| Next Year's Clock (Reckoning!B27 = 25 Nov 2027) | T-21 Thu 4 Nov 2027; T-0 25 Nov 2027 | 4 Nov 2027; 25 Nov 2027 |

**Gift Ledger sheet.** A drawer gap of par 6 − good 2 − mendable 1 = 3 ✓. A ceiling of $40 with $45 spent shows over by $5 ✓. Staff & Service $80 flows into the Ledger total ✓, the ceilings come to $120 against a $300 limit ("Within the total") ✓, and spent is $125 ✓.

J2 re-runs these same checks against the Google-converted copies.

## 5 · Dated offers (enforcement lives in the worker; specs in listing-pack.md and welcome-sequence.md)

| When (UTC) | Job | Self-check |
|---|---|---|
| 2026-11-05T17:30:00Z (12:30 pm ET) | Publish the landing page with the early-bird lines; select Blocks E3-A and E5-A for any held sends | Landing page shows "Table Pack included"; a test-mode order gets the Plan and the Table Pack |
| 2026-11-13T04:59:00Z (12 Nov, 11:59 pm ET) | The early-bird ends: landing page and button text switch to standard; Blocks E3-B and E5-B; the webhook's Table Pack grant stops on `created_at` alone | 05:05Z: no early-bird phrase live; test orders stamped 04:58Z and 05:00Z behave as specified |
| 2026-11-13T05:00:00Z | Thank-you-page upsell and onboarding email line for the $7 Table Pack switch on | The upsell link resolves to the $7 checkout |
| 2027-01-06 (Book opens) | {{butlers_book_url}} redirects to the founders' checkout (discount pre-applied, `expires_at` 2027-02-01T04:59:00Z); Block E5-E selected | Test-mode checkout shows $29 |
| 2027-02-01T04:59:00Z (31 Jan, 11:59 pm ET) | Founders' price ends: {{butlers_book_url}} switches to the $35 checkout; the "$29" lines come off the landing page | 05:05Z: discount shows expired; the code is refused; no "$29" live |

Every job retries every minute for an hour. If a self-check still fails, the page falls back to the standard, no-offer version and the Owner gets an alert. An expired offer never stays live.

## 6 · Calendar

| Date (ET) | What finishes |
|---|---|
| Mon 26 Oct | Fonts fetched and pinned (`fonts.lock`); J1 first render of all manuscripts; G2–G6 first run |
| Thu 29 Oct | Lead magnet PDF and Gift Ledger sheet link pass every gate |
| Fri 30 Oct | J3 audio passes QC; J2 Planner Sheet Google link live and checked |
| Sun 1 Nov | Lead magnet and welcome sequence live; the {{holiday_plan_url}} landing page is live in its "opens Thu 5 Nov, 12:30 pm ET" state |
| Mon 2 Nov | The Plan and Bonus 7 PDFs pass G1–G6 |
| Wed 4 Nov, 6:00 pm | The Table Pack passes J5 and G1–G6; full release gate across every file; fallback switch armed |
| Thu 5 Nov, 12:30 pm | The Plan goes live |
