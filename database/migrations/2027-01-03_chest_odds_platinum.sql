-- Platinum gave back more Kim cương on average than it costs when every badge is already owned
-- (2835 of 2500), so opening it again and again made Kim cương. gems_800 gives 12 of its weight to Khiên.
-- Average back after this: 2355 of 2500. Weights still sum to 100.
UPDATE chest_drops SET weight = CASE item_code WHEN 'gems_800' THEN 12 WHEN 'shield' THEN 22 END
WHERE chest_code = 'platinum' AND item_code IN ('gems_800', 'shield') AND NOT guaranteed;
