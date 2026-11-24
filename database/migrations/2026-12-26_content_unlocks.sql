-- Extensive and Intensive lessons bought with Kim cương (lib/contentUnlocks.ts). Premium is no longer sold,
-- so a premium EL / IL lesson must be openable with Kim cương like a Listening Lab lesson (listening_unlocks).
-- kind: 'el' (el_lessons.id) | 'il' (il_lessons.id). No foreign key on lesson_id: it points to one of two tables.
BEGIN;

CREATE TABLE IF NOT EXISTS content_unlocks (
	user_id       uuid        NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	kind          varchar(4)  NOT NULL CHECK (kind IN ('el', 'il')),
	lesson_id     uuid        NOT NULL,
	source        varchar(20) NOT NULL DEFAULT 'coins' CHECK (source IN ('coins', 'gift')),
	coin_event_id bigint      REFERENCES coin_events(id) ON DELETE SET NULL,
	created_at    timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, kind, lesson_id)
);

COMMIT;
