-- Security pass 2026-11-19: tighten Directus permissions. Safe to run twice.
-- Restart Directus afterwards (it caches permissions).

BEGIN;

-- 1. Comments: a learner could send `user_created` and post as someone else.
--    The field is filled by Directus itself (special = user-created), so it is not needed in the payload.
UPDATE directus_permissions
SET fields = 'lesson_id,parent_id,content'
WHERE collection = 'comments' AND action = 'create' AND fields LIKE '%user_created%';

-- 2. source_videos (whole library + full transcripts): no read for guests or learners.
--    Learner pages never read it through /items; the extension reads the database directly.
--    Admins have admin access; content editors keep their own policy (create + read).
DELETE FROM directus_permissions p
WHERE p.collection = 'source_videos'
  AND p.action = 'read'
  AND NOT EXISTS (
    -- keep a read row whose policy also lets that role create source_videos (the editor policy)
    SELECT 1 FROM directus_permissions c
    WHERE c.policy = p.policy AND c.collection = 'source_videos' AND c.action = 'create'
  );

COMMIT;
