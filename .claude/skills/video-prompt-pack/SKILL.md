---
name: video-prompt-pack
description: Write the image and video prompts for one post (start frames, b-roll, activity clips, carousel stills) with the persona's locked anchors, relight rule, camera method and caption safe zones. Use before any Higgsfield, Seedance, Kling or still-image generation.
---

# Video prompt pack

Every generated frame must look like the same character in the same world, and must never pretend to be a real person or a real recording. The pack is written once per post and handed to the Video Producer with the script.

## Prompt order (every prompt, every time)

1. **Character**: the Soul ID or character reference, the age written out, and the three locked anchors from the bible's look section.
2. **Wardrobe**: the outfit from the bible, word for word.
3. **Set**: the named location still, with its key light direction and colour temperature.
4. **Action**: one simple action per clip. Hands do one thing.
5. **Props**: the post's first-frame prop, placed and described.
6. **Camera**: lens feel, framing (medium close-up for talking, waist-up for activity), height and one movement at most (slow push-in, or locked off).
7. **Light**: the relight rule below.
8. **Negative prompt**: text, logos, brand marks, extra fingers, warped jewellery, other people's faces, younger or older age, nudity.

## Relight rule

Each clip is lit for its own set: write the key direction, temperature and fill for that set, never "same as before". A start frame is regenerated for a new set, not edited.

## Start-frame variants

Talking reels get a fresh variant of the master start frame each time: change the crop, one prop position and one background object; keep face, hair and light locked. Log the variant id. Identical first frames across posts read as unoriginal and get demoted.

## Safe zones

- Keep the top 12% and bottom 20% of a 9:16 frame free of faces and key props: captions, the platform's AI label and the interface sit there.
- On-screen text is added in the edit, never generated inside the image.

## Never

- Never ask a model to make a frame "read as real", "indistinguishable from a photo" or "not AI". The persona is openly AI.
- No real people, celebrities or look-alikes; no real brands, logos or readable labels; no identifiable homes or streets.
- Everyone is fully clothed. Ages render true to the bible.

## Before the batch

Run the face-drift check: generate 20 frames across sets and outfits and confirm the anchors survive in every one. A failed anchor stops the batch.
