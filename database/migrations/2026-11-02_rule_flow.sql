-- =====================================================================
-- Listening Lab v2: lessons by rule, runs, review by form, Xu (coins)
-- Spec: https://claude.ai/artifact/JZqukX3nVxjwJSdWUWBrW5 (memory: listening-v2-rule-flow-design)
--
-- The whole lab moves to the new flow (no flag, no old flow):
--   listening_skills   a rule (Flap T)               + accent, pass_ratio, test_size
--   listening_lessons  one form of the rule          + kind, explain audio, redirect, title
--   listening_clips    the lesson's pool             + role (replaces step), focus_text, accent, difficulty
--   listening_runs     one sitting: the items drawn, their results, where the learner is
--   listening_attempts + run_id, phase, format, used_slow, used_hint, time_ms
--   listening_review_cards  FSRS per learner x lesson (same columns as phrase_progress)
--   listening_skill_progress  learning | mastered | tested_out per learner x rule
--   coin_events + user_xp.coins  the Xu ledger and its balance (like xp_events + user_xp)
--   listening_unlocks  lessons bought with Xu (kept for ever)
--   listening_clip_tags, listening_topics, listening_clip_topics, listening_praise_lines
--
-- Backfill: clips get a role from their step (first step-1 clip of a lesson = core, the other
-- step-1 clips and step-4 clips = pool, voice = voice, challenge = challenge). `step` stays for
-- the old reports and is no longer written. Learners with XP get welcome Xu: 1 per 2 XP, 300 at
-- most. Foreign keys read on hot paths get the index Postgres never makes on its own.
--
-- Small tables: plain CREATE INDEX inside the transaction. On a big production table build
-- them with CREATE INDEX CONCURRENTLY outside a transaction instead.
-- Safe to run twice.
-- =====================================================================
BEGIN;

-- ── Rules and forms ───────────────────────────────────────────────────
ALTER TABLE listening_skills ADD COLUMN IF NOT EXISTS accent varchar(10) NOT NULL DEFAULT 'any';
ALTER TABLE listening_skills ADD COLUMN IF NOT EXISTS pass_ratio real NOT NULL DEFAULT 0.8;
ALTER TABLE listening_skills ADD COLUMN IF NOT EXISTS test_size smallint NOT NULL DEFAULT 8;
ALTER TABLE listening_skills DROP CONSTRAINT IF EXISTS listening_skills_accent_check;
ALTER TABLE listening_skills ADD CONSTRAINT listening_skills_accent_check CHECK (accent IN ('us', 'uk', 'any'));
ALTER TABLE listening_skills DROP CONSTRAINT IF EXISTS listening_skills_pass_ratio_check;
ALTER TABLE listening_skills ADD CONSTRAINT listening_skills_pass_ratio_check CHECK (pass_ratio > 0 AND pass_ratio <= 1);
ALTER TABLE listening_skills DROP CONSTRAINT IF EXISTS listening_skills_test_size_check;
ALTER TABLE listening_skills ADD CONSTRAINT listening_skills_test_size_check CHECK (test_size BETWEEN 3 AND 30);

ALTER TABLE listening_lessons ADD COLUMN IF NOT EXISTS kind varchar(20) NOT NULL DEFAULT 'pattern';
ALTER TABLE listening_lessons ADD COLUMN IF NOT EXISTS explain_clear_url text;
ALTER TABLE listening_lessons ADD COLUMN IF NOT EXISTS explain_natural_url text;
ALTER TABLE listening_lessons ADD COLUMN IF NOT EXISTS redirect_lesson_id uuid REFERENCES listening_lessons(id) ON DELETE SET NULL;
ALTER TABLE listening_lessons DROP CONSTRAINT IF EXISTS listening_lessons_kind_check;
ALTER TABLE listening_lessons ADD CONSTRAINT listening_lessons_kind_check CHECK (kind IN ('pattern', 'trap', 'mixed'));
ALTER TABLE listening_lessons_translations ADD COLUMN IF NOT EXISTS title varchar(255);

-- ── Clips: role in the lesson's pool ──────────────────────────────────
ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS role varchar(20);
ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS focus_text varchar(255);
ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS accent varchar(10);
ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS difficulty smallint;
ALTER TABLE listening_clips DROP CONSTRAINT IF EXISTS listening_clips_role_check;
ALTER TABLE listening_clips ADD CONSTRAINT listening_clips_role_check CHECK (role IN ('core', 'voice', 'pool', 'challenge', 'trap'));
ALTER TABLE listening_clips DROP CONSTRAINT IF EXISTS listening_clips_accent_check;
ALTER TABLE listening_clips ADD CONSTRAINT listening_clips_accent_check CHECK (accent IN ('us', 'uk', 'au', 'other'));
ALTER TABLE listening_clips DROP CONSTRAINT IF EXISTS listening_clips_difficulty_check;
ALTER TABLE listening_clips ADD CONSTRAINT listening_clips_difficulty_check CHECK (difficulty BETWEEN 1 AND 3);

WITH ranked AS (
	SELECT id, step,
		ROW_NUMBER() OVER (PARTITION BY lesson_id, step ORDER BY sort NULLS LAST, id) AS n
	FROM listening_clips
	WHERE lesson_id IS NOT NULL AND step IS NOT NULL AND role IS NULL
)
UPDATE listening_clips c SET role = CASE
		WHEN r.step = 'type' AND r.n = 1 THEN 'core'
		WHEN r.step IN ('type', 'more') THEN 'pool'
		WHEN r.step = 'voice' THEN 'voice'
		ELSE 'challenge'
	END
FROM ranked r WHERE r.id = c.id;

-- At most one core clip per lesson
CREATE UNIQUE INDEX IF NOT EXISTS listening_clips_one_core ON listening_clips (lesson_id) WHERE role = 'core';
CREATE INDEX IF NOT EXISTS listening_clips_pool_idx ON listening_clips (lesson_id, role, status);

-- Other rules a clip shows ("not at all": Flap T + linking); its main rule is lesson_id
CREATE TABLE IF NOT EXISTS listening_clip_tags (
	clip_id    uuid NOT NULL REFERENCES listening_clips(id) ON DELETE CASCADE,
	lesson_id  uuid NOT NULL REFERENCES listening_lessons(id) ON DELETE CASCADE,
	PRIMARY KEY (clip_id, lesson_id)
);
CREATE INDEX IF NOT EXISTS listening_clip_tags_lesson ON listening_clip_tags (lesson_id);

-- Topics: questions, numbers, names...
CREATE TABLE IF NOT EXISTS listening_topics (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	status        varchar(20)  NOT NULL DEFAULT 'published',
	sort          integer,
	name          varchar(255) NOT NULL,
	slug          varchar(255) NOT NULL UNIQUE,
	date_created  timestamptz  DEFAULT now()
);
CREATE TABLE IF NOT EXISTS listening_topics_translations (
	id                   serial PRIMARY KEY,
	listening_topics_id  uuid REFERENCES listening_topics(id) ON DELETE CASCADE,
	languages_code       varchar(255) REFERENCES languages(code) ON DELETE SET NULL,
	name                 varchar(255)
);
CREATE INDEX IF NOT EXISTS listening_topics_translations_owner ON listening_topics_translations (listening_topics_id);
CREATE TABLE IF NOT EXISTS listening_clip_topics (
	clip_id   uuid NOT NULL REFERENCES listening_clips(id) ON DELETE CASCADE,
	topic_id  uuid NOT NULL REFERENCES listening_topics(id) ON DELETE CASCADE,
	PRIMARY KEY (clip_id, topic_id)
);
CREATE INDEX IF NOT EXISTS listening_clip_topics_topic ON listening_clip_topics (topic_id);

-- ── Praise lines written by the team ──────────────────────────────────
CREATE TABLE IF NOT EXISTS listening_praise_lines (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	status        varchar(20)  NOT NULL DEFAULT 'published',
	trigger       varchar(20)  NOT NULL CHECK (trigger IN ('clip_right', 'streak', 'phase_done', 'lesson_done', 'skill_done', 'wrong', 'comeback')),
	min_streak    smallint,
	skill_id      uuid REFERENCES listening_skills(id) ON DELETE CASCADE,
	lesson_id     uuid REFERENCES listening_lessons(id) ON DELETE CASCADE,
	clip_id       uuid REFERENCES listening_clips(id) ON DELETE CASCADE,
	locale        varchar(10)  NOT NULL DEFAULT 'vi',
	text          varchar(280) NOT NULL,
	tone          varchar(20),
	mascot_pose   varchar(20)  CHECK (mascot_pose IN ('nod', 'peek', 'cheer', 'flex', 'comfort')),
	audio_url     text,
	weight        smallint     NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 10),
	date_created  timestamptz  DEFAULT now(),
	-- A line belongs to at most one rule, form or clip; none = a line for every lesson
	CHECK (num_nonnulls(skill_id, lesson_id, clip_id) <= 1)
);

-- ── Runs: one sitting of a lesson, a test or a review ─────────────────
CREATE TABLE IF NOT EXISTS listening_runs (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id       uuid REFERENCES directus_users(id) ON DELETE CASCADE,
	learner_key   varchar(80) NOT NULL,
	mode          varchar(20) NOT NULL CHECK (mode IN ('learn', 'lesson_test', 'skill_test', 'review')),
	skill_id      uuid REFERENCES listening_skills(id) ON DELETE CASCADE,
	lesson_id     uuid REFERENCES listening_lessons(id) ON DELETE CASCADE,
	-- [{ clip_id, phase, format, result?: { correct, listens, answer, slow, hint } }]
	items         jsonb       NOT NULL DEFAULT '[]'::jsonb,
	position      smallint    NOT NULL DEFAULT 0,
	status        varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished', 'abandoned')),
	passed        boolean,
	started_at    timestamptz NOT NULL DEFAULT now(),
	finished_at   timestamptz,
	date_updated  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS listening_runs_active ON listening_runs (learner_key, lesson_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS listening_runs_user ON listening_runs (user_id, started_at);

ALTER TABLE listening_attempts ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES listening_runs(id) ON DELETE SET NULL;
ALTER TABLE listening_attempts ADD COLUMN IF NOT EXISTS phase varchar(20);
ALTER TABLE listening_attempts ADD COLUMN IF NOT EXISTS format varchar(20);
ALTER TABLE listening_attempts ADD COLUMN IF NOT EXISTS used_slow boolean NOT NULL DEFAULT false;
ALTER TABLE listening_attempts ADD COLUMN IF NOT EXISTS used_hint boolean NOT NULL DEFAULT false;
ALTER TABLE listening_attempts ADD COLUMN IF NOT EXISTS time_ms integer;
ALTER TABLE listening_attempts DROP CONSTRAINT IF EXISTS listening_attempts_phase_check;
ALTER TABLE listening_attempts ADD CONSTRAINT listening_attempts_phase_check
	CHECK (phase IN ('pre', 'voice', 'practice', 'retry', 'challenge', 'post', 'review', 'test'));
ALTER TABLE listening_attempts DROP CONSTRAINT IF EXISTS listening_attempts_format_check;
ALTER TABLE listening_attempts ADD CONSTRAINT listening_attempts_format_check
	CHECK (format IN ('type', 'gap', 'choice', 'tap', 'identify', 'speak'));
CREATE INDEX IF NOT EXISTS listening_attempts_run ON listening_attempts (run_id) WHERE run_id IS NOT NULL;
-- Which clips a learner already met (drawing prefers new ones)
CREATE INDEX IF NOT EXISTS listening_attempts_user_clip ON listening_attempts (user_id, clip_id);

ALTER TABLE listening_progress DROP CONSTRAINT IF EXISTS listening_progress_status_check;
ALTER TABLE listening_progress ADD CONSTRAINT listening_progress_status_check CHECK (status IN ('in_progress', 'completed', 'tested_out'));
ALTER TABLE listening_progress ADD COLUMN IF NOT EXISTS last_run_id uuid REFERENCES listening_runs(id) ON DELETE SET NULL;

-- ── Progress per rule, review per form ────────────────────────────────
CREATE TABLE IF NOT EXISTS listening_skill_progress (
	user_id           uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	skill_id          uuid NOT NULL REFERENCES listening_skills(id) ON DELETE CASCADE,
	status            varchar(20) NOT NULL DEFAULT 'learning' CHECK (status IN ('learning', 'mastered', 'tested_out')),
	lessons_done      smallint NOT NULL DEFAULT 0,
	mastery           real NOT NULL DEFAULT 0 CHECK (mastery BETWEEN 0 AND 1),
	mastered_at       timestamptz,
	last_test_run_id  uuid REFERENCES listening_runs(id) ON DELETE SET NULL,
	date_updated      timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, skill_id)
);

CREATE TABLE IF NOT EXISTS listening_review_cards (
	user_id         uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	lesson_id       uuid NOT NULL REFERENCES listening_lessons(id) ON DELETE CASCADE,
	due             timestamptz NOT NULL DEFAULT now(),
	stability       double precision NOT NULL DEFAULT 0,
	difficulty      double precision NOT NULL DEFAULT 0,
	elapsed_days    integer NOT NULL DEFAULT 0,
	scheduled_days  integer NOT NULL DEFAULT 0,
	reps            integer NOT NULL DEFAULT 0,
	lapses          integer NOT NULL DEFAULT 0,
	state           smallint NOT NULL DEFAULT 0,
	last_review     timestamptz,
	source          varchar(20) NOT NULL DEFAULT 'learned' CHECK (source IN ('learned', 'tested_out')),
	PRIMARY KEY (user_id, lesson_id)
);
CREATE INDEX IF NOT EXISTS listening_review_cards_due ON listening_review_cards (user_id, due);
CREATE INDEX IF NOT EXISTS listening_review_cards_lesson ON listening_review_cards (lesson_id);

ALTER TABLE user_daily_stats ADD COLUMN IF NOT EXISTS reviews smallint NOT NULL DEFAULT 0;

-- ── Xu: ledger + balance, lessons bought ──────────────────────────────
ALTER TABLE user_xp ADD COLUMN IF NOT EXISTS coins integer NOT NULL DEFAULT 0;
ALTER TABLE user_xp ADD COLUMN IF NOT EXISTS coins_earned_total integer NOT NULL DEFAULT 0;
ALTER TABLE user_xp DROP CONSTRAINT IF EXISTS user_xp_coins_check;
ALTER TABLE user_xp ADD CONSTRAINT user_xp_coins_check CHECK (coins >= 0);

CREATE TABLE IF NOT EXISTS coin_events (
	id          bigserial PRIMARY KEY,
	user_id     uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	-- > 0 earned (what was really added, the 500 cap applied), < 0 spent; 0 = all of it
	-- missed because the purse was full (wanted says how much)
	amount      integer NOT NULL CHECK (amount <> 0 OR wanted > 0),
	-- what the rule gave before the cap: "full, 15 Xu missed"
	wanted      integer,
	reason      varchar(20) NOT NULL CHECK (reason IN ('lesson', 'perfect', 'goal', 'streak', 'review', 'ad', 'unlock', 'premium_day', 'freeze', 'retest', 'refund', 'admin')),
	dedupe_key  varchar(120) NOT NULL,
	lesson_id   uuid REFERENCES listening_lessons(id) ON DELETE SET NULL,
	day         date NOT NULL,
	created_at  timestamptz NOT NULL DEFAULT now(),
	UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS coin_events_user_time ON coin_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS coin_events_lesson ON coin_events (lesson_id) WHERE lesson_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS listening_unlocks (
	user_id        uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	lesson_id      uuid NOT NULL REFERENCES listening_lessons(id) ON DELETE CASCADE,
	source         varchar(20) NOT NULL DEFAULT 'coins' CHECK (source IN ('coins', 'gift')),
	coin_event_id  bigint REFERENCES coin_events(id) ON DELETE SET NULL,
	created_at     timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, lesson_id)
);
CREATE INDEX IF NOT EXISTS listening_unlocks_user_time ON listening_unlocks (user_id, created_at);
CREATE INDEX IF NOT EXISTS listening_unlocks_lesson ON listening_unlocks (lesson_id);

ALTER TABLE xp_events DROP CONSTRAINT IF EXISTS xp_events_reason_check;
ALTER TABLE xp_events ADD CONSTRAINT xp_events_reason_check CHECK (reason IN ('lesson', 'replay', 'review', 'lesson_test', 'skill_test'));

-- Welcome Xu: 1 per 2 XP already won, 300 at most
WITH gift AS (
	INSERT INTO coin_events (user_id, amount, wanted, reason, dedupe_key, day)
	SELECT user_id, LEAST(300, xp_total / 2), LEAST(300, xp_total / 2), 'admin', 'welcome', (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
	FROM user_xp WHERE xp_total >= 2
	ON CONFLICT (user_id, dedupe_key) DO NOTHING
	RETURNING user_id, amount
)
UPDATE user_xp u SET coins = u.coins + g.amount, coins_earned_total = u.coins_earned_total + g.amount
FROM gift g WHERE g.user_id = u.user_id;

-- ── Indexes Postgres never makes for foreign keys (read on hot paths) ──
CREATE INDEX IF NOT EXISTS listening_lessons_translations_owner ON listening_lessons_translations (listening_lessons_id);
CREATE INDEX IF NOT EXISTS listening_skills_translations_owner ON listening_skills_translations (listening_skills_id);
CREATE INDEX IF NOT EXISTS listening_groups_translations_owner ON listening_groups_translations (listening_groups_id);
CREATE INDEX IF NOT EXISTS listening_clips_source_video ON listening_clips (source_video_id);
CREATE INDEX IF NOT EXISTS listening_progress_lesson ON listening_progress (lesson_id);
CREATE INDEX IF NOT EXISTS listening_reviews_clip ON listening_reviews (clip_id);
CREATE INDEX IF NOT EXISTS listening_reviews_lesson ON listening_reviews (lesson_id);
CREATE INDEX IF NOT EXISTS comments_lesson ON comments (lesson_id);
CREATE INDEX IF NOT EXISTS xp_events_lesson ON xp_events (lesson_id) WHERE lesson_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS learning_events_user ON learning_events (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS learning_events_lesson ON learning_events (lesson_id) WHERE lesson_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS listening_answers_lesson ON listening_answers (lesson_id);
CREATE INDEX IF NOT EXISTS listening_lesson_learners_user ON listening_lesson_learners (user_id) WHERE user_id IS NOT NULL;

COMMIT;
