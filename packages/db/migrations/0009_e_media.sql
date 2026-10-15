-- 0009 (IOS-3 stream E): media pipeline (docs/IOS-34-CONTRACTS.md §4, §5.6).
-- Alters only E's tables (asset) and adds media_* tables. References objects from 0001–0008 only.

-- ───────────────────────────── Assets: one row per stored file, findable per slot ─────────────────────────────
ALTER TABLE asset
  ADD COLUMN slot_id uuid REFERENCES calendar_slot(id),
  -- 'final' | 'slide' | 'cover' | 'voice' | 'clip' | 'still' | 'reference' | 'look'
  ADD COLUMN role    text;
CREATE INDEX asset_slot_idx ON asset (slot_id, role, created_at);

-- ───────────────────────────── Per-persona media identity: Soul ID, voice, colour grade ─────────────────────────────
CREATE TABLE media_profile (
  persona_id     uuid PRIMARY KEY REFERENCES persona(id),
  soul_id        text,
  soul_status    text NOT NULL DEFAULT 'none' CHECK (soul_status IN ('none','ready','failed')),
  reference_key  text,                                   -- storage key of the face reference (character sheet still)
  voice_provider text,
  voice_id       text,
  grade          jsonb NOT NULL DEFAULT '{}'::jsonb,     -- ColorGrade (from the persona kit)
  look_prompts   jsonb NOT NULL DEFAULT '[]'::jsonb,     -- prompts the Soul ID was trained from
  meta           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── Higgsfield price table, written by the `generate cost` probe ─────────────────────────────
CREATE TABLE media_price (
  operation   text NOT NULL,                             -- soul_id | still | image_to_video | talking_with_audio
  model       text NOT NULL,
  resolution  text NOT NULL DEFAULT '720p',
  duration_s  integer NOT NULL DEFAULT 0,                -- 0 for stills and Soul IDs
  credits     numeric(10,2) NOT NULL,
  source      text NOT NULL DEFAULT 'probe',
  probed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation, model, resolution, duration_s)
);

-- ───────────────────────────── Generation log (every paid media call, with what it cost) ─────────────────────────────
CREATE TABLE media_generation (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id  uuid NOT NULL REFERENCES persona(id),
  slot_id     uuid REFERENCES calendar_slot(id),
  operation   text NOT NULL,
  provider    text NOT NULL,
  model       text,
  job_id      text,
  url         text,
  credits     numeric(10,2) NOT NULL DEFAULT 0,
  usd_cost    numeric(12,4) NOT NULL DEFAULT 0,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_generation_persona_idx ON media_generation (persona_id, created_at);
CREATE INDEX media_generation_slot_idx ON media_generation (slot_id);

-- ───────────────────────────── Render state per slot: media.render resumes from here ─────────────────────────────
CREATE TABLE media_render (
  slot_id         uuid PRIMARY KEY REFERENCES calendar_slot(id),
  persona_id      uuid NOT NULL REFERENCES persona(id),
  script_id       uuid REFERENCES script(id),
  format          text NOT NULL CHECK (format IN ('talking','activity_text','voiceover','static','carousel')),
  step            text NOT NULL DEFAULT 'voice',         -- voice | generate | q3 | render | q4 | done | blocked
  state           jsonb NOT NULL DEFAULT '{}'::jsonb,
  loops           jsonb NOT NULL DEFAULT '{}'::jsonb,    -- auto-fix loops used per stage, e.g. {"q2":1,"q4":2}
  waiting         text,                                  -- e.g. a budget cap the job is deferred on
  final_asset_id  uuid REFERENCES asset(id),
  cover_asset_id  uuid REFERENCES asset(id),
  q4_report_id    uuid REFERENCES qc_report(id),
  credits         numeric(10,2) NOT NULL DEFAULT 0,
  usd_cost        numeric(12,4) NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_render_persona_idx ON media_render (persona_id, updated_at);
