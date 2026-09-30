-- Free plan = chỉ các bài is_free, không còn tính lượt (quota) theo lượt Check.
-- Chạy được nhiều lần. Chạy xong khởi động lại Directus để xoá cache quyền.
--   docker exec -i map-listening-db psql -U postgres -d map-listening < database/migrations/2026-09-26_listening_premium_lock.sql

BEGIN;

-- 1. Bài mặc định là Premium; admin tick is_free trong Directus để mở cho gói Free.
UPDATE listening_targets SET is_free = false WHERE is_free IS NULL;
ALTER TABLE listening_targets ALTER COLUMN is_free SET DEFAULT false;
ALTER TABLE listening_targets ALTER COLUMN is_free SET NOT NULL;

-- 2. Khách (Public) và Free User không đọc được phần để làm bài của clip
--    (start_time / end_time / transcript). Phần này chỉ lấy qua
--    GET /v1/listening-lab/challenges/:key/clips, nơi kiểm tra is_free / Premium.
--    Vẫn đọc được id, target_id, source_video_id để trang danh sách đếm clip và
--    lấy ảnh bìa video.
UPDATE directus_permissions p
SET fields = 'id,status,date_created,date_updated,source_video_id,target_id'
FROM directus_policies pol
WHERE pol.id = p.policy
  AND p.collection = 'listening_clips'
  AND p.action = 'read'
  AND pol.name IN ('$t:public_label', 'Free Access');

COMMIT;

-- Rollback:
--   UPDATE directus_permissions p SET fields = '*' FROM directus_policies pol
--   WHERE pol.id = p.policy AND p.collection = 'listening_clips' AND p.action = 'read'
--     AND pol.name IN ('$t:public_label', 'Free Access');
--   ALTER TABLE listening_targets ALTER COLUMN is_free DROP NOT NULL;
--   ALTER TABLE listening_targets ALTER COLUMN is_free DROP DEFAULT;
