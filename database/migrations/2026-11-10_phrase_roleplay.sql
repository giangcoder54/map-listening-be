-- =====================================================================
-- Phrase Lab, lesson step 4 "Nhập vai" (role-play): a real situation and a short dialogue,
-- the learner answers (typed or spoken) using the phrase, AI says if it fits, then the saved
-- suggestions are shown.
--
-- The dialogue is English and the same for every learner language; only its translation is per
-- language, so a new language only adds translation rows.
--
--   phrases.roleplay                {                                    (English, the base)
--     "setting":     "Your mum asks why the fridge is empty again",
--     "partner":     "Mum",
--     "lines":       [{ "speaker": "Mum", "en": "Who ate all the dumplings?" }],
--     "suggestions": ["You know what? It was the cat.", "..."],
--     "follow_up":   "The cat. Can't open the fridge."
--   }
--   phrases_translations.roleplay   {                                    (one per learner language)
--     "setting":   "Mẹ hỏi sao tủ lạnh lại trống trơn",
--     "lines":     ["Ai ăn hết chỗ há cảo rồi?"],                        (same order as lines)
--     "follow_up": "..."
--   }
--   The learner answers the last line. No translation for the learner's language = English only.
--   No roleplay at all = the lesson falls back to situations[0].
--
--   phrase_roleplay_checks          one row per AI check (daily limit, and to read real answers)
-- =====================================================================

BEGIN;

ALTER TABLE phrases ADD COLUMN IF NOT EXISTS roleplay jsonb;
ALTER TABLE phrases_translations ADD COLUMN IF NOT EXISTS roleplay jsonb;

CREATE TABLE IF NOT EXISTS phrase_roleplay_checks (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id       uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	phrase_id     uuid NOT NULL REFERENCES phrases(id) ON DELETE CASCADE,
	answer        varchar(400) NOT NULL,
	input         varchar(10)  NOT NULL DEFAULT 'text' CHECK (input IN ('text', 'voice')),
	verdict       varchar(10)  CHECK (verdict IN ('good', 'ok', 'off')),   -- null = AI failed
	feedback      text,
	corrected     varchar(400),
	ms            integer,                                                  -- AI time
	date_created  timestamptz  DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phrase_roleplay_checks_user_day ON phrase_roleplay_checks (user_id, date_created);

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json, v.readonly, v.hidden, v.sort, v.width, v.required, v.note FROM (VALUES
	('phrases', 'roleplay', 'cast-json', 'input-code', '{"language":"json"}', NULL, NULL, false, false, 40, 'full', false, 'Role-play of lesson step 4, English: setting, partner, lines [{speaker, en}], suggestions [en], follow_up'),
	('phrases_translations', 'roleplay', 'cast-json', 'input-code', '{"language":"json"}', NULL, NULL, false, false, 20, 'full', false, 'Translation of the role-play: setting, lines [same order], follow_up')
) AS v(collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

INSERT INTO directus_collections (collection, icon, note, hidden)
SELECT 'phrase_roleplay_checks', 'record_voice_over', 'Phrase Lab: role-play answers checked by AI', false
WHERE NOT EXISTS (SELECT 1 FROM directus_collections c WHERE c.collection = 'phrase_roleplay_checks');

COMMIT;
