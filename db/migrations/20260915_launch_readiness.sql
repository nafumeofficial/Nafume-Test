-- ============================================================================
-- NAFUME migration 20260915_launch_readiness
-- ----------------------------------------------------------------------------
-- For a database that ALREADY has db/schema.sql applied. Additive only: no
-- DROP, no DELETE, no TRUNCATE, no column type changes. Every statement is
-- guarded, so running it twice is a no-op.
--
-- Adds what the ownership, payment-confirmation and delivery-gated review fixes
-- need:
--   customers                verified identifiers (email/phone verified_at)
--   orders                   verified owner, normalized email, payment
--                            confirmation detail, awaiting_verification state
--   verification_challenges  expiring, single-use, attempt-limited codes
--   payment_events           webhook event de-duplication / audit
--   review_requests          hashed review-link token
--   discount_redemptions     allowance slots (DB-level reuse protection)
--
-- BEFORE RUNNING ON PRODUCTION: take a backup (see NAFUME-READINESS-REPORT.md
-- §Production migration). Apply to the isolated test project first.
-- Rollback: db/migrations/20260915_launch_readiness.rollback.sql
-- ============================================================================

BEGIN;

-- ── customers: which identifiers has the customer PROVEN they control? ──────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;

-- ── orders ──────────────────────────────────────────────────────────────────
-- verified_owner_customer_id is the ONLY thing that lets a signed-in customer
-- see an order. It is set when the order is placed from an authenticated
-- session, or when a customer proves control of the email/phone the order was
-- placed with. customer_id alone (matched from typed checkout details) grants
-- nothing.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_email_normalized     TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS placed_by_customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS verified_owner_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;

-- Payment confirmation detail. payment_status gains 'awaiting_verification':
-- the customer reported a payment we could not yet confirm as CAPTURED.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pending_payment_id       TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_captured_amount  INTEGER;   -- paise, as Razorpay reported
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_currency         TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_confirmed_via    TEXT;      -- checkout_callback | webhook | reconciliation | status_refresh
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_checked_at       TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_note             TEXT;

UPDATE orders
   SET ship_email_normalized = lower(btrim(ship_email))
 WHERE ship_email IS NOT NULL AND ship_email_normalized IS NULL;

CREATE INDEX IF NOT EXISTS orders_ship_email_normalized_idx ON orders (ship_email_normalized);
CREATE INDEX IF NOT EXISTS orders_verified_owner_idx        ON orders (verified_owner_customer_id);
CREATE INDEX IF NOT EXISTS orders_payment_open_idx          ON orders (payment_status, created_at)
  WHERE payment_status IN ('pending', 'awaiting_verification');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_payment_status_check') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
      CHECK (payment_status IN ('pending', 'awaiting_verification', 'paid', 'failed', 'refunded')) NOT VALID;
  END IF;
END $$;
ALTER TABLE orders VALIDATE CONSTRAINT orders_payment_status_check;

-- ── verification_challenges ─────────────────────────────────────────────────
-- One row per code sent. Codes are stored only as an HMAC; the email body that
-- carried the code is redacted in outbound_messages. live_key is non-null only
-- while the challenge is usable, so the partial UNIQUE index allows exactly one
-- live challenge per (purpose, channel, identifier).
CREATE TABLE IF NOT EXISTS verification_challenges (
  id              UUID PRIMARY KEY,
  purpose         TEXT        NOT NULL,             -- account_register | phone_login | link_identifier
  channel         TEXT        NOT NULL,             -- email | phone
  identifier      TEXT        NOT NULL,             -- normalized email / 10-digit phone
  customer_id     UUID        REFERENCES customers(id) ON DELETE CASCADE,
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  code_hash       TEXT,                             -- NULL when the provider holds the code (MSG91)
  provider        TEXT        NOT NULL,             -- resend | msg91
  attempts        INTEGER     NOT NULL DEFAULT 0,
  max_attempts    INTEGER     NOT NULL DEFAULT 5,
  send_count      INTEGER     NOT NULL DEFAULT 1,
  last_sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  invalidated_at  TIMESTAMPTZ,
  live_key        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS verification_challenges_live_key
  ON verification_challenges (live_key) WHERE live_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS verification_challenges_identifier_idx
  ON verification_challenges (channel, identifier, created_at DESC);
CREATE INDEX IF NOT EXISTS verification_challenges_expiry_idx
  ON verification_challenges (expires_at);

-- ── payment_events ──────────────────────────────────────────────────────────
-- Every authenticated webhook delivery, keyed by provider event id
-- (x-razorpay-event-id). A redelivery or concurrent duplicate hits the UNIQUE
-- index instead of being processed as new.
CREATE TABLE IF NOT EXISTS payment_events (
  id                  UUID PRIMARY KEY,
  event_key           TEXT        NOT NULL,         -- "razorpay:<event id>"
  provider            TEXT        NOT NULL DEFAULT 'razorpay',
  event_type          TEXT,
  razorpay_payment_id TEXT,
  razorpay_order_id   TEXT,
  outcome             TEXT,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at        TIMESTAMPTZ,
  attempts            INTEGER     NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_events_event_key ON payment_events (event_key);
CREATE INDEX IF NOT EXISTS payment_events_payment_idx ON payment_events (razorpay_payment_id);

-- ── review_requests: hashed review-link token ───────────────────────────────
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS access_token_hash       TEXT;
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS access_token_expires_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS review_requests_access_token_key
  ON review_requests (access_token_hash) WHERE access_token_hash IS NOT NULL;

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS access_method TEXT;   -- session | review_link

-- ── discount_redemptions: allowance slots ───────────────────────────────────
-- slot_key = code|customer_id|slot while the redemption holds an allowance.
-- The partial UNIQUE index makes a parallel second use of the same reward
-- impossible at the database level. status gains 'expired' (a stale unpaid
-- hold that gave its slot back).
ALTER TABLE discount_redemptions ADD COLUMN IF NOT EXISTS allowance_slot INTEGER;
ALTER TABLE discount_redemptions ADD COLUMN IF NOT EXISTS slot_key       TEXT;

WITH ranked AS (
  SELECT d.id, d.code, d.customer_id,
         row_number() OVER (PARTITION BY d.code, d.customer_id ORDER BY d.created_at, d.id) AS n
    FROM discount_redemptions d
   WHERE d.status IN ('pending', 'redeemed')
     AND d.customer_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM discount_redemptions x
                      WHERE x.code = d.code AND x.customer_id = d.customer_id AND x.slot_key IS NOT NULL)
)
UPDATE discount_redemptions t
   SET allowance_slot = r.n,
       slot_key       = r.code || '|' || r.customer_id::text || '|' || r.n::text
  FROM ranked r
 WHERE t.id = r.id;

CREATE UNIQUE INDEX IF NOT EXISTS discount_redemptions_slot_key
  ON discount_redemptions (slot_key) WHERE slot_key IS NOT NULL;

-- ── Row Level Security on the new tables (no policies = no anon access) ────
ALTER TABLE verification_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events          ENABLE ROW LEVEL SECURITY;

-- ── Record that this migration ran ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
INSERT INTO schema_migrations (version) VALUES ('20260915_launch_readiness')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
