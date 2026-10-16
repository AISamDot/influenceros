-- 0019 (IOS-5 stream K, docs/IOS-5-CONTRACTS.md §4; PRD §3.12 notes, §3.15 items 1–8): the production playbook.
-- New tables only (production_*, location_*, hook_template); references objects from 0001–0016 only.
-- Runs on PGlite and Supabase Postgres.

-- ───────────────────────────── Identity references (character sheet, detail strip, core refs, BOPA) ─────────────────────────────
-- One row per generated reference image. `url` is the provider URL a generation can reference (Higgsfield takes
-- https URLs, never the dashboard's /api/media paths); `asset_key` is the stored copy. The identity stack that goes into
-- every persona generation is kind IN ('face','full_body') with status 'active'. Nothing here ever comes from a
-- Pinterest pin or a scraped creator: these are the persona's own generations.
CREATE TABLE production_identity (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id  uuid NOT NULL REFERENCES persona(id),
  kind        text NOT NULL CHECK (kind IN ('sheet','detail_strip','face','full_body','core','bopa_background_grid','bopa_background',
                                             'bopa_outfit','bopa_pose_grid','bopa_pose','bopa_angle')),
  label       text NOT NULL,
  prompt      text NOT NULL,
  url         text NOT NULL,
  asset_key   text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','candidate','rejected')),
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX production_identity_persona_idx ON production_identity (persona_id, kind, status);
CREATE UNIQUE INDEX production_identity_label_idx ON production_identity (persona_id, kind, label) WHERE status <> 'rejected';

-- ───────────────────────────── Location lock: each recurring place gets a locked reference set ─────────────────────────────
CREATE TABLE location_lock (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id   uuid NOT NULL REFERENCES persona(id),
  place        text NOT NULL,                              -- the World Bible / look place name, as written
  place_key    text NOT NULL,                              -- normalised (lower case, single spaces) for lookups
  description  text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','locked','retired')),
  -- [{url, asset_key, angle}] the anchor frames every still at this place references
  refs         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- the 5-setting pick: [{label, prompt, url, asset_key}] and which one was locked
  candidates   jsonb NOT NULL DEFAULT '[]'::jsonb,
  chosen       integer,
  source       text NOT NULL DEFAULT 'bible' CHECK (source IN ('bible','world','owner')),
  locked_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (persona_id, place_key)
);

-- ───────────────────────────── Consistency chain: approved frames feed the next shot ─────────────────────────────
-- Every persona still a render makes. Status follows QC: 'approved' once Q3/Q4 passes, 'rejected' when QC sends it
-- back. Only approved frames are ever chained from.
CREATE TABLE production_frame (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id  uuid NOT NULL REFERENCES persona(id),
  slot_id     uuid REFERENCES calendar_slot(id),
  gen_key     text NOT NULL,
  location    text,                                         -- place_key
  camera      text,
  url         text NOT NULL,                                -- provider URL (referenceable)
  asset_key   text,
  chained_from uuid REFERENCES production_frame(id),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX production_frame_chain_idx ON production_frame (persona_id, location, status, created_at);
CREATE INDEX production_frame_slot_idx ON production_frame (slot_id, gen_key);

-- ───────────────────────────── Hook-template library (PRD §3.15.6–7; seeded from the Licbe resources as inspiration) ─────────────────────────────
-- The built-in rows mirror HOOK_TEMPLATES in @ios/content (source 'library'); the Owner and the Studio Manager can add
-- their own (source 'owner' / 'studio'). Templates are patterns, never copied lines.
CREATE TABLE hook_template (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  hook_type   text NOT NULL,
  pattern     text NOT NULL,
  example     text NOT NULL,
  formats     jsonb NOT NULL DEFAULT '[]'::jsonb,
  source      text NOT NULL DEFAULT 'library' CHECK (source IN ('library','owner','studio')),
  active      boolean NOT NULL DEFAULT true,
  uses        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO hook_template (id, name, hook_type, pattern, example, formats) VALUES
  ('three_mistakes',    '3 mistakes',          'mistake',       '3 mistakes {audience} make with {topic}',                 '3 mistakes everyone makes with their first budget',          '["talking","carousel","activity_text"]'),
  ('do_this_instead',   'Do this instead',     'mistake',       'Stop {bad habit}. Do this instead.',                       'Stop saving what''s left. Do this instead.',                 '["talking","activity_text","static"]'),
  ('myth_vs_fact',      'Myth vs fact',        'myth_bust',     'Myth: {belief}. Fact: {truth}.',                          'Myth: you need a big salary to save. Fact: you need a system.', '["carousel","talking","text_note"]'),
  ('ranking',           'Ranking',             'number',        'Ranking {n} {things} from worst to best',                  'Ranking 5 ways to save from worst to best',                   '["talking","carousel","facecam_screen"]'),
  ('story_hook',        'Story hook',          'story',         'The day {small moment} changed how I {verb}',              'The day my card got declined changed how I shop',            '["voiceover","talking","photo_dump"]'),
  ('pov',               'POV',                 'pov',           'POV: you finally {win}',                                   'POV: you finally stopped dreading payday',                   '["activity_text","meme","static"]'),
  ('quiz',              'Quiz',                'question',      'Can you guess {question}?',                                'Can you guess where most of your money goes?',               '["carousel","talking","reply_comment"]'),
  ('beginner_guide',    'Beginner guide',      'how_to',        'The beginner''s guide to {topic} in {n} steps',            'The beginner''s guide to saving in 3 steps',                 '["carousel","facecam_screen","talking"]'),
  ('reaction',          'Reaction',            'contrarian',    'My honest reaction to {thing everyone is sharing}',       'My honest reaction to the "no-spend" trend',                 '["news_greenscreen","reply_comment","talking"]'),
  ('triple_hook',       'Triple hook',         'curiosity_gap', '{demo 1}. {demo 2}. {demo 3}. Here''s how.',              'Coffee: £2. Lunch: £8. Taxi: £14. Here''s the fix.',          '["activity_text","talking"]'),
  ('reply_to_comment',  'Reply to a comment',  'callout',       'Someone asked {question}. Here''s my answer.',             'Someone asked how to start with no savings. Here''s my answer.', '["reply_comment","talking"]'),
  ('relatable',         'Relatable',           'pov',           'Me pretending {situation} is fine',                        'Me pretending my bank app isn''t open on purpose',           '["meme","text_note","static"]');
