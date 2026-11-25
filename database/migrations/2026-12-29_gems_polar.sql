-- Kim cuong packs sold by card through Polar (USD). The price is read from the Polar product when the team
-- saves the pack in /admin/gems-content; a pack with no product is sold by bank transfer only.
-- Only adds columns: safe to run before the code is deployed.
ALTER TABLE xu_packs ADD COLUMN IF NOT EXISTS polar_product_id varchar(64);
ALTER TABLE xu_packs ADD COLUMN IF NOT EXISTS price_usd_cents integer;
CREATE UNIQUE INDEX IF NOT EXISTS xu_packs_polar_product ON xu_packs (polar_product_id) WHERE polar_product_id IS NOT NULL;
