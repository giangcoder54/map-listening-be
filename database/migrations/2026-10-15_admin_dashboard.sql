-- Admin dashboard (GET /v1/admin/dashboard): monthly goals, lesson publish dates and
-- real sign-up dates. Safe to run twice.
--
--   listening_lessons    + published_at: first time the lesson went live, set by a trigger
--   admin_monthly_goals  one target per (month, metric), edited on /admin
--   directus_users       gl_created_at fixed for accounts made before 2026-10-09
--
--   docker exec -i map-listening-db psql -U postgres -d map-listening -v ON_ERROR_STOP=1 \
--     < database/migrations/2026-10-15_admin_dashboard.sql

BEGIN;

-- ── Lesson publish date ───────────────────────────────────────────────
ALTER TABLE listening_lessons ADD COLUMN IF NOT EXISTS published_at timestamptz;
-- Lessons live before this column: the creation date is the best guess we have
UPDATE listening_lessons SET published_at = date_created
WHERE status = 'published' AND published_at IS NULL;

-- Set on the first switch to 'published' (Directus, admin pages or SQL alike).
-- Unpublishing and publishing again keeps the first date.
CREATE OR REPLACE FUNCTION listening_lessons_published_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.status = 'published' AND NEW.published_at IS NULL THEN
		NEW.published_at := now();
	END IF;
	RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS listening_lessons_published_at ON listening_lessons;
CREATE TRIGGER listening_lessons_published_at
	BEFORE INSERT OR UPDATE OF status ON listening_lessons
	FOR EACH ROW EXECUTE FUNCTION listening_lessons_published_at();

CREATE INDEX IF NOT EXISTS listening_lessons_published_at_idx ON listening_lessons (published_at);

-- ── Monthly goals ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_monthly_goals (
	id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	month        char(7) NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),  -- '2026-10'
	metric       varchar(32) NOT NULL,  -- lessons_published | new_users | paid_orders | revenue_vnd | learning_dau
	target       numeric NOT NULL CHECK (target >= 0),
	date_updated timestamptz NOT NULL DEFAULT now(),
	UNIQUE (month, metric)
);

-- ── Real sign-up dates ────────────────────────────────────────────────
-- 2026-10-06_growth.sql filled gl_created_at with the deploy time for every account
-- Directus had no activity for. Those accounts share one timestamp: move each back to
-- the first thing the account did. Accounts with no trace keep the deploy time.
-- LEAST skips NULLs and only ever moves a date earlier, so running this again is harmless.
UPDATE directus_users u SET gl_created_at = LEAST(
	u.gl_created_at,
	u.first_seen_at,
	u.referred_at,
	(SELECT min(date_created) FROM listening_attempts WHERE user_id = u.id),
	(SELECT min(date_created) FROM listening_lesson_learners WHERE user_id = u.id),
	(SELECT min(date_created) FROM listening_progress WHERE user_id = u.id),
	(SELECT min(date_created) FROM listening_reviews WHERE user_id = u.id),
	(SELECT min(date_created) FROM placement_results WHERE user_id = u.id),
	(SELECT min(date_created) FROM purchase_histories WHERE "user" = u.id),
	(SELECT min(date_created) FROM comments WHERE user_created = u.id))
WHERE u.gl_created_at IN (
	SELECT gl_created_at FROM directus_users GROUP BY gl_created_at HAVING count(*) >= 3);

-- ── Indexes for the per-day numbers ───────────────────────────────────
CREATE INDEX IF NOT EXISTS listening_attempts_date_created_idx ON listening_attempts (date_created);
CREATE INDEX IF NOT EXISTS listening_attempts_lesson_idx ON listening_attempts (lesson_id);
CREATE INDEX IF NOT EXISTS directus_users_gl_created_at_idx ON directus_users (gl_created_at);

COMMIT;
