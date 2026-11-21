-- Intensive Listening: the gist question is asked twice (before and after the sentences) and is not marked until the
-- result, so the two answers can be compared. Each passage says which sentences hold the gist, and each sentence lists
-- its key words (words that change the meaning: can't, not, but, the main nouns), so the result can say which misses
-- may have made the learner misunderstand.
--   il_lessons.gist_sentences   sentence numbers (il_sentences.n) that carry the answer to the gist question
--   il_sentences.key_words      lower-case words of the sentence that matter for its meaning
--   il_attempts.gist_choice2    the answer given the second time (gist_choice stays the first)
ALTER TABLE il_lessons  ADD COLUMN IF NOT EXISTS gist_sentences smallint[] NOT NULL DEFAULT '{}';
ALTER TABLE il_sentences ADD COLUMN IF NOT EXISTS key_words text[] NOT NULL DEFAULT '{}';
ALTER TABLE il_attempts ADD COLUMN IF NOT EXISTS gist_choice2 smallint;
ALTER TABLE il_attempts ADD COLUMN IF NOT EXISTS gist_right2 boolean;

-- "You can't unboil an egg": sentences 2 and 3 flip the meaning (can't, then "it turns out you can")
UPDATE il_lessons SET gist_sentences = '{2,3}' WHERE slug = 'you-cant-unboil-an-egg';
UPDATE il_sentences s SET key_words = v.k FROM (VALUES
	(2, ARRAY['cant', 'unboil']),
	(3, ARRAY['can']),
	(4, ARRAY['thermal', 'mechanical', 'undo']),
	(9, ARRAY['permanent', 'not']),
	(11, ARRAY['unhappen', 'retrace'])
) AS v(n, k) WHERE s.n = v.n AND s.lesson_id = (SELECT id FROM il_lessons WHERE slug = 'you-cant-unboil-an-egg');

-- "Where does chocolate come from?": where the word comes from (3, 4) and what the first chocolate was (5, 6)
-- (key words chosen by .claude/skills/intensive-key-words in the web repo)
UPDATE il_lessons SET gist_sentences = '{3,4,5,6}' WHERE slug = 'where-does-chocolate-come-from';
UPDATE il_sentences s SET key_words = v.k FROM (VALUES
	(3, ARRAY['where']),
	(4, ARRAY['borrowed']),
	(5, ARRAY['wasnt', 'eat']),
	(6, ARRAY['drink']),
	(7, ARRAY['but', 'doesnt']),
	(8, ARRAY['dark']),
	(11, ARRAY['not', 'sweet'])
) AS v(n, k) WHERE s.n = v.n AND s.lesson_id = (SELECT id FROM il_lessons WHERE slug = 'where-does-chocolate-come-from');

-- The narrowing ladder: for a key word still missed after the 0.75x retry the learner hears the word said clearly in
-- another video and types it; if that fails, picks its meaning. The outcome is kept on the sentence's round-1 result:
--   { word, outcome: clear | known | new | unclear | skipped }
--   clear    heard it when said clearly: the sound changes in fast speech (linking, weak form, ending)
--   known    did not hear it, but knows its meaning: knows the spelling, not the sound
--   new      did not hear it and does not know its meaning: a new word
--   unclear  did not hear it even said clearly (no meaning to ask for: a small word)
--   skipped  the learner skipped it
ALTER TABLE il_results ADD COLUMN IF NOT EXISTS ladder jsonb;
