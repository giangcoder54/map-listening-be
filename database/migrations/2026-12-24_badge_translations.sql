-- Badge names per language, as rows instead of a column per language (name_vi / name_en).
-- Base language (vi-VN) stays in badges.name_vi. Every other language is a row here: a new language = new rows, no migration.
-- Keys: (code, lang). lang is the BCP-47 `language` of nuxt.config locales (en-US, th-TH...).
BEGIN;

CREATE TABLE IF NOT EXISTS badge_translations (
	code varchar(30) NOT NULL REFERENCES badges(code) ON DELETE CASCADE,
	lang varchar(10) NOT NULL,
	name text NOT NULL,
	PRIMARY KEY (code, lang)
);

-- copy the English names that exist today, then drop the per-language column
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'badges' AND column_name = 'name_en') THEN
		INSERT INTO badge_translations (code, lang, name)
		SELECT code, 'en-US', name_en FROM badges WHERE name_en IS NOT NULL AND name_en <> ''
		ON CONFLICT (code, lang) DO NOTHING;
		ALTER TABLE badges DROP COLUMN name_en;
	END IF;
END $$;

COMMIT;
