# Dot Pickering: Look Prompts v2 (Higgsfield)

**v2 changes:** Dot is now **72** with **warm hazel-brown eyes** and **no freckles** (the thread veins stay). **Anchor 3 is the stray curl**, a body feature, so every look carries all three anchors; the ladle is the signature prop. Every candid pastes the anchors verbatim. The Soul ID floor is 20 frames. Mirrored panels are regenerated, never flipped. Each reel gets its own still variant. The gold tooth is scored on stills and first/last frames only. Talking reels are 3 Seedance clips of ≤10 s. The drift test follows the studio spec (20 generations plus an all-five cross-test).

**Pipeline:**
1. Generate a character sheet (Nano Banana Pro or Soul 2.0).
2. Pick the best panels and train a **Soul ID** from **20–25** clean frames (§2). 20 is the floor.
3. Make one master still per outfit per set, then a **variant still per reel** (§3.0).
4. Animate the talking reels with **Seedance** (9:16, 720p) from the reel's variant still, with the ElevenLabs voice track uploaded as **3 files of ≤10 s each**, one per clip.
5. Make activity clips and the grin cutaway with **Kling / Wan**, also from the reel's variant still.
6. Make stills and carousel images with **Nano Banana / Soul 2.0**.

**Rules for every prompt:**
- Paste the three anchors verbatim, plus the face constants.
- Force her age (72).
- Keep her fully clothed.
- Allow no brands, logos or readable text.
- Allow one speaker only.
- Any prop she uses must be in the still at frame one.

**The anchors (verbatim, every prompt, every look):**
1. `white tightly-curled short perm under a fine black hairnet`
2. `one gold tooth on her upper left canine, visible when she talks or smiles`
3. `one stray white curl escaping the hairnet above her left ear`

**Signature prop (verbatim in every look that has it: Service Lilac, Home Kitchen, Christmas Service):** `long-handled stainless steel serving ladle held in her right hand`

**Face constants (verbatim, every prompt with her face):** `a 72-year-old woman, round ruddy face with fine broken capillaries (thread veins) across her cheeks and nose, fair skin with no freckles, warm hazel-brown eyes, laugh lines and crow's feet, a softening jawline, a few faint age spots on her temples, thinning grey-brown eyebrows, broad nose, slightly crooked lower front teeth`

**Mirror check:** the gold tooth (HER upper left) and the stray curl (above HER left ear) both appear on the **viewer's RIGHT** in a frontal shot. Reject any frame where either has flipped. **Never flip a frame to fix it**: flipping also mirrors the curl and the burn mark on her right hand. Regenerate.

---

## 1. Character sheet prompt (3-panel, white background; under the 3,500-character limit)

```
Photoreal character reference sheet: three panels side by side on one wide image, plain seamless pure white studio background, the SAME woman in all three panels with identical face, hair, age and outfit.

SUBJECT: Dorothy "Dot" Pickering, a white English dinner lady from West Yorkshire, clearly in her early seventies. FACE: a 72-year-old woman, round ruddy face with fine broken capillaries (thread veins) across her cheeks and nose, fair skin with no freckles, warm hazel-brown eyes, laugh lines and crow's feet, a softening jawline, a few faint age spots on her temples, thinning grey-brown eyebrows, broad nose, slightly crooked lower front teeth. Short and sturdy build, about 5 ft 1, broad shoulders, strong forearms.
ANCHOR 1: white tightly-curled short perm under a fine black hairnet.
ANCHOR 2: one gold tooth on her upper left canine, visible when she talks or smiles.
ANCHOR 3: one stray white curl escaping the hairnet above her left ear.
PROP: long-handled stainless steel serving ladle held in her right hand.
No glasses. Small plain gold sleeper earrings. A faded pale burn mark on the back of her right hand.

OUTFIT (identical in all three panels): pale lilac short-sleeved polycotton wrap tabard with side ties at the waist, completely plain, over a white crew-neck cotton T-shirt; black straight-leg trousers; white rubber kitchen clogs; a folded white tea towel tucked into the tabard tie at her left hip. Fully clothed, modest.

PANEL 1 (left): full body, front view, standing square to camera, feet visible, ladle held down by her right side, neutral confident expression, mouth closed.
PANEL 2 (centre): waist-up, three-quarter view turned 20 degrees to her left, pointing the ladle toward the camera like a pointer, one eyebrow raised, knowing half-smile showing the gold upper left canine.
PANEL 3 (right): head-and-shoulders close-up, facing camera at eye level, laughing with mouth open so the gold upper left canine is clearly visible, sharp detail on the hazel-brown eyes, the hairnet mesh, the perm curls and the stray curl above her left ear.

PHOTOGRAPHY: 50mm lens, f/5.6, soft diffused key light from front-left, gentle fill, faint natural shadow under the chin, true-to-life colour, slight film grain, no beauty retouching, visible pores and fine wrinkles, natural facial asymmetry.

CONSTRAINTS: same person, same age (72), same hairnet, same outfit in every panel. Plain white background, no props except the ladle. No text, no captions, no labels, no logos, no brand marks, no watermark, no extra jewellery. Not young, not middle-aged, not frail, not over 80, no freckles, no blue eyes, no smooth or airbrushed skin, no glamour makeup, no glasses, not a cartoon, not CGI, not plastic, not a caricature.
```

**Run settings:**
- Wide 16:9 or 3:2 sheet.
- Generate 8 and keep the 2 best.
- If any panel mirrors the tooth or the curl, **regenerate that sheet**. Don't flip panels.

---

## 2. Soul ID training set

- **Count:** 20–25 frames. **20 is the floor** (Higgsfield recommends 20 or more).
- **Mix (20 core frames, plus up to 5 extras):**
  - 8 frontal
  - 5 at a 3/4 angle (≤30°)
  - 4 close-ups with the gold tooth visible
  - 3 full-body
  - plus 2–5 in other outfits (Home Kitchen cardigan, Plot 14 bobble hat over the hairnet, Sunday Best rain bonnet)
- **Keep in every frame:** the hairnet and perm, the stray curl on the correct side, no glasses, hazel-brown eyes, no freckles. Cover lighting from both sides.
- **Exclude:**
  - profile shots
  - frames with hands near the mouth
  - motion blur
  - any frame where the tooth or the curl is on the wrong side (regenerate; never flip)
  - any frame where her face reads younger than 68 or older than 78
  - any frame with freckles or blue eyes
- **After training,** regenerate the sheet through Soul ID and compare it with the original. The QC agent approves it only if it meets the §7 similarity thresholds against the original and a vision-model check reads it as the same woman.

---

## 3. Master-still template (one per outfit per set)

```
[Soul ID: DOT] 9:16 vertical photoreal phone-camera still. A Yorkshire dinner lady, a 72-year-old woman, round ruddy face with fine broken capillaries (thread veins) across her cheeks and nose, fair skin with no freckles, warm hazel-brown eyes, laugh lines and crow's feet, a softening jawline, a few faint age spots on her temples, thinning grey-brown eyebrows, broad nose, slightly crooked lower front teeth, white tightly-curled short perm under a fine black hairnet, one gold tooth on her upper left canine, visible when she talks or smiles, one stray white curl escaping the hairnet above her left ear. Long-handled stainless steel serving ladle held in her right hand. No glasses. Wearing [OUTFIT from bible §11, pasted verbatim]. She stands behind [SET from §4], medium close-up from mid-chest up, facing the camera within 15 degrees, eye level slightly below her face, mouth gently closed in a neutral resting position, [PROP: e.g. a stemmed glass of orange drink on the steel counter to her left]. [SET lighting from §4]. Natural skin texture, visible pores, slight grain. Fully clothed. No text, no logos, no labels, no brand marks, no other people.
```

For looks without the ladle (Plot 14, Sunday Best), delete the ladle sentence and keep everything else.

**Lip-sync prep:**
- Mouth closed and neutral (so the tooth isn't asked to hold through speech).
- Both hands visible or resting, with nothing near the face.
- The ladle held low or resting on the counter, so lip motion isn't blocked.

### 3.0 Per-reel variant still (every reel gets its own)

The master still locks the face, the light recipe and the key-light side. Each reel animates from a **variant** generated from the master with Soul ID and the same light recipe. Change **at least two** of:
- crop: MCU (mid-chest up) / medium (waist up) / slightly wider (counter edge visible)
- counter props (bowls, tins, plates, a jug), always including the reel's own trend prop
- tea-towel position (tucked in the left tie / over the right shoulder / on the counter)
- background shelf items on the Hatch wall
- camera height (eye level / 5° lower)

Append to the master prompt: `Variant: [crop], [counter props], [tea towel position], [camera height]. Same face, same light direction, same outfit.`

Log the variant number against the reel. Each variant passes the §7 face checks before it's animated. This avoids near-identical first frames, which risk "unoriginal" or duplicate-content demotion.

### 3.1 Ladle-slam insert library (render once, reuse; no face, so no drift)

```
Extreme close-up, 9:16, a 72-year-old woman's right hand with a faded pale burn mark on the back gripping a long-handled stainless steel serving ladle, slamming the ladle bowl down flat onto a brushed stainless steel counter, small splash of gravy jumping, fluorescent light glinting on steel, slight camera shake on impact, photoreal, 0.6 seconds, no text, no logos.
```

Render 5 variants and save them as `slam_01–05`:
- dry counter
- gravy splash
- flour puff
- custard splash
- a Christmas version with a holly sprig on the counter

Add 3 more in week 2 (`slam_06–08`: different counter clutter) so the open doesn't repeat frame for frame across a week.

### 3.2 The stamp prop (blank face; the words are added in the edit)

```
Close-up, 9:16, an old wooden-handled rubber stamp with a BLANK rubber face being pressed down hard onto a plain white melamine plate on a stainless steel counter, a woman's hand with a faded pale burn mark, photoreal, no text, no letters, no ink marks visible.
```

### 3.3 The grin cutaway (ends every talking reel; this is where the gold tooth lives)

Animate from the reel's variant still with Kling (no audio, no lip-sync), 1.0–1.5 s. Motion prompt:

```
She stops, looks straight into the lens and breaks into a wide grin that shows her gold tooth, small nod, ladle still. No speech.
```

QC: the tooth is on the viewer's right and stays solid in the first and last frames. If it flickers, regenerate this clip only.

---

## 4. Location still prompts (empty scenes; no people, brands or readable text)

**L1. THE HATCH (her garage; signature set, 60% of talking reels)**

```
9:16 vertical photoreal interior, empty, no people. A converted single-car garage in a northern English terraced house fitted with a salvaged 1980s school-canteen serving hatch: a long brushed stainless steel counter with three empty bain-marie wells and a few dents and scuffs, a horizontal aluminium roller shutter half-raised above it, pale lilac painted breeze-block wall behind, a steel rail with hanging stainless ladles, slotted spoons and an egg slice, a stack of plain white melamine plates and a stack of plain white bowls, a wall shelf of plain unlabelled tins, a small window on the left with net curtain. Lighting: cool-white fluorescent tube overhead plus warm grey daylight from the left window, slight steam haze. Worn speckled grey lino floor. Camera on the customer side at chest height looking straight across the counter, clear standing space behind the counter for one person. No text, no signage, no posters, no logos, no labels, no children's artwork, no people.
```

**L2. HOME KITCHEN (cost reels, Mam's Tin, Operation Sprout)**

```
9:16 vertical photoreal interior, empty, no people. A small 1970s-fitted kitchen in a West Yorkshire red-brick terraced house: cream painted wooden cupboard doors with small brass knob handles, brown-and-cream patterned ceramic wall tiles, worn wooden worktop, an old white four-ring gas cooker with a steaming dented aluminium pan, deep white ceramic sink under a sash window with a net curtain and condensation on the glass, a stoneware crock of wooden spoons, a blank wall calendar with no writing, a plain red-and-white check tea towel on the oven rail, a small kitchen table with a lilac-and-white gingham oilcloth, a chipped white mug, a white chest freezer against the far wall. Lighting: warm low afternoon window light from camera-left, one warm overhead bulb. Lived-in but tidy. No text, no logos, no branded packaging, no readable labels, no people.
```

**L3. PLOT 14 (allotment; November–February)**

```
9:16 vertical photoreal exterior, empty, no people. An English allotment plot in late November, overcast mid-morning with soft flat grey light: a weathered green-painted timber shed with a small dusty window and a padlocked door, raised beds of leeks, curly kale and tall Brussels sprout stalks, a terracotta rhubarb forcing pot, a galvanised watering can, an old wooden wheelbarrow, wet grass paths, neighbouring plots with bean canes, bare trees and the backs of red-brick terraced houses in the distance, a thin wisp of bonfire smoke. Damp, muddy, real. No signs, no plot numbers, no text, no logos, no people.
```

**L4. ST BARNABAS CHURCH-HALL KITCHEN (Thursday Dinners; cooking at scale)**

```
9:16 vertical photoreal interior, empty, no people. The kitchen of a 1960s English church hall: long stainless steel worktops, a large stainless commercial six-burner range with two giant dented aluminium stockpots steaming, white square-tiled walls, an unbranded stainless tea urn, stacks of plain white cups and saucers, a serving hatch opening onto a hall with trestle tables covered in white paper and stacked orange plastic chairs, a plain wall clock without numerals, fluorescent ceiling lights with one slightly flickering, a mop bucket in the corner. No posters, no noticeboards, no signs, no text, no logos, no religious iconography in focus, no people.
```

---

## 5. Candid-photo prompts (stills, carousels and statics; "a phone snap Pat took")

**C1. PLOT 14 TROPHY** (no ladle in this look)

```
[Soul ID: DOT] Candid smartphone photo, 4:5, slightly off-level framing, a Yorkshire woman at her allotment in November holding up a single huge muddy leek like a trophy and laughing at someone off-camera. A 72-year-old woman, round ruddy face with fine broken capillaries (thread veins) across her cheeks and nose, fair skin with no freckles, warm hazel-brown eyes, laugh lines and crow's feet, a softening jawline, a few faint age spots on her temples, thinning grey-brown eyebrows, broad nose, slightly crooked lower front teeth, white tightly-curled short perm under a fine black hairnet, one gold tooth on her upper left canine, visible when she talks or smiles, one stray white curl escaping the hairnet above her left ear. A mustard knitted bobble hat pulled over the hairnet with the hairnet edge showing at the temples, pea-green quilted gilet over a lilac fleece, muddy navy wellies, overcast flat light, green timber shed behind, damp grass, cold pink cheeks, mild motion blur on the leek, natural phone-camera grain. No glasses. No ladle. No text, no logos, no other people.
```

**C2. DOT VS THE COMMENTS**

```
[Soul ID: DOT] Candid smartphone photo, 4:5, at a small kitchen table with a lilac-and-white gingham oilcloth, a Yorkshire woman in a custard-yellow cable-knit cardigan holding a smartphone at arm's length with the screen facing AWAY from the camera, squinting at it with deep suspicion, one eyebrow up. A 72-year-old woman, round ruddy face with fine broken capillaries (thread veins) across her cheeks and nose, fair skin with no freckles, warm hazel-brown eyes, laugh lines and crow's feet, a softening jawline, a few faint age spots on her temples, thinning grey-brown eyebrows, broad nose, slightly crooked lower front teeth, white tightly-curled short perm under a fine black hairnet, one gold tooth on her upper left canine, visible when she talks or smiles, one stray white curl escaping the hairnet above her left ear. Long-handled stainless steel serving ladle held in her right hand, resting on the table like a gavel. A chipped white mug of tea steaming, brown-and-cream tiles behind, warm window light from the left, slight grain. No glasses. Phone screen not visible. No text, no logos, no other people.
```

**C3. SUNDAY BEST AT THE BUS STOP** (no ladle in this look)

```
[Soul ID: DOT] Candid smartphone photo, 4:5, a Yorkshire woman waiting at a plain glass bus shelter on a wet terraced street, mid-laugh. A 72-year-old woman, round ruddy face with fine broken capillaries (thread veins) across her cheeks and nose, fair skin with no freckles, warm hazel-brown eyes, laugh lines and crow's feet, a softening jawline, a few faint age spots on her temples, thinning grey-brown eyebrows, broad nose, slightly crooked lower front teeth, white tightly-curled short perm under a fine black hairnet, one gold tooth on her upper left canine, visible when she talks or smiles, one stray white curl escaping the hairnet above her left ear. A clear plastic rain bonnet over the hairnet, knee-length navy wool swing coat with big black buttons, pale lilac knitted scarf, black handbag on her forearm, tartan shopping trolley bag beside her with leeks poking out, drizzle, grey daylight, red-brick houses behind, puddle reflections. No glasses. No ladle. No timetable, no adverts, no street signs, no readable text, no logos, no other people.
```

**C4. ACROSS THE POND: SQUASH VS SQUASH** (the first-frame still for P9; Service Lilac at the Hatch)

```
[Soul ID: DOT] 9:16 vertical photoreal phone-camera still at the Hatch. A Yorkshire dinner lady, a 72-year-old woman, round ruddy face with fine broken capillaries (thread veins) across her cheeks and nose, fair skin with no freckles, warm hazel-brown eyes, laugh lines and crow's feet, a softening jawline, a few faint age spots on her temples, thinning grey-brown eyebrows, broad nose, slightly crooked lower front teeth, white tightly-curled short perm under a fine black hairnet, one gold tooth on her upper left canine, visible when she talks or smiles, one stray white curl escaping the hairnet above her left ear. Long-handled stainless steel serving ladle held in her right hand, resting on the counter. Pale lilac short-sleeved wrap tabard over a white T-shirt. On the steel counter in front of her: a whole butternut squash on the left, and on the right a plain clear plastic bottle of orange cordial concentrate with no label beside an empty plain tumbler and a plain glass jug of water. She looks from the butternut squash to the camera with one eyebrow raised, mouth closed. Cool fluorescent overhead light plus warm daylight from screen-left. Natural skin texture, slight grain. Fully clothed. No text, no logos, no labels, no other people.
```

---

## 6. Relight rule for video

1. **Light the still, never the video.** Each set has a fixed light recipe:
   - **Hatch:** cool overhead fluorescent plus warm daylight from screen-left.
   - **Kitchen:** warm window light from screen-left plus a warm overhead bulb.
   - **Allotment:** flat overcast.
   - **Church hall:** fluorescent.

   The master still and every variant are generated under that recipe. If a still needs fixing (wrong direction, too dark, harsh shadows), relight the **still** (Higgsfield Relight or a re-generation) **before** animating. Don't relight a finished video, and don't put lighting words in a Seedance motion prompt that contradict the still.
2. **Light direction never flips within a reel.** All clips in one reel, including activity inserts and the grin cutaway, share the same key-light side. Light from screen-left is the house default.
3. **Colour temperature stays within ±300K across cuts.** Apply the set's LUT in the edit:
   - Hatch: neutral-cool, 4,300K
   - Kitchen: warm, 3,400K
   - Allotment: neutral, 5,600K
   - Church hall: neutral, 4,000K
4. **Motion prompts describe movement only.** For example: "speaks firmly to camera, small nods, eyebrows raise on the punchline, ladle taps the counter twice". Don't mention light, time of day, weather or camera moves beyond a slow push-in. Don't ask for the gold tooth in a talking clip; it belongs to the grin cutaway.
5. **Christmas variants** add warm fairy-light bokeh in the still only, and the key-light side stays the same.
6. **Reject a clip** if her skin tone shifts by more than a visible step between cuts, if the light swings during speech, or if the gold tooth is missing or on the wrong side in a still, a first frame or a last frame. Mid-speech tooth flicker in a Seedance clip is not a reject on its own.
7. **Clip length:** every Seedance clip is ≤10 s with ≤10 s of uploaded audio (≤8 s on plans that cap at 8 s). Higgsfield's hard limit is 15 s per shot and per audio clip; never plan to it.

---

## 7. Face-drift test (run by Sun 25 Oct; repeat every 4 weeks and after any model update)

This follows the studio's proposed single spec (the same numbers as Margot's file), so all five personas are tested the same way.

**Per-character test: 20 generations from Soul ID**
- 5 looks across the 4 sets: 8 stills, 8 Seedance frame grabs (first and last frames only) and 4 Kling grin-cutaway frames.
- 3 of the 20 deliberately hard: low light, a big laugh, a 30° turn.

**Face-embedding similarity to the reference** (panel 3 of the approved sheet):

| Measure | Pass |
|---|---|
| Median of 20 | ≥ 0.70 |
| Lowest single image | ≥ 0.60 |

These are defaults; recalibrate on the first run and log the calibration.

**Anchor and constant checklist (score every generation):**
1. The face reads as Dot at a glance.
2. The perm and hairnet are present.
3. The stray curl is above her left ear (the viewer's right).
4. The gold tooth is on the correct side. **Scored on stills and on first/last frames only**; mid-speech frames are exempt.
5. No glasses.
6. Her eyes are hazel-brown.
7. No freckles; thread veins present.
8. She reads as 70–75 (never under 68, never over 78).
9. The ladle is in her right hand (where the look has a ladle).
10. No text or logo.

**Pass:** the similarity thresholds above, plus ≥ 18 of 20 generations passing all 10 checks. If she fails, retrain the Soul ID with more frontal close-ups and re-run.

**Cross-character test (all five; numeric ceiling plus automated distinctness sort)**
- **Similarity:** compare Dot's reference against Margot's, Rosa's, Walt's and Ambrose's references. Similarity must be **< 0.45 for every pair**.
- **Automated distinctness sort (replaces the human blind sort):** a grid of 6 frames per persona (30 frames, shuffled). The QC agent assigns each frame to its nearest persona by face embedding against the five references, and a vision model given the five reference sheets sorts them into five piles independently. **Pass: 0 mis-sorts on both.**
- **If Dot fails against Margot or Rosa:** push the round ruddy face, thread veins, hazel-brown eyes, hairnet and no-glasses rule harder and re-test. If she fails a second time, switch anchor 1 to `steel-grey tightly-curled short perm under a fine black hairnet` (the fallback that takes her out of the white-and-silver cluster), retrain and re-test.

**Logging:** store the scores, the contact sheet and pass/fail in the persona record.

**Weekly QC in production:** spot-check 1 in 5 published talking reels with checks 1–10 (tooth on first/last frames and the grin cutaway). Drift above 5% pauses talking reels (bible §17).

---

## 8. Negative prompt (append when the tool supports one)

```
young, middle-aged, frail, very elderly, over 80, smooth skin, airbrushed, glamour makeup, freckles, blue eyes, pale blue eyes, grey-blue eyes, glasses, sunglasses, purple hair, violet streak, silver pixie cut, cream cardigan, cream Aran cardigan, beaded glasses chain, olive skin, profile view, two people, crowd, children, child, text, letters, words, captions, logo, brand, label, watermark, signage, poster, cartoon, anime, 3D render, CGI, plastic skin, extra fingers, deformed hands, gold tooth on her right side, two gold teeth, curl above her right ear, missing hairnet, nudity, revealing clothing
```
