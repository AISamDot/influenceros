# Rosa Bellini: Look Prompts (Higgsfield) v2

Pipeline: **Soul 2.0 / Nano Banana** for the character sheet and stills → **Soul ID** to lock identity → **Seedance** for talking clips (720p, 9:16, our ElevenLabs track uploaded) → **Kling / Wan** for activity clips and inserts. Everything is exported at 1080×1920.

**v2 changes:** new hair (dyed aubergine roller set with silver roots) and glasses anchors; every start frame and candid now carries the full face lock, the three anchors, the age and "fully clothed"; per-reel start-frame variants; SF-4's candle moved to the light side; one action per activity clip; typewriter keys never legible; the slam insert is replaced by a 1.2 s cup set-down (no splash); typewriter SFX for the typed verdict; the cross-character test now covers all five.

**Face lock (verbatim, in every prompt; it forces the age):**
`81-year-old Italian-American woman, clearly elderly, olive skin with real age (deep laugh lines, crow's feet, soft jowls, fine lines above the upper lip, age spots on temples and hands), slightly hooded dark-brown eyes, strong straight Roman nose, full lower lip, rounded chin, thin softly drawn dark eyebrows, a small brown beauty mark on her left cheekbone, oxblood matte lipstick slightly worn at the centre`

**Three anchors (verbatim, in every prompt):**
1. `smooth, rounded, chin-length roller-set hair dyed deep aubergine, with a thin line of silver roots at her left side parting`
2. `tortoiseshell glasses pushed up on top of her head like a headband, never over her eyes`
3. `small gold script "R" pendant on a fine gold chain`

**Closing line (verbatim, end of every prompt with Rosa in it):** `Fully clothed and modest. One person only. No text, no logos, no brand names.`

**Hard rules for every Rosa image:** she is 81 and looks it (the dyed hair makes age the first QC check). No pink, no lilac or violet clothing, no mustard. Glasses never on her eyes. The espresso cup and saucer are in frame from the first frame in talking reels. One person on screen. Never a horizontal flip. Never ask her to touch the pendant (it warps the "R"). Typewriter keys are never legible.

---

## 1. Character-sheet prompt (3 panels, white background) · ~2,900 characters (under the 3,500 cap)

```
Photorealistic character reference sheet: three panels side by side on a seamless pure white studio background, the same woman in all three panels, identical face, hair, jewellery and clothing in every panel.

Panel 1 (left): front-facing head-and-shoulders portrait, eyes to camera, relaxed knowing half-smile.
Panel 2 (centre): three-quarter view head-and-shoulders, head turned 35 degrees to her left, same expression.
Panel 3 (right): full-body standing, front-facing, feet visible, arms relaxed, holding a small white porcelain espresso cup with a thin gold rim on a matching saucer at waist height.

Subject: Rosa Bellini, an 81-year-old Italian-American woman from Brooklyn. She is clearly elderly, real age 81, not younger, not a young model with dyed hair. Olive skin with natural aging: deep laugh lines, crow's feet, soft jowls, fine vertical lines above the upper lip, age spots on her temples and the backs of her hands, visible pores. Slightly hooded dark-brown eyes, strong straight Roman nose, full lower lip, rounded chin, thin softly drawn dark eyebrows, a small brown beauty mark on her left cheekbone. Oxblood matte lipstick slightly worn at the centre. 5 ft 2, soft sturdy build, slightly rounded shoulders, upright posture.

Signature anchors, identical in all three panels:
- smooth, rounded, chin-length roller-set hair dyed deep aubergine, with a thin line of silver roots at her left side parting
- tortoiseshell glasses pushed up on top of her head like a headband, never over her eyes
- small gold script "R" pendant on a fine gold chain

Wardrobe, fully clothed and modest: oxblood-red button-front wool cardigan with sleeves pushed to the forearm, over a cream silk blouse with a small rounded collar, the pendant resting on the blouse; charcoal wool straight-leg trousers; black low-heeled leather loafers. Plain gold wedding band on her right ring finger. Short nails with slightly chipped oxblood polish. No logos, no labels, no text, no pattern branding anywhere.

Lighting: soft even studio light, neutral 5000K, gentle fill, no harsh shadows. Natural skin texture, no retouching, no beauty filter, true-to-life colour. Lens: 85mm look for panels 1 and 2, 50mm look for panel 3, sharp focus, eye-level camera.

Deliberate imperfection: the silver roots at the parting, a few flyaway hairs from the set, a slight asymmetry in her smile, a faint crease in the cardigan, the chipped nail polish.

Avoid: younger face, smooth or airbrushed skin, glamour makeup, silver or white hair all over, curly or springy hair, bright purple or violet hair, pink or blush clothing, tweed suit, designer logos, jewellery other than the listed pendant and wedding band, glasses worn over the eyes, sunglasses, hat, hairnet, different hairstyle between panels, extra people, extra fingers, distorted hands, text, watermark, nudity, cleavage, cartoon, 3D render, illustration.
```

**Turning the sheet into a Soul ID:**
1. Generate 8 sheets and pick the one with the strongest age, nose, beauty mark and hair (aubergine, not bright purple; roots visible).
2. Using that sheet as reference, generate 24 single-image variants: 8 angles (front, ±15°, ±35°, high, low, full body) × 3 expressions (neutral, amused, "verdict" with one eyebrow raised). Use 3 lighting setups (soft daylight, warm lamp, candle) spread across them, and keep the O1 cardigan throughout.
3. Curate 20–30 that pass the anchor checklist (§6), including at least one full-body.
4. Train the Soul ID.
5. Run the 20-generation drift test (§6) **before** any production still is made.

---

## 2. Talking start frames (one locked master per look, then per-reel variants)

Generate each master with Soul ID, 9:16, then **relight** it to the set (§5) and lock it. Each prompt below is complete: paste it as is after the Soul ID reference.

**SF-1 Kitchen / O1** (Rosa Reads Your Texts)
```
Rosa Bellini, an 81-year-old Italian-American woman, clearly elderly, olive skin with real age (deep laugh lines, crow's feet, soft jowls, fine lines above the upper lip, age spots on temples and hands), slightly hooded dark-brown eyes, strong straight Roman nose, full lower lip, rounded chin, thin softly drawn dark eyebrows, a small brown beauty mark on her left cheekbone, oxblood matte lipstick slightly worn at the centre. Smooth, rounded, chin-length roller-set hair dyed deep aubergine, with a thin line of silver roots at her left side parting; tortoiseshell glasses pushed up on top of her head like a headband, never over her eyes; small gold script "R" pendant on a fine gold chain. Oxblood-red button-front wool cardigan over a cream silk blouse with a small rounded collar. Head-and-shoulders, front-facing, eye-level, seated at her kitchen table, holding a small white porcelain espresso cup with a thin gold rim on its saucer at chest height in her right hand, eyebrows slightly raised, mouth closed and relaxed. Background softly out of focus: bottle-green square ceramic wall tiles, a cream wall phone with a coiled cord, a lace café curtain. Soft window light from camera-left, warm practical fill. 9:16, photoreal, natural skin texture. Fully clothed and modest. One person only. No text, no logos, no brand names.
```

**SF-2 Living room / O1** (sell reels)
```
Rosa Bellini, an 81-year-old Italian-American woman, clearly elderly, olive skin with real age (deep laugh lines, crow's feet, soft jowls, fine lines above the upper lip, age spots on temples and hands), slightly hooded dark-brown eyes, strong straight Roman nose, full lower lip, rounded chin, thin softly drawn dark eyebrows, a small brown beauty mark on her left cheekbone, oxblood matte lipstick slightly worn at the centre. Smooth, rounded, chin-length roller-set hair dyed deep aubergine, with a thin line of silver roots at her left side parting; tortoiseshell glasses pushed up on top of her head like a headband, never over her eyes; small gold script "R" pendant on a fine gold chain. Oxblood-red button-front wool cardigan over a cream silk blouse with a small rounded collar. Head-and-shoulders, front-facing, eye-level, seated in a burgundy velvet armchair, holding a small white porcelain espresso cup with a thin gold rim on its saucer at chest height in her right hand, mouth closed, a dry half-smile. Behind her, out of focus: a floral sofa under clear plastic slipcovers, cream-and-gold wallpaper. Warm brass-lamp key light from camera-left, dim room beyond. 9:16, photoreal, natural skin texture, no mirrors. Fully clothed and modest. One person only. No text, no logos, no brand names.
```

**SF-3 Living room night / O5** (late-night verdicts)
```
Rosa Bellini, an 81-year-old Italian-American woman, clearly elderly, olive skin with real age (deep laugh lines, crow's feet, soft jowls, fine lines above the upper lip, age spots on temples and hands), slightly hooded dark-brown eyes, strong straight Roman nose, full lower lip, rounded chin, thin softly drawn dark eyebrows, a small brown beauty mark on her left cheekbone, oxblood matte lipstick slightly worn at the centre. Smooth, rounded, chin-length roller-set hair dyed deep aubergine, with a thin line of silver roots at her left side parting; tortoiseshell glasses pushed up on top of her head like a headband, never over her eyes; small gold script "R" pendant on a fine gold chain. Quilted espresso-brown satin housecoat tied at the waist over cream cotton pyjamas with a piped collar. Head-and-shoulders, front-facing, eye-level, seated in an armchair late at night, holding a small white porcelain espresso cup with a thin gold rim on its saucer at chest height in her right hand, mouth closed, one eyebrow slightly raised. A single warm lamp from camera-left, darker room, slight low-light grain. 9:16, photoreal, natural skin texture, no mirrors. Fully clothed and modest. One person only. No text, no logos, no brand names.
```

**SF-4 Bar / O2** (rare talking Date Diary). The candle sits **on the right of frame**, on the same side as the key light.
```
Rosa Bellini, an 81-year-old Italian-American woman, clearly elderly, olive skin with real age (deep laugh lines, crow's feet, soft jowls, fine lines above the upper lip, age spots on temples and hands), slightly hooded dark-brown eyes, strong straight Roman nose, full lower lip, rounded chin, thin softly drawn dark eyebrows, a small brown beauty mark on her left cheekbone, oxblood matte lipstick slightly worn at the centre. Smooth, rounded, chin-length roller-set hair dyed deep aubergine, with a thin line of silver roots at her left side parting; tortoiseshell glasses pushed up on top of her head like a headband, never over her eyes; small gold script "R" pendant on a fine gold chain. Bottle-green velvet wrap dress with three-quarter sleeves and a modest V-neck, small gold hoop earrings. Head-and-shoulders, front-facing, eye-level, seated at a small round white marble table, holding a small white porcelain espresso cup with a thin gold rim on its saucer at chest height in her right hand. A lit candle in a short amber glass at the lower right of frame; an empty bentwood chair out of focus across the table. Candlelight key from camera-right, warm amber bokeh, deep soft shadows on her left side. 9:16, photoreal, no bottle labels. Fully clothed and modest. One person only. No text, no logos, no brand names.
```

**SF-5 Stoop / O4** (rare outdoor talking)
```
Rosa Bellini, an 81-year-old Italian-American woman, clearly elderly, olive skin with real age (deep laugh lines, crow's feet, soft jowls, fine lines above the upper lip, age spots on temples and hands), slightly hooded dark-brown eyes, strong straight Roman nose, full lower lip, rounded chin, thin softly drawn dark eyebrows, a small brown beauty mark on her left cheekbone, oxblood matte lipstick slightly worn at the centre. Smooth, rounded, chin-length roller-set hair dyed deep aubergine, with a thin line of silver roots at her left side parting; tortoiseshell glasses pushed up on top of her head like a headband, never over her eyes; small gold script "R" pendant on a fine gold chain. Camel wool car coat buttoned to the collar, an oxblood-and-cream paisley silk scarf knotted loosely at the neck. Head-and-shoulders, front-facing, eye-level, seated on a brownstone stoop, holding a small white porcelain espresso cup with a thin gold rim on its saucer at chest height in her right hand, mouth closed. Black wrought-iron railing behind her, dusk. Cool sky light from camera-left, warm street-lamp glow from the right. 9:16, photoreal, no house numbers. Fully clothed and modest. One person only. No text, no logos, no brand names.
```

### 2.1 Per-reel start-frame variants (face and light locked; first frames never repeat)

Generating every reel from one identical still gives dozens of posts the same first frame, which is the "unoriginal" and duplicate-demotion pattern. So:

1. **The master stays locked** (face, hair, light, wardrobe). Every variant is an **image edit of the master** (Nano Banana / Soul edit), never a fresh generation.
2. **Each variant changes exactly one thing in each axis:**

| Axis | Options |
|---|---|
| **Crop** | **A** standard head-and-shoulders · **B** tight (chin to mid-chest, cup still in frame) · **C** slightly wider (to the table edge) |
| **Cup position** | **1** right hand at chest height · **2** both hands around the cup at chest height · **3** saucer on the table in front of her, right hand resting beside it (crop C only) |
| **Background prop** (one, out of focus) | Kitchen: moka pot on the counter · pot of basil on the sill · tea towel on the oven rail · bowl of lemons · the typewriter's edge (keyboard out of frame, keys not legible). Living room: lace doily · the soft-focus wedding photo · a folded newspaper (no readable text). Bar: a second unlit candle · a wine glass with a little red. |

3. **Variant edit prompt:** `Edit this image: change only [the crop to …] / [the cup position to …] / [add … softly out of focus in the background]. Keep her face, age, skin, hair, roots, glasses position, pendant, outfit, expression and lighting exactly the same. Do not change age or features. No text, no logos.`
4. **Every variant passes the anchor checklist (§6) before use.** Variant IDs follow `SF-1 / B-2-basil`.
5. **Rotation:** no two consecutive talking reels share a variant ID, and no variant is used more than once in 7 days. Log the variant ID against each post. Keep 6–8 live variants per master.
6. **Inside one reel:** clips alternate between the variant and its tight-crop sibling (for example A for clips 1 and 3, B for clips 2 and 4). It reads as a two-camera edit and hides the jump cuts.
7. **Private variant:** `SF-1/PRIVATE` (crop A, cup position 2, lemons) is reserved for paid Verdict Videos and never posted publicly.

**Seedance motion prompt (talking, every clip):** `She speaks directly to camera with natural small head movements, expressive eyebrows, occasional slow blink, a brief knowing smile at the end; the espresso cup stays exactly where it is in the first frame; she does not raise the cup to her mouth and does not touch her necklace; the camera is static; lighting does not change.`

**Clip length:** time the real ElevenLabs file, then cut at sentence boundaries into clips of **≤10 s** (hard cap 15 s per shot and 15 s of audio; ≤8 s if the Higgsfield plan caps there). Most reels are 3–4 clips.

---

## 3. Location stills (empty scenes, no people, no brands, no readable text)

All are 9:16 vertical, photoreal, eye-level as if seated (so Rosa can be composited or generated into them), with natural imperfection: worn surfaces, a little clutter, real dust.

**L1: Rosa's kitchen (main set)**
```
Empty 1960s Brooklyn walk-up kitchen, no people. A small square table covered in a faded oilcloth with a pale lemon print, slightly worn at the corners; on it a white porcelain espresso cup with a thin gold rim on a saucer, a small aluminium stovetop moka pot with no brand marks, and a cream and bottle-green 1960s manual typewriter seen from the side, its keyboard turned away from camera and softly out of focus, keys not legible, a blank sheet of paper in the roller, no visible brand name. Walls of bottle-green square ceramic tiles with cream grout, a cream wall-mounted telephone with a long coiled cord, a cast-iron radiator under a window with a lace café curtain, a pot of basil on the sill, a brick wall visible through the window. Soft overcast daylight from the window on the left, a warm tungsten ceiling light on low. Lived-in: a tea towel on the oven handle, a chipped enamel colander. Photoreal, 9:16, eye-level seated height, no text, no labels, no logos, no people.
```

**L2: Marco's bar (date set)**
```
Empty intimate candlelit wine bar in Bay Ridge, Brooklyn, evening, no people. In the foreground, a small round white marble bistro table for two with two bentwood chairs, one empty chair facing camera on the far side, a lit candle in a short amber glass on the right side of the table, two stemmed wine glasses, one with a little red wine. Behind: a dark walnut bar with brass rail, shelves of unlabelled dark-green and amber wine bottles, warm Edison-bulb pendants, exposed brick, soft bokeh. Candlelight key from the right, deep warm shadows. Photoreal, 9:16, eye-level seated height, no readable text, no bottle labels, no signage, no logos, no people.
```

**L3: The stoop on 18th Avenue (street set)**
```
Empty brownstone stoop on a quiet residential Brooklyn street at dusk, no people. Worn brownstone steps with a black wrought-iron railing, a small potted rosemary on the top step, autumn leaves in the corners, a row of attached brick and brownstone houses receding down the block, bare street trees, parked cars out of focus with no visible badges or plates. Dusk sky fading from amber to blue, warm sodium street lamp glow beginning on the right. Photoreal, 9:16, eye-level seated height on the stoop, no readable text, no signage, no house numbers, no logos, no people.
```

**L4: The living room with the good sofa**
```
Empty Italian-American Brooklyn living room, evening, no people. A floral brocade sofa covered in clear plastic slipcovers, a lace doily on the armrest, a burgundy velvet armchair beside it, a small dark-wood side table with a white porcelain espresso cup on a saucer and a brass table lamp with a cream pleated shade glowing warmly. Behind: patterned wallpaper in muted cream and gold, a framed wedding photograph too soft-focus to make out faces, a glass-front cabinet with good china, heavy drapes. A warm lamp key from the left, a dim room beyond. Photoreal, 9:16, eye-level seated height, no mirrors in frame, no readable text, no logos, no people.
```

**L5: The typed page (base plate for typed transcript statics and carousel slides)**
```
Overhead photo of a single blank sheet of cream typing paper lying slightly askew on a faded pale-lemon-print oilcloth, a faint brown coffee ring near the bottom corner of the paper, a small white porcelain espresso cup with a thin gold rim on its saucer at the top right, the corner of a cream and bottle-green manual typewriter at the top left edge, softly out of focus, keyboard out of frame, keys not legible. Soft window daylight from the left, gentle shadows, slight paper texture and one soft crease. Photoreal, 4:5, no text on the paper, no letters, no logos, no people, no hands.
```
All typed text on L5 is added in post (Courier-style type, numbered lines in the left margin). Never generate text with the AI model.

---

## 4. Candid-photo prompts (carousel covers, profile picture, Date Diary covers)

Generate with Soul ID. Look for "phone-photo" realism: slightly off-centre, imperfect exposure, real grain. Candids are **never frame 0** of a reach post; they're covers for trust posts, carousel back slides and the profile picture.

**C1: Stoop, morning espresso (profile picture and back slides)**
```
Candid phone photo of Rosa Bellini, an 81-year-old Italian-American woman, clearly elderly, olive skin with real age (deep laugh lines, crow's feet, soft jowls, fine lines above the upper lip, age spots on temples and hands), slightly hooded dark-brown eyes, strong straight Roman nose, full lower lip, rounded chin, thin softly drawn dark eyebrows, a small brown beauty mark on her left cheekbone, oxblood matte lipstick slightly worn at the centre. Smooth, rounded, chin-length roller-set hair dyed deep aubergine, with a thin line of silver roots at her left side parting; tortoiseshell glasses pushed up on top of her head like a headband, never over her eyes; small gold script "R" pendant on a fine gold chain. Sitting on her brownstone stoop on a cold bright November morning in a camel wool coat buttoned up and an oxblood-and-cream paisley silk scarf, holding a small white espresso cup and saucer in both hands, mid-laugh with her eyes crinkled, looking just off camera as if someone made a bad joke. Slightly off-centre framing, a little motion blur in one hand, morning sun flare from the right, faint phone-camera grain, natural skin texture. 4:5, photoreal. Fully clothed and modest. One person only. No text, no logos, no brand names.
```

**C2: Marco's bar, caught mid-story (Date Diary covers)**
```
Candid flash photo of Rosa Bellini, an 81-year-old Italian-American woman, clearly elderly, olive skin with real age (deep laugh lines, crow's feet, soft jowls, fine lines above the upper lip, age spots on temples and hands), slightly hooded dark-brown eyes, strong straight Roman nose, full lower lip, rounded chin, thin softly drawn dark eyebrows, a small brown beauty mark on her left cheekbone, oxblood matte lipstick slightly worn at the centre. Smooth, rounded, chin-length roller-set hair dyed deep aubergine, with a thin line of silver roots at her left side parting; tortoiseshell glasses pushed up on top of her head like a headband, never over her eyes; small gold script "R" pendant on a fine gold chain. At a small marble table in a candlelit wine bar in a bottle-green velvet wrap dress with a modest V-neck and small gold hoops, one hand raised mid-gesture as if telling a story, eyebrows up, the empty bentwood chair opposite her slightly out of focus, a candle on the right of the table and a single glass of red wine. Direct on-camera flash with hard shadow behind her, warm background, imperfect framing that cuts the table edge. 4:5, photoreal, no readable labels. Fully clothed and modest. One person only. No text, no logos, no brand names.
```

**C3: Kitchen, late night, reading back (carousel covers and the "Transcript" visual)**
```
Candid photo of Rosa Bellini, an 81-year-old Italian-American woman, clearly elderly, olive skin with real age (deep laugh lines, crow's feet, soft jowls, fine lines above the upper lip, age spots on temples and hands), slightly hooded dark-brown eyes, strong straight Roman nose, full lower lip, rounded chin, thin softly drawn dark eyebrows, a small brown beauty mark on her left cheekbone, oxblood matte lipstick slightly worn at the centre. Smooth, rounded, chin-length roller-set hair dyed deep aubergine, with a thin line of silver roots at her left side parting; tortoiseshell glasses pushed up on top of her head like a headband, never over her eyes; small gold script "R" pendant on a fine gold chain. At her kitchen table late at night in a quilted espresso-brown satin housecoat over cream piped pyjamas, looking down at a sheet of paper in a cream and bottle-green manual typewriter with one eyebrow raised and her lips pressed together; the typewriter is seen from the side with its keyboard out of frame, keys not legible, and the paper's typing too small and soft to read; an espresso cup and saucer beside it. A single warm overhead light, deep shadows, slight high-ISO grain, the edge of the cream wall phone in the background. 4:5, photoreal. Fully clothed and modest. One person only. No text, no logos, no brand names.
```

---

## 5. Relight rule and video rules (every talking and activity clip)

1. **Never animate a mismatched composite.** If Rosa is generated or placed into a location still, **relight the still first** so the key-light direction, colour temperature and contrast on her face match the set. Then animate. Video models amplify a lighting mismatch into face drift and "pasted-on" edges.
2. **The light bible, per set:**

| Set | Key light | Colour temp | Fill / mood |
|---|---|---|---|
| Kitchen (day) | Window, camera-left, soft | ~4,500K | Warm tungsten practical, low |
| Kitchen (night) | Overhead bulb, top-front | ~2,900K | Deep shadows, light grain |
| Living room | Brass lamp, camera-left | ~2,800K | Dim room, warm wallpaper bounce |
| Bar | Candle (right of frame) and pendants, camera-right, low | ~2,600K | Amber bokeh, hard falloff |
| Stoop (dusk) | Sky, camera-left | ~6,000K sky / ~2,200K street lamp on the right | Cool-warm split |

3. **Relight prompt (Nano Banana / Soul edit):** `Relight the woman to match the scene: [key] from [direction], [temp], matching shadow direction and softness on her face, neck and hands; keep her face, age, hair, roots, glasses position, pendant, outfit and expression exactly the same; do not change age or features.`
4. **Lock the result as the master start frame** (one per look; §2). Make per-reel variants only by editing the master (§2.1). Never regenerate the face from scratch per reel.
5. **Seedance prompts must never change the lighting.** Always include "lighting does not change; camera is static."
6. **Talking framing:** head and shoulders, front-facing within ±15°, mouth unobstructed (no hand or cup in front of her mouth), glasses pushed up, plain background. No profile-angle lip-sync, no wide talking shots, never two speakers.
7. **Props from frame one:** the cup and saucer must be in the start frame. Never ask the model to make a prop appear mid-clip.
8. **Activity clips (Kling/Wan): one action per clip,** 6–10 s, low motion, from the relit still, with the prop already in hand. No stacked actions ("walks down the steps *while* buttoning her coat" is two). Never touch the pendant. No hand close-ups beyond the inserts below.

**Activity clip template (paste and fill the brackets; everything else is fixed):**
```
Rosa Bellini, an 81-year-old Italian-American woman, clearly elderly, olive skin with real age (deep laugh lines, crow's feet, soft jowls, fine lines above the upper lip, age spots on temples and hands), slightly hooded dark-brown eyes, strong straight Roman nose, full lower lip, rounded chin, thin softly drawn dark eyebrows, a small brown beauty mark on her left cheekbone, oxblood matte lipstick slightly worn at the centre. Smooth, rounded, chin-length roller-set hair dyed deep aubergine, with a thin line of silver roots at her left side parting; tortoiseshell glasses pushed up on top of her head like a headband, never over her eyes; small gold script "R" pendant on a fine gold chain. [OUTFIT, exact text from the wardrobe table]. [SETTING]. [PROP] already in her hand from the first frame. [ONE ACTION]. She does not touch her necklace. [SHOT SIZE], static camera, [KEY LIGHT per the light bible], lighting does not change, [6–10] seconds. Fully clothed and modest. One person only. No text, no logos, no brand names.
```

**Reusable inserts (generate once, reuse forever):**
- **Cup set-down insert ×4** (kitchen oilcloth, bar marble, living-room side table, stoop step): `Close-up of an elderly woman's olive-skinned hand with age spots, a plain gold band on the ring finger and slightly chipped oxblood nail polish, setting a small white porcelain espresso cup with a thin gold rim down onto its saucer on [surface] with one firm, controlled movement; the cup is in her hand from the first frame; no splash, no spill, the coffee stays still; shallow depth of field; no text, no logos.` Generate 5 s, trim to **1.2 s** in the edit. SFX (ElevenLabs): "porcelain espresso cup set down on its saucer, one crisp clack, quiet small room". It's the audio full stop. It is never a slam.
- **Gentle set-down insert** (CALL SOMEBODY): the same shot, but she sets the cup down slowly and softly. No SFX, room tone only.
- **Typewriter SFX set (ElevenLabs SFX, generated once):** (a) 30 single key strikes from a 1960s manual typewriter, varied; (b) the carriage-return bell, one ding, with the lever's short ratchet; (c) a 1-second run of fast typing for card headers. In the edit, each letter of the typed verdict gets one strike (about 8 letters a second), then the ding. Typing happens in post on the transcript card; never generate on-screen typing with the video model.

---

## 6. 20-generation face-drift test (must pass before 1 Nov)

**Run:** 20 Soul ID generations: 4 sets × 5 outfits, mixing angles (front, 15°, 35°), expressions (neutral, laugh, verdict brow) and lights (per §5). Use the full face lock and anchors, as written in §2.

**Score each image** pass/fail on:

| Check | Fail if |
|---|---|
| Age | She reads younger than ~76 (the dyed hair makes this the most likely failure) |
| Hair | Not a smooth chin-length set; colour drifts to bright purple, black, brown or silver; roots missing or on the wrong side |
| Glasses | On her eyes, missing, or not tortoiseshell |
| Pendant | Missing, or the letter or style changed |
| Face | Nose shape, eye colour, brows or beauty mark (left cheekbone) changed |
| Skin | Olive skin turns pale or orange |
| Hands | Distorted fingers, or a missing or extra ring |
| Prop | The cup is the wrong colour or rim, or appears/disappears |
| Branding | Any text or logo appears |

**Pass bar:** ≥ 18/20 on each check, and ≥ 17/20 images with zero failures. **Also run every new start-frame variant (§2.1) through the same checklist** before it goes into rotation.

**Cross-character test (all five):** a lineup of 6 images each of Rosa, Dot, Margot, Ambrose and Walt (30 images), shuffled.
- **Automated distinctness sort (replaces the human blind sort):** the QC agent assigns each image to the persona whose Soul ID reference set it is closest to by face embedding, and a vision model given the five reference sheets labels each image independently. Both must sort all 30 with 100% accuracy.
- **Numeric ceiling:** compute face-embedding similarity (for example InsightFace/ArcFace) between Rosa's set and each sibling's set. Proposed ceiling: mean cross-identity cosine similarity ≤ 0.35 (the Studio Manager sets the final number in the canonical spec).
- **Watch pairs:** Rosa vs Dot and Rosa vs Margot (the other older women). Walt Novak (68, Polish-American, Parma, Ohio) no longer shares Rosa's Italian-American lane; log his pair score anyway. If Rosa is confused with anyone, strengthen the Roman nose, beauty mark and aubergine set, re-curate the Soul ID set, and re-run.

**Then, in production:**
- QC every published clip against the checklist above.
- If two or more clips fail in a week, re-run the drift test.
