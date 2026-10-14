import type { PostFormat, Platform } from '@ios/core';

/**
 * Profit Engine read models (PRD §3.11, FR-24). Stream D owns and implements them; the Money page, the Profit card
 * and the `profit.*` tools the Studio Manager calls all return these shapes. Change them only additively.
 * Money is integer cents; LLM/media spend comes from the ledger in USD and Higgsfield credits are converted with
 * the studio's credit price (stream D's setting), so every row has one comparable cost in cents.
 */

export type PnlGrain = 'post' | 'persona' | 'format' | 'product' | 'platform';

export interface PnlQuery {
  studioId: string;
  /** Inclusive start, exclusive end. */
  from: Date;
  to: Date;
  grain: PnlGrain;
  personaId?: string;
}

export interface PnlRow {
  grain: PnlGrain;
  /** post id, persona id, format, product id or platform. */
  key: string;
  label: string;
  personaId: string | null;
  format?: PostFormat;
  platform?: Platform;
  /**
   * Gross sales attributed (orders.source_post_id, coupon, short link). On post, format and platform rows this
   * includes `allocatedRevenueCents`: the persona's unattributed sales spread over its posts by views.
   */
  revenueCents: number;
  /** Part of `revenueCents` allocated by views rather than attributed to the post directly. */
  allocatedRevenueCents?: number;
  feesCents: number;
  refundsCents: number;
  /** LLM + media USD + Higgsfield credits at the credit price, from credit_ledger debits by ref. */
  costCents: number;
  costBreakdown: { llmCents: number; mediaCents: number; creditsCents: number; hfCredits: number };
  profitCents: number;
  posts: number;
  views: number;
  /** Net revenue (gross − fees − refunds) per post published in the window. */
  revenuePerPostCents: number;
  costPerPostCents: number;
  /** Revenue per 1,000 views. */
  rpmCents: number;
}

export type LeverKind = 'cadence' | 'credit_reallocation' | 'format_mix' | 'model_routing';

export interface LeverAction {
  id: string;
  studioId: string;
  personaId: string | null;
  lever: LeverKind;
  /** Settings before and after, e.g. { postsPerWeek: 10 } → { postsPerWeek: 14 }. */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  rationale: string;
  /** Expected monthly profit change, cents. */
  expectedImpactCents: number;
  /** Measured after the review window; null until then. */
  measuredImpactCents: number | null;
  status: 'applied' | 'measured' | 'reverted';
  createdAt: Date;
  measuredAt: Date | null;
}

export interface ForecastBand {
  p10: number;
  median: number;
  p90: number;
}

export interface Forecast {
  /** null = studio total. */
  personaId: string | null;
  horizonDays: 90;
  runs: number;
  /** Weekly profit in cents. */
  weekly: Array<{ weekStart: string } & ForecastBand>;
  totalCents: ForecastBand;
  /** Consecutive forecast weeks with a negative median, from the next week. 4+ = kill candidate. */
  negativeWeeks: number;
  generatedAt: Date;
  /** Profit from tomorrow to the end of the current month, cents (for "this month vs forecast"). */
  monthRemainderCents?: ForecastBand;
  /** Full weeks of history the model was fitted on. */
  weeksOfHistory?: number;
}

export interface ProfitAction {
  rank: number;
  title: string;
  personaId: string | null;
  kind: LeverKind | 'kill_candidate' | 'cap_raise' | 'price_test' | 'product' | 'other';
  /** Expected monthly profit impact, cents. */
  expectedImpactCents: number;
  confidence: 'low' | 'medium' | 'high';
  /** True when the Owner must approve it (kill/retire, cap raises, plan upgrades, prices outside the band). */
  requiresOwner: boolean;
  rationale: string;
}

/** The Profit card on the Studio wall. */
export interface ProfitCardData {
  /** YYYY-MM */
  month: string;
  /** Month-to-date profit, cents. */
  profitCents: number;
  /** Whole-month profit forecast: month to date plus the forecast for the rest of the month. */
  forecastCents: ForecastBand;
  topLevers: LeverAction[];
  opportunities: ProfitAction[];
}

/** Totals of a P&L view (every grain of the same window sums to the same totals). */
export interface PnlTotals {
  revenueCents: number;
  feesCents: number;
  refundsCents: number;
  costCents: number;
  profitCents: number;
  posts: number;
  views: number;
}
