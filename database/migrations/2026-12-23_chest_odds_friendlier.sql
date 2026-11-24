-- Rare drops were 1-3%, which reads as "I will never win". Move weight from the cheapest drops to the rare ones
-- (each chest's weights still sum to 100, so the % on the page is the real chance). Average value stays well under the price.
-- bronze 150: gems_300 3 -> 8, gold_star 2 -> 8
UPDATE chest_drops SET weight = CASE item_code WHEN 'gems_50' THEN 30 WHEN 'shield' THEN 22 WHEN 'extra_star' THEN 20 WHEN 'gems_100' THEN 12 WHEN 'gold_star' THEN 8 WHEN 'gems_300' THEN 8 END
WHERE chest_code = 'bronze' AND item_code IN ('gems_50','shield','extra_star','gems_100','gold_star','gems_300');
-- silver 400: gems_1000 2 -> 6
UPDATE chest_drops SET weight = CASE item_code WHEN 'gems_100' THEN 24 WHEN 'shield' THEN 18 WHEN 'extra_star' THEN 14 WHEN 'gold_star' THEN 20 WHEN 'gems_300' THEN 12 WHEN 'badge_silver' THEN 6 WHEN 'gems_1000' THEN 6 END
WHERE chest_code = 'silver' AND item_code IN ('gems_100','shield','extra_star','gold_star','gems_300','badge_silver','gems_1000');
-- gold 1000: gems_2500 1 -> 3
UPDATE chest_drops SET weight = CASE item_code WHEN 'gems_300' THEN 28 WHEN 'gold_star' THEN 18 WHEN 'gems_100' THEN 21 WHEN 'shield' THEN 8 WHEN 'badge_gold' THEN 8 WHEN 'gems_800' THEN 8 WHEN 'extra_star' THEN 6 WHEN 'gems_2500' THEN 3 END
WHERE chest_code = 'gold' AND item_code IN ('gems_300','gold_star','gems_100','shield','badge_gold','gems_800','extra_star','gems_2500');
-- platinum 2500: gems_6000 1 -> 3, badge_platinum 6 -> 8
UPDATE chest_drops SET weight = CASE item_code WHEN 'gems_300' THEN 25 WHEN 'gold_star' THEN 18 WHEN 'gems_800' THEN 24 WHEN 'badge_gold' THEN 12 WHEN 'shield' THEN 10 WHEN 'badge_platinum' THEN 8 WHEN 'gems_6000' THEN 3 END
WHERE chest_code = 'platinum' AND guaranteed = false AND item_code IN ('gems_300','gold_star','gems_800','badge_gold','shield','badge_platinum','gems_6000');
-- platinum had a gems_100 row (old premium_day weight): trim so the non-guaranteed weights sum to exactly 100
UPDATE chest_drops SET weight = 5 WHERE chest_code = 'platinum' AND item_code = 'gems_100' AND guaranteed = false;
UPDATE chest_drops SET weight = 20 WHERE chest_code = 'platinum' AND item_code = 'gems_300' AND guaranteed = false;
