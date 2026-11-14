-- =====================================================================
-- Weekly challenge (web repo: docs/weekly-challenge-plan.md)
--   - A challenge round is a lesson of kind 'challenge' (its clips, answers and practice steps as
--     usual), kept out of the lesson path. listening_challenges says when it is open and its rules.
--   - Two rounds a week: 'normal' (free) and 'hard' (Xu, Premium free, after passing the normal one).
--   - listening_challenge_results: the first go finished while the challenge is open, one per
--     learner: what the "x% passed" numbers count. Later goes are practice only.
--   - listening_runs.mode 'challenge', with challenge_id.
--   - coin_events.reason 'challenge' (Xu won by passing).
-- =====================================================================

BEGIN;

ALTER TABLE listening_lessons DROP CONSTRAINT IF EXISTS listening_lessons_kind_check;
ALTER TABLE listening_lessons ADD CONSTRAINT listening_lessons_kind_check CHECK (kind IN ('pattern', 'trap', 'mixed', 'challenge'));

CREATE TABLE IF NOT EXISTS listening_challenges (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	lesson_id     uuid NOT NULL UNIQUE REFERENCES listening_lessons(id) ON DELETE CASCADE,
	-- ISO week, e.g. 2026-W47; one normal and one hard round a week
	week          varchar(10) NOT NULL,
	tier          varchar(10) NOT NULL DEFAULT 'normal' CHECK (tier IN ('normal', 'hard')),
	status        varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
	starts_at     timestamptz NOT NULL,
	ends_at       timestamptz NOT NULL,
	pass_score    smallint NOT NULL DEFAULT 7,
	max_listens   smallint NOT NULL DEFAULT 3 CHECK (max_listens BETWEEN 1 AND 10),
	-- Xu to open it; NULL: the default for its tier and age (lib/challenges.ts)
	price_xu      integer,
	participants  integer NOT NULL DEFAULT 0,
	passed_count  integer NOT NULL DEFAULT 0,
	-- % of official goes right, per clip: kept once the challenge is closed
	item_stats    jsonb,
	date_created  timestamptz NOT NULL DEFAULT now(),
	CHECK (ends_at > starts_at),
	UNIQUE (week, tier)
);
CREATE INDEX IF NOT EXISTS listening_challenges_time ON listening_challenges (starts_at DESC) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS listening_challenge_results (
	challenge_id  uuid NOT NULL REFERENCES listening_challenges(id) ON DELETE CASCADE,
	learner_key   varchar(80) NOT NULL,
	user_id       uuid REFERENCES directus_users(id) ON DELETE SET NULL,
	run_id        uuid REFERENCES listening_runs(id) ON DELETE SET NULL,
	score         smallint NOT NULL,
	total         smallint NOT NULL,
	passed        boolean NOT NULL,
	finished_at   timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (challenge_id, learner_key)
);
CREATE INDEX IF NOT EXISTS listening_challenge_results_user ON listening_challenge_results (user_id) WHERE user_id IS NOT NULL;

ALTER TABLE listening_runs DROP CONSTRAINT IF EXISTS listening_runs_mode_check;
ALTER TABLE listening_runs ADD CONSTRAINT listening_runs_mode_check CHECK (mode IN ('learn', 'lesson_test', 'skill_test', 'review', 'challenge'));
ALTER TABLE listening_runs ADD COLUMN IF NOT EXISTS challenge_id uuid REFERENCES listening_challenges(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS listening_runs_challenge ON listening_runs (challenge_id, learner_key) WHERE challenge_id IS NOT NULL;

ALTER TABLE coin_events DROP CONSTRAINT IF EXISTS coin_events_reason_check;
ALTER TABLE coin_events ADD CONSTRAINT coin_events_reason_check CHECK (reason IN (
	'lesson', 'perfect', 'goal', 'streak', 'review', 'ad', 'unlock', 'premium_day', 'freeze', 'retest', 'refund', 'admin', 'trap',
	'streak_milestone', 'skill_test', 'replay', 'phrase_unlock', 'ai', 'challenge'
));

COMMIT;
