-- =====================================================================
-- Xu economy (web repo: docs/xu-economy-plan.md)
--   - phrase_unlocks: Phrase Lab phrases bought with Xu (lib/coins.ts unlockPhrase), like
--     listening_unlocks for lessons. A bought phrase is open for good and covers its AI checks.
--   - coin_events.reason: the new ways to win and spend Xu.
--   - phrase_roleplay_checks.paid: an AI check that cost Xu (a free phrase beyond its free ones)
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS phrase_unlocks (
	user_id       uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	phrase_id     uuid NOT NULL REFERENCES phrases(id) ON DELETE CASCADE,
	source        varchar(20) NOT NULL DEFAULT 'coins' CHECK (source IN ('coins', 'gift')),
	coin_event_id bigint,
	created_at    timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, phrase_id)
);

ALTER TABLE coin_events DROP CONSTRAINT IF EXISTS coin_events_reason_check;
ALTER TABLE coin_events ADD CONSTRAINT coin_events_reason_check CHECK (reason IN (
	'lesson', 'perfect', 'goal', 'streak', 'review', 'ad', 'unlock', 'premium_day', 'freeze', 'retest', 'refund', 'admin', 'trap',
	'streak_milestone', 'skill_test', 'replay', 'phrase_unlock', 'ai'
));

ALTER TABLE phrase_roleplay_checks ADD COLUMN IF NOT EXISTS paid boolean NOT NULL DEFAULT false;

COMMIT;
