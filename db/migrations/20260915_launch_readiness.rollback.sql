-- ============================================================================
-- ROLLBACK for 20260915_launch_readiness
-- ----------------------------------------------------------------------------
-- DESTRUCTIVE. Removes the columns and tables the migration added, and with
-- them: verification state, webhook event history, review-link tokens,
-- redemption slots and order ownership links.
--
-- Prefer rolling back the APPLICATION (redeploy the previous Vercel
-- deployment) and leaving this schema in place: every addition is additive and
-- the previous code ignores unknown columns and tables. Run this only if the
-- schema itself must be removed, and only after restoring/confirming a backup.
--
-- IMPORTANT: once real orders exist in 'awaiting_verification', the previous
-- code does not understand that state. Resolve those orders first (reconcile
-- them to 'paid' or back to 'pending') before redeploying older code.
-- ============================================================================

BEGIN;

UPDATE orders SET payment_status = 'pending' WHERE payment_status = 'awaiting_verification';
UPDATE discount_redemptions SET status = 'released' WHERE status = 'expired';

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;

DROP INDEX IF EXISTS orders_ship_email_normalized_idx;
DROP INDEX IF EXISTS orders_verified_owner_idx;
DROP INDEX IF EXISTS orders_payment_open_idx;
DROP INDEX IF EXISTS review_requests_access_token_key;
DROP INDEX IF EXISTS discount_redemptions_slot_key;

ALTER TABLE orders DROP COLUMN IF EXISTS ship_email_normalized;
ALTER TABLE orders DROP COLUMN IF EXISTS placed_by_customer_id;
ALTER TABLE orders DROP COLUMN IF EXISTS verified_owner_customer_id;
ALTER TABLE orders DROP COLUMN IF EXISTS pending_payment_id;
ALTER TABLE orders DROP COLUMN IF EXISTS payment_captured_amount;
ALTER TABLE orders DROP COLUMN IF EXISTS payment_currency;
ALTER TABLE orders DROP COLUMN IF EXISTS payment_confirmed_via;
ALTER TABLE orders DROP COLUMN IF EXISTS payment_checked_at;
ALTER TABLE orders DROP COLUMN IF EXISTS payment_note;

ALTER TABLE customers DROP COLUMN IF EXISTS email_verified_at;
ALTER TABLE customers DROP COLUMN IF EXISTS phone_verified_at;

ALTER TABLE review_requests DROP COLUMN IF EXISTS access_token_hash;
ALTER TABLE review_requests DROP COLUMN IF EXISTS access_token_expires_at;
ALTER TABLE reviews DROP COLUMN IF EXISTS access_method;

ALTER TABLE discount_redemptions DROP COLUMN IF EXISTS allowance_slot;
ALTER TABLE discount_redemptions DROP COLUMN IF EXISTS slot_key;

DROP TABLE IF EXISTS verification_challenges;
DROP TABLE IF EXISTS payment_events;

DELETE FROM schema_migrations WHERE version = '20260915_launch_readiness';

COMMIT;
