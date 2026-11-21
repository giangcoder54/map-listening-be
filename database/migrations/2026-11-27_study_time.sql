-- Study time: seconds a learner worked, per Vietnam day, all modes together.
--   user_study_time   one row per learner per day: seconds
--   user_study_clock  the learner's last practice event (to measure the gap to the next one)
-- Measured while they practise (lib/studyTime.ts touchStudy): each practice event adds the time since the learner's
-- previous event, up to GAP_CAP (120 s, as Anki caps a card at 60 s); a longer gap is a break and adds a flat 20 s
-- (the first clip heard). Extensive Listening adds the listened time it records (addStudySeconds).
-- Backfill: the same rule applied to old events (Lab answers, Intensive sentence results) and Extensive listened_s.
-- Safe to run twice (the backfill runs only while user_study_time is empty). Rollback at the bottom.

CREATE TABLE IF NOT EXISTS user_study_time (
	user_id uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	day     date NOT NULL,
	seconds int NOT NULL DEFAULT 0,
	PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS user_study_clock (
	user_id uuid PRIMARY KEY REFERENCES directus_users(id) ON DELETE CASCADE,
	last_at timestamptz NOT NULL
);

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM user_study_time) THEN
		INSERT INTO user_study_time (user_id, day, seconds)
		SELECT user_id, (at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS day,
			sum(CASE WHEN gap IS NULL OR gap > 120 THEN 20 ELSE gap END)::int
		FROM (
			SELECT user_id, at, extract(epoch FROM at - lag(at) OVER (PARTITION BY user_id ORDER BY at)) AS gap
			FROM (
				SELECT user_id, date_created AS at FROM listening_attempts WHERE user_id IS NOT NULL AND date_created IS NOT NULL
				UNION ALL
				SELECT a.user_id, r.date_created FROM il_results r JOIN il_attempts a ON a.id = r.attempt_id WHERE r.date_created IS NOT NULL
			) ev
		) g
		GROUP BY 1, 2;

		INSERT INTO user_study_time (user_id, day, seconds)
		SELECT user_id, (finished_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, sum(listened_s)::int
		FROM el_attempts WHERE finished_at IS NOT NULL AND listened_s > 0
		GROUP BY 1, 2
		ON CONFLICT (user_id, day) DO UPDATE SET seconds = user_study_time.seconds + EXCLUDED.seconds;
	END IF;
END $$;

-- Rollback:
-- DROP TABLE IF EXISTS user_study_clock; DROP TABLE IF EXISTS user_study_time;
