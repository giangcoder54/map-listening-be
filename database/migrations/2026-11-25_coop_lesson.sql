-- Luyện cùng is a lesson of the Listening Lab done by two learners: the room keeps the lesson and what each player pays for it
ALTER TABLE coop_rooms   ADD COLUMN IF NOT EXISTS lesson_id    uuid REFERENCES listening_lessons(id) ON DELETE SET NULL;
ALTER TABLE coop_members ADD COLUMN IF NOT EXISTS lesson_price integer NOT NULL DEFAULT 0;
