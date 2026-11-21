-- The lexicon: one shared store for every English word and phrase a learner meets (spec: MapListeningProject/docs/lexicon-spec.md).
-- Extensive, Intensive, the daily review and My words point at an entry by id instead of keeping their own text and meaning.
--
--   lex_entries              one row per word or phrase (lemma, kind, IPA US/UK)
--   lex_forms                the forms seen in text ("turns out", "turned out" -> "turn out")
--   lex_senses               the senses of an entry; base text = gloss_en (English)
--   lex_sense_translations   the meaning of a sense in a learner language, one row per (sense, lang); lang is BCP-47 (vi-VN, th-TH)
--                            columns: short (a card's answer, a few words), meaning (one line), example_tr
--                            a learner language without a row falls back to gloss_en
--   lex_occurrences          where an entry appears (lesson, sentence, clip), with the sense chosen for that context
--   user_lex                 a learner and an entry (saved / learning / known / ignored); replaces user_words + el_saved_words later
--   lex_suggestions          a learner's better meaning, applied only when an admin accepts it
--
-- Nothing reads these tables yet; the old ones (word_meanings, el_vocab, user_words...) stay until the routes move over.

CREATE TABLE IF NOT EXISTS lex_entries (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	lemma         text NOT NULL,                       -- base form as shown: "turn out", "reside"
	norm          text NOT NULL,                       -- lowercase, straight quotes, single spaces: the key
	homograph     smallint NOT NULL DEFAULT 1,         -- saw (tool) = 1, saw (see) = 2
	kind          text NOT NULL CHECK (kind IN ('word', 'phrasal_verb', 'idiom', 'phrase', 'chunk')),
	ipa_us        text,
	ipa_uk        text,
	cefr          text,
	freq_rank     integer,
	source        text NOT NULL,                       -- where the entry came from: kaikki, el_vocab, phrase_lab, clip_target, user_words...
	reviewed      boolean NOT NULL DEFAULT false,
	date_created  timestamptz NOT NULL DEFAULT now(),
	date_updated  timestamptz NOT NULL DEFAULT now(),
	UNIQUE (norm, homograph)
);
CREATE INDEX IF NOT EXISTS lex_entries_kind ON lex_entries (kind);

CREATE TABLE IF NOT EXISTS lex_forms (
	entry_id  uuid NOT NULL REFERENCES lex_entries(id) ON DELETE CASCADE,
	form      text NOT NULL,                           -- normalized like lex_entries.norm; the lemma itself is a form too
	PRIMARY KEY (entry_id, form)
);
CREATE INDEX IF NOT EXISTS lex_forms_form ON lex_forms (form);

CREATE TABLE IF NOT EXISTS lex_senses (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	entry_id      uuid NOT NULL REFERENCES lex_entries(id) ON DELETE CASCADE,
	ord           smallint NOT NULL,                   -- 1 = the sense shown first
	pos           text,                                -- noun, verb, adj, adv, prep, pron, conj, intj, det, num, phrase...; label via i18n pos.*
	gloss_en      text,                                -- base text; null until the English Wiktionary pass fills it
	example_en    text,
	source        text NOT NULL,
	reviewed      boolean NOT NULL DEFAULT false,
	date_created  timestamptz NOT NULL DEFAULT now(),
	UNIQUE (entry_id, ord)
);

CREATE TABLE IF NOT EXISTS lex_sense_translations (
	sense_id      uuid NOT NULL REFERENCES lex_senses(id) ON DELETE CASCADE,
	lang          text NOT NULL,
	short         text NOT NULL,
	meaning       text NOT NULL,
	example_tr    text,
	source        text NOT NULL,                       -- kaikki, el_vocab, phrase_lab, ai, claude, user
	reviewed      boolean NOT NULL DEFAULT false,
	date_updated  timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (sense_id, lang)
);
CREATE INDEX IF NOT EXISTS lex_sense_translations_queue ON lex_sense_translations (lang) WHERE NOT reviewed;

CREATE TABLE IF NOT EXISTS lex_occurrences (
	id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	entry_id    uuid NOT NULL REFERENCES lex_entries(id) ON DELETE CASCADE,
	sense_id    uuid REFERENCES lex_senses(id) ON DELETE SET NULL,
	owner_type  text NOT NULL CHECK (owner_type IN ('el_lesson', 'il_sentence', 'll_clip')),
	owner_id    uuid NOT NULL,
	n           smallint,                              -- order in the lesson's word list (el_lesson)
	surface     text NOT NULL,                         -- the words as said: "turns out"
	start_ms    integer,
	end_ms      integer
);
CREATE INDEX IF NOT EXISTS lex_occurrences_owner ON lex_occurrences (owner_type, owner_id);
CREATE INDEX IF NOT EXISTS lex_occurrences_entry ON lex_occurrences (entry_id);
CREATE UNIQUE INDEX IF NOT EXISTS lex_occurrences_slot ON lex_occurrences (owner_type, owner_id, n) WHERE n IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_lex (
	user_id        uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	entry_id       uuid NOT NULL REFERENCES lex_entries(id) ON DELETE CASCADE,
	sense_id       uuid REFERENCES lex_senses(id) ON DELETE SET NULL,
	status         text NOT NULL DEFAULT 'saved' CHECK (status IN ('saved', 'learning', 'known', 'ignored')),
	occurrence_id  uuid REFERENCES lex_occurrences(id) ON DELETE SET NULL,
	saved_at       timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, entry_id)
);

CREATE TABLE IF NOT EXISTS lex_suggestions (
	id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id        uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	entry_id       uuid NOT NULL REFERENCES lex_entries(id) ON DELETE CASCADE,
	sense_id       uuid REFERENCES lex_senses(id) ON DELETE CASCADE,   -- null = a new sense
	lang           text NOT NULL,
	short          text NOT NULL,
	meaning        text,
	status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
	reviewed_by    uuid REFERENCES directus_users(id) ON DELETE SET NULL,
	date_created   timestamptz NOT NULL DEFAULT now(),
	date_reviewed  timestamptz
);
CREATE INDEX IF NOT EXISTS lex_suggestions_queue ON lex_suggestions (date_created) WHERE status = 'pending';
