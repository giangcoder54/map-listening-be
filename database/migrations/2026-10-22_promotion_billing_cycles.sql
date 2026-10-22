-- =====================================================================
-- Coupons limited to some billing cycles.
--
--   promotions.billing_cycles   cycles the coupon works for: 1 = monthly, 12 = yearly,
--                               0 = lifetime. NULL = every cycle (coupons made before this).
-- Checked at /v1/promotions/validate, /v1/checkout and /v1/polar/checkout (lib/promotions.ts).
-- Safe to run twice. Only the custom API reads it: no Directus cache to clear.
-- =====================================================================

BEGIN;

ALTER TABLE promotions ADD COLUMN IF NOT EXISTS billing_cycles integer[];

COMMIT;
