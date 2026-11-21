-- One table for every review card (words, sound patterns, pairs, spelling, sentences, Listening Lab forms).
-- It holds only the schedule (FSRS) of a card; what the card is about stays in its own table:
--   word      ref_id = user_words.id        pattern / pair / spell   ref_id = il_cards.id
--   sentence  ref_id = il_sentences.id      form                     ref_id = listening_lessons.id
-- One count of "cards due", one query for a session, a new kind of card is one more `kind`.
CREATE TABLE IF NOT EXISTS review_cards (
	id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id         uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	kind            text NOT NULL CHECK (kind IN ('word', 'pattern', 'pair', 'spell', 'sentence', 'form')),
	ref_id          uuid NOT NULL,
	label           text,                       -- sentence: what was missed (sound, linking...)
	source          text,                       -- form: 'learned' or 'tested_out'
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
	UNIQUE (user_id, kind, ref_id)
);
CREATE INDEX IF NOT EXISTS review_cards_due ON review_cards (user_id, due) WHERE suspended_at IS NULL;
CREATE INDEX IF NOT EXISTS review_cards_ref ON review_cards (kind, ref_id);

-- Move what exists
INSERT INTO review_cards (user_id, kind, ref_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, right_streak, suspended_at, date_created)
	SELECT user_id, 'word', id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, right_streak, suspended_at, date_created FROM user_words
	ON CONFLICT DO NOTHING;
INSERT INTO review_cards (user_id, kind, ref_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, right_streak, suspended_at, date_created)
	SELECT user_id, kind, id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, right_streak, suspended_at, date_created FROM il_cards
	ON CONFLICT DO NOTHING;
INSERT INTO review_cards (user_id, kind, ref_id, label, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, right_streak, suspended_at)
	SELECT user_id, 'sentence', sentence_id, label, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, right_streak, suspended_at FROM il_review_cards
	ON CONFLICT DO NOTHING;
INSERT INTO review_cards (user_id, kind, ref_id, source, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, right_streak, suspended_at)
	SELECT user_id, 'form', lesson_id, source, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, COALESCE(right_streak, 0), suspended_at FROM listening_review_cards
	ON CONFLICT DO NOTHING;

-- A saved word / a pattern, pair or spelling slip gets its card at once (first review tomorrow); its card leaves with it
CREATE OR REPLACE FUNCTION review_card_add() RETURNS trigger AS $$
BEGIN
	INSERT INTO review_cards (user_id, kind, ref_id)
	VALUES (NEW.user_id, CASE TG_TABLE_NAME WHEN 'user_words' THEN 'word' ELSE NEW.kind END, NEW.id)
	ON CONFLICT DO NOTHING;
	RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION review_card_drop() RETURNS trigger AS $$
BEGIN
	DELETE FROM review_cards WHERE ref_id = OLD.id AND kind = CASE TG_TABLE_NAME
		WHEN 'user_words' THEN 'word' WHEN 'il_sentences' THEN 'sentence' WHEN 'listening_lessons' THEN 'form' ELSE OLD.kind END;
	RETURN OLD;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS user_words_card_add ON user_words;
CREATE TRIGGER user_words_card_add AFTER INSERT ON user_words FOR EACH ROW EXECUTE FUNCTION review_card_add();
DROP TRIGGER IF EXISTS il_cards_card_add ON il_cards;
CREATE TRIGGER il_cards_card_add AFTER INSERT ON il_cards FOR EACH ROW EXECUTE FUNCTION review_card_add();
DROP TRIGGER IF EXISTS user_words_card_drop ON user_words;
CREATE TRIGGER user_words_card_drop AFTER DELETE ON user_words FOR EACH ROW EXECUTE FUNCTION review_card_drop();
DROP TRIGGER IF EXISTS il_cards_card_drop ON il_cards;
CREATE TRIGGER il_cards_card_drop AFTER DELETE ON il_cards FOR EACH ROW EXECUTE FUNCTION review_card_drop();
DROP TRIGGER IF EXISTS il_sentences_card_drop ON il_sentences;
CREATE TRIGGER il_sentences_card_drop AFTER DELETE ON il_sentences FOR EACH ROW EXECUTE FUNCTION review_card_drop();
DROP TRIGGER IF EXISTS listening_lessons_card_drop ON listening_lessons;
CREATE TRIGGER listening_lessons_card_drop AFTER DELETE ON listening_lessons FOR EACH ROW EXECUTE FUNCTION review_card_drop();

-- The old homes of the schedule
DROP INDEX IF EXISTS il_cards_due;
ALTER TABLE user_words DROP COLUMN IF EXISTS due, DROP COLUMN IF EXISTS stability, DROP COLUMN IF EXISTS difficulty, DROP COLUMN IF EXISTS elapsed_days,
	DROP COLUMN IF EXISTS scheduled_days, DROP COLUMN IF EXISTS learning_steps, DROP COLUMN IF EXISTS reps, DROP COLUMN IF EXISTS lapses,
	DROP COLUMN IF EXISTS state, DROP COLUMN IF EXISTS last_review, DROP COLUMN IF EXISTS right_streak, DROP COLUMN IF EXISTS suspended_at;
ALTER TABLE il_cards DROP COLUMN IF EXISTS due, DROP COLUMN IF EXISTS stability, DROP COLUMN IF EXISTS difficulty, DROP COLUMN IF EXISTS elapsed_days,
	DROP COLUMN IF EXISTS scheduled_days, DROP COLUMN IF EXISTS learning_steps, DROP COLUMN IF EXISTS reps, DROP COLUMN IF EXISTS lapses,
	DROP COLUMN IF EXISTS state, DROP COLUMN IF EXISTS last_review, DROP COLUMN IF EXISTS right_streak, DROP COLUMN IF EXISTS suspended_at;
DROP TABLE IF EXISTS il_review_cards;
DROP TABLE IF EXISTS listening_review_cards;
-- Rollback: restore from backup (the schedule columns and the two tables are gone)
