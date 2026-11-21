-- Daily review across every kind of card (spec: Intensive, ôn tập theo loại lỗi).
--   il_cards     a sound pattern ("sort of" -> sorta), a pair easy to mix up (can / can't), or a spelling slip the
--                learner marked in an Intensive result; one FSRS card each (columns as py-fsrs / user_words)
--   review_log   one row per review of any card (word, pattern, pair, spell, sentence), like Anki's revlog
--   suspended_at a card taken out of review ("known, don't ask again"); nothing is deleted
--   right_streak rights in a row: 0 choose among 3, 1 choose in another voice, 2+ type it
CREATE TABLE IF NOT EXISTS il_cards (
	id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id         uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	kind            text NOT NULL CHECK (kind IN ('pattern', 'pair', 'spell')),
	key             text NOT NULL,
	shown           text NOT NULL,
	real            text,
	note            text,
	skill           text,
	options         jsonb NOT NULL DEFAULT '[]'::jsonb,
	sentence_id     uuid REFERENCES il_sentences(id) ON DELETE SET NULL,
	video_id        text,
	start_ms        int,
	end_ms          int,
	due             timestamptz NOT NULL DEFAULT now() + interval '1 day',
	stability       double precision NOT NULL DEFAULT 0,
	difficulty      double precision NOT NULL DEFAULT 0,
	elapsed_days    integer NOT NULL DEFAULT 0,
	scheduled_days  integer NOT NULL DEFAULT 0,
	learning_steps  integer NOT NULL DEFAULT 0,
	reps            integer NOT NULL DEFAULT 0,
	lapses          integer NOT NULL DEFAULT 0,
	state           smallint NOT NULL DEFAULT 0,
	last_review     timestamptz,
	right_streak    integer NOT NULL DEFAULT 0,
	suspended_at    timestamptz,
	date_created    timestamptz NOT NULL DEFAULT now(),
	UNIQUE (user_id, kind, key)
);
CREATE INDEX IF NOT EXISTS il_cards_due ON il_cards (user_id, due) WHERE suspended_at IS NULL;

CREATE TABLE IF NOT EXISTS review_log (
	id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id         uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	card_kind       text NOT NULL,
	card_id         uuid NOT NULL,
	rating          smallint NOT NULL CHECK (rating BETWEEN 1 AND 4),
	answer          text,
	review_duration integer,
	date_created    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_log_user ON review_log (user_id, date_created DESC);
CREATE INDEX IF NOT EXISTS review_log_card ON review_log (card_id, date_created);

ALTER TABLE user_words ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE user_words ADD COLUMN IF NOT EXISTS right_streak integer NOT NULL DEFAULT 0;
ALTER TABLE il_review_cards ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
-- The daily popup: shown once a day (the learner's day, Vietnam time), on any device; "later" three days running -> a slim bar
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS review_prompted_on date;
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS review_skips integer NOT NULL DEFAULT 0;
