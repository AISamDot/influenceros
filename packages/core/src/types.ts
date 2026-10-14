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
] as const;
export type PersonaState = (typeof PERSONA_STATES)[number];

export type Autonomy = 'L0' | 'L1' | 'L2';
export type Platform = 'tiktok' | 'instagram' | 'youtube' | 'pinterest';
export const PLATFORMS: readonly Platform[] = ['tiktok', 'instagram', 'youtube', 'pinterest'];
export type PostFormat = 'talking' | 'activity_text' | 'voiceover' | 'static' | 'carousel';
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
}

export const DEFAULT_SETTINGS: StudioSettings = {
  caps: { llm_usd_month: 300, hf_credits_month: 8000 },
  persona_default_caps: { llm_usd_month: 40, hf_credits_month: 1200 },
  alert_threshold: 0.8,
  approvals: { auto_approve_cards: true, auto_approve_hours: 24, post_veto_window_minutes: 120 },
  default_autonomy: 'L1',
  disclosure_text: '',
  gate: {
    block: [
      'Disease-cure claims',
      'Dangerous medical advice',
      'Specific securities or crypto buy/sell calls',
      'Guaranteed returns or income claims',
      'Fabricated results used to sell',
      'Fake credentials',
      'Undisclosed sponsorships or affiliate links',
      'Denying being AI when asked',
      'Missing post-level AI flag',
    ],
    pass: ['Opinions', 'General education'],
  },
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
  | 'post';
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
