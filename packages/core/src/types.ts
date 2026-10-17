export const PERSONA_STATES = [
  'PROPOSED',
  'SETUP',
  'TESTING',
  'MONETISING',
  'RE_ANGLE',
  'KILLED',
  'SCALING',
  'BRAND',
  'RETIRED',
  /** (16 Oct) Soft archive: every row kept, nothing runs; restoring returns to `archived_from_state`. */
  'ARCHIVED',
] as const;
export type PersonaState = (typeof PERSONA_STATES)[number];

export type Autonomy = 'L0' | 'L1' | 'L2';
export type Platform = 'tiktok' | 'instagram' | 'youtube' | 'pinterest';
export const PLATFORMS: readonly Platform[] = ['tiktok', 'instagram', 'youtube', 'pinterest'];
/** The five weekly-mix formats (PRD §3.3); the cadence mix always covers these. */
export type CoreFormat = 'talking' | 'activity_text' | 'voiceover' | 'static' | 'carousel';
/**
 * Optional formats from the format library (PRD §3.12 step 4, FR-4.3c), switched on per persona by its Format Plan
 * (IOS-5 stream L) or, until that lands, per week in studio settings.formats:
 * - "product_in_hand": the persona holding our own product, from its cover as a second reference, for sell slots;
 * - "trend_reenactment": a reference movement clip drives the character (Kling 3.0 motion transfer, motion only);
 * - (IOS-5) "photo_dump": 5–10 casual "camera roll" stills from the week, an IG carousel (4:5 or 1:1);
 * - (IOS-5) "text_note": a text-on-image note / quote card (static);
 * - (IOS-5) "facecam_screen": the persona in a corner over a generated screen recording or slides;
 * - (IOS-5) "reply_comment": a talking or text answer to a top comment, the comment shown as a sticker-like overlay
 *   with the commenter's handle anonymised;
 * - (IOS-5) "news_greenscreen": the persona over a News Desk headline card (never a real outlet's logo);
 * - (IOS-5) "meme": a relatable text post.
 * The IOS-5 values and their CHECK constraints (migration 0016) landed with docs/IOS-5-CONTRACTS.md: stream L owns
 * what they mean in the plan (Format Plan, cadence, calendar); stream K builds their renderers, scripts and QC.
 */
export type OptionalFormat =
  | 'product_in_hand'
  | 'trend_reenactment'
  | 'photo_dump'
  | 'text_note'
  | 'facecam_screen'
  | 'reply_comment'
  | 'news_greenscreen'
  | 'meme';
export type PostFormat = CoreFormat | OptionalFormat;
export const CORE_FORMATS: readonly CoreFormat[] = ['talking', 'activity_text', 'voiceover', 'static', 'carousel'];
export const OPTIONAL_FORMATS: readonly OptionalFormat[] = [
  'product_in_hand',
  'trend_reenactment',
  'photo_dump',
  'text_note',
  'facecam_screen',
  'reply_comment',
  'news_greenscreen',
  'meme',
];
export const POST_FORMATS: readonly PostFormat[] = [...CORE_FORMATS, ...OPTIONAL_FORMATS];
/** Formats written and cut like an activity + on-screen text loop: no voice, on-screen lines carry the post. */
export const TEXT_LOOP_FORMATS: readonly PostFormat[] = ['activity_text', 'product_in_hand', 'trend_reenactment'];
/**
 * The core format each post is written as (its script shape): the base the Scriptwriter, Q1 and the board fall back
 * to until stream K gives a format its own script rules. Talking-shaped formats are spoken; static-shaped ones are
 * a single image line; carousel-shaped ones are slides.
 */
export const FORMAT_SHAPE: Readonly<Record<PostFormat, CoreFormat>> = {
  talking: 'talking',
  activity_text: 'activity_text',
  voiceover: 'voiceover',
  static: 'static',
  carousel: 'carousel',
  product_in_hand: 'activity_text',
  trend_reenactment: 'activity_text',
  photo_dump: 'carousel',
  text_note: 'static',
  facecam_screen: 'talking',
  reply_comment: 'talking',
  news_greenscreen: 'talking',
  meme: 'static',
};
/** The core format a post is written as (see FORMAT_SHAPE). */
export const scriptShape = (f: PostFormat): CoreFormat => FORMAT_SHAPE[f] ?? 'activity_text';
export const isOptionalFormat = (f: string): f is OptionalFormat => (OPTIONAL_FORMATS as readonly string[]).includes(f);
export type PostPurpose = 'reach' | 'trust' | 'sell';
export type GateVerdict = 'green' | 'amber' | 'red';

export interface Actor {
  readonly type: 'owner' | 'agent' | 'system';
  readonly id: string;
}
export const actorRef = (a: Actor): string => `${a.type}:${a.id}`;
export const OWNER: Actor = { type: 'owner', id: 'hossam' };
export const STUDIO_MANAGER: Actor = { type: 'agent', id: 'studio-manager' };
export const SYSTEM: Actor = { type: 'system', id: 'core' };

/**
 * What a ledger entry paid for (credit_ledger.ref_type / ref_id), so the Profit Engine can build per-post,
 * per-product and per-persona P&L (FR-24.1). Content work for a calendar slot (idea, script, QC, Gate, media)
 * uses the slot id; the slot links to its post once one exists. See docs/IOS-2-CONTRACTS.md §5.
 */
export type CostRefType = 'calendar_slot' | 'post' | 'product' | 'knowledge' | 'news' | 'chat_thread' | 'persona' | 'studio';
export interface CostRef {
  readonly type: CostRefType;
  readonly id: string;
}

export interface Caps {
  /** Monthly LLM spend cap, USD. */
  llm_usd_month: number;
  /** Monthly Higgsfield credit cap. */
  hf_credits_month: number;
}

export interface StudioSettings {
  caps: Caps;
  persona_default_caps: Caps;
  /** Alert threshold as a fraction of a cap (0.8 = 80%). Work is refused at 100%. */
  alert_threshold: number;
  approvals: {
    /** Persona launch and product v1 cards auto-approve after `auto_approve_hours` (pilot default: on). */
    auto_approve_cards: boolean;
    auto_approve_hours: number;
    /** L1/L2 posts publish after QC + Gate unless vetoed within this window. */
    post_veto_window_minutes: number;
  };
  default_autonomy: Autonomy;
  /**
   * Optional bio line. The platform minimum is what's required: post-level AI flags, the platform's AI profile
   * label, and never denying being AI when asked. Changing this text still needs the Owner (§3.7).
   */
  disclosure_text: string;
  /** Compliance Gate rule config: legal/platform lines only. Opinions and general education pass. */
  gate: { block: string[]; pass: string[] };
  /**
   * (16 Oct) Optional formats, per persona per week (0 = off). product_in_hand takes sell slots that carry a product;
   * trend_reenactment takes reach slots booked from a trend idea with a reference clip.
   */
  formats: Record<OptionalFormat, number>;
  /**
   * (IOS-5) Weekly cap on Apify scraping spend (USD, trailing 7 days, every actor run: Growth Radar, Winner Finder,
   * Pinterest fallback, market scans). Owner-only like every cap; enforced by `meteredApify` in @troupe/agents.
   */
  apify_weekly_cap_usd: number;
}

export const DEFAULT_SETTINGS: StudioSettings = {
  caps: { llm_usd_month: 300, hf_credits_month: 8000 },
  persona_default_caps: { llm_usd_month: 40, hf_credits_month: 1200 },
  alert_threshold: 0.8,
  approvals: { auto_approve_cards: true, auto_approve_hours: 24, post_veto_window_minutes: 120 },
  default_autonomy: 'L1',
  disclosure_text: '',
  gate: {
    // PRD §3.4 (relaxed 16 Oct): only these lines block. First-person stories, situations and lore pass.
    block: [
      'A story used as proof that a product or service works ("this workbook got me over him", "I made $5K with this")',
      'Real people or brands without permission (celebrity or brand endorsements)',
      'Undisclosed sponsorships or affiliate links',
      'Fake credentials',
      'Disease-cure claims',
      'Dangerous medical advice',
      'Specific securities or crypto buy/sell calls',
      'Guaranteed returns or income claims',
      'Missing post-level AI flag',
      'Denying being AI when asked',
    ],
    pass: ['Opinions', 'General education', 'First-person stories and situations ("my date stood me up tonight", "day 12 of my no-buy")', 'Dramatised scenarios and character lore'],
  },
  formats: { product_in_hand: 0, trend_reenactment: 0, photo_dump: 0, text_note: 0, facecam_screen: 0, reply_comment: 0, news_greenscreen: 0, meme: 0 },
  apify_weekly_cap_usd: 10,
};

export interface PersonaRow {
  id: string;
  studio_id: string;
  slug: string;
  name: string;
  niche: string;
  sub_niche: string | null;
  state: PersonaState;
  autonomy: Autonomy;
  budget: Partial<Caps>;
  portrait_url: string | null;
  look_pack: Array<{ label: string; url: string }>;
  accent_color: string | null;
  timezone: string;
  current_bible_version: number | null;
  launched_at: Date | null;
  state_changed_at: Date;
  created_at: Date;
  /** (16 Oct) Set while the persona is ARCHIVED. */
  archived_at?: Date | null;
  archived_from_state?: PersonaState | null;
  archive_reason?: string | null;
}

export type ApprovalKind =
  | 'persona_kill'
  | 'persona_retire'
  | 'spend_over_cap'
  | 'plan_upgrade'
  | 'disclosure_change'
  | 'legal_text_change'
  | 'persona_launch'
  | 'product_v1'
  | 'post'
  /** (IOS-4 fix) Publish a post whose QC failed on majors only, with the Owner's reason. Owner-only. */
  | 'qc_override'
  /** (16 Oct) An agent's proposal to archive a persona that has launched. Owner-only. */
  | 'persona_archive';
export type ApprovalMode = 'explicit' | 'auto_after' | 'veto_window';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'auto_approved' | 'withdrawn';

export interface ApprovalRow {
  id: string;
  studio_id: string;
  persona_id: string | null;
  kind: ApprovalKind;
  mode: ApprovalMode;
  status: ApprovalStatus;
  title: string;
  summary: string | null;
  payload: Record<string, unknown>;
  subject_type: string | null;
  subject_id: string | null;
  proposed_by: string;
  auto_approve_at: Date | null;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  executed_at: Date | null;
  execution_result: unknown;
  created_at: Date;
}
