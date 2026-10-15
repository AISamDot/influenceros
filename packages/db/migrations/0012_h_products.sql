-- IOS-4 stream H: Product Builder (docs/IOS-34-CONTRACTS.md §4, §5.6).
-- product_version gains the built files (ProductFile[]), the QP report and build metadata; product_build logs every
-- build attempt (resumable, idempotent per product version); product_manuscript records imported markdown manuscripts;
-- product_template records Google Sheets / Notion copies made for a version.

ALTER TABLE product_version
  ADD COLUMN files         jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ProductFile[] (@ios/agents ios34.ts); file_url = the A4 PDF
  ADD COLUMN source        text CHECK (source IN ('brief','manuscript')),
  ADD COLUMN page_count    integer,
  ADD COLUMN qc_report_id  uuid REFERENCES qc_report(id),
  ADD COLUMN content_hash  text,
  ADD COLUMN outline       jsonb NOT NULL DEFAULT '[]'::jsonb;   -- section titles, for "material change" checks

ALTER TABLE product_brief
  ADD COLUMN source text NOT NULL DEFAULT 'monetization' CHECK (source IN ('monetization','manuscript'));

CREATE TABLE product_build (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid NOT NULL REFERENCES product(id),
  persona_id    uuid NOT NULL REFERENCES persona(id),
  version       integer NOT NULL,
  source        text NOT NULL CHECK (source IN ('brief','manuscript')),
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running','passed','blocked','failed')),
  fix_loops     integer NOT NULL DEFAULT 0,
  renderer      text,
  doc           jsonb,                                         -- the structured content (sections and blocks)
  qc_report_id  uuid REFERENCES qc_report(id),
  block_reason  text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, version)
);
CREATE INDEX product_build_persona_idx ON product_build (persona_id, created_at DESC);

CREATE TABLE product_manuscript (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id   uuid NOT NULL REFERENCES persona(id),
  product_id   uuid REFERENCES product(id),
  sha256       text NOT NULL,
  filename     text NOT NULL,
  storage_key  text NOT NULL,
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,               -- front matter
  version      integer,
  status       text NOT NULL DEFAULT 'imported' CHECK (status IN ('imported','built','blocked','failed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (persona_id, sha256)
);

CREATE TABLE product_template (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES product(id),
  persona_id  uuid NOT NULL REFERENCES persona(id),
  version     integer NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('sheet','notion')),
  provider    text NOT NULL,
  url         text NOT NULL,
  spec        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, version, kind)
);
