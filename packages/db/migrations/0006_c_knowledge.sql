-- 0006 (IOS-2 stream C): Field Brain and News Desk.
--
-- Embeddings are EMBEDDING_DIM = 384 (bge-small-en-v1.5 locally; fakes use the same size). The `embedding`
-- columns stay untyped `vector` so rows from another embedder can coexist during a re-embed; retrieval casts to
-- vector(384) and filters on vector_dims() and embedding_model, which is exactly what the partial HNSW indexes
-- below cover (the pgvector pattern for fixed-dimension indexes on a mixed column).

-- ───────────────────────────── Field Brain ─────────────────────────────

ALTER TABLE knowledge_node
  ADD COLUMN embedding_model text,                               -- provider name that produced `embedding`
  ADD COLUMN origin          text NOT NULL DEFAULT 'map'
                               CHECK (origin IN ('seed','map','plan','owner')),
  ADD COLUMN notes           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- persona use notes, seed source refs
  ADD COLUMN researched_at   timestamptz,
  ADD COLUMN research_error  text;

CREATE INDEX knowledge_node_niche_idx ON knowledge_node (studio_id, lower(niche));
CREATE INDEX knowledge_node_embedding_hnsw ON knowledge_node
  USING hnsw ((embedding::vector(384)) vector_cosine_ops) WHERE vector_dims(embedding) = 384;

ALTER TABLE knowledge_source
  ADD COLUMN meta             jsonb NOT NULL DEFAULT '{}'::jsonb, -- origin, feed flag, school (experts), personas
  ADD COLUMN last_fetched_at  timestamptz,
  ADD COLUMN fetch_failures   integer NOT NULL DEFAULT 0,
  ADD COLUMN last_error       text;

-- One row per Field Brain build or refresh (status page, weekly refresh, cost per niche).
CREATE TABLE knowledge_build (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id     uuid NOT NULL REFERENCES studio(id),
  niche         text NOT NULL,
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  nodes_total   integer NOT NULL DEFAULT 0,
  nodes_queued  integer NOT NULL DEFAULT 0,
  sources_total integer NOT NULL DEFAULT 0,
  cost_usd      numeric(12,6) NOT NULL DEFAULT 0,
  mode          text NOT NULL DEFAULT 'fake' CHECK (mode IN ('live','fake')),
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX knowledge_build_niche_idx ON knowledge_build (studio_id, lower(niche), started_at DESC);

-- ───────────────────────────── News Desk ─────────────────────────────

ALTER TABLE news_item
  ADD COLUMN embedding_model text,
  ADD COLUMN kind            text NOT NULL DEFAULT 'news' CHECK (kind IN ('news','reddit','youtube')),
  ADD COLUMN title_key       text,                                -- normalised title for near-duplicate checks
  ADD COLUMN duplicate_of    uuid REFERENCES news_item(id),
  ADD COLUMN coverage        integer NOT NULL DEFAULT 1,          -- sources carrying the same story
  ADD COLUMN scored_at       timestamptz;

CREATE INDEX news_item_recent_idx ON news_item (studio_id, lower(niche), created_at DESC);
CREATE INDEX news_item_embedding_hnsw ON news_item
  USING hnsw ((embedding::vector(384)) vector_cosine_ops) WHERE vector_dims(embedding) = 384;

ALTER TABLE news_briefing
  ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'::jsonb;              -- run id, mode, chat message id
