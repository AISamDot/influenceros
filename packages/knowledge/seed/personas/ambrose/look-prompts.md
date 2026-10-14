# Ambrose Hale: Look Prompts (Higgsfield) v1.1

**v1.1 changes:** the face now separates from Margot's (rectangular face, square jaw, shallow cleft chin, grey-green hazel eyes); the tie is midnight-navy, not slate-blue; **every set is keyed from camera-right**; the boot room is honey Bath stone, not whitewash; the drift test now has numbers and runs against all four siblings; Pantry Book VO shots are daylight and object-led; start frames vary per reel.

**Pipeline:**
1. Soul ID character sheet.
2. Twenty-generation drift test, plus the all-five cross test (§1). Both must pass before any production still is made.
3. In-set stills (Soul 2.0 / Nano Banana), one per outfit per set, then **one fresh variant per reel** (crop and props change; face and light don't).
4. Talking clips (Seedance 2.0, 720p, uploaded ElevenLabs voice track, two clips of 15 s or less per reel; each clip 29 spoken words or fewer).
5. Activity clips (Kling 3.0 or Wan, image-to-video from an in-set still).
6. Export at 1080×1920 with sharpening.

**Fixed rules for every generation:**
- 9:16.
- The three anchors and the hair line are repeated verbatim.
- Age is forced to 72 in every prompt that shows him, candids included.
- Fully clothed.
- No logos, brands, readable text, or watch or clock faces.
- Props are in the scene from the first frame.
- One person only.
- Key light from **camera-right**.
- Never describe the face in image-to-video prompts; let the still carry it.

**Anchors (copy exactly):**
- `white cotton butler's gloves on both hands, always on`
- `a silver pocket-watch chain across the waistcoat, the watch closed and tucked away`
- `half-moon reading glasses perched low on the nose, thin gold wire frames`
- Hair: `silver-white hair combed straight back with visible comb lines, slightly thinning at the temples`

---

## 1. Character sheet (Soul ID reference): 3 panels, white background

**Prompt (about 3,250 characters; keep under 3,500):**

```
Photorealistic character reference sheet, three panels side by side on a seamless pure white studio background, the same man in all three panels. Panel 1: full front view from head to mid-thigh, facing the camera, standing upright, neutral composed expression. Panel 2: three-quarter view turned 30 degrees to his right, chest-up, a slight closed-mouth smile. Panel 3: front-facing head-and-shoulders close-up, looking at the camera over the top of his glasses, one eyebrow faintly raised.

Subject: Ambrose Hale, a 72-year-old English butler, clearly elderly with real visible age: deep horizontal forehead lines, crow's feet, deep nasolabial folds, thin skin with a few liver spots at the left temple, loose skin at the neck. Tall and lean with slightly rounded shoulders and an upright butler's posture. Long rectangular face with a strong square jaw and slight jowls at the jaw corners, a shallow cleft chin, a high domed forehead, a prominent Adam's apple. Deep-set grey-green hazel eyes with hooded lids, a strong slightly hooked nose with a small bump on the bridge, thin lips, clean-shaven with a faint silver stubble shadow, bushy silver eyebrows with a few long wiry hairs, the left eyebrow slightly higher than the right, a small healed nick on the chin, faint pink pressure marks on the nose bridge, slightly large ears with long lobes, one lower front tooth slightly crooked.

Hair: silver-white hair combed straight back with visible comb lines, slightly thinning at the temples, no parting.

Signature anchors, visible in every panel: white cotton butler's gloves on both hands, always on; a silver pocket-watch chain across the waistcoat, the watch closed and tucked away; half-moon reading glasses perched low on the nose, thin gold wire frames.

Wardrobe, fully clothed: a charcoal grey wool herringbone three-piece suit, single-breasted two-button jacket with notch lapels, five-button waistcoat with the bottom button undone, flat-front trousers with a sharp crease, a crisp white cotton shirt with a semi-cutaway collar, a plain matte midnight-navy silk tie with a small dimple, black cap-toe oxford shoes in panel 1. No pocket square, no tie bar, no lapel pin, no rings.

Hands: in panel 1 the gloved hands are loosely clasped in front at belt height; in panel 2 one gloved hand rests flat on the waistcoat.

Lighting and camera: soft studio key light from the front-right with gentle fill, no harsh shadows, white gloves and shirt correctly exposed with matte cotton texture visible, true-to-life skin texture with pores and fine wrinkles, 85mm portrait lens look, sharp focus, neutral colour grade, fine film grain.

Deliberate imperfection: a few lint flecks on the left lapel, a faint crease across the right shirt cuff, the tie dimple slightly off-centre.

Consistency: identical face, hair, glasses, gloves, watch chain and suit in all three panels, the same age of 72 in every panel.

Exclude: logos, brand names, text, labels, monograms, watermark, visible watch face, young or smoothed skin, blue eyes, beard, moustache, hat, pocket square, bare hands, extra fingers, distorted hands, cartoon, 3D render, illustration style, revealing clothing.
```

**Soul ID training set (20+ images):**
- Generate the sheet 6 times.
- Keep the best 2 sheets.
- Split each into three panels.
- Add 14 in-set stills (§2) that pass the face check, at least 4 of them in each of L1 and L2.

### Drift test (studio spec; run 21–24 Oct, before batch production)

**Tooling:** face-embedding cosine similarity with InsightFace ArcFace (`buffalo_l`), the same model for every persona so the numbers compare. Reference image: **panel 3** of the chosen sheet.

**A. Per-character: 20 generations**
- 4 sets × 5 conditions:
  - front, talking expression
  - 15° turn
  - looking down at a prop
  - candid mid-laugh
  - Outfit 5 (Christmas Service)
- 4 of the 20 are Seedance frame grabs (scored at the first, middle and last frame; the lowest counts).

| Measure | Pass |
|---|---|
| Median similarity to panel 3 | **≥ 0.70** |
| Lowest single image | **≥ 0.60** |
| All three anchors plus the hair line present | **20 of 20** |
| Reads 70 or older (QC agent: vision-model age estimate, two independent passes agree) | **20 of 20** |
| Grey-green hazel eyes, cleft chin, square jaw visible where the angle allows | **≥ 18 of 20** |

**B. Cross-character: Ambrose against all four siblings**
- Score Ambrose's panel 3 against each sibling's reference (Margot, Dot, Rosa, Walt), and Ambrose's 20 drift images against each sibling reference.
- **Fail if any single score is 0.45 or higher.** One ceiling for every pair.
- **Pair to watch: Margot.** She shares silver hair, glasses, a long face and an English-or-Irish stone-cottage world. Log her pair score separately on the contact sheet.
- **Automated distinctness sort (replaces the human blind sort):** a grid of 6 frames per persona (30 frames, all five), shuffled, in their own sets and outfits, plus a second grid of the same five faces in one neutral grey studio at the same mid close-up. The QC agent matches each frame to a name by face embedding (nearest reference), and a vision model given the five reference sheets matches them independently. **Pass: 0 mis-sorts across both grids, by both methods.**

**If A fails:** replace the 5 lowest-scoring training images with fresh sheet-derived references, retrain Soul ID, re-run A.
**If B fails against Margot:** push the rectangular jaw, cleft chin and hazel eyes harder in the sheet; warm the pantry grade by 200K; never seat him in a cardigan or knit near a window. Re-run B.
**If B fails against Walt:** push clean-shaven, the combed-back hair and the half-moons on the nose (Walt Novak, 68, Polish-American, is the studio's other older man). Re-run B.

**Logging:** store scores, both contact sheets and pass/fail in the persona record. Re-run A and B every 4 weeks and after any Higgsfield model update.

---

## 2. Location stills (empty scenes)

Each set has **one fixed key-light direction: window camera-right** (every sibling's main set is keyed from camera-left). Generate each scene once, keep the best version as the **set reference image**, and feed it into every in-set generation together with the Soul ID.

### L1: The Silver Pantry (verdicts, Pantry Book VOs, Rules)
```
Photorealistic empty interior, vertical 9:16, a small English butler's pantry built into the back kitchen of an old honey-coloured Bath-stone cottage. Walls and cabinetry painted deep ink blue, glass-fronted upper cupboards holding neat rows of plain crystal glasses, stacked plain white plates and a row of small plain dark leather notebooks with no titles, worn brass cup-pull handles. In the foreground a long scrubbed oak counter at waist height with a folded plain linen cloth, a polished plain silver salver, a small plain silver hand bell, and a small brass desk lamp, switched off. A deep white ceramic butler's sink with an old brass tap at the left edge. A small sash window camera-right with a plain muslin blind half down, letting in soft cool morning daylight. Small imperfections: a faint water ring on the oak, a hairline crack in one wall tile, a smudge on one cupboard pane. Eye-level camera at counter height, 35mm lens, gentle depth of field, slight film grain. No people. No text, no labels, no logos, no brands, no readable writing anywhere, no clocks.
```

### L2: The Snug (seated talking, Sunday rituals, trust content)
```
Photorealistic empty interior, vertical 9:16, a small low-ceilinged sitting room in an old English Bath-stone cottage at dusk. Walls in warm dove-grey limewash with dark ink-blue painted woodwork, one dark oak ceiling beam. A worn dark brown leather wingback armchair angled toward the camera, a small stone fireplace with a low coal fire glowing on the left, a narrow side table holding a plain white china teacup and saucer, a closed hardback book with a plain cloth cover, and a brass table lamp with a linen shade casting warm amber light. A small bookshelf with plain unmarked spines, softly out of focus. A small window camera-right showing deep blue dusk light. Small imperfections: a slightly threadbare arm on the chair, a few ash flecks on the hearth, a lamp shade sitting slightly crooked. Eye-level camera at seated head height, 35mm lens, warm and cool light mixed, slight film grain. No people. No text, no titles, no logos, no brands, no readable writing, no clocks, no television.
```

### L3: The Cottage Dining Room (Rules, hosting demos, the Street Lunch)
```
Photorealistic empty interior, vertical 9:16, a small cottage dining room with pale stone-grey painted panelling and ink-blue skirting. A rectangular dark oak table for six laid formally for dinner: a pressed white linen tablecloth, plain white dinner plates set exactly the same distance from the table edge, plain silver cutlery, plain crystal wine and water glasses above the knives, white linen napkins folded in simple rectangles, two plain silver candlesticks with unlit cream candles. A 12-inch pale boxwood ruler with no markings visible resting along the near table edge. Six matching worn wooden dining chairs. A low sideboard behind with two covered plain silver serving dishes. A window camera-right with soft blue-hour light and warm light from a single wall lamp on the left. Small imperfections: one chair slightly out of line, a faint scorch mark on the sideboard, a candle wick bent. Camera at standing eye level looking slightly down the table, 35mm lens, slight film grain. No people. No text, no labels, no logos, no brands, no readable writing, no clocks, no artwork with faces.
```

### L4: The Boot Room (shoe and coat care, ironing the newspaper, Outdoor departures)
```
Photorealistic empty interior, vertical 9:16, a narrow cottage boot room and scullery with a worn grey flagstone floor and bare honey-coloured Bath-stone walls. A row of black iron hooks holding a dark charcoal-navy wool overcoat and a dove-grey wool scarf, a plain black umbrella with a wooden crook handle. A long wooden bench with three pairs of polished black and brown leather shoes fitted with wooden shoe trees, a wooden box of horsehair brushes and folded cloths beside them. A wooden ironing board holding a heavy old black cast-iron flat iron with a worn wooden handle and a folded newspaper whose columns are blurred and unreadable with no masthead. A small window camera-right with cool early-morning daylight, a wicker basket of logs on the floor. Small imperfections: mud on the doormat, a scuff on one shoe, a cobweb in the top corner. Eye-level camera, 35mm lens, crisp cool light, slight film grain. No people. No text, no labels, no logos, no brands, no readable writing, no clocks.
```

---

## 3. Candid photo prompts (Soul ID on, character in scene)

Use these for statics, carousel covers and "real life" texture. Anchors and hair line verbatim; age forced.

### C1: Caught mid-task (Pantry Shirtsleeves, L1)
```
Candid phone photo, vertical 9:16, Ambrose Hale (Soul ID), a 72-year-old English butler, clearly elderly, standing at the scrubbed oak counter of a small ink-blue butler's pantry, looking down with total concentration while polishing a plain silver spoon with a linen cloth, unaware of the camera. Jacket off: charcoal herringbone waistcoat, white shirt sleeves held up by black elastic sleeve garters, tie tucked into the shirt, a long plain ink-blue work apron. White cotton butler's gloves on both hands, always on; a silver pocket-watch chain across the waistcoat, the watch closed and tucked away; half-moon reading glasses perched low on the nose, thin gold wire frames; silver-white hair combed straight back with visible comb lines, slightly thinning at the temples. Shot from slightly above on a phone at 26mm, horizon a little off-level, soft cool window light from the right, slight motion blur on the polishing hand, a smudge on the cupboard glass behind him, lint on the waistcoat. No text, no logos, no brands, no other people.
```

### C2: Market morning (Outdoor, exterior)
```
Candid phone snapshot, vertical 9:16, Ambrose Hale (Soul ID), a 72-year-old English butler, clearly elderly, at an outdoor winter market in a small English town of honey-coloured stone, choosing a clementine from a wooden crate, holding it up to the light with mild suspicion. He wears a knee-length dark charcoal-navy wool Chesterfield overcoat with a black velvet collar over a charcoal three-piece suit, a dove-grey wool scarf, a furled plain black umbrella over his forearm. White cotton butler's gloves on both hands, always on; a silver pocket-watch chain across the waistcoat, the watch closed and tucked away, just visible under the open coat; half-moon reading glasses perched low on the nose, thin gold wire frames; silver-white hair combed straight back with visible comb lines, slightly thinning at the temples. Grey drizzly morning, soft light from the right, wet cobbles, breath faintly visible, background stalls and passers-by heavily blurred with no faces in focus, taken from about two metres away, slightly tilted, a raindrop on the lens edge. No readable signs, no price tags, no text, no logos, no brands.
```

### C3: The snug after hours (Day Off, L2)
```
Candid phone photo, vertical 9:16, Ambrose Hale (Soul ID), a 72-year-old English butler, clearly elderly, sitting in a worn dark leather wingback armchair in a small cottage sitting room at night, caught mid-laugh at something off-camera, head tipped back slightly, eyes creased. He wears a moss-grey knitted wool waistcoat over a pale blue-grey Oxford shirt with a dark navy knitted tie and grey flannel trousers. White cotton butler's gloves on both hands, always on, one hand holding a plain white china teacup; a silver pocket-watch chain across the waistcoat, the watch closed and tucked away; half-moon reading glasses perched low on the nose, thin gold wire frames; silver-white hair combed straight back with visible comb lines, slightly thinning at the temples. Warm amber lamp light from the right, a low coal fire glowing on the left behind him, slightly underexposed, visible phone-camera grain, a little soft focus. No text, no logos, no brands, no television, no other people.
```

---

## 4. In-set still template (Soul 2.0 / Nano Banana, start frames for video)

```
Photorealistic, vertical 9:16, Ambrose Hale (Soul ID), a 72-year-old English butler, [OUTFIT exact description from bible §11], white cotton butler's gloves on both hands, always on; a silver pocket-watch chain across the waistcoat, the watch closed and tucked away; half-moon reading glasses perched low on the nose, thin gold wire frames; silver-white hair combed straight back with visible comb lines, slightly thinning at the temples. [SET reference image + one-line set description]. [POSE: chest-up, facing camera within 15 degrees, eye level, both gloved hands resting on the counter beside the PROP]. [PROP already in frame]. Soft window light from camera-right, warm practical lamp in the background, catchlights in both eyes, no shadow across the mouth, white gloves correctly exposed, matte cotton texture visible. Real skin texture, slight film grain, one small imperfection [lint on lapel / creased cuff]. No text, no logos, no brands, no clocks, no other people.
```

**Vary per reel (never publish two reels from the identical start frame):** pick one crop (chest-up / waist-up / chest-up with the camera 5–10° higher), one secondary prop arrangement (cloth folded or draped, bell left or right of the salver, notebook shelved or on the counter) and one imperfection. Face, outfit, set and light stay locked. Log the combination per post so it isn't repeated within 14 days.

## 5. Video prompt templates

**Talking (Seedance 2.0, 720p, uploaded audio, at most 15 s per clip; 29 spoken words or fewer and one held pause):**
```
Start frame: [in-set still]. Ambrose speaks calmly and precisely to camera with small, natural mouth movements matching the audio, minimal head movement, slow occasional blinks, a slight raise of the left eyebrow over his glasses at the end. Both gloved hands stay resting on the counter beside the [PROP]. Camera locked off at eye level, 9:16. Soft window light from camera-right, warm lamp in the background, lighting unchanged. One person only, no text, no other movement in the scene.
```
**If the Higgsfield plan caps clips at 8 s:** split each `// CUT` half again at the full stop nearest its middle, and render each piece from the same start frame with its own audio slice.

**Activity (Kling 3.0 or Wan, 5 s, no speech):**
```
Start frame: [in-set still, tight on gloved hands and object]. One slow, deliberate motion: [the gloved hand lays the boxwood ruler from the table edge to the plate rim, then lifts it away]. Hands steady, fingers in white cotton gloves, the object stays the same shape and size. Static camera, shallow depth of field, soft window light from camera-right unchanged. No text, no new objects appear, no other people.
```

**Pantry Book VO shot set (daylight, object-led; never a desk, a pen writing or an evening lamp):**
1. The story's object in gloved hands at the counter (a flute lifted to the window, a candle turned, a serving spoon held to the light).
2. A gloved hand takes one plain dark leather notebook from the row in the glass-fronted cupboard and lays it, closed, on the silver salver.
3. The object is set back in its place on the shelf or counter.

---

## 6. The relight rule for video

1. **One key per set, always camera-right.**
   - Pantry: soft cool morning daylight through a muslin blind (about 5,000K); brass lamp off.
   - Snug: dusk window plus an amber lamp.
   - Dining: blue hour plus a wall lamp (candles unlit unless the clip is a candle shot).
   - Boot room: cool early morning.
   - Every start frame must show its set's key and time of day. **Never animate a still that was lit for another set**, and never mix times of day inside one reel.
2. **Never feed the white-background character sheet (or any studio-lit still) straight into Seedance or Kling.** First regenerate the start frame *in the set* with Soul ID plus the set reference image. If an approved still drifts in light, run it through Higgsfield relight to match the set reference (direction, colour temperature, contrast) before any video credits are spent.
3. **Talking-face lighting:**
   - Key light 30–45° from the front-right, about 2:1 fill.
   - Catchlights in both eyes.
   - No glasses glare and no shadow across the mouth.
   - No top light, backlight or rim-only light (they darken the mouth and weaken lip-sync).
   - Face within 15° of the camera.
4. **Protect the whites.** Gloves and shirt must keep matte cotton texture: expose for the gloves and never clip them. Put `white gloves correctly exposed, matte cotton texture visible` in the still prompt.
5. **Restate the light in every video prompt** ("soft window light from camera-right, warm lamp in the background, lighting unchanged"). Never write a generic "cinematic lighting".
6. **One grade per set.** Apply the set's LUT in post. Match skin tone across clips in the same reel, and flag a mismatch at QC Q3.
7. **Props never pop in.** Every prop that appears in a clip must already be in its start frame. If a clip needs a new prop, generate a new start frame.
