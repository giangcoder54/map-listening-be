-- Intensive Listening: the words, phrases and structures worth learning in a passage ("Từ vựng" on the result).
--   il_vocab          one item, tied to the sentence it is heard in (sentence_n): its audio and its example.
--                     term: the text as heard; a split structure writes its gap as " ... " (not only ... but also)
--   il_translations   the meaning in another language: key = vocab:<il_vocab.id>   (Vietnamese stays in il_vocab.meaning)
-- Saved by a learner into user_words like any other word. Run after 2026-11-19_intensive_listening.sql.

CREATE TABLE IF NOT EXISTS il_vocab (
	id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	lesson_id   uuid NOT NULL REFERENCES il_lessons(id) ON DELETE CASCADE,
	sentence_n  smallint NOT NULL,
	term        text NOT NULL,
	forms       text[] NOT NULL DEFAULT '{}',              -- other forms to find it by in other videos
	kind        text NOT NULL DEFAULT 'word' CHECK (kind IN ('word', 'phrase', 'grammar')),
	meaning     text NOT NULL,
	date_created timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS il_vocab_term ON il_vocab (lesson_id, lower(term));

-- Rollback: DROP TABLE IF EXISTS il_vocab; DELETE FROM il_translations WHERE key LIKE 'vocab:%';
