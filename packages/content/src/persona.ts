import type { PersonaRow, PostFormat } from '@ios/core';
import type { Db } from '@ios/db';
import type { LlmCacheBlock } from '@ios/providers';
import { asRecord, asString, asStrings, hashInt, keywordFrom, stableStringify } from './util';

/**
 * Everything a content agent needs about one persona, read from the persona row and its current bible (PRD
 * Appendix A). Missing sections fall back to niche-based defaults, so a persona without a bible still gets a plan.
 */
export interface Pillar {
  readonly name: string;
  readonly examples: readonly string[];
  readonly formats: readonly PostFormat[];
}
export interface CommentKeyword {
  readonly keyword: string;
  readonly delivers: string;
}
export interface PersonaContext {
  readonly persona: PersonaRow;
  readonly bibleVersion: number | null;
  readonly bible: Record<string, unknown>;
  readonly pillars: readonly Pillar[];
  readonly keywords: readonly CommentKeyword[];
  /** The default CTA keyword (the free lead magnet when there is one). */
  readonly leadKeyword: string;
  readonly voice: { wpm: number; lexicon: string[]; avoid: string[]; catchphrases: string[]; energy: string };
  readonly hookLibrary: readonly string[];
  readonly bannedHooks: readonly string[];
  readonly frameworks: ReadonlyArray<{ name: string; steps: string[] }>;
  readonly audience: { pains: string[]; desires: string[]; language: string[]; objections: string[] };
  readonly look: { settings: string[]; outfits: string[]; framing: string; stylisation: string };
  readonly priceBand: { minCents: number; maxCents: number };
  readonly neverClaims: readonly string[];
  /** Hue for generated thumbnails. */
  readonly hue: number;
  /** Prompt-cached context: studio content rules first (most stable), then the persona bible. */
  readonly cached: readonly LlmCacheBlock[];
}

const FORMATS: readonly PostFormat[] = ['talking', 'activity_text', 'voiceover', 'static', 'carousel'];

/** Stable studio-wide rules every content agent works under (cached first; change the version when editing). */
export const STUDIO_CONTENT_RULES = `Studio content rules v2 (Influencer OS).
- What wins: reach plus sales. Every post has one clear CTA, usually "Comment KEYWORD" that DMs a resource.
- English only. Write for the ear: short sentences, contractions, one idea per line, no jargon.
- First-person stories, situations, dramatised scenarios and lore are character content and are allowed: "my date stood me up
  tonight", "day 12 of my no-buy", "a lady at my hatch asked me". Write them freely.
- Legal and platform lines (the Compliance Gate blocks these; everything else, including strong opinions and general education, is fine):
  a story used as proof that a product or service works ("this workbook got me over him", "I made $5K with this"),
  real people or brands without permission (no celebrity or brand endorsements, no "as seen on"),
  fake credentials (no doctor, adviser, CPA or "certified" claims),
  disease-cure or dangerous medical claims (no diagnosing, treating or curing disease; never tell anyone to stop medication),
  specific securities or crypto buy/sell calls, guaranteed returns or income claims ("make $5K a month"),
  undisclosed sponsorships or affiliate links (#ad / #affiliate; personas never claim to have used an affiliate product),
  fake scarcity (no invented countdowns, "only 3 left" or "1,000 sold"), testimonials or reviews that are not real and verifiable.
- AI disclosure is the platform minimum: the post-level AI flag and the platform's AI profile label. The persona is an AI creator
  and never denies being AI when sincerely asked.
- Every factual claim (statistics, studies, "research shows") must cite a knowledge hit id; otherwise say it as opinion or general education.`;

const parseWpm = (pace: string): number => {
  const m = pace.match(/(\d{2,3})\s*wpm/i);
  const n = m ? Number(m[1]) : 160;
  return n >= 110 && n <= 210 ? n : 160;
};

/** "$7–39" → {700, 3900}. */
export function parsePriceBand(band: string): { minCents: number; maxCents: number } {
  const nums = (band.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (nums.length >= 2 && nums[0]! <= nums[1]!) return { minCents: Math.round(nums[0]! * 100), maxCents: Math.round(nums[1]! * 100) };
  return { minCents: 500, maxCents: 4900 };
}

function hueOf(p: PersonaRow): number {
  const m = (p.accent_color ?? '').match(/hsl\(\s*(\d+)/);
  return m ? Number(m[1]) : hashInt(p.id) % 360;
}

function defaultPillars(niche: string): Pillar[] {
  const n = niche.toLowerCase();
  return [
    { name: `${niche} basics`, examples: [`The first step in ${n}`, `${niche} in 30 seconds`], formats: ['talking', 'carousel'] },
    { name: 'Habits and systems', examples: ['A 10-minute weekly reset', 'One habit that makes the rest easy'], formats: ['activity_text', 'voiceover'] },
    { name: 'Myths and mistakes', examples: [`The ${n} myth that wastes your time`, 'The mistake everyone makes first'], formats: ['talking', 'static'] },
  ];
}

export async function loadPersonaContext(db: Db, personaId: string): Promise<PersonaContext> {
  const persona = await db.one<PersonaRow>('SELECT * FROM persona WHERE id = $1', [personaId]);
  const bibleRow = await db.maybeOne<{ version: number; content: Record<string, unknown> }>(
    `SELECT version, content FROM persona_bible WHERE persona_id = $1
      ORDER BY (version = $2) DESC, (status = 'approved') DESC, version DESC LIMIT 1`,
    [personaId, persona.current_bible_version ?? -1],
  );
  const bible = asRecord(bibleRow?.content);
  const dna = asRecord(bible.content_dna);
  const voice = asRecord(bible.voice);
  const eng = asRecord(bible.engagement_style);
  const look = asRecord(bible.look);
  const audience = asRecord(bible.audience);

  const pillars: Pillar[] = (Array.isArray(dna.pillars) ? dna.pillars : [])
    .map((x) => asRecord(x))
    .filter((x) => typeof x.name === 'string')
    .map((x) => ({
      name: asString(x.name),
      examples: asStrings(x.examples),
      formats: asStrings(x.formats).filter((f): f is PostFormat => FORMATS.includes(f as PostFormat)),
    }));
  const keywords: CommentKeyword[] = (Array.isArray(eng.comment_keywords) ? eng.comment_keywords : [])
    .map((x) => asRecord(x))
    .filter((x) => typeof x.keyword === 'string' && /^[A-Za-z]{2,12}$/.test(asString(x.keyword)))
    .map((x) => ({ keyword: asString(x.keyword).toUpperCase(), delivers: asString(x.delivers) }));
  const lead = keywords.find((k) => /free|starter|guide|checklist/i.test(k.delivers)) ?? keywords[0];

  const cached: LlmCacheBlock[] = [{ key: 'studio-rules:content:v2', text: STUDIO_CONTENT_RULES }];
  if (bibleRow) {
    cached.push({
      key: `bible:${persona.id}:v${bibleRow.version}`,
      text: `Persona bible v${bibleRow.version}: ${persona.name} (${persona.niche}${persona.sub_niche ? `; ${persona.sub_niche}` : ''}).\n${stableStringify(bible)}`,
    });
  } else {
    cached.push({
      key: `persona:${persona.id}:basic`,
      text: `Persona: ${persona.name}, an AI creator. Niche: ${persona.niche}${persona.sub_niche ? `; ${persona.sub_niche}` : ''}. No bible yet: keep to general education and opinion.`,
    });
  }

  return {
    persona,
    bibleVersion: bibleRow?.version ?? null,
    bible,
    pillars: pillars.length ? pillars : defaultPillars(persona.niche),
    keywords,
    leadKeyword: lead?.keyword ?? keywordFrom(persona.niche, 'GUIDE'),
    voice: {
      wpm: parseWpm(asString(voice.pace)),
      lexicon: asStrings(voice.lexicon),
      avoid: asStrings(voice.avoid),
      catchphrases: asStrings(voice.catchphrases),
      energy: asString(voice.energy, 'Warm and direct'),
    },
    hookLibrary: asStrings(dna.hook_library).map((h) => h.replace(/^["“]|["”]$/g, '')),
    bannedHooks: asStrings(dna.banned_hooks),
    frameworks: (Array.isArray(bible.signature_frameworks) ? bible.signature_frameworks : [])
      .map((x) => asRecord(x))
      .filter((x) => typeof x.name === 'string')
      .map((x) => ({ name: asString(x.name), steps: asStrings(x.steps) })),
    audience: {
      pains: asStrings(audience.pains),
      desires: asStrings(audience.desires),
      language: asStrings(audience.their_language).map((h) => h.replace(/^["“]|["”]$/g, '')),
      objections: asStrings(audience.objections),
    },
    look: {
      settings: asStrings(look.settings).length ? asStrings(look.settings) : persona.look_pack.map((l) => l.label),
      outfits: asStrings(look.outfits),
      framing: asString(look.framing, 'Chest-up for talking; hands and props for activity clips'),
      stylisation: asString(look.stylisation, 'Photoreal, soft natural light'),
    },
    priceBand: parsePriceBand(asString(asRecord(bible.products).price_band)),
    neverClaims: asStrings(asRecord(bible.compliance).never_claims),
    hue: hueOf(persona),
    cached,
  };
}
