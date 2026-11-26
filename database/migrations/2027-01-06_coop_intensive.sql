-- Luyện cùng rooms are one Intensive passage: coop_rooms.lesson_id now points at il_lessons (was listening_lessons)
BEGIN;
ALTER TABLE coop_rooms DROP CONSTRAINT IF EXISTS coop_rooms_lesson_id_fkey;
UPDATE coop_rooms SET lesson_id = NULL WHERE lesson_id IS NOT NULL AND lesson_id NOT IN (SELECT id FROM il_lessons);
ALTER TABLE coop_rooms ADD CONSTRAINT coop_rooms_lesson_id_fkey FOREIGN KEY (lesson_id) REFERENCES il_lessons(id) ON DELETE SET NULL;
COMMIT;
