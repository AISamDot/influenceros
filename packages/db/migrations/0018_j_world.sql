-- 0018 (IOS-5 stream J, docs/IOS-5-CONTRACTS.md; PRD §3.13, §3.14): the persona's world.
-- World Bible (place, home, recurring places, cast, routine, seasons, holidays, local life) with versions; a weather
-- cache for real-time grounding (Open-Meteo); the ~12-week storyline (arcs with chapters, beats assigned to slots);
-- the fact / continuity ledger; the no-repeat engine's concept fingerprints (pgvector, EMBEDDING_DIM 384); Pinterest
-- inspiration pins + mood boards (mood and format only, never a face reference) and Pinterest publishing (a board per
-- persona on the one studio account). Additive only; runs on PGlite and Supabase Postgres.

CREATE TABLE world_bible (
  persona_id   uuid PRIMARY KEY REFERENCES persona(id),
  studio_id    uuid NOT NULL REFERENCES studio(id),
  version      integer NOT NULL DEFAULT 1,
  city         text NOT NULL,
  region       text,
  country      text NOT NULL,
  timezone     text NOT NULL,
  lat          double precision,
  lon          double precision,
  summary      text NOT NULL DEFAULT '',
  content      jsonb NOT NULL,
  source       text NOT NULL DEFAULT 'generator' CHECK (source IN ('generator','owner','agent','backfill')),
  updated_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE world_bible_version (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id  uuid NOT NULL REFERENCES persona(id),
  version     integer NOT NULL,
  content     jsonb NOT NULL,
  change      text NOT NULL,
  actor       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (persona_id, version)
);

-- Last live weather per persona (grounding reuses it for 30 minutes; the hourly schedule refreshes it).
CREATE TABLE world_weather (
  persona_id  uuid PRIMARY KEY REFERENCES persona(id),
  fetched_at  timestamptz NOT NULL,
  data        jsonb NOT NULL
);

CREATE TABLE storyline_arc (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id  uuid NOT NULL REFERENCES persona(id),
  studio_id   uuid NOT NULL REFERENCES studio(id),
  season      integer NOT NULL,
  title       text NOT NULL,
  premise     text NOT NULL,
  weeks       integer NOT NULL DEFAULT 12,
  -- Monday (UTC) of the arc's week 1; set by the first week the calendar plans after adoption.
  starts_on   date,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','superseded')),
  content     jsonb NOT NULL,          -- chapters (title, weeks, tension, payoff, subplots), running gags, callbacks, milestones
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (persona_id, season)
);
CREATE UNIQUE INDEX storyline_arc_active_idx ON storyline_arc (persona_id) WHERE status = 'active';

CREATE TABLE storyline_beat (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  arc_id         uuid NOT NULL REFERENCES storyline_arc(id),
  persona_id     uuid NOT NULL REFERENCES persona(id),
  chapter_id     text NOT NULL,
  beat_key       text NOT NULL,
  week           integer NOT NULL,
  ord            integer NOT NULL DEFAULT 0,
  kind           text NOT NULL DEFAULT 'development' CHECK (kind IN ('setup','development','gag','callback','cliffhanger','payoff','milestone')),
  text           text NOT NULL,
  tension        text,
  payoff         text,
  status         text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','assigned','used','dropped')),
  assigned_week  date,
  slot_at        timestamptz,
  source         text NOT NULL DEFAULT 'draft' CHECK (source IN ('draft','steer','owner','extend')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (arc_id, beat_key)
);
CREATE INDEX storyline_beat_week_idx ON storyline_beat (persona_id, week, ord);

CREATE TABLE continuity_fact (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id    uuid NOT NULL REFERENCES studio(id),
  persona_id   uuid NOT NULL REFERENCES persona(id),
  kind         text NOT NULL CHECK (kind IN ('person','pet','age','event','possession','opinion','place','other')),
  subject      text NOT NULL,
  value        text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  statement    text NOT NULL,
  source_type  text NOT NULL,          -- 'bible' | 'script' | 'story_frame' | 'reply' | 'remix_brief' | 'owner'
  source_id    text,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retracted')),
  stated_at    timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX continuity_fact_persona_idx ON continuity_fact (persona_id, kind, subject) WHERE status = 'active';

-- One row per recorded subject: recordApproved is idempotent per subject.
CREATE TABLE continuity_record (
  subject_type  text NOT NULL,
  subject_id    text NOT NULL,
  persona_id    uuid NOT NULL REFERENCES persona(id),
  facts         integer NOT NULL DEFAULT 0,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_type, subject_id)
);

CREATE TABLE concept_fingerprint (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id          uuid NOT NULL REFERENCES studio(id),
  persona_id         uuid REFERENCES persona(id),
  subject_type       text NOT NULL,
  subject_id         text NOT NULL,
  premise            text NOT NULL,
  hook_type          text,
  topic              text NOT NULL,
  format             text NOT NULL,
  key_line           text NOT NULL,
  series             text,
  wording            text NOT NULL DEFAULT '',
  embedding          vector(384) NOT NULL,
  wording_embedding  vector(384),
  beat_embedding     vector(384),
  embedding_model    text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id)
);
CREATE INDEX concept_fingerprint_persona_idx ON concept_fingerprint (persona_id, created_at DESC);
CREATE INDEX concept_fingerprint_studio_idx ON concept_fingerprint (studio_id, created_at DESC);
CREATE INDEX concept_fingerprint_embedding_idx ON concept_fingerprint USING hnsw (embedding vector_cosine_ops);
CREATE INDEX concept_fingerprint_wording_idx ON concept_fingerprint USING hnsw (wording_embedding vector_cosine_ops);

-- What the no-repeat engine and the continuity check blocked (persona page panel).
CREATE TABLE concept_block (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id     uuid NOT NULL REFERENCES studio(id),
  persona_id    uuid REFERENCES persona(id),
  subject_type  text NOT NULL,
  subject_id    text,
  check_name    text NOT NULL,
  similarity    double precision,
  nearest_id    uuid,
  reason        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX concept_block_persona_idx ON concept_block (persona_id, created_at DESC);

-- Inspiration pins: candidates from a search (Pinterest API or the Apify fallback) and the ones picked into a mood
-- board. Titles and descriptions are third-party text (untrusted). image_url only feeds the "too similar" face check.
CREATE TABLE inspiration_pin (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id    uuid NOT NULL REFERENCES studio(id),
  draft_id     uuid REFERENCES persona_draft(id),
  persona_id   uuid REFERENCES persona(id),
  external_id  text NOT NULL,
  url          text NOT NULL,
  image_url    text,
  title        text NOT NULL DEFAULT '',
  description  text NOT NULL DEFAULT '',
  board        text,
  source       text NOT NULL CHECK (source IN ('pinterest-api','apify')),
  query        text NOT NULL,
  picked       boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX inspiration_pin_scope_idx ON inspiration_pin (studio_id, COALESCE(draft_id::text, ''), COALESCE(persona_id::text, ''), external_id);

CREATE TABLE inspiration_board (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id    uuid NOT NULL REFERENCES studio(id),
  draft_id     uuid REFERENCES persona_draft(id),
  persona_id   uuid REFERENCES persona(id),
  descriptors  jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX inspiration_board_draft_idx ON inspiration_board (draft_id) WHERE draft_id IS NOT NULL;
CREATE UNIQUE INDEX inspiration_board_persona_idx ON inspiration_board (persona_id) WHERE persona_id IS NOT NULL;

-- Pinterest publishing: one studio account, a board per persona (live and fake boards are kept apart, so a fake run
-- never stands in for a real pin once the key arrives).
CREATE TABLE pinterest_board (
  persona_id  uuid NOT NULL REFERENCES persona(id),
  live        boolean NOT NULL,
  studio_id   uuid NOT NULL REFERENCES studio(id),
  board_id    text NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (persona_id, live)
);

CREATE TABLE pinterest_pin (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id   uuid NOT NULL REFERENCES studio(id),
  persona_id  uuid NOT NULL REFERENCES persona(id),
  kind        text NOT NULL CHECK (kind IN ('product','carousel')),
  ref_id      uuid NOT NULL,
  live        boolean NOT NULL,
  board_id    text,
  pin_id      text,
  url         text,
  title       text NOT NULL,
  description text NOT NULL,
  status      text NOT NULL DEFAULT 'published' CHECK (status IN ('published','failed')),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, ref_id, live)
);
