# Walt Novak: Look Prompts (Higgsfield) · v3

**Pipeline (fully automated; the Video Producer generates, the QC agent grades, nobody hand-picks):**
1. **Character sheet:** Nano Banana Pro or Soul 2.0. Generate 8 sheets. The QC agent scores each against the sheet checklist (§1) with Claude vision and picks the highest score that passes every line; ties go to the sheet whose Panel 1 has the lowest ArcFace similarity to Ambrose's locked sheet. Lock it.
2. **Reference set:** generate 24 varied stills from the sheet (Nano Banana Pro, with the sheet as reference). Use outfits W1–W5 and locations L1–L4, at different angles and expressions.
3. **Automated cull:** keep every still that scores ≥ 9/10 on the vision checklist (§6.1) **and** reaches an ArcFace cosine ≥ 0.55 against Panel 1. Soul ID needs 20 or more images, so 20 is the floor; below 20, generate replacements and re-score.
4. **Train Soul ID** on that set in Soul 2.0 ([Higgsfield](https://higgsfield.ai/blog/consistent-characters-locations)). Higgsfield's own support describes Soul ID as built for created human characters, so a synthetic reference set is the intended use.
   - **Fallback, not the plan:** if training degrades on the set, pass the sheet plus the location still as references into Seedance 2.0 (up to 9 references per call) and carry on. Don't plan around any other Higgsfield feature.
5. **Run the 20-generation drift test** (§6) before Fri 23 Oct, so the 21–30 Oct batch is shot on a locked face.

**Global rules (every generation):**
- 9:16 for video and stills; 4:5 crops for Instagram carousels.
- 720p for talking video.
- **Every prompt states "a 68-year-old white American man of Polish descent, clearly 68" and "fully clothed"**, and carries the three anchors **verbatim**. Soul ID is never trusted to supply the age on its own.
- No logos, brand marks, readable text, house numbers, street signs or licence plates.
- Tags are blank or carry illegible scribbles. **All words are added in the edit.**
- Hallmarks, maker's marks and the bases of objects are never visible.
- **Never generate a lookalike of a branded or character product** (tumblers, blind-box toys, sneakers). Use the viewer's consented photo as an inset in the edit, or a clearly generic object.
- Props are **in frame from the first frame**. When Walt writes or taps, he holds a **plain black unlabelled marker** from frame one. The pocket tags never move.
- One person on screen. Front or three-quarter only (20° at most) for anything with lip-sync.
- **Glasses:** clear lenses, both eyes visible, no glare covering the eyes. Key light at least 30° off-axis.
- **Skin:** fair and neutral. Never pink, ruddy, orange or blotchy (ruddy is Dot's).
- **Never dark blue clothing** (Ambrose's lane): cobalt stays bright and mid-light.

**The anchors (paste verbatim):**
- `large steel-grey wire-framed aviator-shape eyeglasses with clear lenses, worn on his face, both eyes clearly visible through the lenses`
- `a small bundle of blank manila string tags tucked into his left chest pocket, their safety-orange strings hanging out over the pocket edge`
- `a short grey flat-top haircut, flat across the crown, with the sides clipped short`

There is no sanctioned variant.

**Face line (paste verbatim after the age line):** `big and broad with a barrel chest, a wide fleshy face with heavy jowls and a broad jaw, fair weathered skin with deep horizontal forehead lines and a few light-brown age spots near the hairline, a large nose broken once and bending slightly to his left, small deep-set brown eyes under heavy grey eyebrows, a thick salt-and-pepper push-broom moustache trimmed at the lip line so both lips stay visible, clean-shaven chin and cheeks, a plain gold wedding band on his left hand`

---

## 1. Character sheet prompt (3-panel, white background)

```
Photorealistic character reference sheet: three panels side by side on a seamless pure white background, even soft studio light with a gentle fill from the left and right, the same man in all three panels with an identical face, hair, clothing and accessories.

SUBJECT: Walt, a 68-year-old white American man of Polish descent from Parma, Ohio. He is clearly 68 years old: not younger, not in his 50s, not frail. Big and broad, about 6'1", a barrel chest and a solid belly, a thick neck and heavy shoulders. A wide, fleshy face with heavy jowls and a broad jaw. Fair, weathered skin with deep horizontal forehead lines and a few light-brown age spots near the hairline; no freckles, no ruddy cheeks, no broken veins. A large nose, broken once and bending slightly to his left. Small deep-set brown eyes under heavy grey eyebrows, with crow's feet. A thick salt-and-pepper push-broom moustache trimmed at the lip line so both lips stay fully visible; clean-shaven chin and cheeks with a faint grey shadow. Natural, slightly yellowed, even teeth. Big hands with thick fingers; a plain gold wedding band on the left ring finger.

SIGNATURE ANCHORS, visible in every panel: large steel-grey wire-framed aviator-shape eyeglasses with clear lenses, worn on his face, both eyes clearly visible through the lenses; a small bundle of blank manila string tags tucked into his left chest pocket, their safety-orange strings hanging out over the pocket edge; a short grey flat-top haircut, flat across the crown, with the sides clipped short.

OUTFIT, fully clothed and identical in every panel: a long-sleeve cobalt-blue cotton twill work shirt with two button-flap chest pockets, sleeves rolled to the forearm, top button open over a white crew-neck T-shirt; khaki duck-canvas work trousers; a plain black leather belt with a plain steel buckle; scuffed tan suede work boots. The shirt slightly creased, one cuff starting to unroll, a little sawdust on the right sleeve.

PANEL 1 (left): front view, head and shoulders, looking straight into the lens through the glasses, neutral deadpan face with the faintest dry half-smile under the moustache. The aviator glasses, the pocket tags with orange strings and the flat-top are all clearly visible.
PANEL 2 (centre): three-quarter view turned to his left, head and shoulders, same expression. The glasses, the flat-top silhouette and the pocket tags are visible.
PANEL 3 (right): full-body standing front view, arms relaxed at his sides, weight on one leg, the whole outfit and boots visible. The glasses, the pocket tags and the flat-top are visible.

STYLE: photoreal; natural skin texture with pores and fine wrinkles; true-to-life fair skin graded neutral, not pink, not ruddy, not orange; slight natural shine on the forehead; realistic short grey hair and coarse moustache texture; no glare on the eyeglass lenses so both eyes are clearly visible; 85mm lens look; sharp focus; no retouching, no beauty filter. Deliberate imperfection: a smudge on the left lens, a few stray moustache hairs, creased fabric.

STRICTLY AVOID: any text, letters, numbers, labels, watermarks, logos or brand marks anywhere; hats; sunglasses or tinted lenses; glasses pushed up on the head, hanging on a chain or perched low on the nose; gold, tortoiseshell or half-moon frames; a beard, goatee or stubble on the chin; a handlebar or walrus moustache covering the mouth; long, combed-back or slicked hair; a suit, tie, waistcoat or gloves; navy, ink-blue or charcoal clothing; ruddy cheeks, thread veins or freckles; tattoos; jewellery other than the wedding band; a younger or slimmer face; smooth or waxy skin; bright white teeth; different outfits between panels; extra people; objects in his hands; cropped heads; a cartoon, illustrated or 3D-render look.
```

**Sheet checklist (scored automatically by the QC agent with Claude vision; any miss = regenerate):**
- The glasses are steel aviators **worn on the face** in all panels, with both eyes visible and no glare over them.
- The tag bundle sits in the **left** chest pocket with orange strings showing, in all panels.
- The hair is a flat-top (flat crown, short sides), not a buzz cut or a crew cut, in all panels.
- The moustache sits at the lip line; both lips are visible; chin is clean-shaven.
- The nose bends slightly to his left; skin tone matches across panels and isn't ruddy.
- He reads 66–70 and is visibly big and barrel-chested.

---

## 2. Location stills (empty scenes; 9:16; no people, no brands, no readable text)

**Generate each at 9:16; the QC agent locks the best frame** (vision check: no text, no logos, no people, the clear space is present, the light direction matches the spec). Feed it with the character reference in every Seedance/Kling call, as recommended in the [Higgsfield guide](https://higgsfield.ai/blog/consistent-characters-locations).

### L1: The Sale House (a client's basement on sale morning) · key light from high camera-left glass-block windows, 5,000K, plus overhead fluorescent 4,000K
```
Photoreal empty interior, vertical 9:16, eye level of a standing adult, 28mm phone-camera look. The finished basement of a 1950s Ohio bungalow on the morning of an estate sale. No people. Knotty-pine wall panelling, a dropped acoustic-tile ceiling with two fluorescent light panels, and two small glass-block windows high on the left wall letting in cool diffused daylight. Folding tables along the walls hold plain white china plates with thin gold rims, cut-crystal stemware, silver-plated serving trays, a gravy boat, table lamps and a box of vinyl records shown edge-on. A ping-pong table in the centre is covered edge to edge with kitchenware: mixing bowls, plain glass casserole dishes, a cast-iron skillet with no maker mark. A built-in knotty-pine shelf on the back wall holds board games with blank box lids and a row of small trophies with blank plates. Plain manila string tags are tied to several items and a few small round orange price stickers sit on others; every tag and sticker is blank or carries only illegible scribbles. Deliberate imperfection: a water stain on one ceiling tile, a dehumidifier in the corner, one folding table slightly crooked. Leave clear space in the lower-centre foreground beside the ping-pong table for a man standing, framed from mid-torso up. Slight film grain, true-to-life colour. No text, no readable labels, no logos, no brand names, no price signs, no bar, no mirrors, no people.
```

### L2: Walt's Garage (with the Bread-Maker Shelf) · key light frontal, overcast daylight 6,000K through the open door behind camera, plus a dim side window camera-right
```
Photoreal empty interior, vertical 9:16, chest-height camera, 28mm phone-camera look. A detached one-and-a-half-car garage behind a 1950s Ohio bungalow, late autumn. No people, no car. Back wall: a pegboard with unbranded hand tools (hammers, hand saws, clamps, a level) above a sturdy wooden workbench with a bench vise, a coffee can of plain black markers, and a plain plastic lunch tub. Right wall: a grey metal shelving unit holding seven different plain white and brushed-silver countertop bread machines in a dusty row, with no logos or lettering; on the top shelf, a plain black bowling-ball bag with no markings. A small dirty single-pane window on the right wall. Stacks of brown cardboard banker's boxes with blank lids. On the concrete floor, three loose piles of household objects, each marked only by a square of coloured painter's tape (safety orange, blue, grey); no words. Lighting: the overhead door is open behind the camera and lets in cool, even overcast daylight (6,000K) that falls on the front of the scene; one bare bulb hangs unlit from the rafters. Deliberate imperfection: an oil stain on the concrete, a cobweb in the top corner, a box with a crushed corner, sawdust under the vise. Leave clear space at centre frame, mid-height, in front of the workbench for a man standing facing the camera. No text, no readable labels, no logos, no licence plates, no serving hatch, no counter.
```

### L3: The Back Bedroom (Clearing My Own House; the Keep Box card table) · key light from camera-right window, warm 3,800K, plus a small lamp on the left
```
Photoreal empty interior, vertical 9:16, eye-level 28mm phone-camera look. The small back bedroom of a 1950s Ohio bungalow, halfway through a move. No people. Plain off-white painted walls with lighter rectangles where pictures were taken down. A single bed covered by a white bedsheet, stacked plain brown moving boxes, some taped shut and some open with crumpled packing paper (no printing visible). Against the left wall, a glass-front curio cabinet holds about fifty-seven small glossy porcelain figurines of children in pastel clothes, with no marks visible. By the window, a folding card table with one folding chair, an empty brown banker's box and a plain white mug on it. Low winter afternoon sun comes through a sheer curtain on camera-right, warm 3,800K, plus the glow of a small table lamp with a pleated shade on the left. Deliberate imperfection: a roll of packing tape on the floor, a curtain slightly off its hook. Leave clear space beside the card table for a seated or standing man, framed from mid-torso up. No text, no readable labels, no logos, no legible photos, no people.
```

### L4: The Driveway (the Mule) · soft overcast light from above-front, 6,500K
```
Photoreal empty exterior, vertical 9:16, chest-height camera, 28mm phone-camera look. The open rear double doors of a plain white full-size cargo van, about twenty years old, parked in a concrete driveway beside a 1950s brick-and-siding bungalow in an Ohio suburb on a flat grey late-autumn afternoon. No people. The van's load floor sits at waist height and holds a plain brown cardboard box the size of a flat-screen TV, a plain unbranded countertop air fryer, a plain round robot vacuum, and a stack of quilted grey moving blankets. The van is plain white with a dent and road salt on the bumper, with no lettering, no logo and no plates visible. A detached garage at the end of the driveway; wet brown leaves on the concrete; a bare tree on the grass strip by the curb; blurred bungalows behind, with no house numbers and no street signs. Soft even overcast daylight, 6,500K, from above and slightly in front. Leave clear space on the right of the open doors for a man standing beside the van, framed from mid-torso up. No text, no readable labels, no logos, no brand names, no people.
```

### L5 (build by Wed 25 Nov): The Basement Kitchen · key light from high camera-left glass-block window, 5,000K, plus one bare bulb 2,700K
```
Photoreal empty interior, vertical 9:16, eye-level 28mm phone-camera look. The unfinished basement "second kitchen" of a 1950s Ohio bungalow. No people. Painted cinderblock walls, a white enamel 1960s gas stove with no brand, a double laundry tub, a long wooden shelf of glass canning jars with plain metal lids, some filled with dark preserves and some empty, every jar label blank or illegible. One glass-block window high on the left wall gives cool diffused daylight; a single bare bulb hangs from a ceiling joist. A wooden work table in front holds an empty banker's box. Deliberate imperfection: a damp patch at the base of one wall, cobwebs on the joists. Leave clear space in front of the work table for a man standing, framed from mid-torso up. No text, no readable labels, no logos, no people.
```

### L6 (build by Wed 25 Nov): The Attic · key light from a gable window camera-right, cool 5,500K
```
Photoreal empty interior, vertical 9:16, eye-level 28mm phone-camera look. The low expansion attic of a 1950s Ohio bungalow. No people. Sloped ceilings with exposed rafters, plywood flooring, pink fibreglass insulation visible behind the knee walls, stacked banker's boxes with blank lids, a rolled rug, a dress form with nothing on it, plain holiday-decoration bins with no printing. Daylight from a small gable window on camera-right. Deliberate imperfection: dust in the light, a box that has split. Leave clear space in the centre where a man can stand upright under the ridge, framed from mid-torso up. No text, no readable labels, no logos, no people.
```

---

## 3. Talking start frames (one per Seedance clip)

**Rules:**
- Every talking clip gets **its own start frame**, relit to its location (§5) before it goes into Seedance.
- **Lock the face and the light; vary the crop and the prop position** clip to clip and reel to reel. Never reuse a start frame in two reels: identical openings risk "unoriginal" or duplicate demotion. The QC agent's perceptual-hash check rejects any start frame within a set hash distance of one already published.
- Fill the four slots in the template below. The age line, the face line, "fully clothed" and the anchors are fixed text and never edited.

**Template (fixed text in plain type; slots in braces):**
```
Photoreal vertical 9:16 video start frame, phone-camera look, {CROP}, front-facing (turned 20 degrees at most), eyes to the lens through his glasses, mouth clearly visible and unobstructed. Walt, a 68-year-old white American man of Polish descent, clearly 68, fully clothed: big and broad with a barrel chest, a wide fleshy face with heavy jowls and a broad jaw, fair weathered skin with deep horizontal forehead lines and a few light-brown age spots near the hairline, a large nose broken once and bending slightly to his left, small deep-set brown eyes under heavy grey eyebrows, a thick salt-and-pepper push-broom moustache trimmed at the lip line so both lips stay visible, clean-shaven chin and cheeks, a plain gold wedding band on his left hand. Signature anchors: large steel-grey wire-framed aviator-shape eyeglasses with clear lenses, worn on his face, both eyes clearly visible through the lenses; a small bundle of blank manila string tags tucked into his left chest pocket, their safety-orange strings hanging out over the pocket edge; a short grey flat-top haircut, flat across the crown, with the sides clipped short. Wearing {OUTFIT}. {PROP AND HANDS}; the prop is in shot from this first frame and does not cover his mouth or the pocket tags. Setting: {SETTING AND LIGHT}, matching the locked location still. Natural deadpan expression, mid-thought. Photoreal skin texture, fair skin graded neutral, no glare on the lenses, slight grain, deliberate imperfection: a smudge on the left lens, a creased collar. One person only. No text, no logos, no readable labels, no brand marks, no hallmarks.
```

**Outfit slot text (paste exactly):**
- **W1:** `a long-sleeve cobalt-blue cotton twill work shirt with two button-flap chest pockets, sleeves rolled to the forearm, top button open over a white crew-neck T-shirt, and khaki duck-canvas work trousers`
- **W2:** `a heavy cobalt-blue-and-black buffalo-check wool-blend shirt-jacket with two flap chest pockets, worn open over a white waffle-knit thermal, and khaki work trousers`
- **W3:** `a khaki duck-canvas bib shop apron with a bib pocket over a white long-sleeve thermal henley with the sleeves pushed up, and dark indigo jeans` (the anchor tags sit in the **bib pocket**; write "tucked into the bib pocket of his apron" in place of "his left chest pocket")
- **W4:** `a two-tone short-sleeve bowling shirt with a cobalt-blue body, white side panels and a white left chest pocket, camp collar, no embroidery or text, over a white crew-neck T-shirt, and dark indigo jeans`
- **W5:** `an open cobalt-blue full-zip knit sweater jacket over a khaki brushed-cotton button-down shirt with a left chest pocket, collar open`

### Post 1, Shot A (written out in full: the pinned origin)
```
Photoreal vertical 9:16 video start frame, phone-camera look, medium close-up from mid-torso up with his face about 35% of frame height, front-facing (turned 20 degrees at most), eyes to the lens through his glasses, mouth clearly visible and unobstructed. Walt, a 68-year-old white American man of Polish descent, clearly 68, fully clothed: big and broad with a barrel chest, a wide fleshy face with heavy jowls and a broad jaw, fair weathered skin with deep horizontal forehead lines and a few light-brown age spots near the hairline, a large nose broken once and bending slightly to his left, small deep-set brown eyes under heavy grey eyebrows, a thick salt-and-pepper push-broom moustache trimmed at the lip line so both lips stay visible, clean-shaven chin and cheeks, a plain gold wedding band on his left hand. Signature anchors: large steel-grey wire-framed aviator-shape eyeglasses with clear lenses, worn on his face, both eyes clearly visible through the lenses; a small bundle of blank manila string tags tucked into his left chest pocket, their safety-orange strings hanging out over the pocket edge; a short grey flat-top haircut, flat across the crown, with the sides clipped short. Wearing a long-sleeve cobalt-blue cotton twill work shirt with two button-flap chest pockets, sleeves rolled to the forearm, top button open over a white crew-neck T-shirt, and khaki duck-canvas work trousers. Seated at a folding card table, he holds a plain white dinner plate with a thin gold rim upright in both hands at lower-chest height, off to his right side, its face toward the camera so no back or markings show; the plate is in shot from this first frame and does not cover his mouth or the pocket tags. Behind him, a stack of matching plates and an open brown moving box. Setting: the back bedroom, low winter afternoon sun through a sheer curtain from camera-right, warm 3,800K, a small table lamp glowing on the left, matching the locked location still. Natural deadpan expression, mid-thought. Photoreal skin texture, fair skin graded neutral, no glare on the lenses, slight grain, deliberate imperfection: a smudge on the left lens, a creased collar. One person only. No text, no logos, no readable labels, no brand marks, no hallmarks.
```

### Post 1, Shot B (its own frame, relit to L3 separately; not an edit of Shot A)
```
Photoreal vertical 9:16 video start frame, phone-camera look, a slightly tighter medium close-up from the chest up with his face about 40% of frame height and the card-table edge along the bottom of the frame, front-facing (turned 20 degrees at most), eyes to the lens through his glasses, mouth clearly visible and unobstructed. Walt, a 68-year-old white American man of Polish descent, clearly 68, fully clothed: big and broad with a barrel chest, a wide fleshy face with heavy jowls and a broad jaw, fair weathered skin with deep horizontal forehead lines and a few light-brown age spots near the hairline, a large nose broken once and bending slightly to his left, small deep-set brown eyes under heavy grey eyebrows, a thick salt-and-pepper push-broom moustache trimmed at the lip line so both lips stay visible, clean-shaven chin and cheeks, a plain gold wedding band on his left hand. Signature anchors: large steel-grey wire-framed aviator-shape eyeglasses with clear lenses, worn on his face, both eyes clearly visible through the lenses; a small bundle of blank manila string tags tucked into his left chest pocket, their safety-orange strings hanging out over the pocket edge; a short grey flat-top haircut, flat across the crown, with the sides clipped short. Wearing a long-sleeve cobalt-blue cotton twill work shirt with two button-flap chest pockets, sleeves rolled to the forearm, top button open over a white crew-neck T-shirt. The plain white gold-rimmed dinner plate now lies flat on the card table in front of him, and both of his big hands rest on its rim; the plate is in shot from this first frame. Setting: the back bedroom, low winter afternoon sun through a sheer curtain from camera-right, warm 3,800K, a small table lamp glowing on the left, matching the locked location still; the catchlights sit at the same clock position as in Shot A. Natural expression, one eyebrow slightly raised. Photoreal skin texture, fair skin graded neutral, no glare on the lenses, slight grain, deliberate imperfection: a smudge on the left lens, a creased collar. One person only. No text, no logos, no readable labels, no brand marks, no hallmarks.
```

### Slot values for the other week-1 talking clips

| Clip | {CROP} | {OUTFIT} | {PROP AND HANDS} | {SETTING AND LIGHT} |
|---|---|---|---|---|
| **1C** | a medium shot from the waist up, more of the room visible | W1 | seated, his hands folded on the card table beside the flat gold-rimmed plate | the back bedroom (sheeted bed and figurine cabinet soft behind him); camera-right window 3,800K plus lamp on the left |
| **1D** | a tight close-up from the chest up, the plate's gold rim just visible at the bottom edge | W1 | his left hand resting on the plate rim at the frame edge; a small private half-smile under the moustache | the same back-bedroom light, catchlights matched to 1A |
| **3A** | a medium close-up from mid-torso up | W1 | standing, he holds a dented plain stainless-steel thermos bottle (no logo, no markings) upright in his right hand at chest height, off to his left side | the garage in front of the workbench; frontal overcast daylight 6,000K |
| **3B** | a tighter close-up from the chest up | W1 | the same thermos held in both hands at lower-chest height, a slight head tilt | the same garage light, the pegboard soft behind him |
| **3C** | a medium shot from the waist up | W1 | the thermos standing on the workbench beside him, his left hand resting on its cap | the same garage light, the bread-machine shelf soft on the right |
| **3D** | a medium close-up from mid-torso up, camera 5° lower | W1 | the thermos raised a little toward the lens in his right hand | the same garage light |
| **7A** | a medium close-up from mid-torso up | W3 | a roll of blank manila string tags in his left hand at chest height and a plain black unlabelled marker in his right hand | the garage in front of the workbench; frontal overcast daylight 6,000K |
| **7B** | a tighter close-up from the chest up | W3 | the same tag roll and marker held lower, near his belt line | the same garage light |
| **7C** | a medium shot from the waist up, standing beside the workbench | W3 | the tag roll lifted slightly toward the lens, marker in the other hand; three taped floor squares (orange, blue, grey) visible at his feet | the same garage light |
| **7D** | a medium close-up, camera 5° higher | W3 | the marker capped and pointed down at the tag roll in his other hand | the same garage light, the bread-machine shelf soft on the right |

Week-2 talking clips (posts 11, 14, 17) get their slot values written automatically in week 1 by the Scriptwriter once the scripts are final, using this table's pattern. Post 14 (Tag Tuesday #1): Walt holds a blank manila tag and the marker; the viewer's consented photo goes in as an inset in the edit. Nothing branded is generated.

---

## 4. Candid and still prompts (Soul ID selected; the age line, face line, "fully clothed" and the anchors are always written out)

### C1: Workbench lunch (for statics)
```
Candid vertical phone photo, slightly off-level, as if propped on the workbench. Walt, a 68-year-old white American man of Polish descent, clearly 68, fully clothed: big and broad with a barrel chest, a wide fleshy face with heavy jowls, fair weathered skin, a large nose bending slightly to his left, small deep-set brown eyes, a thick salt-and-pepper push-broom moustache trimmed at the lip line, clean-shaven chin. Signature anchors: large steel-grey wire-framed aviator-shape eyeglasses with clear lenses, worn on his face, both eyes clearly visible through the lenses; a small bundle of blank manila string tags tucked into his left chest pocket, their safety-orange strings hanging out over the pocket edge; a short grey flat-top haircut, flat across the crown, with the sides clipped short. He sits on a stool at the L2 garage workbench holding half a sandwich on rye bread over an open plain plastic tub, mid-laugh at something off-camera, eyes crinkled behind the glasses. Wearing W2: a heavy cobalt-blue-and-black buffalo-check wool-blend shirt-jacket worn open over a white waffle-knit thermal. Overcast daylight from the open door, soft fill, slight motion blur on the hand. Photoreal, phone-camera grain. No text, no logos, no brand marks, the tub plain.
```

### C2: The knock test (for Sale House statics and carousel covers)
```
Candid vertical close-up in the L1 Sale House basement. Walt, a 68-year-old white American man of Polish descent, clearly 68, fully clothed: big and broad with a barrel chest, a wide fleshy face, fair weathered skin, a large nose bending slightly to his left, a thick salt-and-pepper push-broom moustache trimmed at the lip line. Signature anchors: large steel-grey wire-framed aviator-shape eyeglasses with clear lenses, worn on his face, both eyes clearly visible through the lenses; a small bundle of blank manila string tags tucked into the bib pocket of his apron, their safety-orange strings hanging out over the pocket edge; a short grey flat-top haircut, flat across the crown, with the sides clipped short. He leans in and knocks on the top of a plain walnut-veneer sideboard with the knuckles of his right hand, head tilted, listening, one eyebrow raised. Wearing W3: a khaki duck-canvas bib shop apron over a white long-sleeve thermal henley with the sleeves pushed up. Cool diffused daylight from the high glass-block window on camera-left with a soft fill from the right, dust in the light, shallow depth of field with his face sharp. Photoreal, natural skin texture. No text, no hallmarks, no logos, no readable tags.
```

### C3: Bread-maker trophy (for the Bread-Maker Count and No-Buy statics)
```
Candid vertical snapshot at dusk in the L2 garage, lit by direct on-camera flash: hard flash light, a sharp shadow on the pegboard behind him, a small flash reflection kept off his eyes. Walt, a 68-year-old white American man of Polish descent, clearly 68, fully clothed: big and broad with a barrel chest, a wide fleshy face, fair weathered skin, a large nose bending slightly to his left, a thick salt-and-pepper push-broom moustache trimmed at the lip line. Signature anchors: large steel-grey wire-framed aviator-shape eyeglasses with clear lenses, worn on his face, both eyes clearly visible through the lenses; a small bundle of blank manila string tags tucked into his left chest pocket, their safety-orange strings hanging out over the pocket edge; a short grey flat-top haircut, flat across the crown, with the sides clipped short. He holds a dusty plain white countertop bread machine up at chest height in both hands, like a bowling trophy, keeping it below the pocket tags. Deadpan face, looking straight into the lens. The shelf of bread machines is behind him, slightly out of focus. Wearing W2: a heavy cobalt-blue-and-black buffalo-check wool-blend shirt-jacket worn open over a white waffle-knit thermal. Photoreal, amateur flash look, true fair skin with flash highlights on the forehead, not pink. No text, no logos, no lettering on the bread machine.
```

### C4: The Keep Box (Post 10 static and Keep Box lore stills)
```
Candid vertical still at the card table by the window in the L3 back bedroom. Walt, a 68-year-old white American man of Polish descent, clearly 68, fully clothed: big and broad with a barrel chest, a wide fleshy face with heavy jowls, fair weathered skin, a large nose bending slightly to his left, a thick salt-and-pepper push-broom moustache trimmed at the lip line, a plain gold wedding band on his left hand. Signature anchors: large steel-grey wire-framed aviator-shape eyeglasses with clear lenses, worn on his face, both eyes clearly visible through the lenses; a small bundle of blank manila string tags tucked into his left chest pocket, their safety-orange strings hanging out over the pocket edge; a short grey flat-top haircut, flat across the crown, with the sides clipped short. He sits with both hands resting on the rim of an open brown banker's box, looking down into it with a small private smile under the moustache. Visible inside: a plain dented steel lunch pail with its lid closed and a sealed blank envelope; nothing readable. (From Post 19 on, add: an index card lying face down.) Wearing W5: an open cobalt-blue full-zip knit sweater jacket over a khaki brushed-cotton button-down shirt with a left chest pocket. Low winter sun from camera-right, warm 3,800K, lamp glow from the left. Photoreal, slight grain. No text, no logos, no readable labels.
```

---

## 5. The relight rule for video

**Rule:** before any still becomes a video start frame, relight Walt to match that location's locked key light. Use Higgsfield Relight or a Nano Banana Pro edit. Relight **each start frame on its own**; never derive one clip's frame from another by editing the prop.

| Location | Key direction | Colour temperature | Fill | Talking-reel fix |
|---|---|---|---|---|
| L1 Sale House | High camera-left glass-block windows | 5,000K cool, diffused | Overhead fluorescent 4,000K, plus a soft bounce from the right at −1 stop | Turn Walt 15° toward the windows so both eyes catch light; check the fluorescent doesn't green his skin |
| L2 Garage | Frontal (open door behind the camera) | 6,000K overcast | Natural | Default talking set; tilt the glasses' reflection off-axis by raising the key slightly |
| L3 Back Bedroom | Camera-right window plus lamp | 3,800K warm | Lamp glow from the left | Seat him facing the window, three-quarter at most; keep the warm light from turning his skin orange |
| L4 Driveway | Overcast, from above and in front | 6,500K | Natural | Add a subtle under-eye fill so the brow and glasses frames don't shadow his eyes |
| L5 Basement Kitchen | High camera-left glass-block window | 5,000K | Bare bulb 2,700K above | Activity-first; talking only at medium close-up facing the window |
| L6 Attic | Camera-right gable window | 5,500K | Natural bounce off plywood | Activity-first; keep the low ceiling out of the top third |

**Hard rules (all checked automatically by the QC agent at Q3):**
1. The light direction and colour on his face must match the room. Reject any frame where they disagree.
2. **No backlit faces.** Never put the window behind Walt in a talking shot.
3. Catchlights sit at the same clock position across every clip in a reel.
4. **No lighting changes inside a clip.** Don't prompt for "lights flicker", "sun comes out" or anything similar.
5. If Seedance shifts the exposure by more than 0.3 stops between clips, regenerate. Don't grade it.
6. Skin tone must match across every clip in a reel; reject any clip where he goes pinker, redder, greyer or more orange.
7. **Lens glare** must not cover more than 10% of either eye in any frame; reject and regenerate.
8. Name the files by post and clip: `P01_A_L3_W1_relit_v1.png` and so on.

**Talking-reel spec (Seedance + ElevenLabs track):**
- **Framing:** medium close-up from mid-torso up, face 30–40% of frame height; one clip per reel may go to a tighter chest-up or a waist-up medium for variety.
- **Head and eyes:** front-facing or turned 20° at most; eyes to the lens. No profile-angle lip-sync.
- **Mouth:** never covered: no hand, cup, thermos or knuckle-to-glasses push in a lip-sync clip. The moustache stays trimmed at the lip line.
- **Clips:** **3–4 clips per reel, each ≤ 8 s of audio** (about 17 spoken words at his pace). This fits every Higgsfield plan (some cap at 8 s; the hard limit is 15 s per shot and per uploaded audio clip), so no plan check or upgrade is needed. Each reel runs **30 s or less**, including pauses. The scripts mark cuts with "//".
- **Motion prompt:** "gentle natural head movement, occasional slow blink, a small flat shrug, hands steady holding the [prop] at chest height, the glasses stay on his face, the tags stay in his pocket, locked-off camera with very slight handheld drift."

**Activity-clip spec (Kling or Wan, no lip-sync):**
- 5–8 s each, with 2–3 clips per post (3–4 for voiceover reels).
- Walt may look down at the task.
- Hands do one simple action per clip: lifting, knocking on wood, tying a tag, opening a drawer, setting down a box, writing with the marker, pushing his glasses up with one knuckle.
- Tags stay blank or carry scribbles; text goes on in the edit.

**Activity-clip template (fixed text plus slots):**
```
Photoreal vertical 9:16 video, phone-camera look, {SHOT SIZE}. Walt, a 68-year-old white American man of Polish descent, clearly 68, fully clothed: big and broad with a barrel chest, a wide fleshy face with heavy jowls, fair weathered skin, a large nose bending slightly to his left, a thick salt-and-pepper push-broom moustache trimmed at the lip line, clean-shaven chin. Signature anchors: large steel-grey wire-framed aviator-shape eyeglasses with clear lenses, worn on his face, both eyes clearly visible through the lenses; a small bundle of blank manila string tags tucked into his left chest pocket, their safety-orange strings hanging out over the pocket edge; a short grey flat-top haircut, flat across the crown, with the sides clipped short. Wearing {OUTFIT}. In {LOCATION}, lit exactly as the locked still: {LIGHT}. One simple action over 5 to 8 seconds: {ACTION}. Every object he handles is in his hands or on the surface from the first frame; if he writes or taps, he holds a plain black unlabelled marker from the first frame and the pocket tags stay in his pocket. He may look down at the task; no talking. Camera locked off with very slight handheld drift. One person only. No text, no logos, no readable labels; tags blank or scribbled.
```

---

## 6. Face and voice drift tests (before Fri 23 Oct; fully automated)

*Offered to the Studio Manager as the single studio spec. If a canonical studio spec is published, it replaces this section.*

### 6.1 Per-character test: 20 generations

| Count | What |
|---|---|
| 8 | Stills: L1–L4 × two outfits each (W1 plus one of W2–W5) |
| 4 | Expressions: deadpan, belly laugh, the knock test (listening), mid-word |
| 3 | Angles: front, three-quarter left, three-quarter right |
| 3 | Seedance talking start frames, plus an 8 s clip each, scored at the first, middle and last frames |
| 2 | Kling activity clips, scored at the first and last frames |

**Visual score, out of 10, for each generation (scored by the QC agent with Claude vision against the locked sheet; no human graders):**
1. fair skin, neutral, consistent with the sheet (not pink, ruddy, orange or grey);
2. the nose bending slightly to his left;
3. the grey flat-top (flat crown, short sides);
4. the push-broom moustache at the lip line, both lips visible, chin clean-shaven;
5. the wide, jowly face and the barrel-chested build;
6. steel aviators **worn on the face**, eyes visible, no glare over the eyes;
7. the tag bundle in the left chest (or bib) pocket with orange strings;
8. no dark-blue clothing; cobalt reads bright;
9. wedding band only, on the left hand;
10. reads age 66–70.

**Numeric score:** face-embedding cosine similarity (InsightFace ArcFace, `buffalo_l`) between each generation and Panel 1 of the locked sheet.

**Pass:** at least 18 of the 20 generations score 9/10 or better **and** at least 18 of the 20 reach a cosine of 0.55 or more.

**Fail:** the Video Producer retrains Soul ID with the 5 worst references replaced by fresh sheet-derived ones, then reruns automatically. After two failed reruns, fall back to sheet-plus-location references in Seedance (§Pipeline 4) and log it for the Studio Manager.

### 6.2 All-five cross-test (run automatically once the five sheets are locked)
- **Setup:** generate each of the five characters 3 times in the same neutral grey studio, at the same medium close-up framing and the same light.
- **Face-embedding distinctness:** the mean ArcFace cosine between any two different characters must be **0.30 or lower**. Any pair above it gets a face-lock change on the persona the Studio Manager names.
- **Vision-model blind match (replaces human blind-sort):** the QC agent gives Claude vision the five locked sheets (labelled) and the 15 test images (shuffled, unlabelled, file names randomised) and asks it to assign each image to a sheet. Run it 3 times with a fresh shuffle. **Pass = 100% correct on all 3 runs.** Any miss triggers a review of that pair by the Studio Manager's critique pass and a face-lock change.
- **Voice distinctness (replaces matching voices to faces):** speaker-embedding cosine (SpeechBrain ECAPA-TDNN) between every pair of locked voices stays below the same-speaker threshold (bible §9), and the accent classifier returns a different accent label for each English variety (US for Walt and Rosa, separated by speaker embedding and gender; England for Ambrose and Dot, separated by speaker embedding and gender; Ireland for Margot) [VERIFY classifier labels].
- **Pairs to watch for Walt:** **Walt–Ambrose** on both face and voice (the only two men, both fair-skinned). If their ArcFace cosine exceeds 0.25, strengthen Walt's separators first (heavier jowls, a broader jaw, a more visible nose bend), since Ambrose's look is already locked.
