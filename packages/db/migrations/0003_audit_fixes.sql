-- 0003: fixes from the IOS-1 audit.

-- Posts default to L1 (green auto-publishes after the veto window); the studio default_autonomy setting is
-- applied when a persona goes live (SETUP → TESTING).
ALTER TABLE persona ALTER COLUMN autonomy SET DEFAULT 'L1';

-- FR-17.3: TRUNCATE skips row triggers, so block it with a statement trigger too.
-- Deploy note (IOS-5, Supabase): run the app as a non-owner role and
--   REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM <app role>;
-- with the tables owned by a separate migration role, so the app can't disable or drop these triggers.
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

-- Credit holds: a paid call reserves its estimate before it runs (so concurrent calls can't all fit in the same
-- headroom), then the hold is settled to the actual debit or released.
ALTER TABLE credit_ledger DROP CONSTRAINT credit_ledger_entry_type_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_entry_type_check CHECK (entry_type IN ('debit','grant','hold'));
