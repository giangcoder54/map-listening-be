-- Phòng Luyện cùng: two learners hear the same clip at the same time, talk in a chat, answer, then see the answer together.
-- State lives here; the browsers poll it (GET /v1/coop/:id), so no socket server is needed.
CREATE TABLE IF NOT EXISTS coop_rooms (
	id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	host_id    uuid        NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	status     varchar(10) NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','playing','done','cancelled')),
	-- [{ clip_id, blank, options, correct, word, transcript, video_id, start, end }]
	questions  jsonb       NOT NULL,
	idx        smallint    NOT NULL DEFAULT 0,
	phase      varchar(10) NOT NULL DEFAULT 'answer' CHECK (phase IN ('answer','reveal')),
	-- bumped by "play the clip": every browser plays the clip again when it sees a new number
	play_seq   integer     NOT NULL DEFAULT 0,
	phase_at   timestamptz NOT NULL DEFAULT now(),
	created_at timestamptz NOT NULL DEFAULT now(),
	done_at    timestamptz
);
CREATE INDEX IF NOT EXISTS coop_rooms_status ON coop_rooms (status, created_at DESC);
CREATE TABLE IF NOT EXISTS coop_members (
	room_id   uuid NOT NULL REFERENCES coop_rooms(id) ON DELETE CASCADE,
	user_id   uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	joined_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS coop_members_user ON coop_members (user_id);
CREATE TABLE IF NOT EXISTS coop_answers (
	room_id uuid     NOT NULL REFERENCES coop_rooms(id) ON DELETE CASCADE,
	idx     smallint NOT NULL,
	user_id uuid     NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	choice  smallint NOT NULL CHECK (choice BETWEEN 0 AND 2),
	correct boolean  NOT NULL,
	PRIMARY KEY (room_id, idx, user_id)
);
CREATE TABLE IF NOT EXISTS coop_messages (
	id         bigserial PRIMARY KEY,
	room_id    uuid NOT NULL REFERENCES coop_rooms(id) ON DELETE CASCADE,
	user_id    uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	body       text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coop_messages_room ON coop_messages (room_id, id);

-- the reward for a finished room goes in the ledger as 'coop'
ALTER TABLE coin_events DROP CONSTRAINT IF EXISTS coin_events_reason_check;
ALTER TABLE coin_events ADD CONSTRAINT coin_events_reason_check CHECK (reason IN (
	'lesson','perfect','goal','streak','review','ad','unlock','premium_day','freeze','retest','refund','admin','trap','streak_milestone',
	'skill_test','replay','phrase_unlock','ai','challenge','bank','star','chest','card','card_skip','recovery','purchase','chargeback',
	'room_fee','room_prize','help','coop'));
