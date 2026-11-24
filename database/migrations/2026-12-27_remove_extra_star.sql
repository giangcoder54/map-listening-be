-- "Thêm 1 Ngôi sao may mắn" removed: every run already has its stars, the item decided nothing.
-- Held items become Khiên (same rarity and expiry); drops and the quest reward switch to Khiên.
UPDATE user_items SET item_code = 'shield' WHERE item_code = 'extra_star' AND used_at IS NULL;
DELETE FROM chest_drops WHERE item_code = 'extra_star';
UPDATE cards SET reward = '{"item":"shield"}'::jsonb WHERE reward = '{"item":"extra_star"}'::jsonb;
UPDATE items SET active = false WHERE code = 'extra_star';
