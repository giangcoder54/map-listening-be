-- A sentence the team keeps out of the practice bank (a grammar-only item, a bad cut): the clip
-- stays where it is (lesson, challenge), only the bank skips it. Managed in /admin/practice.
BEGIN;
CREATE TABLE IF NOT EXISTS practice_hidden_clips (
	clip_id      uuid PRIMARY KEY REFERENCES listening_clips(id) ON DELETE CASCADE,
	date_created timestamptz NOT NULL DEFAULT now()
);
COMMIT;
