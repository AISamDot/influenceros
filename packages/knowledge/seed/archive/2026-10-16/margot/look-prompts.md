# Margot: Look Prompts (Higgsfield) v2

**Pipeline:**
- **Character:** Soul ID character sheet → Soul ID training set.
- **Stills:** Nano Banana / Soul 2.0.
- **Talking reels:** Seedance, 9:16, 720p, image-to-video from an approved start still, with the ElevenLabs track uploaded.
- **Activity and voiceover clips:** Kling or Wan.

**Rules for every prompt:**
- Paste the 3 anchors **verbatim**. Where the glasses sit (on her face, or hanging at her chest) goes in a separate clause after the anchors: `Glasses position: …`.
- Paste the face text **verbatim**. Never paraphrase or shorten it.
- Force the age ("84-year-old … clearly in her mid-eighties").
- Fully clothed. Swim robe always zipped; no swimwear ever visible.
- Hair always dry.
- No brands, logos, readable text or letter shapes: the mug is plain, any paper is blank.
- Every prop is in the first frame.
- No red graphics, no rubber stamp, no desk lamp, no biscuit tin, no look over the top of her glasses.

**Anchors (verbatim, every prompt)**
1. `short tousled silver-white pixie cut with a soft side-swept fringe falling to her left`
2. `round translucent sea-glass-green acetate glasses on a beaded chain of small amber, cream and turquoise beads`
3. `a single small plain gold hoop earring in her left ear only, right ear bare`

**Glasses position clauses (pick one, after the anchors)**
- `Glasses position: worn on her face.`
- `Glasses position: hanging on the chain at her chest.`

**Face (verbatim, every prompt)**
`long oval face, high cheekbones, long straight nose, deep-set pale blue-grey eyes, fine silver-grey eyebrows, deep crow's feet, dense fine sun freckles across nose and cheekbones on weathered, lightly tanned fair skin, thin lips with a wry lopsided half-smile (left corner higher), a faint pale scar through the outer end of her right eyebrow, natural skin texture`

---

## 1. Character-sheet prompt (3-panel, white background; about 2,700 characters)

```
Photorealistic character reference sheet, three panels side by side on a plain seamless pure white background, soft even studio light, no shadows on the background, the same woman in all three panels.
LEFT PANEL: full-body, standing straight, facing camera, arms relaxed.
CENTER PANEL: head-and-shoulders close-up, facing camera directly, calm wry half-smile.
RIGHT PANEL: waist-up three-quarter view turned slightly to her right, looking at camera.

SUBJECT: Margot, an 84-year-old Irish woman, clearly elderly and in her mid-eighties, tall, lean and wiry with upright posture and slightly bony hands. long oval face, high cheekbones, long straight nose, deep-set pale blue-grey eyes, fine silver-grey eyebrows, deep crow's feet, dense fine sun freckles across nose and cheekbones on weathered, lightly tanned fair skin, thin lips with a wry lopsided half-smile (left corner higher), a faint pale scar through the outer end of her right eyebrow, natural skin texture. Visible pores and fine wrinkles, no makeup, no retouching.

SIGNATURE ANCHORS, IDENTICAL IN ALL THREE PANELS:
1) short tousled silver-white pixie cut with a soft side-swept fringe falling to her left
2) round translucent sea-glass-green acetate glasses on a beaded chain of small amber, cream and turquoise beads
3) a single small plain gold hoop earring in her left ear only, right ear bare
Glasses position: worn on her face, the chain looping behind her neck.

WARDROBE, FULLY CLOTHED, IDENTICAL IN ALL PANELS: chunky cream Aran cable-knit cardigan with brown horn toggle buttons, sleeves slightly long and pushed up to the forearm, worn over a fine sea-glass-green merino turtleneck; deep-teal wide-leg wool trousers; brown leather lace-up brogues. Plain fabrics, no logos, no labels, no text, no patterns other than the cable knit.

DELIBERATE IMPERFECTION: a few flyaway silver hairs, a faint fingerprint smudge on the left lens, one toggle slightly askew, a loose thread at one cuff.

STYLE: real photograph, 50mm lens, natural colour, neutral white balance, sharp focus on the face, consistent identity, proportions and lighting across all three panels, reference-sheet clarity.

AVOID: young or middle-aged face, round or ruddy face, rosy flushed cheeks, smooth or airbrushed skin, heavy makeup, curls, perm, hairnet, wet hair, coloured hair streaks, long hair, tortoiseshell, black or gold wire glasses, glasses pushed up into the hair, sunglasses, two earrings, hoop in the right ear, hats, jewellery other than described, any text, letters, numbers, watermark, logo or brand, props, furniture, background scenery, cartoon, 3D render, illustration, painting, extra people, extra fingers, mirrored or flipped face.
```

**Settings**
- Aspect 16:9 (sheet). Generate 4 and keep the one where all three panels match.

**Soul ID training set** (Higgsfield recommends 20+ clean, varied, well-lit images)
- From the sheet, generate **24 singles**: 6 per look (Sunroom W1, Sunroom W5, Sunroom W4, Prom W2). Bathing Steps W3 gets its own 6 later.
- Each set of 6 covers front, slight left and slight right, with expressions: neutral, half-smile, laugh, one raised eyebrow, and one with the glasses hanging on the chain (for the reaction beat).
- Every single includes the anchors, the glasses-position clause and the face text, verbatim.
- Reject any image with a flipped hoop, the wrong glasses colour, a curl, wet hair, lettering on the mug or a red graphic.
- Train Soul ID on the best 20. A Soul 2.0 character works only in Soul 2.0, so train separately for any other Soul model you use.

---

## 2. Location stills (empty scenes, 9:16; no people, brands or readable text)

Each set has a **locked light recipe** (in brackets). Paste it verbatim into every still and video prompt for that set. The Bureau set is retired (v2).

### 2.1 The Sunroom (home base; talking reels; the Tempo Office tube; W1 / W4 / W5)
`[LIGHT: soft overcast window light from camera left, 5600K, gentle bounce fill from the right, low contrast, no direct sun]`
```
Photorealistic empty interior, vertical 9:16, eye-level camera: a small glass lean-to sunroom on the side of a whitewashed stone cottage on the west coast of Ireland, late morning, overcast, rain beads and thin streaks running down the glass panes. In the foreground a worn scrubbed-pine table; on it a chipped plain cream enamel mug with a thin gold repaired seam down one side and no lettering, a brown glazed teapot, and a smooth palm-sized amber glass pebble glowing faintly. On the whitewashed stone back wall, a small square brass hatch with a closed hinged door, a shallow brass receiving tray beneath it and a short run of brass pipe rising into the wall; a plain brass cylinder canister with domed ends and two felt rings lies in the tray. Behind: a wicker armchair with a folded pale grey-green wool throw, terracotta pots of red geraniums on the low sill, a row of old glass jars holding buttons and coins, tomato plants on canes, a blurred grey-green sea and low hills beyond the glass. Lived-in, a little cluttered, real. [LIGHT: soft overcast window light from camera left, 5600K, gentle bounce fill from the right, low contrast, no direct sun]. No people, no text, no letters, no numbers, no logos, no brand names, no readable labels, no markings on the canister.
```

### 2.2 The Prom (seafront; activity + text; Receipts From 2075; W2)
`[LIGHT: flat overcast daylight, 6500K, no direct sun, soft top light, low contrast]`
```
Photorealistic empty outdoor scene, vertical 9:16, eye-level: a long seaside promenade on the west coast of Ireland beside a low sea wall with a pale green painted metal railing, rust showing through in spots. Wet grey concrete path with shallow puddles reflecting the sky, choppy grey-green Atlantic with small whitecaps, a heavy pale overcast sky, a blurred concrete diving tower far along the shore and low hills across the bay. A wooden bench facing the sea. Windy, damp, real. [LIGHT: flat overcast daylight, 6500K, no direct sun, soft top light, low contrast]. No people, no signs, no text, no numbers, no logos, no brands, no cars.
```

### 2.3 The Bathing Steps (seated or static only; candid statics; W3)
`[LIGHT: misty overcast morning, 6000K, soft and even, light from the sky behind camera, low contrast]`
```
Photorealistic empty outdoor scene, vertical 9:16: weathered granite steps leading down into choppy grey-green sea, dark seaweed on the lower wet steps, a steel handrail running down beside them, sea spray and light mist. On the top dry step: a tall brushed-copper flask with a plain domed copper cap screwed on and closed, a dented enamel tin cup with faint steam rising, and a folded sea-glass-green silicone swim cap. Low rocky shoreline and a blurred stone sea wall behind. Early morning, cold, quiet. [LIGHT: misty overcast morning, 6000K, soft and even, light from the sky behind camera, low contrast]. No people, no signs, no text, no logos, no brands, no markings on the flask.
```

### 2.4 Empty-plate library (voiceover b-roll; no Margot, so no drift)
Generate once in batch week from the stills above as 5 s Kling clips, gentle motion only. Reuse them across *Dear You* and *Receipts From 2075*.

| Plate | From | Motion |
|---|---|---|
| E1 Rain on the Prom railing | 2.2 | Rain falling, puddles rippling |
| E2 Waves on the sea wall | 2.2 | A wave breaks against the wall, spray |
| E3 The steps at high water | 2.3 | Swell washing over the lower steps |
| E4 The tube hatch, close | 2.1 | Static hatch, rain shadows moving on the wall |
| E5 Rain on the sunroom glass | 2.1 | Drops running down the pane, sea blurred beyond |

---

## 3. Candid-photo and start-frame prompts (with Margot; Soul ID)

### 3.1 Profile picture: "Hello, you" (Sunroom, W1; 4:5)
```
Candid phone photo, 4:5, of Margot, an 84-year-old Irish woman, clearly in her mid-eighties, sitting at a worn pine table in a rain-streaked glass sunroom, mid-laugh, holding a chipped plain cream enamel mug with a thin gold repaired seam and no lettering in both hands, looking straight at camera. short tousled silver-white pixie cut with a soft side-swept fringe falling to her left; round translucent sea-glass-green acetate glasses on a beaded chain of small amber, cream and turquoise beads; a single small plain gold hoop earring in her left ear only, right ear bare. Glasses position: worn on her face. long oval face, high cheekbones, long straight nose, deep-set pale blue-grey eyes, fine silver-grey eyebrows, deep crow's feet, dense fine sun freckles across nose and cheekbones on weathered, lightly tanned fair skin, thin lips with a wry lopsided half-smile (left corner higher), a faint pale scar through the outer end of her right eyebrow, natural skin texture. Fully clothed in a chunky cream Aran cable-knit cardigan with brown horn toggles over a sea-glass-green turtleneck. Red geraniums blurred behind. [LIGHT: soft overcast window light from camera left, 5600K, gentle bounce fill from the right, low contrast, no direct sun]. Slight phone-camera grain, slightly off-centre framing, one flyaway hair. No text, no logos, no brands.
```

### 3.2 Top step, before the swim (Bathing Steps, W3; 4:5)
```
Candid phone photo, 4:5, of Margot, an 84-year-old Irish woman, clearly elderly, sitting on the top dry step of weathered granite sea steps before her morning swim, laughing into the wind and squinting, holding a dented enamel tin cup with faint steam rising in both hands, a tall brushed-copper flask with its domed cap screwed on and closed standing beside her on the step, a folded sea-glass-green swim cap on her knee. short tousled silver-white pixie cut with a soft side-swept fringe falling to her left; round translucent sea-glass-green acetate glasses on a beaded chain of small amber, cream and turquoise beads; a single small plain gold hoop earring in her left ear only, right ear bare. Glasses position: hanging on the chain at her chest. Hair dry. long oval face, high cheekbones, long straight nose, deep-set pale blue-grey eyes, fine silver-grey eyebrows, deep crow's feet, dense fine sun freckles across nose and cheekbones on weathered, lightly tanned fair skin, thin lips with a wry lopsided half-smile (left corner higher), a faint pale scar through the outer end of her right eyebrow, natural skin texture. Fully clothed in a plain charcoal hooded fleece-lined changing robe zipped up to the collarbone, black neoprene swim slippers, no swimwear visible. Grey-green choppy sea behind. [LIGHT: misty overcast morning, 6000K, soft and even, light from the sky behind camera, low contrast]. Real and unposed. No text, no logos, no brands.
```

### 3.3 "The canister" (Sunroom tube wall, W4; 4:5; carousel covers and trust statics)
```
Candid photo, 4:5, of Margot, an 84-year-old Irish woman, clearly in her mid-eighties, standing beside a small square brass hatch set into the whitewashed stone wall of a rain-streaked glass sunroom, holding a plain brass cylinder canister with domed ends and two felt rings in both hands at chest height, one eyebrow raised, dry and amused, looking straight at camera. short tousled silver-white pixie cut with a soft side-swept fringe falling to her left; round translucent sea-glass-green acetate glasses on a beaded chain of small amber, cream and turquoise beads; a single small plain gold hoop earring in her left ear only, right ear bare. Glasses position: worn on her face. long oval face, high cheekbones, long straight nose, deep-set pale blue-grey eyes, fine silver-grey eyebrows, deep crow's feet, dense fine sun freckles across nose and cheekbones on weathered, lightly tanned fair skin, thin lips with a wry lopsided half-smile (left corner higher), a faint pale scar through the outer end of her right eyebrow, natural skin texture. Fully clothed in a deep-teal flecked wool shawl-collar cardigan over a cream crew-neck knit, a double strand of small freshwater pearls, sea-glass-green fingerless knit mitts. [LIGHT: soft overcast window light from camera left, 5600K, gentle bounce fill from the right, low contrast, no direct sun]. Natural grain. No readable text, no markings on the canister, no logos, no brands.
```

### 3.4 Talking-reel start still, frame-0 hero object (Sunroom, W1; 9:16)
Template for every talking reel. Swap the object, the hand position and the crop per reel; keep the face, anchors, outfit and light.
```
Photorealistic vertical 9:16 phone-video still, chest-up medium close-up at eye level, of Margot, an 84-year-old Irish woman, clearly in her mid-eighties, seated at a worn pine table in a rain-streaked glass sunroom, face square to camera, eyes about a third from the top of the frame, mouth closed in a calm wry half-smile. She holds a smooth palm-sized amber glass pebble with a faint warm inner glow in her open right palm at chest height, toward camera, sharp and clearly visible; a chipped plain cream enamel mug with a thin gold repaired seam and no lettering stands on the table beside her. short tousled silver-white pixie cut with a soft side-swept fringe falling to her left; round translucent sea-glass-green acetate glasses on a beaded chain of small amber, cream and turquoise beads; a single small plain gold hoop earring in her left ear only, right ear bare. Glasses position: worn on her face. long oval face, high cheekbones, long straight nose, deep-set pale blue-grey eyes, fine silver-grey eyebrows, deep crow's feet, dense fine sun freckles across nose and cheekbones on weathered, lightly tanned fair skin, thin lips with a wry lopsided half-smile (left corner higher), a faint pale scar through the outer end of her right eyebrow, natural skin texture. Fully clothed in a chunky cream Aran cable-knit cardigan with brown horn toggles over a sea-glass-green turtleneck. [LIGHT: soft overcast window light from camera left, 5600K, gentle bounce fill from the right, low contrast, no direct sun]. Slight phone-camera grain. No text, no logos, no brands.
```
**Edit-variant for later segments:** in Nano Banana, edit this approved still so the object rests on the table and her hands are folded on it. Change nothing else. This gives segments 2–3 the same face and light without the hand holding an object for 20 s.

---

## 4. The relight rule for video

1. **One set, one light recipe.** Every still and every video prompt for a set includes that set's `[LIGHT: …]` line verbatim (§2). Never mix two recipes in one reel. (Margot's key light is always from camera left; Ambrose's is from camera right.)
2. **Relight the still, never the clip.** If a source still's light doesn't match its set recipe, use Higgsfield Relight (or regenerate the still) *before* animating. Never relight or heavily re-grade a generated video segment to make it match; regenerate it from the matched still instead.
3. **Soft light only for talking segments.** Overcast or window-soft light only: no hard sun, golden hour, backlight or rim light. Hard light shifts the face model between Seedance segments.
4. **One still per reel, a new still per reel.** All talking segments in one reel come from one approved start still or its edit-variants (§3.4), so light and face stay identical across cuts. Each new reel gets a fresh start still (crop, angle within ±15°, object, hand position) so platforms don't read reels as duplicates.
5. **Grade once, at the end.** Apply the Margot LUT to the finished edit: warm-neutral, slightly lifted blacks, 8% grain. Never grade segments individually.
6. **Reject on a light jump.** If a segment's light direction, colour temperature or skin tone visibly jumps against its neighbour, regenerate it from the same still. Don't fix it in grade.

---

## 5. Production notes (Seedance / Kling / Wan)

**Talking reels (Seedance, 9:16, 720p)**
- Image-to-video from the reel's approved start still (§3.4).
- **Default: 3 segments per reel**, cut at sentence breaks with 150–400 ms pauses. Segment length = the longest length that passes the drift-test ladder (§6). Seedance accepts up to 15 s per shot and 15 s of uploaded audio, but **some Higgsfield plans cap clips at 8 s: check the plan before batch week.** With an 8 s cap, use 4 segments. Segments of 6 s or less (5–6 per reel) are the last resort if the face won't hold.
- Chest-up, face square to camera. Motion intensity about 30–45.
- Calm delivery cues ("dry, amused, conversational"), never "energetic, highly expressive", because big mouths de-sync.
- No hands near the mouth, no turning to profile, no drinking mid-line. A held object stays still at chest height.
- Join segments with jump cuts or a 1–2 s object-only cutaway.
- Add burned-in captions, the frame-0 card, the frank and the redaction bar after generation.

**Activity clips (Kling / Wan, 5 s)**
- Medium or wide shots, no speech.
- Keep hand-to-object interaction simple: hold, lift, turn, set down. **Never pour** (the Forever Flask stays capped; she holds the steaming tin cup).
- Every prop must already be in the starting still. The canister is already in the tray or in her hands; she never posts it into the hatch on camera (she taps the closed hatch door; the *whoosh* is SFX).
- Objects that defy physics show it **only in object-only cutaways**, never in a shot with her face.
- Bathing Steps: seated or static on the top step only. No walking on wet steps, no water entry, robe zipped, hair dry.
- **Glasses-drop reaction beat:** start still with `Glasses position: worn on her face`; prompt "she lifts her glasses off with one hand and lets them fall onto the beaded chain at her chest, then looks at camera, unimpressed". Fallback: hard cut between two stills (glasses on → `hanging on the chain at her chest`).

**Voiceover reels**
- No lip-sync, so side-on, over-the-shoulder and hands-only shots are fine.
- Build each from 2–3 Margot shots plus empty plates (§2.4). No desk, no lamp, no pen on paper.

**Generation budget (per week, before retakes are tallied; map to plan credits once the Higgsfield plan is chosen)**

| Item | Generations |
|---|---|
| Talking: 3 reels × 3 segments × 2 takes | 18 Seedance |
| Activity: 3 reels × 3 shots × 2 takes | 18 Kling/Wan |
| Voiceover: 2 reels × 3 Margot shots × 2 takes | 12 Kling/Wan |
| Stills: start stills, edit-variants, static, carousel cover | about 12 |
| Retake reserve | +20% |

The old ≤6 s rule needed about 36 Seedance generations a week for talking reels alone.

**Banned in any generation**
- Readable text, letter shapes or logos (all text is added in edit).
- A second person on screen.
- Phones with visible UI.
- Shop or app interfaces.
- Real places' signage.
- Red graphics, rubber stamps, desk lamps, biscuit tins.

---

## 6. Tests (required before 1 Nov; studio spec: one 20-generation test per character plus one all-five cross-test)

**A. Within Margot: 20 generations**
- **Generations:** 4 per look (Sunroom W1, Sunroom W5, Sunroom W4, Prom W2, Bathing Steps W3), using the Soul ID, mixed expressions, with 4 of the 20 taken from Seedance frame grabs (the last second of a segment).
- **Face-embedding similarity to the reference** (centre panel of the sheet):

| Measure | Pass threshold |
|---|---|
| Median | ≥ 0.70 |
| Lowest single image | ≥ 0.60 |

  Use the studio's shared thresholds if the Studio Manager changes them.
- **Anchor checklist per image.** Pass rate ≥ 90%:
  - fringe falls to her left; hair dry;
  - sea-glass glasses with the beaded chain, in the position the prompt asked for;
  - hoop in the left ear only (it appears on the viewer's right);
  - freckles; pale blue-grey eyes;
  - right-eyebrow scar;
  - reads as 80+;
  - mug plain, no lettering; no red anywhere.

**B. Segment-length ladder (sets the talking-reel segment length)**
- One start still, one audio track cut at 6, 8, 10, 12 and 15 s (stopping at the plan's clip cap), 2 takes each.
- Measure face similarity on the first, middle and last frame of each take.
- Lock the **longest** length where the last-frame similarity stays ≥ 0.65 and lip-sync passes Q3. Record it in the persona record; it replaces the old ≤6 s rule.

**C. Across characters (all five)**
- 5 images each of Margot, Dot, Rosa, Walt and Ambrose from their current Soul IDs.
- Face-embedding similarity must be **< 0.45** for every cross pair. Margot–Dot and Margot–Rosa are the pairs to watch.
- **Automated distinctness sort (replaces the human blind sort):** the QC agent assigns each of the 25 shuffled images to its nearest persona by face embedding against the five Soul ID references, and a vision model given the five reference sheets sorts them independently. Pass, on both = no Margot image mis-sorted, and no other image sorted into Margot's pile.
- If a pair fails, push Margot's distinct traits harder (long face, freckles, sea-glass glasses, pixie, weathered light tan) and re-test.

**D. Future-object and action test (batch week, Kling)**
- 3 takes each: F1 glow, F2 upward sand (object-only), F10 lying open and glowing, F4 capped flask with the tin cup in her hands, the glasses-drop beat, the canister in her hands at the tube hatch.
- A take passes if the object keeps its shape and nothing appears mid-clip. Anything with fewer than 2 of 3 passing switches to its fallback (bible §10) for launch.

**Logging**
- Store the scores, contact sheets, the locked segment length and the pass/fail list in the persona record.
- Re-run tests A–C every 4 weeks, and after any model update.
