-- Kim cương v2, P1: Ngôi sao (web repo docs/xu-ngoi-sao-spec.md F2, docs/xu-v2-backend.md mục 4).
--
-- A learner may put a star on a question of a lesson run before answering it: right = win the
-- question's value, wrong = lose it, a hint = the star is void (nothing won or lost). A question
-- (clip) takes a star once per learner, ever (the unique key): the same clip never pays twice.
-- Only adds a table: safe to run before the code is deployed.

CREATE TABLE IF NOT EXISTS star_uses (
	id             bigserial PRIMARY KEY,
	user_id        uuid        NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	run_id         uuid        NOT NULL REFERENCES listening_runs(id) ON DELETE CASCADE,
	clip_id        uuid        NOT NULL REFERENCES listening_clips(id) ON DELETE CASCADE,
	lesson_id      uuid        REFERENCES listening_lessons(id) ON DELETE SET NULL,
	-- 'gold' is for the Ngôi sao vàng item (chests, P3)
	kind           varchar(10) NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal', 'gold')),
	-- what the question was worth (difficulty and format, see lib/stars.ts starValue)
	value          smallint    NOT NULL CHECK (value > 0),
	outcome        varchar(10) NOT NULL CHECK (outcome IN ('right', 'wrong', 'void')),
	-- + value when right, - value when wrong, 0 when void
	delta          integer     NOT NULL,
	coin_event_id  bigint      REFERENCES coin_events(id) ON DELETE SET NULL,
	created_at     timestamptz NOT NULL DEFAULT now(),
	UNIQUE (user_id, clip_id)
);
CREATE INDEX IF NOT EXISTS star_uses_run ON star_uses (run_id);
CREATE INDEX IF NOT EXISTS star_uses_user_day ON star_uses (user_id, created_at);
