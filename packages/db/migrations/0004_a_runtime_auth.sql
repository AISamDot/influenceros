-- 0004 (IOS-2 stream A): agent runtime, Owner login and the IOS-1 recheck fixes.
-- Runs on PGlite and Supabase Postgres. References only 0001–0003 objects.

-- ───────────────────────────── Queue: per-claim lease token ─────────────────────────────
-- Every claim gets a fresh token and every post-claim update matches on it, so a stale run can never overwrite a
-- newer claim of the same job, even when the new claim comes from a worker with the same id (a restarted worker).
ALTER TABLE job ADD COLUMN lease_token uuid;

-- ───────────────────────────── Agent runs ─────────────────────────────
ALTER TABLE agent_run ADD COLUMN mode text CHECK (mode IN ('live','fake'));
ALTER TABLE agent_run ADD COLUMN engine text;                                   -- 'messages' | 'agent-sdk' | 'fake'
ALTER TABLE agent_run ADD COLUMN cache_read_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE agent_run ADD COLUMN cache_write_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE agent_run ADD COLUMN tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb;  -- [{tool, ok, error?, ms}]
ALTER TABLE agent_run ADD COLUMN ref_type text;                                 -- CostRef (P&L attribution)
ALTER TABLE agent_run ADD COLUMN ref_id uuid;
ALTER TABLE agent_run ADD COLUMN error text;
CREATE INDEX agent_run_studio_idx ON agent_run (studio_id, started_at);
CREATE INDEX agent_run_persona_idx ON agent_run (persona_id, started_at);

-- ───────────────────────────── Publish recovery ─────────────────────────────
-- A post whose provider publish succeeded but whose verify call threw (or returned "processing") stays
-- 'publishing' with its external id; the recovery job re-verifies it. A post claimed but never confirmed by the
-- provider (crash before the response) goes back to 'scheduled'; the idempotency key stops a double post.
ALTER TABLE post ADD COLUMN publishing_at timestamptz;
ALTER TABLE post ADD COLUMN verify_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE post ADD COLUMN verify_error text;
CREATE INDEX post_publishing_idx ON post (publishing_at) WHERE status = 'publishing';

-- ───────────────────────────── Owner login ─────────────────────────────
-- One Owner. The fallback password is set from the CLI (`pnpm owner set-password`) and stored as an scrypt hash.
CREATE TABLE owner_credential (
  id             text PRIMARY KEY DEFAULT 'owner' CHECK (id = 'owner'),
  password_hash  text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Magic-link tokens: only the SHA-256 of the token is stored; single use; short expiry.
CREATE TABLE auth_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  purpose     text NOT NULL CHECK (purpose IN ('magic_link')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Sessions: the cookie carries a signed session id; signing out (or `pnpm owner sessions revoke`) revokes the row.
CREATE TABLE auth_session (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  method        text NOT NULL CHECK (method IN ('magic_link','password')),
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);

-- Throttling for sign-in attempts (IP stored only as a salted hash).
CREATE TABLE auth_attempt (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('magic_link','password','verify')),
  ok          boolean NOT NULL,
  ip_hash     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempt_recent_idx ON auth_attempt (kind, created_at);
