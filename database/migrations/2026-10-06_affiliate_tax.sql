-- Tax details of affiliates and withholding on payouts (Vietnam, seller = individual).
-- Safe to run twice.
--
--   affiliates        + legal_name, country, tax_id (CCCD / MST), business_registered,
--                       terms_accepted_at
--   affiliate_payouts + gross_amount (commission), tax_withheld (PIT kept back), and a
--                       snapshot of legal_name / tax_id / country at payout time.
--                       amount stays the money actually sent (gross - tax).

ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS legal_name varchar(255);
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS country char(2) NOT NULL DEFAULT 'VN';
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS tax_id varchar(30);
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS business_registered boolean NOT NULL DEFAULT false;
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;

ALTER TABLE affiliate_payouts ADD COLUMN IF NOT EXISTS gross_amount bigint;
ALTER TABLE affiliate_payouts ADD COLUMN IF NOT EXISTS tax_withheld bigint NOT NULL DEFAULT 0;
ALTER TABLE affiliate_payouts ADD COLUMN IF NOT EXISTS legal_name varchar(255);
ALTER TABLE affiliate_payouts ADD COLUMN IF NOT EXISTS tax_id varchar(30);
ALTER TABLE affiliate_payouts ADD COLUMN IF NOT EXISTS country char(2);
UPDATE affiliate_payouts SET gross_amount = amount WHERE gross_amount IS NULL;

CREATE INDEX IF NOT EXISTS affiliate_payouts_paid_at_idx ON affiliate_payouts (paid_at);
