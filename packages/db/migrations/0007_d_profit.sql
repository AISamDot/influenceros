-- 0007 (IOS-2 stream D): Profit Engine v1 (PRD §3.11, FR-24) and the scheduler behind the cron tick.
-- Only references objects from 0001–0003 and this file (docs/IOS-2-CONTRACTS.md §6).

-- ───────────────────────────── Profit Engine settings ─────────────────────────────

-- Per-studio Profit Engine settings (credit price, lever thresholds). Missing keys fall back to code defaults.
CREATE TABLE profit_setting (
  studio_id   uuid PRIMARY KEY REFERENCES studio(id),
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── Lever log ─────────────────────────────

-- Every automatic lever action, with its expected impact and (after the review window) its measured impact.
CREATE TABLE profit_lever_action (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id              uuid NOT NULL REFERENCES studio(id),
  persona_id             uuid REFERENCES persona(id),          -- null = studio-wide (e.g. credit reallocation)
  lever                  text NOT NULL CHECK (lever IN ('cadence','credit_reallocation','format_mix','model_routing')),
  before                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  after                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  rationale              text NOT NULL,
  expected_impact_cents  integer NOT NULL DEFAULT 0,           -- expected monthly profit change
  measured_impact_cents  integer,                              -- null until measured
  status                 text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','measured','reverted')),
  review_at              timestamptz NOT NULL,                 -- when the impact is measured
  meta                   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- baseline, window, inputs
  created_at             timestamptz NOT NULL DEFAULT now(),
  measured_at            timestamptz
);
CREATE INDEX profit_lever_action_studio_idx ON profit_lever_action (studio_id, created_at DESC);
CREATE INDEX profit_lever_action_persona_idx ON profit_lever_action (persona_id, lever, created_at DESC);
CREATE INDEX profit_lever_action_review_idx ON profit_lever_action (status, review_at);

-- ───────────────────────────── Policy overrides (read by B's calendar and A's runtime) ─────────────────────────────

-- Cadence and format-mix targets per persona, effective from a Monday. The latest row effective for a week wins
-- (by effective_from, then insertion order: the cadence and format levers can write the same week in one cycle).
CREATE TABLE profit_cadence_override (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq              bigint GENERATED ALWAYS AS IDENTITY,
  studio_id        uuid NOT NULL REFERENCES studio(id),
  persona_id       uuid NOT NULL REFERENCES persona(id),
  effective_from   date NOT NULL,
  posts_per_week   integer NOT NULL CHECK (posts_per_week BETWEEN 7 AND 21),
  format_mix       jsonb NOT NULL,
  purpose_mix      jsonb NOT NULL,
  source           text NOT NULL DEFAULT 'lever' CHECK (source IN ('lever','owner')),
  reason           text,
  lever_action_id  uuid REFERENCES profit_lever_action(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profit_cadence_override_persona_idx ON profit_cadence_override (persona_id, effective_from DESC, seq DESC);

-- Model-routing overrides: tier changes only (per persona, or studio-wide when persona_id is null).
CREATE TABLE profit_routing_override (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id        uuid NOT NULL REFERENCES studio(id),
  persona_id       uuid REFERENCES persona(id),
  agent            text NOT NULL,
  tier             text NOT NULL CHECK (tier IN ('fast','standard','strong')),
  active           boolean NOT NULL DEFAULT true,
  reason           text,
  lever_action_id  uuid REFERENCES profit_lever_action(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz
);
CREATE UNIQUE INDEX profit_routing_override_one_active_idx
  ON profit_routing_override (studio_id, COALESCE(persona_id::text, ''), agent) WHERE active;

-- ───────────────────────────── Forecasts and reports ─────────────────────────────

-- 90-day Monte Carlo profit forecast, one per scope per week (persona_id null = studio total).
CREATE TABLE profit_forecast (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id        uuid NOT NULL REFERENCES studio(id),
  persona_id       uuid REFERENCES persona(id),
  week_start       date NOT NULL,
  horizon_days     integer NOT NULL DEFAULT 90,
  runs             integer NOT NULL,
  weekly           jsonb NOT NULL DEFAULT '[]'::jsonb,        -- [{weekStart, p10, median, p90}] in cents
  total            jsonb NOT NULL,                            -- {p10, median, p90} in cents
  month_remainder  jsonb,                                     -- rest of the current month, {p10, median, p90}
  negative_weeks   integer NOT NULL DEFAULT 0,
  inputs           jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX profit_forecast_scope_week_idx ON profit_forecast (studio_id, COALESCE(persona_id::text, ''), week_start);

-- One Weekly Profit Report per studio per week (posted into the Studio chat).
CREATE TABLE profit_report (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id   uuid NOT NULL REFERENCES studio(id),
  week_start  date NOT NULL,
  message_id  uuid REFERENCES chat_message(id),
  body        text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (studio_id, week_start)
);

-- ───────────────────────────── Scheduler ─────────────────────────────

-- Last successful run per scheduled task, plus a short claim so overlapping ticks (Vercel Cron + the Mac) don't
-- run the same task twice.
CREATE TABLE scheduler_run (
  name           text PRIMARY KEY,
  last_run_at    timestamptz,
  last_status    text CHECK (last_status IN ('ok','error')),
  last_error     text,
  runs           integer NOT NULL DEFAULT 0,
  failures       integer NOT NULL DEFAULT 0,
  claimed_until  timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── Tables D may alter ─────────────────────────────

-- Weekly credit/LLM allocation written by the credit-reallocation lever (one row per scope per week).
ALTER TABLE budget_allocation ADD COLUMN source text NOT NULL DEFAULT 'owner' CHECK (source IN ('owner','lever'));
ALTER TABLE budget_allocation ADD COLUMN score numeric(14,4);
ALTER TABLE budget_allocation ADD COLUMN lever_action_id uuid REFERENCES profit_lever_action(id);
CREATE UNIQUE INDEX budget_allocation_scope_week_idx ON budget_allocation (studio_id, COALESCE(persona_id::text, ''), week_start);

-- P&L reads the ledger by attribution and by time.
CREATE INDEX credit_ledger_ref_idx ON credit_ledger (ref_type, ref_id);
CREATE INDEX credit_ledger_created_idx ON credit_ledger (studio_id, created_at);
