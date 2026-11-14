-- =====================================================================
-- Practice bank, "Kho bài tập" (web repo: docs/practice-bank-plan.md)
--   - practice_videos: one entry per video. Each published clip of that video is one item of the
--     bank, a single sentence (lib/bank.ts), so a clip made for a lesson or a past challenge is in the bank too. A clip of a
--     challenge that is still open stays out (the challenge is made of bank clips; its answers
--     must not leak).
--   - practice_clip_progress: what a learner did on each sentence (heard right once, goes taken).
--   - practice_video_unlocks: a Premium video bought with Xu, kept for good.
--   - listening_runs.mode 'bank', with practice_id (the video) and clip_id (the sentence).
--   - coin_events.reason 'bank' (Xu won on a sentence); unlocking uses reason 'unlock'.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS practice_videos (
	id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	short_id        varchar(20) NOT NULL UNIQUE,
	source_video_id uuid NOT NULL UNIQUE REFERENCES source_videos(id) ON DELETE CASCADE,
	-- shown on the card; the video's own title unless the team writes a nicer one
	title           varchar(200) NOT NULL,
	status          varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
	-- Premium video: Xu to open it (price_xu, else the default), free with Premium
	is_premium      boolean NOT NULL DEFAULT false,
	price_xu        integer,
	sort            integer NOT NULL DEFAULT 0,
	date_created    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS practice_videos_list ON practice_videos (status, sort);

-- What a learner did on each sentence: heard right at least once (the card shows a check), goes taken
CREATE TABLE IF NOT EXISTS practice_clip_progress (
	user_id          uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	clip_id          uuid NOT NULL REFERENCES listening_clips(id) ON DELETE CASCADE,
	right_once       boolean NOT NULL DEFAULT false,
	plays            integer NOT NULL DEFAULT 0,
	first_right_at   timestamptz,
	last_played_at   timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, clip_id)
);
CREATE INDEX IF NOT EXISTS practice_clip_progress_clip ON practice_clip_progress (clip_id);

CREATE TABLE IF NOT EXISTS practice_video_unlocks (
	user_id       uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	practice_id   uuid NOT NULL REFERENCES practice_videos(id) ON DELETE CASCADE,
	source        varchar(20) NOT NULL DEFAULT 'coins' CHECK (source IN ('coins', 'gift')),
	coin_event_id bigint,
	created_at    timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, practice_id)
);

ALTER TABLE listening_runs DROP CONSTRAINT IF EXISTS listening_runs_mode_check;
ALTER TABLE listening_runs ADD CONSTRAINT listening_runs_mode_check CHECK (mode IN ('learn', 'lesson_test', 'skill_test', 'review', 'challenge', 'bank'));
ALTER TABLE listening_runs ADD COLUMN IF NOT EXISTS practice_id uuid REFERENCES practice_videos(id) ON DELETE CASCADE;
ALTER TABLE listening_runs ADD COLUMN IF NOT EXISTS clip_id uuid REFERENCES listening_clips(id) ON DELETE CASCADE;
DROP INDEX IF EXISTS listening_runs_practice;
CREATE INDEX IF NOT EXISTS listening_runs_clip ON listening_runs (clip_id, learner_key) WHERE clip_id IS NOT NULL;

ALTER TABLE coin_events DROP CONSTRAINT IF EXISTS coin_events_reason_check;
ALTER TABLE coin_events ADD CONSTRAINT coin_events_reason_check CHECK (reason IN (
	'lesson', 'perfect', 'goal', 'streak', 'review', 'ad', 'unlock', 'premium_day', 'freeze', 'retest', 'refund', 'admin', 'trap',
	'streak_milestone', 'skill_test', 'replay', 'phrase_unlock', 'ai', 'challenge', 'bank'
));

INSERT INTO directus_collections (collection, icon, note, hidden, singleton, accountability, sort_field)
SELECT 'practice_videos', 'video_library', 'Practice bank: one entry per video, its items are the video''s clips', false, false, 'all', 'sort'
WHERE NOT EXISTS (SELECT 1 FROM directus_collections WHERE collection = 'practice_videos');

COMMIT;
