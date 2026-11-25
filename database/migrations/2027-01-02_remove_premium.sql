-- Premium (monthly, yearly, lifetime) is gone: paid lessons open with Kim cuong only. Decided 2026-11-25: nobody has
-- bought a plan for real, so no one is compensated. `is_premium` on a lesson / video / phrase stays: it means
-- "costs Kim cuong". Run once, then restart Directus (roles change here by SQL, its permission cache must clear).
BEGIN;

-- 1. Every account back to a plain learner
UPDATE directus_users SET role = (SELECT id FROM directus_roles WHERE trim(name) = 'Free User' LIMIT 1)
WHERE role IN (SELECT id FROM directus_roles WHERE trim(name) = 'Premium User');
UPDATE directus_users SET is_premium = false, premium_until = NULL, subscription_type = NULL
WHERE is_premium OR premium_until IS NOT NULL OR subscription_type IS NOT NULL;

-- 2. No plan is on sale; unpaid plan orders close (history of paid ones stays)
UPDATE plan_prices SET status = 'archived' WHERE status <> 'archived';
UPDATE plans SET status = 'archived' WHERE status <> 'archived';
UPDATE purchase_histories SET status = 'draft' WHERE status = 'pending' AND coalesce(product_type, '') <> 'coins';

-- 3. Rewards are Kim cuong
ALTER TABLE coin_events DROP CONSTRAINT IF EXISTS coin_events_reason_check;
ALTER TABLE coin_events ADD CONSTRAINT coin_events_reason_check CHECK (reason IN (
	'lesson','perfect','goal','streak','review','ad','unlock','premium_day','referral','freeze','retest','refund','admin','trap','streak_milestone',
	'skill_test','replay','phrase_unlock','ai','challenge','bank','star','chest','card','card_skip','recovery','purchase','chargeback',
	'room_fee','room_prize','help','coop','extensive','intensive'));

DELETE FROM user_rewards WHERE kind = 'premium_day';
ALTER TABLE user_rewards ADD COLUMN IF NOT EXISTS coins integer;
ALTER TABLE user_rewards DROP CONSTRAINT IF EXISTS user_rewards_kind_check;
ALTER TABLE user_rewards ADD CONSTRAINT user_rewards_kind_check CHECK (kind IN ('goal_gems', 'freeze'));

ALTER TABLE referral_conversions ADD COLUMN IF NOT EXISTS reward_coins integer;

ALTER TABLE growth_settings ADD COLUMN IF NOT EXISTS referral_reward_pct integer;
ALTER TABLE growth_settings DROP COLUMN IF EXISTS referral_reward_days;
UPDATE directus_fields SET field = 'referral_reward_pct', note = 'Kim cuong for the inviter, % of what the friend first bought (default 30)'
WHERE collection = 'growth_settings' AND field = 'referral_reward_days';

-- 4. The "Premium day" item and the Premium swap of chest drops
DELETE FROM chest_drops WHERE item_code = 'premium_day';
DELETE FROM user_items WHERE item_code = 'premium_day';
DELETE FROM item_translations WHERE code = 'premium_day';
DELETE FROM items WHERE code = 'premium_day';
ALTER TABLE chest_drops DROP COLUMN IF EXISTS premium_alt;

COMMIT;
