-- =====================================================================
-- Phrase Lab: a bigger bank (docs/phrase-lab-roadmap.md §9 in the web repo)
--
--   phrase_types.track            'phrase' (say it) | 'idiom' (understand it: guess-the-meaning card,
--                                 reviews never ask to say it)
--   phrases.cefr                  A1..C2, how hard the phrase is to understand
--   phrases.freq_tier             1 very common · 2 common · 3 now and then · 4 rare. The type's path
--                                 runs tier 1 first; tier 4 stays out of paths (quizzes, marketing).
--   phrases.freq_clips            times it is said in the video library (source_videos transcripts)
--   phrases.freq_books            times per million words in Google Books (2015-2019), for idioms
--   phrases_translations.examples [{ "a": "...", "b": "...", "a_tr": "...", "b_tr": "..." }]
--                                 short A-B exchanges written for the card (the phrase in a or b)
--   phrases_translations.parts    [{ "text": "storm", "literal": "cơn bão" }]  idioms: word by word
--   phrases_translations.origin   why it means what it means, one sentence (idioms)
--   phrase_type_links             a phrase in more types than its home type (phrases.type_id),
--                                 with how it is used there: "You know what?" opens a chat AND
--                                 starts a complaint. Progress stays per phrase.
-- =====================================================================

BEGIN;

ALTER TABLE phrase_types ADD COLUMN IF NOT EXISTS track varchar(10) NOT NULL DEFAULT 'phrase';
DO $$ BEGIN
	ALTER TABLE phrase_types ADD CONSTRAINT phrase_types_track_check CHECK (track IN ('phrase', 'idiom'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE phrases ADD COLUMN IF NOT EXISTS cefr varchar(2);
ALTER TABLE phrases ADD COLUMN IF NOT EXISTS freq_tier smallint;
ALTER TABLE phrases ADD COLUMN IF NOT EXISTS freq_clips integer;
ALTER TABLE phrases ADD COLUMN IF NOT EXISTS freq_books numeric(10, 4);
DO $$ BEGIN
	ALTER TABLE phrases ADD CONSTRAINT phrases_cefr_check CHECK (cefr IS NULL OR cefr IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
	ALTER TABLE phrases ADD CONSTRAINT phrases_freq_tier_check CHECK (freq_tier IS NULL OR freq_tier BETWEEN 1 AND 4);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE phrases_translations ADD COLUMN IF NOT EXISTS examples jsonb;
ALTER TABLE phrases_translations ADD COLUMN IF NOT EXISTS parts jsonb;
ALTER TABLE phrases_translations ADD COLUMN IF NOT EXISTS origin text;

CREATE TABLE IF NOT EXISTS phrase_type_links (
	id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	phrase_id   uuid NOT NULL REFERENCES phrases(id) ON DELETE CASCADE,
	type_id     uuid NOT NULL REFERENCES phrase_types(id) ON DELETE CASCADE,
	sort        integer,
	usage_vi    text,          -- how it is used in this type (vi)
	usage_en    text,
	date_created timestamptz DEFAULT now(),
	UNIQUE (phrase_id, type_id)
);
CREATE INDEX IF NOT EXISTS phrase_type_links_type ON phrase_type_links (type_id);

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json, v.readonly, v.hidden, v.sort, v.width, v.required, v.note FROM (VALUES
	('phrase_types', 'track', NULL, 'select-dropdown', '{"choices":[{"text":"Phrase","value":"phrase"},{"text":"Idiom","value":"idiom"}]}', NULL, NULL, false, false, 20, 'half', false, 'phrase = learn to say it; idiom = learn to understand it'),
	('phrases', 'cefr', NULL, 'select-dropdown', '{"choices":[{"text":"A1","value":"A1"},{"text":"A2","value":"A2"},{"text":"B1","value":"B1"},{"text":"B2","value":"B2"},{"text":"C1","value":"C1"},{"text":"C2","value":"C2"}]}', NULL, NULL, false, false, 41, 'half', false, 'How hard it is to understand'),
	('phrases', 'freq_tier', NULL, 'input', NULL, NULL, NULL, false, false, 42, 'half', false, '1 very common, 2 common, 3 now and then, 4 rare (kept out of paths)'),
	('phrases', 'freq_clips', NULL, 'input', NULL, NULL, NULL, true, false, 43, 'half', false, 'Times said in the video library'),
	('phrases', 'freq_books', NULL, 'input', NULL, NULL, NULL, true, false, 44, 'half', false, 'Per million words, Google Books 2015-2019'),
	('phrases_translations', 'examples', 'cast-json', 'input-code', '{"language":"json"}', NULL, NULL, false, false, 21, 'full', false, 'Examples: [{a, b, a_tr, b_tr}]'),
	('phrases_translations', 'parts', 'cast-json', 'input-code', '{"language":"json"}', NULL, NULL, false, false, 22, 'full', false, 'Idioms, word by word: [{text, literal}]'),
	('phrases_translations', 'origin', NULL, 'input-multiline', NULL, NULL, NULL, false, false, 23, 'full', false, 'Idioms: why it means this, one sentence')
) AS v(collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

INSERT INTO directus_collections (collection, icon, note, hidden)
SELECT 'phrase_type_links', 'link', 'Phrase Lab: a phrase in more than its home type', false
WHERE NOT EXISTS (SELECT 1 FROM directus_collections c WHERE c.collection = 'phrase_type_links');

-- New types (published once they hold phrases with clips: a type without playable phrases is hidden)
INSERT INTO phrase_types (id, status, slug, sort, track, name)
SELECT gen_random_uuid(), 'published', v.slug, v.sort, v.track, v.name FROM (VALUES
	('fillers',           13, 'phrase', 'Fillers'),
	('listening-replies', 14, 'phrase', 'Listening replies'),
	('changing-topic',    15, 'phrase', 'Changing the topic'),
	('softening',         16, 'phrase', 'Softening'),
	('phrasal-verbs',     17, 'phrase', 'Everyday phrasal verbs'),
	('idioms',            18, 'idiom',  'Idioms')
) AS v(slug, sort, track, name)
WHERE NOT EXISTS (SELECT 1 FROM phrase_types t WHERE t.slug = v.slug);

INSERT INTO phrase_types_translations (phrase_types_id, languages_code, name, description)
SELECT t.id, v.lang, v.name, v.description FROM (VALUES
	('fillers', 'vi-VN', 'Câu giờ khi nói', 'Những câu người bản xứ nói khi đang nghĩ, để không bị im lặng.'),
	('fillers', 'en-US', 'Fillers', 'What people say while they think, so there is no silence.'),
	('listening-replies', 'vi-VN', 'Đáp lời khi nghe', 'Phản hồi ngắn cho người kia biết bạn đang nghe và hiểu.'),
	('listening-replies', 'en-US', 'Listening replies', 'Short replies that show you are listening.'),
	('changing-topic', 'vi-VN', 'Đổi chủ đề, chen ngang', 'Chuyển sang chuyện khác hoặc chen vào lời người khác cho khéo.'),
	('changing-topic', 'en-US', 'Changing the topic', 'Move to another topic or cut in politely.'),
	('softening', 'vi-VN', 'Nói giảm nói tránh', 'Nói nhẹ đi cho đỡ thẳng, đỡ chắc chắn.'),
	('softening', 'en-US', 'Softening', 'Say it less directly, less sure.'),
	('phrasal-verbs', 'vi-VN', 'Cụm động từ hay dùng', 'Động từ đi với giới từ, nghĩa khác hẳn từng chữ.'),
	('phrasal-verbs', 'en-US', 'Everyday phrasal verbs', 'A verb plus a small word, meaning something new.'),
	('idioms', 'vi-VN', 'Thành ngữ thông dụng', 'Ghép từng chữ lại thì ra nghĩa khác hẳn. Đoán thử trước rồi xem đáp án.'),
	('idioms', 'en-US', 'Common idioms', 'The words mean one thing, the idiom another. Guess first, then see.')
) AS v(slug, lang, name, description)
JOIN phrase_types t ON t.slug = v.slug
WHERE NOT EXISTS (SELECT 1 FROM phrase_types_translations x WHERE x.phrase_types_id = t.id AND x.languages_code = v.lang);

COMMIT;
