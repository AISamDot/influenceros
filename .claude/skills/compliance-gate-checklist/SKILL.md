---
name: compliance-gate-checklist
description: Check a script, caption, carousel, product, listing or reply against the studio's legal and platform lines (AI disclosure, endorsements, reviews, health, money and credential claims) and return green, amber or red with the rule and a compliant rewrite. Use before media is queued and before anything publishes.
---

# Compliance Gate checklist

The Gate enforces legal and platform lines only. Opinions, humour, strong takes and general education pass. Quality and taste are QC's job, not the Gate's.

## Red (blocks; never publishes)

1. **Fabricated results used to sell**: invented earnings, before-and-after outcomes, sales counts or testimonials. Covers AI-generated reviews and testimonials too (FTC rule on consumer reviews and testimonials, 16 CFR Part 465).
2. **Fake credentials**: any claim or implication of a degree, licence or professional title (Dr, nutritionist, therapist, financial adviser, lawyer, coach "certified").
3. **Disease-cure or dangerous medical claims**: a food, product or habit that treats, prevents or cures a condition; advice to stop medication; unsafe dosing, fasting or food-safety advice.
4. **Specific securities or crypto calls**: buy, sell or hold a named stock, fund, token or coin; price targets; timing calls.
5. **Guaranteed returns or income**: any promise of money made, saved or returned.
6. **Undisclosed sponsorships or affiliate links**: a material connection without a clear, upfront disclosure (FTC Endorsement Guides, 16 CFR Part 255).
7. **Denying being AI** when sincerely asked, or wording that implies the persona is a real human.
8. **Missing post-level AI flag**: every post carries the platform's AI label (Instagram AI info and the AI-generated profile label, the TikTok AI-generated content toggle, YouTube's altered or synthetic content setting). The pipeline sets it; the Gate verifies it.

## Amber (publishes only with the right approval or a fix)

- A factual claim without a cited Field Brain or news id (soften to opinion or cite it).
- A number without its source and year.
- Health, money or legal content that reads as individual advice ("you should...") rather than general education.
- Real people, brands or trademarks named in a sell asset.
- Third-party content (texts, screenshots, comments) without consent and redaction.
- Seasonal or news content that could read as exploiting a tragedy.

## Green

Everything else: opinions, general education, entertainment, lore clearly framed as fiction.

## Transparency law (context the rules above implement)

- **EU AI Act, Article 50**: AI-generated or manipulated image, audio and video content that resembles real people, objects or events must be disclosed as artificially generated. The platform AI flag on every post plus the AI profile label meets the studio's standard.
- **Platform rules**: each platform's synthetic-media label is mandatory for realistic AI content; never strip C2PA metadata.

## Output

For each finding return: rule id, verdict (green, amber or red), a one-line message, the offending span, and a compliant rewrite when one exists. The overall verdict is the worst finding. Red never proceeds, and only the Owner can release a red after review.
