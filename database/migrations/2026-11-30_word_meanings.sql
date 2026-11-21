-- Meanings of English words in the learner's language, one row per sense, for every language we teach in.
-- Filled from the Wiktionary edition of that language (kaikki.org extracts, CC BY-SA; database/tools/import_kaikki.py), then by
-- hand or by a translation run for the words an edition does not have (source says which).
--   ord = 1 is the word's first sense: the one cards show; short = the sense cut to a line a card can hold.
CREATE TABLE IF NOT EXISTS word_meanings (
	word text NOT NULL,
	lang text NOT NULL,
	ord integer NOT NULL,
	pos text,
	meaning text NOT NULL,
	short text NOT NULL,
	example text,
	example_tr text,
	-- one of the words learners meet most (the library's own word list): the wrong answers of a card come from these
	common boolean NOT NULL DEFAULT false,
	source text NOT NULL DEFAULT 'kaikki',
	reviewed boolean NOT NULL DEFAULT false,
	PRIMARY KEY (word, lang, ord)
);
-- Wrong answers for "what does it mean": first senses of common words of one language and part of speech
CREATE INDEX IF NOT EXISTS word_meanings_first ON word_meanings (lang, pos) WHERE ord = 1 AND common;
