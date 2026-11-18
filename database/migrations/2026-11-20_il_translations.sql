-- Intensive Listening text in more than one language.
--   il_lessons / il_sentences keep the base (Vietnamese) text.
--   il_translations   one row per lesson, language and key (lang 'en-US', 'th-TH'...)
--     key = title | intro | gist_prompt | gist_o<i> | gist_explain | s<n>:t<j>:note | s<n>:t<j>:real
--     (s<n> = the sentence's n, t<j> = the j-th trap of that sentence, 0-based)
-- A new language = new rows here; no code change. A missing key shows the base text. Safe to run twice.

CREATE TABLE IF NOT EXISTS il_translations (
	lesson_id uuid NOT NULL REFERENCES il_lessons(id) ON DELETE CASCADE,
	lang      text NOT NULL,
	key       text NOT NULL,
	text      text NOT NULL,
	PRIMARY KEY (lesson_id, lang, key)
);

-- Rollback:
-- DROP TABLE IF EXISTS il_translations;
