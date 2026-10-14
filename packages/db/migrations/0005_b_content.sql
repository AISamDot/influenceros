-- 0005 (IOS-2 stream B): weekly calendar, hook-lab + scripts, QC Q1/Q2, Compliance Gate v1, Monetization Agent v1.
-- Only alters B's tables (docs/IOS-2-CONTRACTS.md §6) and references objects from 0001–0003.

-- ───────────────────────────── Calendar slots: the Pipeline board reads the stage from status ─────────────────────────────
-- idea (planned) → scripted → q1 → gate → media_queued → (IOS-3: voice, q2, render/rendering, q3, q4, final_gate/qc)
-- → scheduled → live; blocked carries block_reason. The IOS-3 stage names are allowed here so IOS-3 needn't alter it.
ALTER TABLE calendar_slot DROP CONSTRAINT calendar_slot_status_check;
ALTER TABLE calendar_slot ADD CONSTRAINT calendar_slot_status_check CHECK (status IN (
  'planned','scripted','q1','gate','media_queued','voice','q2','rendering','render','q3','q4','qc','final_gate',
  'scheduled','live','blocked','skipped'));
ALTER TABLE calendar_slot
  ADD COLUMN week_start       date,                                   -- Monday (UTC) of the planned week
  ADD COLUMN posting_window   text,                                   -- 'morning' | 'midday' | 'evening' (persona local time)
  ADD COLUMN cta_keyword      text,                                   -- every post has a CTA, usually a comment keyword
  ADD COLUMN product_id       uuid REFERENCES product(id),            -- sell slots: what the Monetization Agent booked
  ADD COLUMN script_id        uuid,                                   -- current script (FK added below)
  ADD COLUMN block_reason     text,
  ADD COLUMN stage_changed_at timestamptz,
  ADD COLUMN meta             jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX calendar_slot_week_idx ON calendar_slot (persona_id, week_start);
CREATE INDEX calendar_slot_status_idx ON calendar_slot (status, slot_at);

-- ───────────────────────────── Ideas ─────────────────────────────
ALTER TABLE idea DROP CONSTRAINT idea_status_check;
ALTER TABLE idea ADD CONSTRAINT idea_status_check CHECK (status IN ('new','booked','scripted','dropped'));
ALTER TABLE idea
  ADD COLUMN cta_keyword text,
  ADD COLUMN product_id  uuid REFERENCES product(id);
CREATE INDEX idea_persona_status_idx ON idea (persona_id, status, created_at);

-- ───────────────────────────── Scripts: written for the ear, with evidence for every factual claim ─────────────────────────────
ALTER TABLE script
  ADD COLUMN slot_id        uuid REFERENCES calendar_slot(id),
  ADD COLUMN format         text CHECK (format IN ('talking','activity_text','voiceover','static','carousel')),
  ADD COLUMN hook           text,                                     -- the shipped hook (hooks holds the lab + A/B variants)
  ADD COLUMN voiceover      text,                                     -- TTS-safe text after Q1 (numbers, symbols, acronyms spelled out)
  ADD COLUMN on_screen_text jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN carousel       jsonb,                                    -- [{title, body}] for carousels
  ADD COLUMN visual_brief   text,
  ADD COLUMN evidence       jsonb NOT NULL DEFAULT '[]'::jsonb,       -- KnowledgeHit ids backing factual claims (FR-23.3)
  ADD COLUMN claims         jsonb NOT NULL DEFAULT '[]'::jsonb,       -- [{text, evidence_id}]
  ADD COLUMN word_count     integer,
  ADD COLUMN est_seconds    numeric(6,1),
  ADD COLUMN fix_loops      integer NOT NULL DEFAULT 0,               -- Q1 auto-fix loops used (max 2)
  ADD COLUMN meta           jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX script_slot_idx ON script (slot_id, version);
ALTER TABLE calendar_slot ADD CONSTRAINT calendar_slot_script_fk FOREIGN KEY (script_id) REFERENCES script(id);

-- ───────────────────────────── Monetization Agent v1 ─────────────────────────────
ALTER TABLE demand_signal
  ADD COLUMN topic_key  text,                                         -- normalised topic the opportunity groups on
  ADD COLUMN source_ref text;                                         -- e.g. comment id: intake is idempotent
CREATE UNIQUE INDEX demand_signal_source_ref_idx ON demand_signal (persona_id, source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX demand_signal_topic_idx ON demand_signal (persona_id, topic_key, created_at);

ALTER TABLE product_opportunity
  ADD COLUMN topic_key  text,
  ADD COLUMN factors    jsonb NOT NULL DEFAULT '{}'::jsonb,           -- Product Opportunity Score inputs (0–1 each)
  ADD COLUMN product_id uuid REFERENCES product(id),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX product_opportunity_topic_idx ON product_opportunity (persona_id, topic_key) WHERE topic_key IS NOT NULL;

ALTER TABLE product ADD COLUMN cta_keyword text;

ALTER TABLE validation_test
  ADD COLUMN keyword   text,
  ADD COLUMN starts_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN ends_at   timestamptz;

-- Real deadlines only: a launch's last call points at ends_on, never at an invented countdown.
ALTER TABLE launch
  ADD COLUMN ends_on date,
  ADD COLUMN plan    jsonb NOT NULL DEFAULT '{}'::jsonb;              -- waitlist email, thank-you upsell, bundle, coupon

-- Listing packs per channel (Lemon Squeezy fields, Etsy variant), each passed through the Gate.
CREATE TABLE product_listing (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id    uuid NOT NULL REFERENCES persona(id),
  product_id    uuid NOT NULL REFERENCES product(id),
  channel       text NOT NULL CHECK (channel IN ('lemonsqueezy','etsy')),
  fields        jsonb NOT NULL,
  gate_verdict  text CHECK (gate_verdict IN ('green','amber','red')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, channel)
);
