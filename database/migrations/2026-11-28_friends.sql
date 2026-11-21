-- Friends: a private leaderboard between people who added each other (by their invite code).
--   user_friends   one row per direction (a, b) and (b, a), so "my friends" is one index lookup
-- Added with POST /friends/add { code } (the code of lib/referrals.ts), removed with POST /friends/remove { id }.
-- Safe to run twice. Rollback at the bottom.

CREATE TABLE IF NOT EXISTS user_friends (
	user_id      uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	friend_id    uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	date_created timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, friend_id),
	CHECK (user_id <> friend_id)
);

-- Rollback:
-- DROP TABLE IF EXISTS user_friends;
