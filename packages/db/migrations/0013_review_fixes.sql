-- 0013 (IOS-3/4 review fixes). Additive only. Runs on PGlite and Supabase Postgres.

-- Membership: the vendor's updated_at of the last subscription event applied, so a late or out-of-order event
-- (a retried invoice after expiry, an old "active" after "cancelled") never overwrites a newer state.
ALTER TABLE membership ADD COLUMN store_updated_at timestamptz;

-- Subscribers: false while a local unsubscribe / complaint / bounce hasn't reached the email provider yet. Broadcasts
-- go to the provider's audience, so they are refused while any subscriber of the persona is unsynced, and the
-- email.send_due sweep retries the sync.
ALTER TABLE subscriber ADD COLUMN provider_synced boolean NOT NULL DEFAULT true;
CREATE INDEX subscriber_unsynced_idx ON subscriber (persona_id) WHERE provider_synced = false;

-- Approvals: 'qc_override' = the Owner publishes a post whose QC failed on majors only, with a reason (FR-21.5/21.6).
-- Owner-only (explicit, never auto-approved). Blockers can never be overridden; the engine refuses those cards.
ALTER TABLE approval DROP CONSTRAINT approval_kind_check;
ALTER TABLE approval ADD CONSTRAINT approval_kind_check CHECK (kind IN (
  'persona_kill','persona_retire','spend_over_cap','plan_upgrade',
  'disclosure_change','legal_text_change','persona_launch','product_v1','post','qc_override'));
ALTER TABLE approval DROP CONSTRAINT approval_owner_only_kinds;
ALTER TABLE approval ADD CONSTRAINT approval_owner_only_kinds CHECK (
  kind NOT IN ('persona_kill','persona_retire','spend_over_cap','plan_upgrade','disclosure_change','legal_text_change','qc_override')
  OR (mode = 'explicit' AND auto_approve_at IS NULL AND status <> 'auto_approved'
      AND (status <> 'approved' OR decided_by LIKE 'owner:%'))
);
