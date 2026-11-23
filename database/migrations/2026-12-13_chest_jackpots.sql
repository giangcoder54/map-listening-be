-- Every chest can pay out more than it cost (a jackpot drop), while the average stays under the price.
INSERT INTO items (code, kind, params, rarity, value) VALUES
	('gems_1000', 'gems', '{"amount":1000}', 3, 1000),
	('gems_2500', 'gems', '{"amount":2500}', 4, 2500),
	('gems_6000', 'gems', '{"amount":6000}', 4, 6000)
ON CONFLICT (code) DO NOTHING;
INSERT INTO item_translations (code, lang, name, body) VALUES
	('gems_1000', 'vi', '1.000 Kim cương', NULL), ('gems_1000', 'en', '1,000 Gems', NULL),
	('gems_2500', 'vi', '2.500 Kim cương', NULL), ('gems_2500', 'en', '2,500 Gems', NULL),
	('gems_6000', 'vi', '6.000 Kim cương', NULL), ('gems_6000', 'en', '6,000 Gems', NULL)
ON CONFLICT (code, lang) DO NOTHING;

-- bronze 150: jackpot 300
UPDATE chest_drops SET weight = 45 WHERE chest_code = 'bronze' AND item_code = 'gems_50';
UPDATE chest_drops SET weight = 5  WHERE chest_code = 'bronze' AND item_code = 'gems_100';
UPDATE chest_drops SET weight = 2  WHERE chest_code = 'bronze' AND item_code = 'gold_star';
INSERT INTO chest_drops (chest_code, item_code, weight) SELECT 'bronze', 'gems_300', 3
	WHERE NOT EXISTS (SELECT 1 FROM chest_drops WHERE chest_code = 'bronze' AND item_code = 'gems_300');
-- silver 400: jackpot 1000
UPDATE chest_drops SET weight = 28 WHERE chest_code = 'silver' AND item_code = 'gems_100';
INSERT INTO chest_drops (chest_code, item_code, weight) SELECT 'silver', 'gems_1000', 2
	WHERE NOT EXISTS (SELECT 1 FROM chest_drops WHERE chest_code = 'silver' AND item_code = 'gems_1000');
-- gold 1000: jackpot 2500
INSERT INTO chest_drops (chest_code, item_code, weight) SELECT 'gold', 'gems_2500', 1
	WHERE NOT EXISTS (SELECT 1 FROM chest_drops WHERE chest_code = 'gold' AND item_code = 'gems_2500');
-- platinum 2500: jackpot 6000
UPDATE chest_drops SET weight = 23 WHERE chest_code = 'platinum' AND item_code = 'gems_800';
INSERT INTO chest_drops (chest_code, item_code, weight) SELECT 'platinum', 'gems_6000', 1
	WHERE NOT EXISTS (SELECT 1 FROM chest_drops WHERE chest_code = 'platinum' AND item_code = 'gems_6000');
