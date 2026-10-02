-- =====================================================================
-- Lifetime Premium: pay once, Premium forever.
--
-- No new table: lifetime is one more price of the Premium plan, with the convention
--   plan_prices.duration_month       = 0  -> lifetime price (total_price = the one payment)
--   purchase_histories.billing_cycle = 0  -> lifetime order
--   directus_users.subscription_type = 'lifetime', premium_until = NULL -> never expires
-- isPremiumUser() already treats premium_until NULL as "no end date".
-- =====================================================================

BEGIN;

-- One payment: 1.499.000 đ; $119 (about 2.5 years of Yearly, like the VND price).
-- The pricing page hides the card for a currency without a lifetime price.
INSERT INTO plan_prices (id, status, date_created, plan_id, duration_month, monthly_price, currency, total_price)
SELECT gen_random_uuid(), 'published', now(), p.id, 0, NULL, v.currency, v.total
FROM plans p
CROSS JOIN (VALUES ('vnd', 1499000), ('usd', 119)) AS v(currency, total)
WHERE p.code = 'premium'
  AND NOT EXISTS (
    SELECT 1 FROM plan_prices x WHERE x.plan_id = p.id AND x.duration_month = 0 AND x.currency = v.currency
  );

-- Admin hints
UPDATE directus_fields SET note = 'Months of Premium. 0 = lifetime (one payment, never expires; set total_price).'
WHERE collection = 'plan_prices' AND field = 'duration_month';

UPDATE directus_fields SET note = 'Months bought. 0 = lifetime.'
WHERE collection = 'purchase_histories' AND field = 'billing_cycle';

UPDATE directus_fields
SET options = '{"choices":[{"text":"Pro","value":"pro"},{"text":"Premium","value":"premium"},{"text":"Lifetime","value":"lifetime"}]}'
WHERE collection = 'directus_users' AND field = 'subscription_type';

COMMIT;
