-- Luyện cùng, part 2: "Đấu" mode (same question at the same time, a clock, a fee into a pot).
ALTER TABLE coop_rooms   ADD COLUMN IF NOT EXISTS mode        varchar(8) NOT NULL DEFAULT 'practice';
ALTER TABLE coop_rooms   ADD COLUMN IF NOT EXISTS fee         integer    NOT NULL DEFAULT 0;
-- the answer clock (phase "answer") or the pause before the next question (phase "reveal"); only in duel mode
ALTER TABLE coop_rooms   ADD COLUMN IF NOT EXISTS deadline_at timestamptz;
ALTER TABLE coop_members ADD COLUMN IF NOT EXISTS score   integer;
ALTER TABLE coop_members ADD COLUMN IF NOT EXISTS time_ms integer;
ALTER TABLE coop_members ADD COLUMN IF NOT EXISTS prize   integer;
ALTER TABLE coop_answers ADD COLUMN IF NOT EXISTS ms      integer;
DO $$ BEGIN
	ALTER TABLE coop_rooms ADD CONSTRAINT coop_rooms_mode_check CHECK (mode IN ('practice','duel'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
