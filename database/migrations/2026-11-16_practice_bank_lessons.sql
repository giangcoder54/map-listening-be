-- Sentences only the practice bank has: each rule gets one hidden "bank" lesson (kind 'bank') that
-- holds them, like the weekly challenge's hidden lessons (kind 'challenge'). Never on the path, never
-- in tests or reviews (loadLessonGraph skips it), not in the admin lesson list; the bank reads its
-- clips (lib/bank.ts CLIP_FILTER) and /admin/practice manages them.
BEGIN;
ALTER TABLE listening_lessons DROP CONSTRAINT IF EXISTS listening_lessons_kind_check;
ALTER TABLE listening_lessons ADD CONSTRAINT listening_lessons_kind_check CHECK (kind IN ('pattern', 'trap', 'mixed', 'challenge', 'bank'));
COMMIT;
