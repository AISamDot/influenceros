---
name: compliance-gate-checklist
description: Check a script, caption, carousel, product, listing or reply against the studio's legal and platform lines (AI disclosure, endorsements, reviews, health, money and credential claims) and return green, amber or red with the rule and a compliant rewrite. Use before media is queued and before anything publishes.
---

# Compliance Gate checklist

The Gate enforces legal and platform lines only. Opinions, humour, strong takes and general education pass. Quality and taste are QC's job, not the Gate's.

**First-person stories are character content (Owner, 16 Oct).** First-person stories, situations, dramatised scenarios and lore pass: "my date stood me up tonight", "day 12 of my no-buy", "a lady at my hatch asked me". Never flag a story because it is invented or told in the first person. A story is red only when it is used as proof that a product or service works (rule 1).

## Red (blocks; never publishes)

1. **A story used as proof that a product or service works**: "this workbook got me over him", "I made $5K with this", "this planner helped me pay off $12,000", a personal result told inside a sell asset, invented testimonials, reviews or customer results. Covers AI-generated reviews and testimonials too (FTC rule on consumer reviews and testimonials, 16 CFR Part 465). The same story without the product credit passes.
2. **Real people or brands without permission**: a celebrity, public figure or brand named as using, recommending or endorsing anything ("Taylor Swift uses this planner", "Recommended by Oprah", "As seen on Shark Tank", "Nike sent me this"), and any real person's name, likeness or voice. Fine only with written permission on file, or for the brand behind a disclosed sponsorship.
3. **Fake credentials**: any claim or implication of a degree, licence or professional title (Dr, nutritionist, therapist, financial adviser, lawyer, coach "certified").
4. **Disease-cure or dangerous medical claims**: a food, product or habit that treats, prevents or cures a condition; advice to stop medication; unsafe dosing, fasting or food-safety advice.
5. **Specific securities or crypto calls**: buy, sell or hold a named stock, fund, token or coin; price targets; timing calls.
6. **Guaranteed returns or income**: any promise of money made, saved or returned.
7. **Undisclosed sponsorships or affiliate links**: a material connection without a clear, upfront disclosure (FTC Endorsement Guides, 16 CFR Part 255).
8. **Denying being AI** when sincerely asked, or claiming to be a human ("I'm a real person"). An in-character story is not a claim to be human.
9. **Missing post-level AI flag**: every post carries the platform's AI label (Instagram AI info and the AI-generated profile label, the TikTok AI-generated content toggle, YouTube's altered or synthetic content setting). The pipeline sets it; the Gate verifies it.

## Amber (publishes only with the right approval or a fix)

- A factual claim without a cited Field Brain or news id (soften to opinion or cite it).
- A number without its source and year.
- Health, money or legal content that reads as individual advice ("you should...") rather than general education.
- Real people, brands or trademarks named in a sell asset without endorsing it (a passing mention).
- Third-party content (texts, screenshots, comments) without consent and redaction.
- Seasonal or news content that could read as exploiting a tragedy.

## Green

Everything else: opinions, general education, entertainment, first-person stories and situations, dramatised scenarios and character lore.

## Transparency law (context the rules above implement)

- **EU AI Act, Article 50**: AI-generated or manipulated image, audio and video content that resembles real people, objects or events must be disclosed as artificially generated. The platform AI flag on every post plus the AI profile label meets the studio's standard.
- **Platform rules**: each platform's synthetic-media label is mandatory for realistic AI content; never strip C2PA metadata.

## Output

For each finding return: rule id, verdict (green, amber or red), a one-line message, the offending span, and a compliant rewrite when one exists. The overall verdict is the worst finding. Red never proceeds, and only the Owner can release a red after review.
