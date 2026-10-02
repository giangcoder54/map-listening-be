-- =====================================================================
-- Skills for what makes natural English hard to hear (connected speech + single words),
-- after the usual classification: linking (catenation, intrusion, gemination), elision,
-- assimilation (incl. yod coalescence), T sounds (flap, stop, silent after N), reduction
-- (weak forms, gonna/wanna, contractions); and words that lose a syllable.
--
-- `slug` is also the "type" the admin "Transcript -> AI" page asks the AI for.
-- Existing skills keep their name and slug; they get a category, a sort, and fixed copy.
-- =====================================================================

BEGIN;

-- Existing skills: category + order inside the group
UPDATE listening_skills SET category = 'Linking',      sort = 10 WHERE slug = 'linking-words';
UPDATE listening_skills SET category = 'Elision',      sort = 20 WHERE slug = 'h-dropping';
UPDATE listening_skills SET category = 'Assimilation', sort = 30 WHERE slug = 'assimilation';
UPDATE listening_skills SET category = 'Reduction',    sort = 50 WHERE slug = 'reduction';
UPDATE listening_skills SET sort = 99 WHERE slug = 'connected-speech-mixed';
UPDATE listening_skills SET sort = 99 WHERE slug = 'single-word';

-- New skills
INSERT INTO listening_skills (status, sort, group_id, name, slug, category, is_premium)
SELECT 'published', v.sort, g.id, v.name, v.slug, v.category, false
FROM (VALUES
	('connected-speech', 11, 'Intrusive Sounds',   'intrusion',              'Linking'),
	('connected-speech', 12, 'Same Sound Merging', 'gemination',             'Linking'),
	('connected-speech', 21, 'T & D Dropping',     't-d-dropping',           'Elision'),
	('connected-speech', 31, 'Did you → Didja',    'yod-coalescence',        'Assimilation'),
	('connected-speech', 40, 'Flap T',             'flap-t',                 'T sounds'),
	('connected-speech', 41, 'Stop T',             'stop-t',                 'T sounds'),
	('connected-speech', 42, 'Silent T after N',   'silent-t-after-n',       'T sounds'),
	('connected-speech', 51, 'Gonna & Wanna',      'informal-reductions',    'Reduction'),
	('connected-speech', 52, 'Contractions',       'contractions',           'Reduction'),
	('single-word',      10, 'Syllable Deletion',  'syllable-deletion',      'Single words'),
	('single-word',      11, 'Clipped Words',      'clipped-words',          'Single words')
) AS v(group_slug, sort, name, slug, category)
JOIN listening_groups g ON g.slug = v.group_slug
ON CONFLICT (slug) DO NOTHING;

-- Descriptions (en-US, vi-VN): fill the missing ones, fix the broken ones
CREATE TEMP TABLE skill_copy (slug text, lang text, description text, example text) ON COMMIT DROP;
INSERT INTO skill_copy VALUES
	('linking-words', 'en-US', 'A final consonant links to the vowel that starts the next word, so two words sound like one.', 'turn it off → "tur-ni-toff"'),
	('linking-words', 'vi-VN', 'Phụ âm cuối nối sang nguyên âm đầu của từ sau, hai từ nghe như một.', 'turn it off → "tur-ni-toff"'),
	('intrusion', 'en-US', 'An extra /w/, /j/ or /r/ sound slips in between two vowels.', 'go on → "go-w-on", I agree → "I-y-agree"'),
	('intrusion', 'vi-VN', 'Một âm /w/, /j/ hoặc /r/ chen vào giữa hai nguyên âm.', 'go on → "go-w-on", I agree → "I-y-agree"'),
	('gemination', 'en-US', 'The same sound ends one word and starts the next: it is said once, a little longer.', 'some more → "so-more", bad dog → "ba-dog"'),
	('gemination', 'vi-VN', 'Từ trước kết thúc và từ sau bắt đầu bằng cùng một âm: chỉ đọc một lần, kéo dài hơn.', 'some more → "so-more", bad dog → "ba-dog"'),
	('h-dropping', 'en-US', 'The /h/ in him, her, his and he disappears when they are unstressed.', 'tell him → "tell-im"'),
	('h-dropping', 'vi-VN', 'Âm /h/ của him, her, his, he bị nuốt khi không được nhấn.', 'tell him → "tell-im"'),
	('t-d-dropping', 'en-US', 'A /t/ or /d/ between two consonants is dropped.', 'last night → "las'' night", next week → "nex'' week"'),
	('t-d-dropping', 'vi-VN', 'Âm /t/ hoặc /d/ nằm giữa hai phụ âm bị bỏ đi.', 'last night → "las'' night", next week → "nex'' week"'),
	('assimilation', 'en-US', 'A sound changes to become more like the sound next to it.', 'ten boys → "tem boys", good girl → "goog girl"'),
	('assimilation', 'vi-VN', 'Một âm biến đổi cho giống âm bên cạnh.', 'ten boys → "tem boys", good girl → "goog girl"'),
	('yod-coalescence', 'en-US', '/t/, /d/, /s/ or /z/ before "you" or "your" merge into "ch", "j", "sh" or "zh".', 'did you → "didja", got you → "gotcha", miss you → "mishu"'),
	('yod-coalescence', 'vi-VN', '/t/, /d/, /s/, /z/ đứng trước "you", "your" hoà thành "ch", "j", "sh", "zh".', 'did you → "didja", got you → "gotcha", miss you → "mishu"'),
	('flap-t', 'en-US', 'In American English, a /t/ between vowels becomes a quick soft "d".', 'get it → "ge-dit", a lot of → "a-lo-da", water → "wa-der"'),
	('flap-t', 'vi-VN', 'Trong tiếng Anh Mỹ, /t/ giữa hai nguyên âm thành một âm "d" nhẹ và nhanh.', 'get it → "ge-dit", a lot of → "a-lo-da", water → "wa-der"'),
	('stop-t', 'en-US', 'A /t/ is cut short (held, not released) before a consonant or at the end: you hear a small stop, not a "t".', 'not now → "no(t) now", can''t go → "can(t) go", button → "bu-(t)n"'),
	('stop-t', 'vi-VN', '/t/ bị chặn lại, không bật hơi, trước phụ âm hoặc ở cuối: chỉ nghe một khoảng ngắt nhỏ.', 'not now → "no(t) now", can''t go → "can(t) go", button → "bu-(t)n"'),
	('silent-t-after-n', 'en-US', 'After /n/, a /t/ often disappears in American English.', 'twenty → "twenny", want it → "wan-nit", internet → "inner-net"'),
	('silent-t-after-n', 'vi-VN', 'Sau /n/, âm /t/ thường biến mất trong tiếng Anh Mỹ.', 'twenty → "twenny", want it → "wan-nit", internet → "inner-net"'),
	('reduction', 'en-US', 'Small words (to, for, of, and, can, them…) are said quickly with a weak vowel.', 'cup of tea → "cuppa tea", for you → "fer you"'),
	('reduction', 'vi-VN', 'Từ chức năng (to, for, of, and, can, them…) đọc nhanh và nhẹ với nguyên âm yếu.', 'cup of tea → "cuppa tea", for you → "fer you"'),
	('informal-reductions', 'en-US', 'Common phrases squeezed into one word in casual speech.', 'going to → "gonna", want to → "wanna", let me → "lemme", don''t know → "dunno"'),
	('informal-reductions', 'vi-VN', 'Cụm từ quen thuộc bị nén thành một từ trong văn nói thân mật.', 'going to → "gonna", want to → "wanna", let me → "lemme", don''t know → "dunno"'),
	('contractions', 'en-US', 'Short forms (''ll, ''d, ''ve, ''re) are tiny and easy to miss, especially stacked.', 'I''d have → "I''da", should have → "shoulda", it''ll → "i-dl"'),
	('contractions', 'vi-VN', 'Dạng rút gọn (''ll, ''d, ''ve, ''re) rất nhỏ, dễ bỏ lỡ, nhất là khi chồng lên nhau.', 'I''d have → "I''da", should have → "shoulda", it''ll → "i-dl"'),
	('syllable-deletion', 'en-US', 'An unstressed syllable inside a word disappears.', 'comfortable → "comf-table", different → "diff-rent", family → "fam-ly"'),
	('syllable-deletion', 'vi-VN', 'Một âm tiết không nhấn bên trong từ bị nuốt mất.', 'comfortable → "comf-table", different → "diff-rent", family → "fam-ly"'),
	('clipped-words', 'en-US', 'The first, unstressed syllable of a word is dropped.', 'because → "''cause", about → "''bout", remember → "''member"'),
	('clipped-words', 'vi-VN', 'Âm tiết đầu (không nhấn) của từ bị bỏ đi.', 'because → "''cause", about → "''bout", remember → "''member"');

UPDATE listening_skills_translations t
SET description = c.description, example = c.example
FROM skill_copy c JOIN listening_skills s ON s.slug = c.slug
WHERE t.listening_skills_id = s.id AND t.languages_code = c.lang;

INSERT INTO listening_skills_translations (listening_skills_id, languages_code, description, example)
SELECT s.id, c.lang, c.description, c.example
FROM skill_copy c JOIN listening_skills s ON s.slug = c.slug
WHERE NOT EXISTS (
	SELECT 1 FROM listening_skills_translations t WHERE t.listening_skills_id = s.id AND t.languages_code = c.lang
);

COMMIT;
