-- 0017 (IOS-5 stream I, docs/IOS-5-CONTRACTS.md; PRD §3.15 items 9–11 + Viral Remix): Growth Radar, Winner Finder
-- and Viral Remix. Public data only, scraped through Apify actors at low volume; every run is debited through
-- meteredApify (credit_ledger provider 'apify', weekly cap in studio settings). Scraped captions, bios and transcripts
-- are untrusted third-party text: stored for analysis, fenced before any agent sees them, never shown as our words.
-- Additive only; runs on PGlite and Supabase Postgres.

-- Actor ids, pay-per-result prices, per-run limits and per-niche seeds (hashtags, keywords, accounts) per studio.
CREATE TABLE radar_config (
  studio_id   uuid PRIMARY KEY REFERENCES studio(id),
  actors      jsonb NOT NULL DEFAULT '{}'::jsonb,
  seeds       jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One Apify run (what was asked, how many items, what it cost). No secrets in `input`.
CREATE TABLE radar_run (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id   uuid NOT NULL REFERENCES studio(id),
  kind        text NOT NULL,
  actor       text NOT NULL,
  niche       text,
  input       jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_items   integer NOT NULL,
  items       integer NOT NULL DEFAULT 0,
  cost_usd    numeric(12,4) NOT NULL DEFAULT 0,
  status      text NOT NULL CHECK (status IN ('ok','capped','failed')),
  error       text,
  week_start  date NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX radar_run_studio_idx ON radar_run (studio_id, created_at DESC);

-- A public account the Radar follows in a niche.
CREATE TABLE tracked_account (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id         uuid NOT NULL REFERENCES studio(id),
  platform          text NOT NULL CHECK (platform IN ('instagram','tiktok')),
  handle            text NOT NULL,
  niche             text NOT NULL,
  source            text NOT NULL CHECK (source IN ('seed','hashtag','search','related','outlier','owner')),
  display_name      text,
  bio               text,                                     -- untrusted
  external_url      text,
  followers         integer,
  following         integer,
  posts             integer,
  account_age_days  integer,
  velocity          numeric(14,2),                            -- followers Δ per week
  acceleration      numeric(14,2),                            -- velocity Δ per week
  growth_score      numeric(6,4),                             -- 0–1
  accelerating      boolean NOT NULL DEFAULT false,
  breakout          jsonb NOT NULL DEFAULT '[]'::jsonb,       -- breakout signals
  growth_basis      text NOT NULL DEFAULT 'first_pass' CHECK (growth_basis IN ('first_pass','history')),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','dropped')),
  last_snapshot_at  timestamptz,
  last_reviewed_at  timestamptz,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (studio_id, platform, handle)
);
CREATE INDEX tracked_account_niche_idx ON tracked_account (studio_id, niche, status);

-- Weekly snapshot per account: the growth curve.
CREATE TABLE profile_snapshot (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES tracked_account(id),
  studio_id          uuid NOT NULL REFERENCES studio(id),
  week_start         date NOT NULL,
  captured_at        timestamptz NOT NULL DEFAULT now(),
  followers          integer NOT NULL,
  following          integer,
  posts              integer,
  median_reel_views  integer,
  reels_sampled      integer NOT NULL DEFAULT 0,
  UNIQUE (account_id, week_start)
);

-- A scraped public post with its scores and (after review) our analysis.
CREATE TABLE radar_post (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id          uuid NOT NULL REFERENCES studio(id),
  account_id         uuid REFERENCES tracked_account(id),
  platform           text NOT NULL CHECK (platform IN ('instagram','tiktok')),
  external_id        text NOT NULL,
  url                text,
  handle             text NOT NULL,
  niche              text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('video','image','carousel')),
  caption            text,                                    -- untrusted
  transcript         text,                                    -- untrusted
  hashtags           text[] NOT NULL DEFAULT '{}',
  sound              text,
  posted_at          timestamptz,
  duration_s         numeric(8,2),
  views              bigint,
  likes              bigint,
  comments           bigint,
  shares             bigint,
  saves              bigint,
  followers_at       integer,
  metric             text NOT NULL DEFAULT 'views' CHECK (metric IN ('views','likes')),
  outlier_score      numeric(10,3),
  tier               text CHECK (tier IN ('normal','outlier','strong')),
  views_per_follower numeric(12,4),
  depth              numeric(10,5),                           -- (saves + shares) ÷ views
  format             text CHECK (format IN ('talking','activity_text','voiceover','static','carousel','product_in_hand','trend_reenactment',
                                            'photo_dump','text_note','facecam_screen','reply_comment','news_greenscreen','meme')),
  hook_type          text,
  topic              text,
  analysis           jsonb,                                   -- our structured review (never copied captions)
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (studio_id, platform, external_id)
);
CREATE INDEX radar_post_niche_idx ON radar_post (studio_id, niche, posted_at DESC);
CREATE INDEX radar_post_account_idx ON radar_post (account_id, posted_at DESC);

-- Account-level content review (cadence, monetisation, what their top reels have in common).
CREATE TABLE radar_review (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id         uuid NOT NULL REFERENCES studio(id),
  account_id        uuid NOT NULL REFERENCES tracked_account(id),
  week_start        date NOT NULL,
  posts_reviewed    integer NOT NULL DEFAULT 0,
  cadence_per_week  numeric(6,2),
  monetisation      jsonb NOT NULL DEFAULT '[]'::jsonb,       -- [{kind, note}]
  summary           jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_run_id      uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, week_start)
);

-- A trend: a hook, format, topic or sound adopted by several accelerating accounts within 14 days.
CREATE TABLE radar_trend (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id          uuid NOT NULL REFERENCES studio(id),
  niche              text NOT NULL,
  week_start         date NOT NULL,
  dimension          text NOT NULL CHECK (dimension IN ('hook','format','topic','sound')),
  key                text NOT NULL,
  label              text NOT NULL,
  adopters           integer NOT NULL,
  adoption_velocity  numeric(10,3) NOT NULL,
  avg_outlier        numeric(10,3) NOT NULL,
  score              numeric(12,3) NOT NULL,
  accounts           jsonb NOT NULL DEFAULT '[]'::jsonb,
  posts              jsonb NOT NULL DEFAULT '[]'::jsonb,
  first_seen         timestamptz,
  last_seen          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (studio_id, niche, week_start, dimension, key)
);

-- The weekly Trend Report (one per studio per week; the message lives in the Studio chat).
CREATE TABLE radar_report (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id   uuid NOT NULL REFERENCES studio(id),
  week_start  date NOT NULL,
  message_id  uuid,
  summary     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (studio_id, week_start)
);

-- Viral Remix: a winner's mechanic rebuilt as a new concept for one of our personas (structure only).
CREATE TABLE remix_brief (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id       uuid NOT NULL REFERENCES studio(id),
  persona_id      uuid NOT NULL REFERENCES persona(id),
  kind            text NOT NULL CHECK (kind IN ('remix','double_down')),
  radar_post_id   uuid REFERENCES radar_post(id),
  source_post_id  uuid REFERENCES post(id),
  week_start      date NOT NULL,
  mechanic        jsonb NOT NULL DEFAULT '{}'::jsonb,
  concept         jsonb NOT NULL DEFAULT '{}'::jsonb,
  format          text NOT NULL,
  score           numeric(8,4),
  status          text NOT NULL DEFAULT 'drafted' CHECK (status IN ('drafted','booked','blocked_repeat','dropped')),
  no_repeat       jsonb,
  idea_id         uuid REFERENCES idea(id),
  agent_run_id    uuid,
  created_by      text NOT NULL DEFAULT 'system',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX remix_brief_radar_post_uq ON remix_brief (persona_id, radar_post_id) WHERE radar_post_id IS NOT NULL;
CREATE UNIQUE INDEX remix_brief_source_post_uq ON remix_brief (persona_id, source_post_id) WHERE source_post_id IS NOT NULL;
CREATE INDEX remix_brief_persona_idx ON remix_brief (persona_id, created_at DESC);
