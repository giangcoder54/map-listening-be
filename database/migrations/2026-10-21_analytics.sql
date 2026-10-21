-- =====================================================================
-- Analytics for the admin dashboard (v1/adminDashboardRoutes.ts):
--
-- 1. directus_users.is_internal: team and test accounts, left out of every dashboard number.
--    Admins and content editors always count as internal; tick it in Directus for any other
--    account of the team.
--
-- 2. learning_events: what the site sees people do, guests included (POST /v1/events):
--      visit         opened the site (once a day)
--      lesson_open   opened a lesson page
--      lesson_start  pressed Start on it
--      step          reached a step of it (step = type | voice | challenge | more)
--      result        reached its result card
--    One row per person, day, event, lesson and step (repeats are dropped). anonymous_id is
--    kept even when signed in, so a guest's earlier visits join their account.
--    Numbers from these start the day this is deployed: the past is not in it.
--
-- 3. admin_releases: changes shipped, marked on the dashboard charts (see below).
-- =====================================================================

BEGIN;

ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;

UPDATE directus_users u SET is_internal = true
FROM directus_roles r
WHERE r.id = u.role AND trim(r.name) IN ('Administrator', 'Content Editor') AND NOT u.is_internal;

-- The founder's own accounts
UPDATE directus_users SET is_internal = true
WHERE lower(email) IN ('giang@gmail.com', 'truonggiang542002@gmail.com') AND NOT is_internal;

CREATE TABLE IF NOT EXISTS learning_events (
	id bigserial PRIMARY KEY,
	day date NOT NULL,
	actor_key varchar(80) NOT NULL,
	user_id uuid REFERENCES directus_users(id) ON DELETE SET NULL,
	anonymous_id varchar(64),
	event varchar(20) NOT NULL CHECK (event IN ('visit', 'lesson_open', 'lesson_start', 'step', 'result')),
	lesson_id uuid REFERENCES listening_lessons(id) ON DELETE CASCADE,
	step varchar(20),
	path varchar(200),
	date_created timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS learning_events_once
	ON learning_events (day, actor_key, event, (COALESCE(lesson_id, '00000000-0000-0000-0000-000000000000'::uuid)), (COALESCE(step, '')));
CREATE INDEX IF NOT EXISTS learning_events_day ON learning_events (day, event);
CREATE INDEX IF NOT EXISTS learning_events_anon ON learning_events (anonymous_id) WHERE anonymous_id IS NOT NULL;

-- 3. admin_releases: what changed and when ("Challenge: word-by-word hints"), drawn as a mark
--    on the dashboard charts so a number can be read before and after the change.
CREATE TABLE IF NOT EXISTS admin_releases (
	id serial PRIMARY KEY,
	day date NOT NULL,
	title varchar(200) NOT NULL,
	user_created uuid REFERENCES directus_users(id) ON DELETE SET NULL,
	date_created timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_releases_day ON admin_releases (day);

COMMIT;
