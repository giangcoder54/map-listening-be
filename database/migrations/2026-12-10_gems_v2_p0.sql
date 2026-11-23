-- Kim cương v2, giai đoạn P0: nền móng (web repo docs/xu-v2-backend.md mục 3, docs/xu-v2-tasks.md P0).
-- The currency is shown as "Kim cương" (Gems); in the database it stays coins / coin_events.
--
--   growth_settings.coin_settings  overrides of the numbers in lib/coins.ts COIN (jsonb, empty = defaults)
--   growth_settings.gems_flags     on/off per Kim cương v2 feature: "off" | "staff" | "all"
--   coin_events.meta               where a row came from (star, chest, card, purchase...)
--   coin_events.balance_after      the purse right after this row, to check the ledger
--   user_xp.coins_debt             Kim cương owed after a chargeback that the purse could not cover
--   coin_daily                     totals per day and reason, written each night, read by the admin stats
-- Only adds tables and columns: safe to run before the code is deployed.

ALTER TABLE growth_settings ADD COLUMN IF NOT EXISTS coin_settings jsonb;
ALTER TABLE growth_settings ADD COLUMN IF NOT EXISTS gems_flags jsonb;

INSERT INTO directus_fields (collection, field, special, interface, options, readonly, hidden, sort, width, note)
SELECT 'growth_settings', f.field, f.special, f.interface, f.options::json, f.readonly, f.hidden, f.sort, f.width, f.note
FROM (VALUES
	('coin_settings', 'cast-json', 'input-code', '{"language":"JSON","lineNumber":true}', false, false, 40, 'full',
	 'Kim cương: con số ghi đè lib/coins.ts COIN, ví dụ {"unlock":{"pattern":120},"freeze":60}. Trống = mặc định. Có hiệu lực trong 1 phút.'),
	('gems_flags', 'cast-json', 'input-code', '{"language":"JSON","lineNumber":true}', false, false, 41, 'full',
	 'Kim cương v2: bật/tắt từng phần, mỗi giá trị là "off" | "staff" | "all", ví dụ {"stars":"staff"}. Trống = tắt hết.')
) AS f(field, special, interface, options, readonly, hidden, sort, width, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields d WHERE d.collection = 'growth_settings' AND d.field = f.field);

ALTER TABLE coin_events ADD COLUMN IF NOT EXISTS meta jsonb;
ALTER TABLE coin_events ADD COLUMN IF NOT EXISTS balance_after integer;

ALTER TABLE coin_events DROP CONSTRAINT IF EXISTS coin_events_reason_check;
ALTER TABLE coin_events ADD CONSTRAINT coin_events_reason_check CHECK (reason IN (
	'lesson', 'perfect', 'goal', 'streak', 'review', 'ad', 'unlock', 'premium_day', 'freeze', 'retest', 'refund', 'admin', 'trap',
	'streak_milestone', 'skill_test', 'replay', 'phrase_unlock', 'ai', 'challenge', 'bank',
	-- Kim cương v2
	'star', 'chest', 'card', 'card_skip', 'recovery', 'purchase', 'chargeback', 'room_fee', 'room_prize', 'help'
));
CREATE INDEX IF NOT EXISTS coin_events_day_reason ON coin_events (day, reason);

ALTER TABLE user_xp ADD COLUMN IF NOT EXISTS coins_debt integer NOT NULL DEFAULT 0;
ALTER TABLE user_xp DROP CONSTRAINT IF EXISTS user_xp_coins_debt_check;
ALTER TABLE user_xp ADD CONSTRAINT user_xp_coins_debt_check CHECK (coins_debt >= 0);

CREATE TABLE IF NOT EXISTS coin_daily (
	day       date        NOT NULL,
	reason    varchar(20) NOT NULL,
	earned    bigint      NOT NULL DEFAULT 0,
	spent     bigint      NOT NULL DEFAULT 0,
	events    integer     NOT NULL DEFAULT 0,
	users     integer     NOT NULL DEFAULT 0,
	PRIMARY KEY (day, reason)
);

-- Results of the nightly ledger check: one row per user whose purse does not match the ledger
CREATE TABLE IF NOT EXISTS coin_mismatches (
	id          bigserial PRIMARY KEY,
	checked_on  date        NOT NULL,
	user_id     uuid        NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	ledger      bigint      NOT NULL,
	purse       bigint      NOT NULL,
	debt        bigint      NOT NULL,
	resolved_at timestamptz,
	UNIQUE (checked_on, user_id)
);
