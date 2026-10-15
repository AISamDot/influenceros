-- IOS-4 stream G: commerce (Lemon Squeezy), persona sites, Resend lists and sequences, membership, attribution.
-- docs/IOS-34-CONTRACTS.md §4 (stream G tables). References only 0001–0008 objects and this file's own.

-- ───────────────────────────── Studio commerce settings ─────────────────────────────

-- Physical-address footer (CAN-SPAM) and the sender domain for persona lists. Owner-set on /commerce.
CREATE TABLE commerce_settings (
  studio_id         uuid PRIMARY KEY REFERENCES studio(id),
  physical_address  text,
  sender_domain     text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── Stores and products ─────────────────────────────

-- One Lemon Squeezy store per persona (linked by the store sync or by the Owner).
CREATE TABLE store_account (
  persona_id    uuid PRIMARY KEY REFERENCES persona(id),
  store_id      text UNIQUE,
  store_name    text,
  store_slug    text,
  store_domain  text,
  currency      text,
  status        text NOT NULL DEFAULT 'unlinked' CHECK (status IN ('unlinked','linked')),
  synced_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Store status of a product: the API-less path is a listing pack plus a stored checkout URL.
ALTER TABLE product
  ADD COLUMN store_id          text,
  ADD COLUMN store_variant_id  text,
  ADD COLUMN checkout_url      text,
  ADD COLUMN store_status      text NOT NULL DEFAULT 'none'
                                 CHECK (store_status IN ('none','listing_pack','awaiting_listing','linked','free')),
  ADD COLUMN store_checked_at  timestamptz,
  ADD COLUMN live_at           timestamptz;

-- Signed webhooks are processed once (replays are acknowledged and skipped).
CREATE TABLE commerce_webhook_event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL CHECK (provider IN ('lemonsqueezy','resend')),
  event_key   text NOT NULL,
  event_type  text NOT NULL,
  status      text NOT NULL CHECK (status IN ('processed','ignored','failed')),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_key)
);

ALTER TABLE orders
  ADD COLUMN store_id          text,
  ADD COLUMN store_product_id  text,
  ADD COLUMN variant_id        text,
  ADD COLUMN discount_code     text,
  ADD COLUMN attribution       text NOT NULL DEFAULT 'none' CHECK (attribution IN ('custom_data','coupon','short_link','none'));
CREATE INDEX orders_source_post_idx ON orders (source_post_id) WHERE source_post_id IS NOT NULL;

-- One refund row per store order, holding the cumulative refunded amount (webhooks are cumulative).
ALTER TABLE refund ADD COLUMN store_ref text;
CREATE UNIQUE INDEX refund_store_ref_idx ON refund (store_ref) WHERE store_ref IS NOT NULL;

-- ───────────────────────────── Attribution ─────────────────────────────

ALTER TABLE short_link
  ADD COLUMN target_path    text,
  ADD COLUMN last_click_at  timestamptz;
CREATE UNIQUE INDEX short_link_post_idx ON short_link (post_id) WHERE post_id IS NOT NULL;

ALTER TABLE coupon
  ADD COLUMN store_discount_id  text,
  ADD COLUMN status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending_store','expired'));
CREATE UNIQUE INDEX coupon_post_idx ON coupon (source_post_id) WHERE source_post_id IS NOT NULL;

-- Clicks per short link per day (no personal data).
CREATE TABLE commerce_click_day (
  short_link_id  uuid NOT NULL REFERENCES short_link(id),
  day            date NOT NULL,
  clicks         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (short_link_id, day)
);

-- ───────────────────────────── Audience ─────────────────────────────

ALTER TABLE subscriber DROP CONSTRAINT subscriber_status_check;
ALTER TABLE subscriber ADD CONSTRAINT subscriber_status_check CHECK (status IN ('pending','active','unsubscribed','bounced','complained'));
ALTER TABLE subscriber
  ADD COLUMN first_name       text,
  ADD COLUMN email_hash       text,
  ADD COLUMN double_opt_in    boolean NOT NULL DEFAULT false,
  ADD COLUMN region           text,
  ADD COLUMN confirmed_at     timestamptz,
  ADD COLUMN unsubscribed_at  timestamptz,
  ADD COLUMN unsub_token      text,
  ADD COLUMN tags             jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN source           text,
  ADD COLUMN short_link_id    uuid REFERENCES short_link(id),
  ADD COLUMN contact_id       text,
  ADD COLUMN updated_at       timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX subscriber_unsub_token_idx ON subscriber (unsub_token) WHERE unsub_token IS NOT NULL;
CREATE INDEX subscriber_email_hash_idx ON subscriber (persona_id, email_hash);

-- Consent log (GDPR / CAN-SPAM): what was shown, when, where from. Never edited.
CREATE TABLE consent_record (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id     uuid NOT NULL REFERENCES persona(id),
  subscriber_id  uuid NOT NULL REFERENCES subscriber(id),
  kind           text NOT NULL CHECK (kind IN ('opt_in_requested','opt_in','confirmed','unsubscribed','complaint','bounced')),
  wording        text,
  source         text,
  region         text,
  ip_hash        text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_record_subscriber_idx ON consent_record (subscriber_id, created_at);

-- One Resend audience (list) per persona.
CREATE TABLE email_list (
  persona_id   uuid PRIMARY KEY REFERENCES persona(id),
  audience_id  text NOT NULL,
  from_name    text NOT NULL,
  from_email   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One-time and short-lived tokens (double opt-in, member sign-in links, downloads). Only hashes are stored.
CREATE TABLE email_token (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id     uuid NOT NULL REFERENCES persona(id),
  subscriber_id  uuid REFERENCES subscriber(id),
  membership_id  uuid REFERENCES membership(id),
  purpose        text NOT NULL CHECK (purpose IN ('confirm','member_login','download')),
  token_hash     text NOT NULL UNIQUE,
  ref            jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE email_sequence
  ADD COLUMN version       integer NOT NULL DEFAULT 1,
  ADD COLUMN gate_verdict  text CHECK (gate_verdict IN ('green','amber','red')),
  ADD COLUMN updated_at    timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX email_sequence_active_idx ON email_sequence (persona_id, kind) WHERE status = 'active';

-- A subscriber's place in a sequence (by kind: the active sequence of that kind is resolved at send time).
CREATE TABLE email_enrollment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id     uuid NOT NULL REFERENCES persona(id),
  subscriber_id  uuid NOT NULL REFERENCES subscriber(id),
  kind           text NOT NULL CHECK (kind IN ('welcome','launch','nurture','winback')),
  next_step      integer NOT NULL DEFAULT 0,
  started_at     timestamptz NOT NULL DEFAULT now(),
  next_at        timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','stopped')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscriber_id, kind)
);
CREATE INDEX email_enrollment_due_idx ON email_enrollment (status, next_at);

CREATE TABLE email_broadcast (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id    uuid NOT NULL REFERENCES persona(id),
  subject       text NOT NULL,
  body          text NOT NULL,
  gate_verdict  text CHECK (gate_verdict IN ('green','amber','red')),
  gate_checks   jsonb NOT NULL DEFAULT '[]'::jsonb,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','blocked')),
  provider_id   text,
  created_by    text NOT NULL,
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Every email sent (the provider id links webhook events back to the subscriber).
CREATE TABLE email_message (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id     uuid NOT NULL REFERENCES persona(id),
  subscriber_id  uuid REFERENCES subscriber(id),
  sequence_id    uuid REFERENCES email_sequence(id),
  step           integer,
  broadcast_id   uuid REFERENCES email_broadcast(id),
  kind           text NOT NULL CHECK (kind IN ('sequence','confirm','member_login','broadcast')),
  provider_id    text UNIQUE,
  subject        text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE email_event DROP CONSTRAINT email_event_type_check;
ALTER TABLE email_event ADD CONSTRAINT email_event_type_check CHECK (type IN
  ('sent','delivered','opened','clicked','replied','bounced','unsubscribed','complained','confirmed','subscribed'));
ALTER TABLE email_event ADD COLUMN message_id uuid REFERENCES email_message(id);
CREATE INDEX email_event_persona_idx ON email_event (persona_id, created_at);

-- ───────────────────────────── Membership ─────────────────────────────

ALTER TABLE membership
  ADD COLUMN store_subscription_id  text,
  ADD COLUMN product_id             uuid REFERENCES product(id),
  ADD COLUMN email_hash             text,
  ADD COLUMN email                  text,                     -- to reach paying members (sign-in links, drops)
  ADD COLUMN ends_at                timestamptz,
  ADD COLUMN past_due_since         timestamptz,
  ADD COLUMN source_post_id         uuid REFERENCES post(id),
  ADD COLUMN updated_at             timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX membership_store_sub_idx ON membership (store_subscription_id) WHERE store_subscription_id IS NOT NULL;
CREATE INDEX membership_email_idx ON membership (persona_id, email_hash);

-- Magic-link sessions for the members area (cookie ios_member; only the hash is stored).
CREATE TABLE member_session (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id     uuid NOT NULL REFERENCES persona(id),
  membership_id  uuid NOT NULL REFERENCES membership(id),
  token_hash     text NOT NULL UNIQUE,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- The monthly drop members get (one per persona per month).
CREATE TABLE member_drop (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id       uuid NOT NULL REFERENCES persona(id),
  month            text NOT NULL CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
  title            text NOT NULL,
  summary          text,
  product_id       uuid REFERENCES product(id),
  product_version  integer,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready')),
  announced_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (persona_id, month)
);

-- ───────────────────────────── Sites ─────────────────────────────

-- Fixed-window rate limits for the public endpoints (bucket = action + hashed client).
CREATE TABLE site_rate_limit (
  bucket        text NOT NULL,
  window_start  timestamptz NOT NULL,
  hits          integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
