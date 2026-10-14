-- Influencer OS: initial schema (PRD §8.3). Plain Postgres; runs on Supabase and on PGlite.
-- Every persona-scoped table carries persona_id. JSONB is used where shapes will evolve.

-- ───────────────────────────── Studio and personas ─────────────────────────────

CREATE TABLE studio (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE persona (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id              uuid NOT NULL REFERENCES studio(id),
  slug                   text NOT NULL,
  name                   text NOT NULL,
  niche                  text NOT NULL,
  sub_niche              text,
  state                  text NOT NULL DEFAULT 'PROPOSED' CHECK (state IN
                           ('PROPOSED','SETUP','TESTING','MONETISING','RE_ANGLE','KILLED','SCALING','BRAND','RETIRED')),
  autonomy               text NOT NULL DEFAULT 'L0' CHECK (autonomy IN ('L0','L1','L2')),
  budget                 jsonb NOT NULL DEFAULT '{}'::jsonb,   -- per-persona monthly caps
  portrait_url           text,
  look_pack              jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{label, url}]
  accent_color           text,
  timezone               text NOT NULL DEFAULT 'UTC',
  current_bible_version  integer,
  launched_at            timestamptz,
  state_changed_at       timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (studio_id, slug)
);

CREATE TABLE persona_bible (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id   uuid NOT NULL REFERENCES persona(id),
  version      integer NOT NULL,
  content      jsonb NOT NULL,                                 -- Appendix A sections
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','superseded')),
  created_by   text NOT NULL,
  approved_by  text,
  approved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (persona_id, version)
);

CREATE TABLE persona_state_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id   uuid NOT NULL REFERENCES persona(id),
  from_state   text,
  to_state     text NOT NULL,
  actor_type   text NOT NULL CHECK (actor_type IN ('owner','agent','system')),
  actor_id     text NOT NULL,
  reason       text,
  approval_id  uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX persona_state_log_persona_idx ON persona_state_log (persona_id, created_at);

CREATE TABLE account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id    uuid NOT NULL REFERENCES persona(id),
  platform      text NOT NULL CHECK (platform IN ('tiktok','instagram','youtube','pinterest','email','store')),
  handle        text NOT NULL,
  token_ref     text,                                          -- vault reference, never the token
  ai_label_ok   boolean NOT NULL DEFAULT false,               -- platform AI profile label is switched on
  two_fa_owner  text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','paused','banned','retired')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, handle)
);
CREATE INDEX account_persona_idx ON account (persona_id);

-- ───────────────────────────── Agent memory ─────────────────────────────

CREATE TABLE playbook_rule (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id   uuid NOT NULL REFERENCES studio(id),
  persona_id  uuid REFERENCES persona(id),                     -- null for studio-scope rules
  scope       text NOT NULL CHECK (scope IN ('persona','studio')),
  rule        text NOT NULL,
  evidence    jsonb NOT NULL DEFAULT '[]'::jsonb,
  source      text NOT NULL CHECK (source IN ('data','feedback')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('proposed','active','retired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'persona') = (persona_id IS NOT NULL))
);

CREATE TABLE feedback (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id      uuid REFERENCES persona(id),
  text            text NOT NULL,
  class           text CHECK (class IN ('one_off','persona_rule','strategy','studio')),
  applied_change  jsonb,
  effect          jsonb,
  status          text NOT NULL DEFAULT 'received' CHECK (status IN ('received','proposed','applied','rejected')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE decision (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id   uuid NOT NULL REFERENCES studio(id),
  persona_id  uuid REFERENCES persona(id),
  agent       text NOT NULL,
  summary     text NOT NULL,
  rationale   text,
  outcome     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id    uuid NOT NULL REFERENCES persona(id),
  kind          text NOT NULL CHECK (kind IN ('timeline','product_roadmap','experiments','season')),
  version       integer NOT NULL DEFAULT 1,
  period_start  date,
  period_end    date,
  content       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── Content ─────────────────────────────

CREATE TABLE idea (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id    uuid NOT NULL REFERENCES persona(id),
  title         text NOT NULL,
  pillar        text,
  format        text CHECK (format IN ('talking','activity_text','voiceover','static','carousel')),
  purpose       text CHECK (purpose IN ('reach','trust','sell')),
  hook_options  jsonb NOT NULL DEFAULT '[]'::jsonb,
  source        jsonb,
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new','scripted','dropped')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE script (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id   uuid NOT NULL REFERENCES persona(id),
  idea_id      uuid REFERENCES idea(id),
  version      integer NOT NULL DEFAULT 1,
  hooks        jsonb NOT NULL DEFAULT '[]'::jsonb,
  body         text NOT NULL,
  caption      text,
  cta_keyword  text,
  hashtags     text[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','qc','gate','approved','rejected')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE calendar_slot (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id     uuid NOT NULL REFERENCES persona(id),
  slot_at        timestamptz NOT NULL,
  format         text NOT NULL CHECK (format IN ('talking','activity_text','voiceover','static','carousel')),
  purpose        text NOT NULL CHECK (purpose IN ('reach','trust','sell')),
  pillar         text,
  title          text NOT NULL,
  status         text NOT NULL DEFAULT 'planned'
                   CHECK (status IN ('planned','scripted','rendering','qc','scheduled','live','skipped')),
  idea_id        uuid REFERENCES idea(id),
  post_id        uuid,
  thumbnail_url  text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calendar_slot_persona_idx ON calendar_slot (persona_id, slot_at);

CREATE TABLE asset (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id   uuid NOT NULL REFERENCES persona(id),
  script_id    uuid REFERENCES script(id),
  type         text NOT NULL CHECK (type IN ('image','video','audio','carousel','thumbnail','document')),
  url          text NOT NULL,
  provider     text,
  credit_cost  integer NOT NULL DEFAULT 0,
  usd_cost     numeric(12,4) NOT NULL DEFAULT 0,
  render_meta  jsonb NOT NULL DEFAULT '{}'::jsonb,
  phash        text,                                           -- originality ledger
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_persona_idx ON asset (persona_id);

CREATE TABLE gate_result (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id    uuid NOT NULL REFERENCES persona(id),
  subject_type  text NOT NULL CHECK (subject_type IN ('script','asset','post','product','reply')),
  subject_id    uuid NOT NULL,
  stage         text NOT NULL CHECK (stage IN ('pre_render','pre_publish')),
  verdict       text NOT NULL CHECK (verdict IN ('green','amber','red')),
  checks        jsonb NOT NULL DEFAULT '[]'::jsonb,
  released_by   text,                                          -- only the Owner can release a red
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gate_result_subject_idx ON gate_result (subject_type, subject_id, created_at);

CREATE TABLE qc_standard (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id   uuid NOT NULL REFERENCES studio(id),
  version     integer NOT NULL,
  rules       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (studio_id, version)
);

CREATE TABLE qc_report (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id    uuid NOT NULL REFERENCES persona(id),
  subject_type  text NOT NULL CHECK (subject_type IN ('script','asset','post','product')),
  subject_id    uuid NOT NULL,
  stage         text NOT NULL CHECK (stage IN ('Q1','Q2','Q3','Q4','QP')),
  score         numeric(5,2),
  pass          boolean NOT NULL,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX qc_report_subject_idx ON qc_report (subject_type, subject_id, created_at);

CREATE TABLE qc_defect (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qc_report_id    uuid NOT NULL REFERENCES qc_report(id),
  persona_id      uuid NOT NULL REFERENCES persona(id),
  type            text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('blocker','major','minor')),
  location        text,                                        -- timestamp or page
  frame_grab_url  text,
  fix_action      text,
  fixed_by        text,
  fixed_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE post (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id        uuid NOT NULL REFERENCES persona(id),
  account_id        uuid REFERENCES account(id),
  calendar_slot_id  uuid REFERENCES calendar_slot(id),
  script_id         uuid REFERENCES script(id),
  platform          text NOT NULL CHECK (platform IN ('tiktok','instagram','youtube','pinterest')),
  format            text NOT NULL CHECK (format IN ('talking','activity_text','voiceover','static','carousel')),
  caption           text,
  media             jsonb NOT NULL DEFAULT '[]'::jsonb,
  thumbnail_url     text,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN
                      ('draft','awaiting_approval','scheduled','publishing','live','failed','vetoed','blocked')),
  ai_flag           boolean NOT NULL DEFAULT true,           -- post-level platform AI flag (always set)
  scheduled_at      timestamptz,
  published_at      timestamptz,
  external_id       text,
  url               text,
  approval_id       uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX post_persona_idx ON post (persona_id, scheduled_at);
ALTER TABLE calendar_slot ADD CONSTRAINT calendar_slot_post_fk FOREIGN KEY (post_id) REFERENCES post(id);

CREATE TABLE metric_snapshot (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id      uuid NOT NULL REFERENCES persona(id),
  post_id         uuid REFERENCES post(id),                    -- null = account-level daily snapshot
  platform        text,
  captured_on     date NOT NULL,
  views           integer NOT NULL DEFAULT 0,
  watch_time_s    integer NOT NULL DEFAULT 0,
  likes           integer NOT NULL DEFAULT 0,
  comments        integer NOT NULL DEFAULT 0,
  saves           integer NOT NULL DEFAULT 0,
  shares          integer NOT NULL DEFAULT 0,
  follows         integer NOT NULL DEFAULT 0,
  followers       integer,
  profile_visits  integer NOT NULL DEFAULT 0,
  link_clicks     integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX metric_snapshot_persona_idx ON metric_snapshot (persona_id, captured_on);

-- ───────────────────────────── Community ─────────────────────────────

CREATE TABLE comment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id      uuid NOT NULL REFERENCES persona(id),
  post_id         uuid REFERENCES post(id),
  platform        text NOT NULL,
  external_id     text,
  author_ref      text,
  text            text NOT NULL,
  classification  text,                                        -- spam, question, purchase_intent, crisis, …
  action          text,                                        -- hide, reply, dm, escalate, none
  action_meta     jsonb,
  status          text NOT NULL DEFAULT 'new' CHECK (status IN ('new','handled','escalated','ignored')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dm_thread (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id       uuid NOT NULL REFERENCES persona(id),
  platform         text NOT NULL,
  external_id      text,
  user_ref         text,
  classification   text,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','bot_paused','closed')),
  messages         jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_message_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE escalation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id   uuid REFERENCES persona(id),
  source_type  text NOT NULL,
  source_id    uuid,
  severity     text NOT NULL CHECK (severity IN ('S1','S2','S3')),
  category     text NOT NULL,
  sla_due_at   timestamptz,
  assignee     text,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  resolution   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

-- ───────────────────────────── Products and commerce ─────────────────────────────

CREATE TABLE product (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id        uuid NOT NULL REFERENCES persona(id),
  name              text NOT NULL,
  slug              text NOT NULL,
  ladder_rung       text NOT NULL CHECK (ladder_rung IN
                      ('lead_magnet','entry','addon','core_bundle','upsell','product_2_3','marketplace','membership','course')),
  status            text NOT NULL DEFAULT 'idea' CHECK (status IN
                      ('idea','brief','building','qc','awaiting_approval','approved','live','retired')),
  price_cents       integer NOT NULL DEFAULT 0,
  currency          text NOT NULL DEFAULT 'USD',
  store_product_id  text,
  cover_url         text,
  current_version   integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (persona_id, slug)
);

CREATE TABLE product_version (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES product(id),
  persona_id  uuid NOT NULL REFERENCES persona(id),
  version     integer NOT NULL,
  file_url    text,
  changelog   text,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','qc','awaiting_approval','approved','live','retired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, version)
);

CREATE TABLE offer (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id   uuid NOT NULL REFERENCES persona(id),
  product_id   uuid REFERENCES product(id),
  kind         text NOT NULL CHECK (kind IN ('single','bundle','addon','upsell','membership')),
  ladder_rung  text,
  price_cents  integer NOT NULL,
  price_band   jsonb,                                          -- {min_cents, max_cents}
  items        jsonb NOT NULL DEFAULT '[]'::jsonb,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE short_link (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id  uuid NOT NULL REFERENCES persona(id),
  slug        text NOT NULL UNIQUE,
  target_url  text NOT NULL,
  product_id  uuid REFERENCES product(id),
  post_id     uuid REFERENCES post(id),
  clicks      integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE coupon (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id      uuid NOT NULL REFERENCES persona(id),
  code            text NOT NULL UNIQUE,
  discount_pct    integer NOT NULL CHECK (discount_pct BETWEEN 0 AND 100),
  product_id      uuid REFERENCES product(id),
  source_post_id  uuid REFERENCES post(id),
  valid_until     timestamptz,
  uses            integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- "order" is a reserved word, hence "orders".
CREATE TABLE orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id           uuid NOT NULL REFERENCES persona(id),
  product_id           uuid REFERENCES product(id),
  offer_id             uuid REFERENCES offer(id),
  store_order_id       text UNIQUE,
  customer_email_hash  text,                                   -- minimal customer data
  amount_cents         integer NOT NULL,
  fee_cents            integer NOT NULL DEFAULT 0,
  currency             text NOT NULL DEFAULT 'USD',
  coupon_id            uuid REFERENCES coupon(id),
  short_link_id        uuid REFERENCES short_link(id),
  source_post_id       uuid REFERENCES post(id),
  status               text NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','refunded','partially_refunded','disputed')),
  ordered_at           timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_persona_idx ON orders (persona_id, ordered_at);

CREATE TABLE refund (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id),
  persona_id    uuid NOT NULL REFERENCES persona(id),
  amount_cents  integer NOT NULL,
  reason        text,
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','refunded','denied')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── Audience ─────────────────────────────

CREATE TABLE subscriber (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id      uuid NOT NULL REFERENCES persona(id),
  email           text NOT NULL,
  consent         boolean NOT NULL DEFAULT false,
  consent_at      timestamptz,
  source_post_id  uuid REFERENCES post(id),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','unsubscribed','bounced')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (persona_id, email)
);

CREATE TABLE email_sequence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id  uuid NOT NULL REFERENCES persona(id),
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('welcome','launch','nurture','winback')),
  steps       jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id     uuid NOT NULL REFERENCES persona(id),
  subscriber_id  uuid REFERENCES subscriber(id),
  sequence_id    uuid REFERENCES email_sequence(id),
  type           text NOT NULL CHECK (type IN ('sent','delivered','opened','clicked','replied','bounced','unsubscribed')),
  meta           jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── Membership ─────────────────────────────

CREATE TABLE membership (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id     uuid NOT NULL REFERENCES persona(id),
  subscriber_id  uuid REFERENCES subscriber(id),
  plan           text NOT NULL,
  price_cents    integer NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('trial','active','past_due','cancelled')),
  started_at     timestamptz NOT NULL DEFAULT now(),
  cancelled_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE community_member (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id     uuid NOT NULL REFERENCES persona(id),
  membership_id  uuid REFERENCES membership(id),
  platform       text NOT NULL,
  user_ref       text NOT NULL,
  access_state   text NOT NULL DEFAULT 'granted' CHECK (access_state IN ('invited','granted','revoked')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE community_event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id  uuid NOT NULL REFERENCES persona(id),
  type        text NOT NULL CHECK (type IN ('prompt','check_in','win')),
  content     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── Monetization ─────────────────────────────

CREATE TABLE demand_signal (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id  uuid NOT NULL REFERENCES persona(id),
  source      text NOT NULL,                                   -- comment, dm, etsy, kdp, pinterest, sibling…
  text        text NOT NULL,
  topic       text,
  weight      numeric(8,2) NOT NULL DEFAULT 1,
  ref         jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_opportunity (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id  uuid NOT NULL REFERENCES persona(id),
  title       text NOT NULL,
  score       integer CHECK (score BETWEEN 0 AND 100),
  evidence    jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','validating','validated','briefed','built','dropped')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE validation_test (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id      uuid NOT NULL REFERENCES persona(id),
  opportunity_id  uuid REFERENCES product_opportunity(id),
  type            text NOT NULL CHECK (type IN ('comment_keyword','waitlist','preorder','price_test','poll')),
  result          jsonb,
  passed          boolean,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_brief (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id      uuid NOT NULL REFERENCES persona(id),
  opportunity_id  uuid REFERENCES product_opportunity(id),
  product_id      uuid REFERENCES product(id),
  content         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE launch (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id  uuid NOT NULL REFERENCES persona(id),
  product_id  uuid REFERENCES product(id),
  starts_on   date,
  sequence    jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','running','done','cancelled')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_readout (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id  uuid NOT NULL REFERENCES persona(id),
  product_id  uuid NOT NULL REFERENCES product(id),
  day         integer NOT NULL CHECK (day IN (7,14,30)),
  metrics     jsonb NOT NULL,
  decision    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_playbook_rule (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id   uuid NOT NULL REFERENCES studio(id),
  rule        text NOT NULL,
  evidence    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── Portfolio ─────────────────────────────

CREATE TABLE budget_allocation (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id   uuid NOT NULL REFERENCES studio(id),
  persona_id  uuid REFERENCES persona(id),
  week_start  date NOT NULL,
  clips       integer NOT NULL DEFAULT 0,
  llm_usd     numeric(12,4) NOT NULL DEFAULT 0,
  credits     integer NOT NULL DEFAULT 0,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Debits (every metered provider call) and grants (Owner-approved spend above a cap).
CREATE TABLE credit_ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id   uuid NOT NULL REFERENCES studio(id),
  persona_id  uuid REFERENCES persona(id),                     -- null = studio-level grant or cost
  unit        text NOT NULL CHECK (unit IN ('llm_usd','hf_credits','media_usd')),
  entry_type  text NOT NULL CHECK (entry_type IN ('debit','grant')),
  amount      numeric(16,6) NOT NULL CHECK (amount >= 0),
  period      text NOT NULL,                                   -- YYYY-MM (UTC)
  provider    text,
  operation   text,
  ref_type    text,
  ref_id      uuid,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_period_idx ON credit_ledger (studio_id, period, unit);
CREATE INDEX credit_ledger_persona_idx ON credit_ledger (persona_id, period, unit);

CREATE TABLE experiment (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id  uuid NOT NULL REFERENCES persona(id),
  hypothesis  text NOT NULL,
  variable    text NOT NULL,
  variants    jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','running','done','stopped')),
  result      jsonb,
  started_at  timestamptz,
  ended_at    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── Approvals (PRD §3.7) ─────────────────────────────

CREATE TABLE approval (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id        uuid NOT NULL REFERENCES studio(id),
  persona_id       uuid REFERENCES persona(id),
  kind             text NOT NULL CHECK (kind IN (
                     'persona_kill','persona_retire','spend_over_cap','plan_upgrade',
                     'disclosure_change','legal_text_change','persona_launch','product_v1','post')),
  mode             text NOT NULL CHECK (mode IN ('explicit','auto_after','veto_window')),
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','auto_approved','withdrawn')),
  title            text NOT NULL,
  summary          text,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  subject_type     text,
  subject_id       uuid,
  proposed_by      text NOT NULL,                              -- 'agent:studio-manager', 'system:…'
  auto_approve_at  timestamptz,
  decided_by       text,
  decided_at       timestamptz,
  decision_note    text,
  executed_at      timestamptz,
  execution_result jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Defence in depth: Owner-only kinds can never carry a timer or be auto-approved,
  -- and an approval of them must be decided by the Owner.
  CONSTRAINT approval_owner_only_kinds CHECK (
    kind NOT IN ('persona_kill','persona_retire','spend_over_cap','plan_upgrade','disclosure_change','legal_text_change')
    OR (mode = 'explicit' AND auto_approve_at IS NULL AND status <> 'auto_approved'
        AND (status <> 'approved' OR decided_by LIKE 'owner:%'))
  ),
  CONSTRAINT approval_timer_matches_mode CHECK ((mode = 'explicit') = (auto_approve_at IS NULL))
);
CREATE INDEX approval_pending_idx ON approval (status, auto_approve_at);
CREATE UNIQUE INDEX approval_one_pending_lifecycle_idx ON approval (persona_id, kind)
  WHERE status = 'pending' AND kind IN ('persona_kill','persona_retire','persona_launch');

CREATE TABLE kill_scale_proposal (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id    uuid NOT NULL REFERENCES studio(id),
  persona_id   uuid NOT NULL REFERENCES persona(id),
  week_start   date NOT NULL,
  action       text NOT NULL CHECK (action IN ('kill','retire','scale','hold','re_angle')),
  score        integer,
  rationale    text NOT NULL,
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  approval_id  uuid REFERENCES approval(id),
  status       text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','executed')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE persona_state_log ADD CONSTRAINT persona_state_log_approval_fk FOREIGN KEY (approval_id) REFERENCES approval(id);
ALTER TABLE post ADD CONSTRAINT post_approval_fk FOREIGN KEY (approval_id) REFERENCES approval(id);

-- ───────────────────────────── System ─────────────────────────────

CREATE TABLE agent_run (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id      uuid NOT NULL REFERENCES studio(id),
  persona_id     uuid REFERENCES persona(id),
  agent          text NOT NULL,
  model          text NOT NULL,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  cost_usd       numeric(12,6) NOT NULL DEFAULT 0,
  outcome        text NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok','error','refused')),
  summary        text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);

CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  studio_id    uuid REFERENCES studio(id),
  persona_id   uuid REFERENCES persona(id),
  actor_type   text NOT NULL CHECK (actor_type IN ('owner','agent','system')),
  actor_id     text NOT NULL,
  action       text NOT NULL,
  entity_type  text,
  entity_id    text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_persona_idx ON audit_log (persona_id, created_at);

-- FR-17.3: the audit log is append-only.
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

CREATE TABLE kill_switch (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id   uuid NOT NULL REFERENCES studio(id),
  scope       text NOT NULL CHECK (scope IN ('global','persona','platform')),
  persona_id  uuid REFERENCES persona(id),
  platform    text,
  active      boolean NOT NULL DEFAULT true,
  reason      text,
  set_by      text NOT NULL,
  set_at      timestamptz NOT NULL DEFAULT now(),
  cleared_by  text,
  cleared_at  timestamptz,
  CHECK (
    (scope = 'global'   AND persona_id IS NULL     AND platform IS NULL) OR
    (scope = 'persona'  AND persona_id IS NOT NULL AND platform IS NULL) OR
    (scope = 'platform' AND persona_id IS NULL     AND platform IS NOT NULL)
  )
);
CREATE UNIQUE INDEX kill_switch_one_active_idx
  ON kill_switch (studio_id, scope, COALESCE(persona_id::text, ''), COALESCE(platform, ''))
  WHERE active;

-- Postgres job queue: claimed with SELECT … FOR UPDATE SKIP LOCKED.
CREATE TABLE job (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id     uuid REFERENCES studio(id),
  persona_id    uuid REFERENCES persona(id),
  kind          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','dead')),
  priority      integer NOT NULL DEFAULT 100,                  -- lower runs first
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  run_at        timestamptz NOT NULL DEFAULT now(),
  locked_by     text,
  locked_at     timestamptz,
  last_error    text,
  result        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX job_claim_idx ON job (status, priority, run_at);
CREATE INDEX job_persona_running_idx ON job (persona_id) WHERE status = 'running';
