-- =====================================================================
-- XP, streak and rewards from a ledger instead of raw attempts (lib/xp.ts,
-- v1/engagementRoutes.ts, v1/lessonRoutes.ts). Plan: docs/xp-leaderboard-refactor.md (web repo).
--
-- Before: every page view recomputed XP and the streak from all of listening_attempts, and
-- the server took the browser's word for is_correct. Now the server checks the answer and
-- writes the XP once, in the same transaction:
--
-- XP is by lesson, whatever its number of clips: +20 the first time it is finished (+10 when
-- an answer of step 1 was looked at), +5 when done again (once a day), +5 a review right.
--
--   xp_events         one row per XP won. dedupe_key makes the rules ("a lesson once",
--                     "a replay once a day") a unique key: a repeat simply does not insert.
--   user_daily_stats  one row per learner per Vietnam day: XP, attempts (the streak), the
--                     daily goal of that day, and `frozen` (a streak freeze covered the day).
--                     Rebuildable from xp_events + listening_attempts.
--   user_xp           one row per learner: lifetime XP (level), streak freezes held, and how
--                     many 200-XP blocks already gave a freeze.
--   user_rewards      what a learner was given (a Premium day for 7 goal days in a row, a
--                     streak freeze), shown once to them (seen_at).
--
-- The backfill at the end scores the past with these rules (lessons finished, reviews), so
-- XP totals go down from the old clip-based numbers; streaks do not change. Daily goals move
-- to the new scale (a lesson is 20 XP): 30 and 50 become 40 (2 lessons), 150 becomes 160.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS xp_events (
	id bigserial PRIMARY KEY,
	user_id uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	reason varchar(20) NOT NULL CHECK (reason IN ('lesson', 'replay', 'review')),
	amount int NOT NULL,
	-- lesson:<lesson id> | replay:<lesson id>:<YYYY-MM-DD> | review:<attempt id>
	dedupe_key varchar(120) NOT NULL,
	day date NOT NULL,
	lesson_id uuid REFERENCES listening_lessons(id) ON DELETE SET NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS xp_events_user_lesson ON xp_events (user_id, lesson_id, created_at);

CREATE TABLE IF NOT EXISTS user_daily_stats (
	user_id uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	day date NOT NULL,
	xp int NOT NULL DEFAULT 0,
	attempts int NOT NULL DEFAULT 0,
	goal int NOT NULL DEFAULT 40,
	frozen boolean NOT NULL DEFAULT false,
	PRIMARY KEY (user_id, day)
);
-- Leaderboard: every learner's days since the start of the week / month
CREATE INDEX IF NOT EXISTS user_daily_stats_day ON user_daily_stats (day, user_id) INCLUDE (xp);

CREATE TABLE IF NOT EXISTS user_xp (
	user_id uuid PRIMARY KEY REFERENCES directus_users(id) ON DELETE CASCADE,
	xp_total int NOT NULL DEFAULT 0,
	freezes int NOT NULL DEFAULT 0,
	freezes_awarded int NOT NULL DEFAULT 0,
	date_updated timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_rewards (
	id bigserial PRIMARY KEY,
	user_id uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	kind varchar(20) NOT NULL CHECK (kind IN ('premium_day', 'freeze')),
	-- premium:<YYYY-MM-DD> (the day the 7th goal day was reached) | freeze:<n-th 500 XP>
	dedupe_key varchar(120) NOT NULL,
	-- Premium days given (0: a lifetime member, nothing to add)
	days int NOT NULL DEFAULT 0,
	seen_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS user_rewards_unseen ON user_rewards (user_id) WHERE seen_at IS NULL;

-- What still reads listening_attempts by learner and date (profile, admin dashboard)
CREATE INDEX IF NOT EXISTS listening_attempts_user_created ON listening_attempts (user_id, date_created);

-- ── Daily goals on the new scale ──────────────────────────────────────────────────────
ALTER TABLE directus_users ALTER COLUMN daily_goal SET DEFAULT 40;
UPDATE directus_users SET daily_goal = CASE daily_goal WHEN 30 THEN 40 WHEN 50 THEN 40 WHEN 150 THEN 160 ELSE daily_goal END
WHERE daily_goal IN (30, 50, 150);

-- ── Backfill: the past scored with these rules ───────────────────────────────────────────

INSERT INTO xp_events (user_id, reason, amount, dedupe_key, day, lesson_id, created_at)
SELECT user_id, 'review', 5, 'review:' || id, (date_created AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, lesson_id, date_created
FROM listening_attempts
WHERE is_correct AND user_id IS NOT NULL AND source = 'review'
ON CONFLICT (user_id, dedupe_key) DO NOTHING;

-- A lesson finished: 20, or 10 when an answer of its step 1 was looked at
INSERT INTO xp_events (user_id, reason, amount, dedupe_key, day, lesson_id, created_at)
SELECT p.user_id, 'lesson',
	CASE WHEN EXISTS (
		SELECT 1 FROM listening_attempts a JOIN listening_clips c ON c.id = a.clip_id
		WHERE a.user_id = p.user_id AND c.lesson_id = p.lesson_id AND c.step = 'type' AND a.answer = '[REVEALED]'
	) THEN 10 ELSE 20 END,
	'lesson:' || p.lesson_id, (p.completed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, p.lesson_id, p.completed_at
FROM listening_progress p
WHERE p.completed_at IS NOT NULL
ON CONFLICT (user_id, dedupe_key) DO NOTHING;

INSERT INTO user_daily_stats (user_id, day, xp, attempts, goal)
SELECT s.user_id, s.day, sum(s.xp)::int, sum(s.attempts)::int, coalesce(max(u.daily_goal), 40)
FROM (
	SELECT user_id, day, amount AS xp, 0 AS attempts FROM xp_events
	UNION ALL
	SELECT user_id, (date_created AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 0, 1
	FROM listening_attempts WHERE user_id IS NOT NULL
) s
JOIN directus_users u ON u.id = s.user_id
GROUP BY s.user_id, s.day
ON CONFLICT (user_id, day) DO NOTHING;

-- A freeze per 200 XP already won, at most 2 held
INSERT INTO user_xp (user_id, xp_total, freezes, freezes_awarded)
SELECT user_id, sum(amount)::int, least(2, sum(amount)::int / 200), sum(amount)::int / 200
FROM xp_events GROUP BY user_id
ON CONFLICT (user_id) DO NOTHING;

COMMIT;
