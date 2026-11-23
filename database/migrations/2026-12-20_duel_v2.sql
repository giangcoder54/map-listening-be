-- Đấu & Luyện cùng v2 (web repo docs/duel-and-coop-spec.md).
--  * duel: a "listen" phase before "answer" (both hear the clip at the same moment), speed points
--  * auto matchmaking: match_queue (fee locked while waiting), match_bans, rooms made by the queue are `auto`
--  * Luyện cùng: a deposit, pick -> "discuss" (change the pick, chat) -> lock, a team star per question

ALTER TABLE coop_rooms DROP CONSTRAINT IF EXISTS coop_rooms_phase_check;
ALTER TABLE coop_rooms ADD CONSTRAINT coop_rooms_phase_check CHECK (phase IN ('answer','reveal','listen','discuss'));
ALTER TABLE coop_rooms ALTER COLUMN phase TYPE varchar(10);

ALTER TABLE coop_rooms   ADD COLUMN IF NOT EXISTS auto  boolean  NOT NULL DEFAULT false;
ALTER TABLE coop_rooms   ADD COLUMN IF NOT EXISTS stars smallint NOT NULL DEFAULT 0;
ALTER TABLE coop_members ADD COLUMN IF NOT EXISTS ready boolean NOT NULL DEFAULT false;
-- practice: the pick after talking, and "I am sure"
ALTER TABLE coop_answers ADD COLUMN IF NOT EXISTS choice2 smallint CHECK (choice2 BETWEEN 0 AND 2);
ALTER TABLE coop_answers ADD COLUMN IF NOT EXISTS locked  boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS match_queue (
	user_id uuid PRIMARY KEY REFERENCES directus_users(id) ON DELETE CASCADE,
	fee     integer     NOT NULL,
	level   integer     NOT NULL DEFAULT 1,
	since   timestamptz NOT NULL DEFAULT now(),
	room_id uuid REFERENCES coop_rooms(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS match_queue_fee ON match_queue (fee, since);

CREATE TABLE IF NOT EXISTS match_bans (
	user_id uuid PRIMARY KEY REFERENCES directus_users(id) ON DELETE CASCADE,
	until   timestamptz NOT NULL
);
