-- Intensive Listening: a short passage heard sentence by sentence, typed back (dictation), checked word by word,
-- every miss labelled (vocabulary, speed, linking/reduction, confusable sounds, wrong mental image, overload),
-- then a second go and Review cards that are heard, not read.
--   il_lessons       one per passage (30-60 s of a library video), gist question, focus label
--   il_sentences     the sentences of the passage: time range, transcript, "traps" (words that usually fail and why)
--   il_attempts      a learner's go at a lesson: gist answer, finished
--   il_results       one row per sentence per round (1 = first dictation, 2 = hearing it again): what was typed,
--                    words right, listens, the words flagged "I don't know this", the labels given
--   il_review_cards  FSRS card per learner x sentence that was missed (heard, then typed again)
-- Lessons are written by Claude (docs/giao-trinh/tools/il_write.py) as drafts. Safe to run twice. Rollback at the bottom.

CREATE TABLE IF NOT EXISTS il_lessons (
	id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	short_id        text UNIQUE NOT NULL DEFAULT substr(md5(random()::text || clock_timestamp()::text), 1, 8),
	source_video_id uuid NOT NULL REFERENCES source_videos(id) ON DELETE CASCADE,
	title           text NOT NULL,
	level           smallint NOT NULL DEFAULT 2 CHECK (level BETWEEN 1 AND 3),   -- 1 easy, 2 medium, 3 hard
	topic           text REFERENCES video_topics(code) ON UPDATE CASCADE ON DELETE SET NULL,
	start_ms        int NOT NULL,
	end_ms          int NOT NULL,
	gist_prompt     text NOT NULL,                -- step 1 question
	gist_options    jsonb NOT NULL,               -- ["...", "...", "..."]
	gist_answer     smallint NOT NULL,
	gist_explain    text,
	intro           text,
	focus           text CHECK (focus IN ('linking', 'confusable', 'imagine', 'speed', 'mixed')),
	status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'hidden')),
	is_premium      boolean NOT NULL DEFAULT false,
	note            text,
	sort            int DEFAULT 0,
	date_created    timestamptz DEFAULT now(),
	date_updated    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS il_lessons_status_idx ON il_lessons (status, level);
CREATE INDEX IF NOT EXISTS il_lessons_video_idx ON il_lessons (source_video_id);

CREATE TABLE IF NOT EXISTS il_sentences (
	id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	lesson_id  uuid NOT NULL REFERENCES il_lessons(id) ON DELETE CASCADE,
	n          smallint NOT NULL,
	start_ms   int NOT NULL,
	end_ms     int NOT NULL,
	text       text NOT NULL,                     -- what is said, plain (the dictation is checked against it)
	traps      jsonb NOT NULL DEFAULT '[]',       -- [{ text, kind linking|confusable|imagine, real, note }]
	UNIQUE (lesson_id, n)
);

CREATE TABLE IF NOT EXISTS il_attempts (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id       uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	lesson_id     uuid NOT NULL REFERENCES il_lessons(id) ON DELETE CASCADE,
	gist_choice   smallint,
	gist_right    boolean,
	finished_at   timestamptz,
	date_created  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS il_attempts_user_idx ON il_attempts (user_id, date_created DESC);
CREATE INDEX IF NOT EXISTS il_attempts_lesson_idx ON il_attempts (lesson_id);

CREATE TABLE IF NOT EXISTS il_results (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	attempt_id    uuid NOT NULL REFERENCES il_attempts(id) ON DELETE CASCADE,
	sentence_id   uuid NOT NULL REFERENCES il_sentences(id) ON DELETE CASCADE,
	round         smallint NOT NULL CHECK (round IN (1, 2)),
	typed         text NOT NULL DEFAULT '',
	words_total   smallint NOT NULL DEFAULT 0,
	words_right   smallint NOT NULL DEFAULT 0,
	listens       smallint NOT NULL DEFAULT 1,
	unknown       jsonb NOT NULL DEFAULT '[]',     -- words the learner flagged "I don't know this word"
	slow_typed    text,                            -- the retype at 0.75x (step 5)
	labels        jsonb NOT NULL DEFAULT '[]',     -- [{ word, label, real? }]
	date_created  timestamptz DEFAULT now(),
	UNIQUE (attempt_id, sentence_id, round)
);
CREATE INDEX IF NOT EXISTS il_results_sentence_idx ON il_results (sentence_id);

CREATE TABLE IF NOT EXISTS il_review_cards (
	user_id         uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	sentence_id     uuid NOT NULL REFERENCES il_sentences(id) ON DELETE CASCADE,
	label           text NOT NULL DEFAULT 'sound',
	due             timestamptz NOT NULL DEFAULT now(),
	stability       double precision NOT NULL DEFAULT 0,
	difficulty      double precision NOT NULL DEFAULT 0,
	elapsed_days    integer NOT NULL DEFAULT 0,
	scheduled_days  integer NOT NULL DEFAULT 0,
	learning_steps  integer NOT NULL DEFAULT 0,
	reps            integer NOT NULL DEFAULT 0,
	lapses          integer NOT NULL DEFAULT 0,
	state           smallint NOT NULL DEFAULT 0,
	last_review     timestamptz,
	PRIMARY KEY (user_id, sentence_id)
);
CREATE INDEX IF NOT EXISTS il_review_cards_due ON il_review_cards (user_id, due);

-- XP: a passage finished the first time, a Review card right (lib/xp.ts)
ALTER TABLE xp_events DROP CONSTRAINT IF EXISTS xp_events_reason_check;
ALTER TABLE xp_events ADD CONSTRAINT xp_events_reason_check
	CHECK (reason IN ('lesson', 'replay', 'review', 'lesson_test', 'skill_test', 'phrase', 'phrase_review', 'extensive', 'intensive', 'intensive_review'));

-- Rollback:
-- DROP TABLE IF EXISTS il_review_cards; DROP TABLE IF EXISTS il_results; DROP TABLE IF EXISTS il_attempts;
-- DROP TABLE IF EXISTS il_sentences; DROP TABLE IF EXISTS il_lessons;
-- ALTER TABLE xp_events DROP CONSTRAINT IF EXISTS xp_events_reason_check;
-- ALTER TABLE xp_events ADD CONSTRAINT xp_events_reason_check
--   CHECK (reason IN ('lesson', 'replay', 'review', 'lesson_test', 'skill_test', 'phrase', 'phrase_review', 'extensive'));
