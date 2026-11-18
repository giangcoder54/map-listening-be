-- "Từ của tôi": one store of saved words for every feature (Extensive, Intensive, the dictionary), with one FSRS card
-- per learner x word. A word is saved by the bookmark button only. Review = hear the word in a line of another video,
-- type it, then see its meaning (v1/wordsRoutes.ts).
--   word      the key: lower case, curly quotes made straight ("can't", "figure out")
--   shown     as written where it was saved
--   forms     other forms heard (frighten, frightened), accepted in review
--   meaning / ipa  a copy taken when it was saved (lesson meaning, else the dictionary)
--   source    extensive | intensive | dict, source_id the el_vocab or il_sentences row
--   video_id + start_ms/end_ms + example  the line it was saved from (review falls back to it)
-- Extensive bookmarks (el_saved_words) are copied in; the old table is no longer written. Safe to run twice.

CREATE TABLE IF NOT EXISTS user_words (
	id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id         uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	word            text NOT NULL,
	shown           text NOT NULL,
	forms           text[] NOT NULL DEFAULT '{}',
	meaning         text,
	ipa             text,
	source          text NOT NULL CHECK (source IN ('extensive', 'intensive', 'dict')),
	source_id       uuid,
	video_id        text,
	start_ms        int,
	end_ms          int,
	example         text,
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
	date_created    timestamptz NOT NULL DEFAULT now(),
	UNIQUE (user_id, word)
);
CREATE INDEX IF NOT EXISTS user_words_due ON user_words (user_id, due);

INSERT INTO user_words (user_id, word, shown, forms, meaning, source, source_id, video_id, start_ms, end_ms, date_created)
SELECT w.user_id, lower(replace(v.term, '’', '''')), v.term, v.forms, v.meaning, 'extensive', v.id, sv.youtube_video_id, v.at_start, v.at_end, w.date_created
FROM el_saved_words w
JOIN el_vocab v ON v.id = w.vocab_id
JOIN el_lessons l ON l.id = v.lesson_id
JOIN source_videos sv ON sv.id = l.source_video_id
ON CONFLICT (user_id, word) DO NOTHING;

-- XP: a word right in review (lib/xp.ts)
ALTER TABLE xp_events DROP CONSTRAINT IF EXISTS xp_events_reason_check;
ALTER TABLE xp_events ADD CONSTRAINT xp_events_reason_check
	CHECK (reason IN ('lesson', 'replay', 'review', 'lesson_test', 'skill_test', 'phrase', 'phrase_review', 'extensive', 'intensive', 'intensive_review', 'word_review'));

-- Rollback:
-- DROP TABLE IF EXISTS user_words;
-- ALTER TABLE xp_events DROP CONSTRAINT IF EXISTS xp_events_reason_check;
-- ALTER TABLE xp_events ADD CONSTRAINT xp_events_reason_check
--   CHECK (reason IN ('lesson', 'replay', 'review', 'lesson_test', 'skill_test', 'phrase', 'phrase_review', 'extensive', 'intensive', 'intensive_review'));
