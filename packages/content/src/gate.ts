import type { GateCheck, StudioServices } from '@ios/agents';
import { type CostRef, type GateVerdict, type PostPurpose } from '@ios/core';
import { json } from '@ios/db';
import { sentences } from './util';

/**
 * Compliance Gate v1 (PRD §3.4, FR-20.10). Independent: no manager controls it, and nothing a maker says can turn a
 * red green. It enforces legal and platform lines only; opinions and general education pass.
 *
 * Red (blocked; only the Owner can release): fabricated results used to sell (incl. testimonials and "I use this"
 * endorsements), fake credentials, disease-cure or dangerous medical claims, specific securities/crypto calls,
 * guaranteed returns or income, undisclosed sponsorships, fake scarcity, denying being AI, a post without its AI flag.
 * Amber (proceeds to media; a human sees it at L0/L1): regulated financial promotions, content aimed at minors,
 * a buy/sell question framing, a missing platform AI profile label.
 *
 * A deterministic rule pass always runs; in live mode a fast-tier model adds a second opinion that can only add
 * findings (max severity wins).
 */

export type GateSubjectKind = 'script' | 'caption' | 'reply' | 'listing' | 'launch' | 'post';

export interface GateInput {
  readonly text: string;
  readonly kind: GateSubjectKind;
  readonly purpose?: PostPurpose;
  /** The content promotes a third-party product that pays (commission or sponsorship). */
  readonly affiliate?: boolean;
  readonly sponsored?: boolean;
  /** Knowledge hit ids backing claims (substantiation for efficacy claims). */
  readonly evidenceIds?: readonly string[];
  /** A real launch deadline (cart close / launch price end). Deadline language is fine only with one. */
  readonly realDeadline?: Date | null;
  /** For replies: the message being answered (to detect a sincere "are you AI?"). */
  readonly incoming?: string;
}

/** Rule ids, in display order. */
export const GATE_RULES = [
  'fabricated_results',
  'testimonials',
  'fake_credentials',
  'medical_claims',
  'securities_calls',
  'guaranteed_returns',
  'undisclosed_sponsorship',
  'fake_scarcity',
  'never_deny_ai',
  'ai_flag',
  'regulated_promotion',
  'minors',
] as const;
export type GateRule = (typeof GATE_RULES)[number] | 'ai_profile_label' | 'model_review';

interface Pattern {
  readonly rule: GateRule;
  readonly verdict: Exclude<GateVerdict, 'green'>;
  readonly re: RegExp;
  readonly message: string;
  readonly fix?: string;
  readonly when?: (i: GateInput, sentence: string) => boolean;
  /**
   * Cautionary education passes: the match is skipped when it is negated ("Never stop your medication…", "Don't buy
   * Bitcoin with…") or attributed to someone being warned about ("Anyone who says returns are guaranteed is lying").
   * 'inside' also checks the matched span itself, for subject…verb patterns ("Most supplements don't cure anything").
   */
  readonly negatable?: true | 'inside';
}

/** A negation governing the matched verb: "never", "don't", "not" … then at most three words, no comma. */
const NEG_BEFORE = /\b(?:never|not|don'?t|do not|doesn'?t|does not|didn'?t|won'?t|will not|shouldn'?t|should not|can'?t|cannot|must not|mustn'?t|without|no one should|nobody should)\s+(?:[\w'’]+\s+){0,3}$/i;
/** The claim is someone else's, quoted to warn against it: "if a course says…", "anyone who promises…". */
const ATTRIB_BEFORE = /\b(?:if|when|anyone|someone|whoever|nobody|no one|people|beware(?: of)?|scammers?|gurus?)\b[^.!?,;]{0,40}\b(?:says?|said|claims?|claimed|tells? you|told you|promises?|promised|promising|sells?|selling|pitches|pitching)\b[^.!?]*$/i;
const NEG_INSIDE = /\b(?:not|never|no|don'?t|do not|doesn'?t|does not|won'?t|will not|can'?t|cannot)\b|n't\b/i;

/** True when a match in `sentence` at `index` is negated or attributed (see Pattern.negatable). */
export function negatedMatch(sentence: string, index: number, matched: string, inside = false): boolean {
  const prefix = sentence.slice(0, index);
  return NEG_BEFORE.test(prefix) || ATTRIB_BEFORE.test(prefix) || (inside && NEG_INSIDE.test(matched));
}

const MONEY_OR_NUMBER = String.raw`(?:over\s+|about\s+|almost\s+|nearly\s+|more than\s+)?[$£€]?\d[\d,.]*\s*(?:k\b|K\b)?`;
const DISEASES = String.raw`cancer|tumou?rs?|diabetes|depression|anxiety|adhd|autism|arthritis|alzheimer'?s|dementia|hypertension|high blood pressure|heart disease|covid|asthma|eczema|psoriasis|ibs|pcos|infertility|thyroid|insomnia|obesity|disease|disorder|infection`;
const ASSETS = String.raw`\$[A-Z]{1,5}\b|\b(?:bitcoin|btc|ethereum|eth|solana|dogecoin|doge|xrp|shiba(?: inu)?|pepe|nvidia|nvda|tesla stock|tsla|aapl|apple stock|amzn|amazon stock|gamestop stock|gme|amc stock|meme ?coins?|this (?:coin|token))\b`;
const QUESTION_FRAME = /^\s*(should|would|do|does|is|are|can)\s+(you|i|it)\b|^\s*before you\b|\bwhether to\b/i;

const PATTERNS: readonly Pattern[] = [
  // ── Fabricated results used to sell (FTC 16 CFR 465, deception law) ──
  {
    rule: 'fabricated_results',
    verdict: 'red',
    re: new RegExp(String.raw`\b(?:i|we|i've|we've|i have|we have)\s+(?:just\s+)?(?:lost|dropped|made|earned|paid off|saved|cleared|gained|grew|doubled|tripled|netted|banked)\s+${MONEY_OR_NUMBER}`, 'i'),
    message: 'Fabricated personal result used to sell (an AI persona has no real results).',
    fix: 'Teach the system instead: "Here is the system, step by step."',
  },
  {
    rule: 'fabricated_results',
    verdict: 'red',
    re: new RegExp(String.raw`\b(?:helped|let|got|allowed)\s+(?:me|us)\s+(?:to\s+)?(?:lose|drop|make|earn|pay off|save|clear|gain|grow|double|bank|net)\s+${MONEY_OR_NUMBER}`, 'i'),
    message: 'Fabricated personal result used to sell (an AI persona has no real results).',
    fix: 'Teach the system instead: "Here is the system, step by step."',
  },
  {
    rule: 'fabricated_results',
    verdict: 'red',
    re: /\bmy\s+(?:clients?|students?|customers?|followers?|members?|readers?)\s+(?:have\s+)?(?:lost|made|earned|paid off|saved|doubled|got)\b/i,
    message: 'Claimed customer results (not real and verifiable).',
    fix: 'Drop the result claim; describe what the product contains.',
  },
  {
    rule: 'fabricated_results',
    verdict: 'red',
    re: /\b(?:i|i've|i have|i've been)\s+(?:use|used|using|been using|swear by|love using|rely on)\b/i,
    message: 'Personas never claim to have used a product they promote (FTC Endorsement Guides).',
    fix: 'Frame it as "worth a look", with #ad or #affiliate.',
    when: (i) => Boolean(i.affiliate || i.sponsored),
  },
  {
    rule: 'testimonials',
    verdict: 'red',
    re: /\b(?:customers?|clients?|students?|buyers?|members?|readers?)\s+(?:say|said|love|rave|told me|are saying|report)\b|\b(?:5|five)[- ]star reviews?\b|\breviews? (?:say|speak)\b/i,
    message: 'Testimonials and reviews must be real and verifiable (FTC fake-review rule; v1: none).',
    fix: 'Remove the testimonial.',
  },
  // ── Fake credentials ──
  {
    rule: 'fake_credentials',
    verdict: 'red',
    re: /\b(?:as an?|i'?m an?|i am an?|being an?|speaking as an?)\s+(?:certified\s+|licensed\s+|registered\s+|board[- ]certified\s+|qualified\s+|former\s+)?(?:doctor|physician|surgeon|nurse|dietitian|nutritionist|pharmacist|therapist|psychologist|psychiatrist|cpa|accountant|financial (?:adviser|advisor|planner)|cfp|lawyer|attorney|dentist|personal trainer|physiotherapist|chiropractor)\b(?!\s+(?:would|will|can|might|should|could|may)\b)/i,
    message: 'Claims a professional credential the persona does not have.',
    fix: 'Speak as an AI creator sharing general education; suggest a professional for personal advice.',
  },
  {
    rule: 'fake_credentials',
    verdict: 'red',
    re: /\b(?:i'?m|i am)\s+(?:certified|licensed|board[- ]certified|a licensed)\b|\bmy (?:medical|law|nursing|finance|psychology|nutrition) (?:degree|license|licence|practice)\b|\bin my (?:clinic|practice)\b/i,
    message: 'Claims a licence, degree or practice.',
    fix: 'Remove the credential claim.',
  },
  // ── Medical: disease cure/treatment, stopping medication, dangerous practices ──
  {
    rule: 'medical_claims',
    verdict: 'red',
    re: new RegExp(String.raw`\b(?:cures?|cured|curing|treats?(?!\s+(?:yourself|yo'self))|treating|reverses?|reversed|reversing|heals?|healed|healing|eliminates?|eradicates?|fixes|beats?|fights?|kills?|prevents?|wipes? out)\b[^.!?]{0,40}\b(?:${DISEASES})\b`, 'i'),
    message: 'Claims to cure, treat or reverse a disease.',
    fix: 'Keep it to general wellness ("can support", "many people find") and suggest a doctor for conditions.',
    negatable: true,
  },
  {
    rule: 'medical_claims',
    verdict: 'red',
    re: /\b(?:stop|quit|ditch|replace|skip|come off|get off|throw out|swap)\b[^.!?]{0,30}\b(?:medications?|meds|medicine|insulin|antidepressants?|prescriptions?|statins?|chemo(?:therapy)?|treatment|inhalers?)\b/i,
    message: 'Tells people to stop or replace medication or treatment.',
    fix: 'Never advise on medication; suggest talking to their doctor.',
    negatable: true,
  },
  {
    rule: 'medical_claims',
    verdict: 'red',
    re: /\bdry fast(?:ing)?\b|\bwater fast(?:ing)?\s+for\s+(?:[3-9]|\d{2,})\s+days\b|\b(?:[3-9]|\d{2,})[- ]day (?:water )?fast\b|\bdrink(?:ing)?\s+(?:bleach|turpentine|borax|hydrogen peroxide|kerosene|mms)\b|\b[2-7]\d{2}\s*(?:k?cal(?:ories)?)\s*(?:a|per)\s*day\b/i,
    message: 'Promotes a dangerous practice.',
    fix: 'Remove it.',
  },
  {
    rule: 'medical_claims',
    verdict: 'red',
    re: /\b(?:supplements?|pills?|capsules?|powders?|teas?|gummies|drops)\b[^.!?]{0,40}\b(?:burns? (?:\w+ )?fat|melts? (?:\w+ )?fat|boosts? (?:your )?(?:immune system|immunity|metabolism|testosterone)|detox(?:es)?|cures?|prevents? (?:disease|illness|cancer))\b/i,
    message: 'Supplement or efficacy claim without substantiation.',
    fix: 'Cite evidence or remove the efficacy claim.',
    when: (i) => !(i.evidenceIds && i.evidenceIds.length),
    negatable: 'inside',
  },
  // ── Specific securities or crypto calls ──
  {
    rule: 'securities_calls',
    verdict: 'red',
    re: new RegExp(String.raw`\b(?:buy|buying|sell|selling|short|shorting|load up on|loading up on|grab|dump|dumping|go long(?: on)?|all in on|ape into|get into|get in on|hold onto|accumulate|accumulating|stack|stacking|add(?:ing)? (?:more|some)?)\b[^.!?]{0,25}(?:${ASSETS})`, 'i'),
    message: 'Specific buy/sell call on a security or crypto asset.',
    fix: 'Teach how to think about risk; no calls on specific assets.',
    when: (_i, s) => !QUESTION_FRAME.test(s),
    negatable: true,
  },
  {
    rule: 'securities_calls',
    verdict: 'red',
    re: new RegExp(String.raw`(?:${ASSETS})[^.!?]{0,30}\b(?:will|is going to|'s going to|gonna|about to|headed to|heading to)\s+(?:10x|100x|moon|explode|skyrocket|double|triple|pump|(?:hit|reach|touch|break)\s+\$?\d|\$?\d[\d,.]*\s?k\b|\$\d)`, 'i'),
    message: 'Price prediction on a specific asset.',
    fix: 'Remove the prediction.',
    negatable: true,
  },
  {
    rule: 'securities_calls',
    verdict: 'red',
    re: new RegExp(String.raw`(?:${ASSETS})[^.!?]*\b(?:get in (?:now|early|before)|you should too|don'?t miss (?:out|it)|before it (?:moons|pumps|explodes))\b`, 'i'),
    message: 'Specific buy/sell call on a security or crypto asset.',
    fix: 'Teach how to think about risk; no calls on specific assets.',
    when: (_i, s) => !QUESTION_FRAME.test(s),
  },
  {
    rule: 'securities_calls',
    verdict: 'amber',
    re: new RegExp(String.raw`\b(?:buy|sell|short)\b[^.!?]{0,25}(?:${ASSETS})`, 'i'),
    message: 'Buy/sell question about a specific asset: keep it to education, never a call.',
    when: (_i, s) => QUESTION_FRAME.test(s),
  },
  // ── Guaranteed returns or income ──
  {
    rule: 'guaranteed_returns',
    verdict: 'red',
    re: /\bguarantee(?:d|s)?\b[^.!?]{0,30}\b(?:returns?|income|profits?|results?|money|earnings|gains?|payouts?|\d+\s?%)|\b(?:returns?|income|profits?|results?|money|earnings|gains?|payouts?|you'?ll make|will make you)\b[^.!?]{0,20}\bguaranteed\b/i,
    message: 'Guaranteed returns, income or results.',
    fix: 'Remove the guarantee.',
    when: (_i, s) => !/\b(?:not|never|no)\b[^.!?]{0,20}guarantee|n't\s+(?:be\s+)?guaranteed/i.test(s),
    negatable: true,
  },
  {
    rule: 'guaranteed_returns',
    verdict: 'red',
    re: /\b(?:risk[- ]free|no[- ]risk|zero[- ]risk)\b[^.!?]{0,20}\b(?:returns?|investments?|income|profits?|money|gains?)\b|\bdouble your money\b|\bquit your job in \d+\b/i,
    message: 'Risk-free or guaranteed money claim.',
    fix: 'Remove the claim.',
  },
  {
    rule: 'guaranteed_returns',
    verdict: 'red',
    re: /\b(?:make|earn|making|earning|bring in|pull in|generate|clear)\s+(?:an extra\s+|up to\s+|over\s+|at least\s+|easily\s+)?[$£€]\s?\d[\d,.]*\s?(?:k\b|K\b)?[^.!?]{0,20}?(?:\b(?:a|per|every|each)\s+(?:day|week|month|year|hour)\b|\/\s?(?:day|week|month|mo|wk|year|yr|hour|hr)\b)|\b(?:passive income|financial freedom|six figures)\s+(?:in|within)\s+\d+\s+(?:days|weeks|months)\b/i,
    message: 'Income claim ("make $5K a month").',
    fix: 'Talk about the method, not an income figure.',
    negatable: true,
  },
  // ── Undisclosed sponsorships / affiliate links ──
  {
    rule: 'undisclosed_sponsorship',
    verdict: 'red',
    re: /[?&](?:ref|aff|affiliate|tag|via)=|\bamzn\.to\b|\bsponsored by\b|\bpartnered with\b|\bpaid partnership\b|\baffiliate link\b|\bi (?:earn|get) (?:a )?commission\b/i,
    message: 'Sponsorship or affiliate link without a disclosure (#ad or #affiliate).',
    fix: 'Add #ad (or #affiliate) at the start of the caption.',
    when: (i) => !hasDisclosure(i.text),
  },
  // ── Fake scarcity (FR-20.10) ──
  {
    rule: 'fake_scarcity',
    verdict: 'red',
    re: /\b(?:only|just)\s+\d+\s+(?:left|remaining|spots?|copies|seats|available)\b|\b(?:selling out|almost sold out|nearly sold out|sold out fast|going fast|won'?t last|before it'?s gone)\b/i,
    message: 'Fake scarcity: digital products do not run out.',
    fix: 'Remove the scarcity line.',
  },
  {
    rule: 'fake_scarcity',
    verdict: 'red',
    re: /\b\d[\d,]*\+?\s+(?:sold|copies sold|people (?:have )?(?:bought|grabbed|joined|downloaded)|happy (?:customers|buyers))\b/i,
    message: 'Unverified "sold" or social-proof count.',
    fix: 'Remove the count.',
  },
  {
    rule: 'fake_scarcity',
    verdict: 'red',
    re: /\b(?:price (?:goes|is going) up|offer ends|ends (?:tonight|today|soon|at midnight)|last chance|last call|final hours|closing soon|countdown|limited[- ]time|today only|expires (?:tonight|today|soon))\b/i,
    message: 'Deadline language without a real deadline.',
    fix: 'Only mention a deadline that exists (launch price end date).',
    when: (i) => !i.realDeadline,
  },
  // ── Never deny being AI ──
  {
    rule: 'never_deny_ai',
    verdict: 'red',
    re: /\b(?:i'?m|i am)\s+(?:not\s+(?:an?\s+)?(?:ai|a\.i\.|bot|robot|chatbot|artificial|fake|computer)|a real (?:person|human|woman|man|girl|guy)|(?:100%|totally|completely|definitely|really|very much|an actual)\s+(?:real|human|person)|human,? not (?:an? )?(?:ai|bot))\b|\b(?:this is|it'?s|this account is)\s+not\s+(?:an?\s+)?(?:ai|bot)\b|\b(?:this is|i'?m) not ai[- ]generated\b/i,
    message: 'Denies being AI. The persona is an AI creator and says so when asked.',
    fix: "I'm an AI creator from a small studio, and the systems I share are real.",
  },
  // ── Amber: regulated promotions, minors ──
  {
    rule: 'regulated_promotion',
    verdict: 'amber',
    re: /\b(?:sign up|apply|open an account|get approved|switch)\b[^.!?]{0,30}\b(?:credit cards?|loans?|bnpl|buy now,? pay later|brokerage|trading app|crypto exchange|mortgage)\b/i,
    message: 'Promotes a regulated financial product: needs disclosure (FCA financial promotion rules for UK audiences).',
  },
  {
    rule: 'minors',
    verdict: 'amber',
    re: /\b(?:hey kids|for kids|for teens|teenagers|under 18|middle school(?:ers)?|high school(?:ers)?|tweens)\b/i,
    message: 'Looks aimed at under-18s: the studio does not target minors.',
  },
];

const DISCLOSURE_RE = /#ad\b|#affiliate\b|#sponsored\b|#partner\b|\bpaid partnership\b|\b(?:affiliate|sponsored) link\b|\bi (?:earn|get) (?:a )?commission\b|^\s*ad:/im;
export const hasDisclosure = (text: string): boolean => DISCLOSURE_RE.test(text);

const AI_QUESTION_RE =
  /\b(?:are|r)\s+(?:you|u)\s+(?:real|human|a bot|an? ai|ai|a robot|a real person|a person|fake|computer generated|ai generated)\b|\bis (?:this|she|he) (?:an? )?(?:ai|bot|real person|real)\b|\bam i (?:talking|chatting|speaking) (?:to|with) (?:a|an) (?:bot|ai|human|person|real person)\b|\byou(?:'re| are) (?:an? )?(?:ai|bot)\b\?/i;
const AI_CONFIRM_RE = /\b(?:ai|a\.i\.|artificial intelligence|virtual (?:creator|influencer|character)|digital (?:creator|character)|ai[- ](?:generated|creator|character|persona|influencer))\b/i;

/** A sincere "are you AI / a bot / real?" question. */
export const asksIfAi = (text: string): boolean => AI_QUESTION_RE.test(text);

/** The deterministic rule pass. Returns one check per rule family: green when clean, else each finding. */
export function gateRules(input: GateInput): GateCheck[] {
  const found: GateCheck[] = [];
  const parts = sentences(input.text);
  for (const p of PATTERNS) {
    for (const s of parts) {
      const m = s.match(p.re);
      if (!m || (p.when && !p.when(input, s))) continue;
      if (p.negatable && negatedMatch(s, m.index ?? 0, m[0], p.negatable === 'inside')) continue;
      if (found.some((f) => f.rule === p.rule && f.span === s && f.verdict === p.verdict)) continue;
      found.push({ rule: p.rule, verdict: p.verdict, message: p.message, span: s, ...(p.fix ? { fix: p.fix } : {}) });
    }
  }
  // Sponsored/affiliate content must carry a disclosure even without a tell-tale link.
  if ((input.sponsored || input.affiliate) && !hasDisclosure(input.text)) {
    found.push({ rule: 'undisclosed_sponsorship', verdict: 'red', message: 'Sponsored or affiliate content without #ad / #affiliate.', fix: 'Add #ad (or #affiliate) at the start of the caption.' });
  }
  // Replies: a sincere "are you AI?" must be answered with yes.
  if (input.kind === 'reply' && input.incoming && asksIfAi(input.incoming) && !AI_CONFIRM_RE.test(input.text)) {
    found.push({
      rule: 'never_deny_ai',
      verdict: 'red',
      message: 'Asked sincerely whether it is AI: the reply must say it is an AI.',
      span: input.text.slice(0, 200),
      fix: "Yes, I'm an AI creator from a small studio. The tips are real and free to use.",
    });
  }
  // A real deadline in the plan makes deadline language fine: say so explicitly.
  if (input.realDeadline) {
    found.push({ rule: 'fake_scarcity', verdict: 'green', message: `Real deadline on ${input.realDeadline.toISOString().slice(0, 10)}: deadline language allowed.` });
  }
  const checks: GateCheck[] = [];
  for (const rule of GATE_RULES) {
    const hits = found.filter((f) => f.rule === rule && f.verdict !== 'green');
    if (hits.length) checks.push(...hits);
    else if (rule !== 'ai_flag') checks.push(found.find((f) => f.rule === rule) ?? { rule, verdict: 'green', message: 'Clear.' });
  }
  return checks;
}

const RANK: Record<GateVerdict, number> = { green: 0, amber: 1, red: 2 };
export function verdictOf(checks: readonly GateCheck[]): GateVerdict {
  return checks.reduce<GateVerdict>((v, c) => (RANK[c.verdict] > RANK[v] ? c.verdict : v), 'green');
}

/** The model's second opinion: it may add amber/red findings, never clear a rule finding. */
interface ModelFinding {
  rule: string;
  verdict: 'amber' | 'red';
  message: string;
  span?: string;
}
const MODEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rule', 'verdict', 'message'],
        properties: {
          rule: { type: 'string', enum: [...GATE_RULES] },
          verdict: { type: 'string', enum: ['amber', 'red'] },
          message: { type: 'string' },
          span: { type: 'string' },
        },
      },
    },
  },
} as const;

function parseFindings(v: unknown): { findings: ModelFinding[] } {
  const f = (v as { findings?: unknown })?.findings;
  if (!Array.isArray(f)) throw new Error('expected { findings: [] }');
  const findings = f
    .filter((x): x is ModelFinding => !!x && typeof x === 'object' && typeof (x as ModelFinding).rule === 'string' && ['amber', 'red'].includes((x as ModelFinding).verdict))
    .map((x) => ({ rule: x.rule, verdict: x.verdict, message: String(x.message ?? '').slice(0, 300), ...(x.span ? { span: String(x.span).slice(0, 300) } : {}) }));
  return { findings };
}

const GATE_SYSTEM = `You are the Compliance Gate: an independent reviewer no manager controls. Check the content against the legal and
platform lines in the studio rules only. Opinions, strong takes and general education pass. Report only clear violations the rule
pass may have missed (paraphrases, implied claims). Never soften; never approve. Return {"findings": []} when nothing is wrong.`;

export interface GateRun {
  readonly verdict: GateVerdict;
  readonly checks: GateCheck[];
  readonly runId: string | null;
}

/** Rules + (live) model second opinion. */
export async function runGate(
  services: StudioServices,
  args: { studioId: string; personaId: string; input: GateInput; cached?: readonly { key: string; text: string }[]; costRef?: CostRef; label?: string; model?: boolean },
): Promise<GateRun> {
  const checks = gateRules(args.input);
  if (args.input.kind !== 'reply' && args.input.kind !== 'post') {
    checks.push({ rule: 'ai_flag', verdict: 'green', message: 'The post-level platform AI flag is required and is set at publish.' });
  }
  let runId: string | null = null;
  if (args.model !== false) {
    const res = await services.runtime.run<{ findings: ModelFinding[] }>({
      agent: 'compliance-gate',
      scope: { studioId: args.studioId, personaId: args.personaId },
      label: args.label ?? `gate: ${args.input.kind}`,
      system: GATE_SYSTEM,
      cached: args.cached?.slice(0, 1),
      skills: ['compliance-gate-checklist'],
      prompt: `Kind: ${args.input.kind}${args.input.purpose ? ` (${args.input.purpose} post)` : ''}${args.input.incoming ? `\nIncoming message: ${args.input.incoming}` : ''}\n---\n${args.input.text}`,
      maxTokens: 2000,
      jsonSchema: MODEL_SCHEMA,
      parse: parseFindings,
      fake: () => ({ findings: [] }),
      costRef: args.costRef,
    });
    runId = res.runId;
    for (const f of res.output.findings) {
      if (!checks.some((c) => c.rule === f.rule && c.span === f.span && c.verdict === f.verdict)) {
        checks.push({ rule: 'model_review', verdict: f.verdict, message: `${f.rule}: ${f.message}`, ...(f.span ? { span: f.span } : {}) });
      }
    }
  }
  return { verdict: verdictOf(checks), checks, runId };
}

export async function saveGateResult(
  services: StudioServices,
  r: { personaId: string; subjectType: 'script' | 'asset' | 'post' | 'product' | 'reply'; subjectId: string; stage: 'pre_render' | 'pre_publish'; verdict: GateVerdict; checks: readonly GateCheck[] },
): Promise<string> {
  const row = await services.db.one<{ id: string }>(
    `INSERT INTO gate_result (persona_id, subject_type, subject_id, stage, verdict, checks) VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
    [r.personaId, r.subjectType, r.subjectId, r.stage, r.verdict, json(r.checks)],
  );
  return row.id;
}

/**
 * The Gate on a community reply (subject_type 'reply'). Never denying being AI is a red rule. `subjectId` is the
 * comment or DM id being answered (a fresh id is generated when there is none).
 */
export async function gateReply(
  services: StudioServices,
  args: { studioId: string; personaId: string; incoming: string; reply: string; subjectId?: string; model?: boolean },
): Promise<GateRun & { gateResultId: string }> {
  const run = await runGate(services, {
    studioId: args.studioId,
    personaId: args.personaId,
    input: { kind: 'reply', text: args.reply, incoming: args.incoming },
    costRef: { type: 'persona', id: args.personaId },
    label: 'gate: reply',
    model: args.model,
  });
  const subjectId = args.subjectId ?? (await services.db.one<{ id: string }>('SELECT gen_random_uuid() AS id')).id;
  const gateResultId = await saveGateResult(services, { personaId: args.personaId, subjectType: 'reply', subjectId, stage: 'pre_publish', verdict: run.verdict, checks: run.checks });
  return { ...run, gateResultId };
}

/**
 * Pre-publish Gate on a post row: caption rules, the post-level AI flag (red when off) and the platform's AI
 * profile label on the account (amber when off: the platform minimum).
 */
export async function gatePost(services: StudioServices, postId: string, opts: { model?: boolean } = {}): Promise<GateRun & { gateResultId: string }> {
  const post = await services.db.one<{ persona_id: string; studio_id: string; caption: string | null; ai_flag: boolean; handle: string | null; ai_label_ok: boolean | null; account_status: string | null }>(
    `SELECT p.persona_id, pe.studio_id, p.caption, p.ai_flag, a.handle, a.ai_label_ok, a.status AS account_status
       FROM post p JOIN persona pe ON pe.id = p.persona_id LEFT JOIN account a ON a.id = p.account_id WHERE p.id = $1`,
    [postId],
  );
  const run = await runGate(services, {
    studioId: post.studio_id,
    personaId: post.persona_id,
    input: { kind: 'post', text: post.caption ?? '' },
    costRef: { type: 'post', id: postId },
    label: 'gate: post',
    model: opts.model,
  });
  const checks = [...run.checks];
  checks.push(
    post.ai_flag
      ? { rule: 'ai_flag', verdict: 'green', message: 'Post-level AI flag is on.' }
      : { rule: 'ai_flag', verdict: 'red', message: 'Post-level AI flag is off: every post carries the platform AI label.', fix: 'Set the AI flag.' },
  );
  if (post.handle && post.ai_label_ok === false) {
    checks.push({ rule: 'ai_profile_label', verdict: 'amber', message: `Switch on the platform's AI profile label for @${post.handle} (platform minimum).` });
  }
  const verdict = verdictOf(checks);
  const gateResultId = await saveGateResult(services, { personaId: post.persona_id, subjectType: 'post', subjectId: postId, stage: 'pre_publish', verdict, checks });
  return { verdict, checks, runId: run.runId, gateResultId };
}
