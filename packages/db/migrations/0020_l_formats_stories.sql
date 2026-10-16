-- 0020 (IOS-5 stream L, docs/IOS-5-CONTRACTS.md; PRD FR-4.3c, FR-4.3d): per-persona Format Plans and the Stories engine.
-- Additive only; runs on PGlite and Supabase Postgres.

-- ── Format Plan ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- One row per version of a persona's Format Plan (FormatPlan JSON in `plan`): weekly feed posts per format, optional
-- formats on/off, Stories per day and their daily mix, a reason and cost per line. Recommended by the Studio Manager in
-- Persona Generator step 6 and adopted with the Owner's launch; the Owner edits it (persona page, generator, chat) and
-- the Profit Engine's format lever re-tunes it within bounds (its weekly overrides live in profit_cadence_override and
-- are composed over the latest version at read time). The CadencePolicy reads the latest version effective for a week.
CREATE TABLE format_plan (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id       uuid NOT NULL REFERENCES studio(id),
  persona_id      uuid NOT NULL REFERENCES persona(id),
  version         integer NOT NULL CHECK (version >= 1),
  plan            jsonb NOT NULL,
  posts_per_week  integer NOT NULL CHECK (posts_per_week BETWEEN 7 AND 21),
  stories_per_day integer NOT NULL CHECK (stories_per_day BETWEEN 3 AND 5),
  source          text NOT NULL CHECK (source IN ('default','recommended','owner','lever')),
  reason          text,
  effective_from  date NOT NULL,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (persona_id, version)
);
CREATE INDEX format_plan_persona_idx ON format_plan (persona_id, version DESC);

-- ── Stories ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 3–5 native frames a day per persona (FR-4.3d): a still + text overlay at 1080×1920. Each frame passes QC
-- (qc_report subject_type 'story_frame') and the Gate (gate_result subject_type 'story_frame') before it publishes.
CREATE TABLE story_frame (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id       uuid NOT NULL REFERENCES studio(id),
  persona_id      uuid NOT NULL REFERENCES persona(id),
  story_date      date NOT NULL,                                -- persona-local date
  seq             integer NOT NULL CHECK (seq BETWEEN 1 AND 5),
  kind            text NOT NULL CHECK (kind IN ('world','storyline','reshare','engagement','sell')),
  status          text NOT NULL DEFAULT 'planned' CHECK (status IN
                    ('planned','rendered','approved','awaiting_approval','blocked','published','skipped','failed')),
  planned_at      timestamptz NOT NULL,
  text            text,                                         -- the overlay (what the audience reads)
  scene           text,                                         -- what the still shows
  cta_keyword     text,
  product_id      uuid REFERENCES product(id),
  reshare_post_id uuid REFERENCES post(id),
  beat            jsonb,                                        -- SlotBeat for storyline frames
  grounding       jsonb,                                        -- the Grounding (or stub) the world frame used
  prompt          jsonb,                                        -- the compiled image prompt
  still_url       text,
  media_url       text,
  media_key       text,
  width           integer,
  height          integer,
  credits         numeric NOT NULL DEFAULT 0,
  qc_report_id    uuid REFERENCES qc_report(id),
  gate_result_id  uuid REFERENCES gate_result(id),
  gate_verdict    text CHECK (gate_verdict IN ('green','amber','red')),
  block_reason    text,
  ai_flag         boolean NOT NULL DEFAULT true CHECK (ai_flag),
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (persona_id, story_date, seq)
);
CREATE INDEX story_frame_persona_idx ON story_frame (persona_id, story_date DESC);
CREATE INDEX story_frame_status_idx ON story_frame (status, planned_at);

-- One row per platform a frame went to (Zernio kind 'story', only where the platform's story capability is on).
CREATE TABLE story_post (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_frame_id  uuid NOT NULL REFERENCES story_frame(id),
  persona_id      uuid NOT NULL REFERENCES persona(id),
  platform        text NOT NULL CHECK (platform IN ('tiktok','instagram','youtube','pinterest')),
  status          text NOT NULL CHECK (status IN ('published','processing','unsupported','blocked','failed')),
  external_id     text,
  reason          text,
  ai_flag         boolean NOT NULL DEFAULT true CHECK (ai_flag),
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (story_frame_id, platform)
);
CREATE INDEX story_post_persona_idx ON story_post (persona_id, published_at DESC);

-- Cumulative story metrics per post and capture day (reach, replies, taps forward and back, exits).
CREATE TABLE story_metric (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_post_id   uuid NOT NULL REFERENCES story_post(id),
  story_frame_id  uuid NOT NULL REFERENCES story_frame(id),
  persona_id      uuid NOT NULL REFERENCES persona(id),
  platform        text NOT NULL,
  captured_on     date NOT NULL,
  reach           integer NOT NULL DEFAULT 0,
  replies         integer NOT NULL DEFAULT 0,
  taps_forward    integer NOT NULL DEFAULT 0,
  taps_back       integer NOT NULL DEFAULT 0,
  exits           integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (story_post_id, captured_on)
);
CREATE INDEX story_metric_persona_idx ON story_metric (persona_id, captured_on DESC);

-- Highlight sets the Persona Manager curates ("Start here", "Free guide", "Shop", "Lore").
CREATE TABLE story_highlight (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id      uuid NOT NULL REFERENCES persona(id),
  set_name        text NOT NULL CHECK (set_name IN ('Start here','Free guide','Shop','Lore')),
  frame_ids       jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason          text,
  curated_by      text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (persona_id, set_name)
);
