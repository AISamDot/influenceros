-- Owner interaction lives in the dashboard (FR-16.1, no Telegram): chat threads, messages, notifications.
-- Field Brain and News Desk storage (§3.10, FR-23). Agent logic for these lands in IOS-2.

-- ───────────────────────────── Chat and notifications ─────────────────────────────

CREATE TABLE chat_thread (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id   uuid NOT NULL REFERENCES studio(id),
  persona_id  uuid REFERENCES persona(id),                     -- set only for kind = 'persona'
  kind        text NOT NULL CHECK (kind IN ('studio','persona','monetization','quality')),
  title       text NOT NULL,
  agent       text NOT NULL,                                   -- 'studio-manager', 'persona-manager', …
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'persona') = (persona_id IS NOT NULL))
);
CREATE UNIQUE INDEX chat_thread_one_per_target_idx
  ON chat_thread (studio_id, kind, COALESCE(persona_id::text, ''));

CREATE TABLE chat_message (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id   uuid NOT NULL REFERENCES chat_thread(id),
  persona_id  uuid REFERENCES persona(id),
  role        text NOT NULL CHECK (role IN ('owner','agent','system')),
  author      text NOT NULL,                                   -- 'owner:hossam', 'agent:studio-manager'
  body        text NOT NULL,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,              -- mentions, inline approval cards, links
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_message_thread_idx ON chat_message (thread_id, created_at);

CREATE TABLE notification (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id   uuid NOT NULL REFERENCES studio(id),
  persona_id  uuid REFERENCES persona(id),
  kind        text NOT NULL CHECK (kind IN ('approval','escalation','budget','digest','publish','system')),
  severity    text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','critical')),
  title       text NOT NULL,
  body        text,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_unread_idx ON notification (studio_id, read_at, created_at);

-- ───────────────────────────── Field Brain and News Desk ─────────────────────────────

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_source (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id    uuid NOT NULL REFERENCES studio(id),
  niche        text NOT NULL,
  name         text NOT NULL,
  url          text,
  kind         text NOT NULL CHECK (kind IN ('journal','institution','publication','expert','dataset','rss','other')),
  canon        boolean NOT NULL DEFAULT false,
  credibility  integer CHECK (credibility BETWEEN 1 AND 5),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (studio_id, niche, name)
);

CREATE TABLE knowledge_node (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id         uuid NOT NULL REFERENCES studio(id),
  niche             text NOT NULL,
  parent_id         uuid REFERENCES knowledge_node(id),
  path              text NOT NULL,                             -- e.g. 'fundamentals/cash-flow'
  title             text NOT NULL,
  level             text CHECK (level IN ('fundamental','intermediate','advanced','debate','myth','frontier')),
  synthesis         text,
  facts             jsonb NOT NULL DEFAULT '[]'::jsonb,        -- [{claim, citations:[{source_id,url,quote}]}]
  frameworks        jsonb NOT NULL DEFAULT '[]'::jsonb,
  questions         jsonb NOT NULL DEFAULT '[]'::jsonb,        -- common questions and misconceptions
  embedding         vector,                                    -- dimension fixed when the embedder is chosen (IOS-2)
  last_verified_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (studio_id, niche, path)
);

CREATE TABLE news_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id     uuid NOT NULL REFERENCES studio(id),
  niche         text NOT NULL,
  source_id     uuid REFERENCES knowledge_source(id),
  title         text NOT NULL,
  url           text NOT NULL,
  published_at  timestamptz,
  summary       text,
  score         integer CHECK (score BETWEEN 0 AND 100),
  raw           jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding     vector,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (studio_id, niche, url)
);

CREATE TABLE news_briefing (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id     uuid NOT NULL REFERENCES persona(id),
  niche          text NOT NULL,
  briefing_date  date NOT NULL,
  items          jsonb NOT NULL DEFAULT '[]'::jsonb,           -- [{news_item_id, why_it_matters, take, score}]
  reaction_ideas jsonb NOT NULL DEFAULT '[]'::jsonb,           -- fast-reaction queue (24–72 h)
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (persona_id, briefing_date)
);
