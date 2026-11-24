-- Gems text tables stored the short code (vi, en); every other translation table stores the BCP-47 `language`
-- of nuxt.config locales (vi-VN, en-US). Make them the same so code never cuts a code with slice(0, 2)
-- (zh-CN and zh-TW would have shared one row). Rows keep their text, only `lang` changes.
-- Tables: item_translations (code, lang), chest_translations (code, lang), card_translations (card_id, lang)
BEGIN;

-- If a row already exists under the long code, the short-code row is a leftover: drop it so the rename cannot collide
DELETE FROM item_translations  s USING item_translations  l WHERE s.lang = 'vi' AND l.lang = 'vi-VN' AND s.code = l.code;
DELETE FROM item_translations  s USING item_translations  l WHERE s.lang = 'en' AND l.lang = 'en-US' AND s.code = l.code;
DELETE FROM chest_translations s USING chest_translations l WHERE s.lang = 'vi' AND l.lang = 'vi-VN' AND s.code = l.code;
DELETE FROM chest_translations s USING chest_translations l WHERE s.lang = 'en' AND l.lang = 'en-US' AND s.code = l.code;
DELETE FROM card_translations  s USING card_translations  l WHERE s.lang = 'vi' AND l.lang = 'vi-VN' AND s.card_id = l.card_id;
DELETE FROM card_translations  s USING card_translations  l WHERE s.lang = 'en' AND l.lang = 'en-US' AND s.card_id = l.card_id;

UPDATE item_translations  SET lang = CASE lang WHEN 'vi' THEN 'vi-VN' WHEN 'en' THEN 'en-US' END WHERE lang IN ('vi', 'en');
UPDATE chest_translations SET lang = CASE lang WHEN 'vi' THEN 'vi-VN' WHEN 'en' THEN 'en-US' END WHERE lang IN ('vi', 'en');
UPDATE card_translations  SET lang = CASE lang WHEN 'vi' THEN 'vi-VN' WHEN 'en' THEN 'en-US' END WHERE lang IN ('vi', 'en');

COMMIT;
