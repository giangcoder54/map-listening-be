-- Intensive Listening: why a learner missed words, explained by the AI (lib/ilExplain.ts).
--   il_explain   one row per sentence, typed answer (its words, lower case) and language: { items: [{ word, heard, ipa_word, ipa_heard, why, tip }] }.
--                Kept so the same typed answer is never sent to the AI twice.
CREATE TABLE IF NOT EXISTS il_explain (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	sentence_id uuid NOT NULL REFERENCES il_sentences(id) ON DELETE CASCADE,
	typed_key text NOT NULL,
	lang varchar(10) NOT NULL,
	items jsonb NOT NULL,
	date_created timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS il_explain_key ON il_explain (sentence_id, lang, typed_key);
