-- =====================================================================
-- Why a learner practises listening, asked once right after they sign in (GoalSurvey.vue).
-- Several answers can be picked.
--
--   learning_goals       jsonb array of exam | movies | work | general | other;
--                        (at least one, there is no skip); NULL = not asked yet
--   learning_goal_other  their own words when "other" is picked
--   learning_goal_at     when they answered
-- Written through PATCH /v1/me/settings; counted on /admin/lesson-questions.
-- Read with the signed-in user itself (users/me, fields=*): the learner's "read own record"
-- permission gets learning_goals, so the site knows without an extra request.
-- Guests answer the same question (one pick) on their first result card (listening_answers,
-- question 'goal').
--
-- After running: clear the Directus cache and restart, or users/me does not return the new
-- column (Directus keeps its schema and permissions in Redis here: REDIS is set):
--   docker exec map-listening-redis redis-cli FLUSHALL && docker restart map-listening-api
-- =====================================================================

BEGIN;

ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS learning_goals jsonb;
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS learning_goal_other text;
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS learning_goal_at timestamptz;

-- Every "read my own user" permission (filter id = $CURRENT_USER) that lists its fields
UPDATE directus_permissions
SET fields = fields || ',learning_goals'
WHERE collection = 'directus_users'
	AND action = 'read'
	AND permissions::jsonb = '{"id":{"_eq":"$CURRENT_USER"}}'::jsonb
	AND fields IS NOT NULL AND fields <> '*'
	AND NOT (',' || fields || ',') LIKE '%,learning_goals,%';

COMMIT;
