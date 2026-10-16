-- 0014 (16 Oct, Owner decision): Persona Generator (PRD §3.12) and persona archive. Additive only; runs on PGlite and
-- Supabase Postgres.

-- ── Soft archive ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- ARCHIVED is a parking state: the persona keeps every row (bible versions, products, slots, posts, threads) and
-- stops working (no planning, scripting, publishing or briefings). Restoring returns it to the state it was archived
-- from. Archiving a persona that has launched needs the Owner (typed name on the dashboard, or an approved
-- persona_archive card); a never-launched persona or a draft can be archived directly.
ALTER TABLE persona DROP CONSTRAINT persona_state_check;
ALTER TABLE persona ADD CONSTRAINT persona_state_check CHECK (state IN
  ('PROPOSED','SETUP','TESTING','MONETISING','RE_ANGLE','KILLED','SCALING','BRAND','RETIRED','ARCHIVED'));
ALTER TABLE persona
  ADD COLUMN archived_at          timestamptz,
  ADD COLUMN archived_from_state  text,
  ADD COLUMN archive_reason       text;
ALTER TABLE persona ADD CONSTRAINT persona_archived_consistent
  CHECK ((state = 'ARCHIVED') = (archived_at IS NOT NULL AND archived_from_state IS NOT NULL));

-- Approvals: persona_archive (an agent's proposal to archive a launched persona) is Owner-only like a kill.
-- A persona_launch whose payload says owner_only (generator-created and archive-restored personas) can never carry a
-- timer or be approved by anyone but the Owner.
ALTER TABLE approval DROP CONSTRAINT approval_kind_check;
ALTER TABLE approval ADD CONSTRAINT approval_kind_check CHECK (kind IN (
  'persona_kill','persona_retire','spend_over_cap','plan_upgrade',
  'disclosure_change','legal_text_change','persona_launch','product_v1','post','qc_override','persona_archive'));
ALTER TABLE approval DROP CONSTRAINT approval_owner_only_kinds;
ALTER TABLE approval ADD CONSTRAINT approval_owner_only_kinds CHECK (
  (kind NOT IN ('persona_kill','persona_retire','spend_over_cap','plan_upgrade','disclosure_change','legal_text_change',
                'qc_override','persona_archive')
   AND NOT (kind = 'persona_launch' AND COALESCE(payload->>'owner_only', 'false') = 'true'))
  OR (mode = 'explicit' AND auto_approve_at IS NULL AND status <> 'auto_approved'
      AND (status <> 'approved' OR decided_by LIKE 'owner:%'))
);
CREATE UNIQUE INDEX approval_one_pending_archive_idx ON approval (persona_id) WHERE status = 'pending' AND kind = 'persona_archive';

-- ── Persona Generator ────────────────────────────────────────────────────────────────────────────────────────────────
-- One draft per persona being co-created. `state` holds the seven steps (opportunity, concept, character, look,
-- voice, content, review); every change writes a persona_draft_version snapshot, so a draft can be resumed, compared
-- and rolled back. `persona_id` is set at launch (or at once for a draft restored from the archive).
CREATE TABLE persona_draft (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id     uuid NOT NULL REFERENCES studio(id),
  title         text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','launched','archived')),
  source        text NOT NULL DEFAULT 'generator' CHECK (source IN ('generator','owner_idea','archive')),
  current_step  integer NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 7),
  version       integer NOT NULL DEFAULT 1,
  state         jsonb NOT NULL DEFAULT '{}'::jsonb,
  scores        jsonb NOT NULL DEFAULT '{}'::jsonb,
  persona_id    uuid REFERENCES persona(id),
  archive_ref   jsonb,                                          -- {label, slug} for drafts restored from the archive
  created_by    text NOT NULL,
  launched_by   text,
  launched_at   timestamptz,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX persona_draft_studio_idx ON persona_draft (studio_id, status, updated_at DESC);

CREATE TABLE persona_draft_version (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id    uuid NOT NULL REFERENCES persona_draft(id),
  version     integer NOT NULL,
  step        integer NOT NULL CHECK (step BETWEEN 0 AND 7),     -- 0 = the whole draft (create, archive, restore)
  change      text NOT NULL,
  actor       text NOT NULL,
  state       jsonb NOT NULL,
  scores      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, version)
);

-- The draft's chat with the Studio Manager (one thread per draft; each message records the step it was sent on).
CREATE TABLE persona_draft_message (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id    uuid NOT NULL REFERENCES persona_draft(id),
  step        integer NOT NULL CHECK (step BETWEEN 1 AND 7),
  role        text NOT NULL CHECK (role IN ('owner','agent','system')),
  author      text NOT NULL,
  body        text NOT NULL,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX persona_draft_message_idx ON persona_draft_message (draft_id, created_at);
