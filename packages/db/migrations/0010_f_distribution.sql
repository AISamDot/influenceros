-- 0010 (IOS-4 stream F): Zernio publishing, community worker, analytics windows, Settings → Accounts.
-- Alters only F's tables (post, account, comment, dm_thread, escalation, metric_snapshot) and adds community_pause.
-- References only objects from 0001–0008. Runs on PGlite and Supabase Postgres.

-- ───────────────────────────── Posts: per-platform publish details ─────────────────────────────
-- meta: { kind, title, mode ('publish' | 'draft_inbox'), platform_options (AI flag always true), cover_url,
--         vendor_media_urls, vendor_cover_url, q4_report_id, blocked_reason, blocked_at, inbox_sent_at }
ALTER TABLE post ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX post_slot_platform_idx ON post (calendar_slot_id, platform);
CREATE INDEX post_status_due_idx ON post (status, scheduled_at);
CREATE INDEX post_external_idx ON post (external_id) WHERE external_id IS NOT NULL;

-- ───────────────────────────── Accounts: vendor link, label tracking, setup state ─────────────────────────────
-- meta: { ai_label_source ('owner' | 'vendor'), ai_label_checked_at, vendor_handle, last_dm_poll_at, synced_at }
ALTER TABLE account ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ───────────────────────────── Comments ─────────────────────────────
ALTER TABLE comment
  ADD COLUMN account_id  uuid REFERENCES account(id),
  ADD COLUMN severity    text CHECK (severity IN ('S1','S2','S3')),
  ADD COLUMN handled_at  timestamptz;
CREATE UNIQUE INDEX comment_external_idx ON comment (persona_id, platform, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX comment_status_idx ON comment (persona_id, status, created_at);

-- ───────────────────────────── DM threads ─────────────────────────────
ALTER TABLE dm_thread
  ADD COLUMN account_id       uuid REFERENCES account(id),
  ADD COLUMN paused_reason    text,
  ADD COLUMN last_handled_at  timestamptz,
  ADD COLUMN needs_handling   boolean NOT NULL DEFAULT false,
  ADD COLUMN meta             jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX dm_thread_external_idx ON dm_thread (persona_id, platform, external_id) WHERE external_id IS NOT NULL;

-- ───────────────────────────── Escalations ─────────────────────────────
ALTER TABLE escalation
  ADD COLUMN summary          text,
  ADD COLUMN notification_id  uuid;

-- ───────────────────────────── Metric windows (cumulative per post at 1h / 24h / 72h / 7d) ─────────────────────────────
-- "window" is a reserved word: always quote it.
ALTER TABLE metric_snapshot ADD COLUMN "window" text CHECK ("window" IN ('1h','24h','72h','7d'));
CREATE UNIQUE INDEX metric_snapshot_post_window_idx ON metric_snapshot (post_id, "window") WHERE post_id IS NOT NULL AND "window" IS NOT NULL;
CREATE INDEX metric_snapshot_post_idx ON metric_snapshot (post_id, captured_on);

-- ───────────────────────────── Community pauses (S1: the bot stops replying to this person) ─────────────────────────────
CREATE TABLE community_pause (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id  uuid NOT NULL REFERENCES persona(id),
  platform    text NOT NULL,
  user_ref    text NOT NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  cleared_by  text,
  cleared_at  timestamptz
);
CREATE INDEX community_pause_active_idx ON community_pause (persona_id, platform, user_ref) WHERE cleared_at IS NULL;
