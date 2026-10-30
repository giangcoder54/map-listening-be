-- =====================================================================
-- How well a learner understands spoken English, in their own view: the second question of the
-- survey after sign-in (GoalSurvey.vue). One answer. Learners who already answered the goals
-- question get this one alone, once.
--
--   listening_level      beginner | elementary | intermediate | advanced; NULL = not asked yet
--   listening_level_at   when they answered
-- Written through PATCH /v1/me/settings; counted on /admin/lesson-questions.
-- Read with the signed-in user itself (users/me, fields=*), like learning_goals.
--
-- After running: clear the Directus cache and restart, or users/me does not return the new
-- column:
--   docker exec map-listening-redis redis-cli FLUSHALL && docker restart map-listening-api
-- =====================================================================

BEGIN;

ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS listening_level text;
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS listening_level_at timestamptz;

-- Every "read my own user" permission (filter id = $CURRENT_USER) that lists its fields
UPDATE directus_permissions
SET fields = fields || ',listening_level'
WHERE collection = 'directus_users'
	AND action = 'read'
	AND permissions::jsonb = '{"id":{"_eq":"$CURRENT_USER"}}'::jsonb
	AND fields IS NOT NULL AND fields <> '*'
	AND NOT (',' || fields || ',') LIKE '%,listening_level,%';

COMMIT;
