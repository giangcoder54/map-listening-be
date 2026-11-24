-- Chests no longer drop "1 ngày Premium" (lessons are bought with Kim cương). Each premium_day weight moves to gems_100,
-- which has the same value (100), so a chest is worth the same on average. The item row stays: older cards may still point to it.
UPDATE chest_drops d SET weight = d.weight + p.weight
FROM chest_drops p
WHERE p.item_code = 'premium_day' AND d.chest_code = p.chest_code AND d.item_code = 'gems_100';

INSERT INTO chest_drops (chest_code, item_code, weight, guaranteed, premium_alt)
SELECT p.chest_code, 'gems_100', p.weight, false, NULL FROM chest_drops p
WHERE p.item_code = 'premium_day'
  AND NOT EXISTS (SELECT 1 FROM chest_drops d WHERE d.chest_code = p.chest_code AND d.item_code = 'gems_100');

DELETE FROM chest_drops WHERE item_code = 'premium_day';
