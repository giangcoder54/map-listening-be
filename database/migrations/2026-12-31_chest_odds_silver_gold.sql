-- Silver and gold gave back more Kim cương on average than they cost: 2026-12-27_remove_extra_star.sql
-- deleted a drop without moving its weight, so every other share grew (silver weights summed to 86, gold
-- to 94). A badge already owned also pays its value in Kim cương, which is counted here.
-- Average back after this: silver 367 of 400, gold 928 of 1000. Each chest's weights sum to 100 again.

-- silver: the 14 freed go to Khiên
UPDATE chest_drops SET weight = 32 WHERE chest_code = 'silver' AND item_code = 'shield' AND NOT guaranteed;

-- gold: the 6 freed plus 8 from gems_300 go to Khiên (the 6 alone would still leave 1024 of 1000)
UPDATE chest_drops SET weight = CASE item_code WHEN 'gems_300' THEN 20 WHEN 'shield' THEN 22 END
WHERE chest_code = 'gold' AND item_code IN ('gems_300', 'shield') AND NOT guaranteed;
