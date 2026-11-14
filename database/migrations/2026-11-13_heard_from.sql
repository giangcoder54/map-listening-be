-- =====================================================================
-- Where a learner first heard of us: the third question of the survey after sign-in
-- (GoalSurvey.vue). One answer, asked once; learners who answered the first two get this alone.
--
--   heard_from        facebook | tiktok | youtube | threads | google | friend | other; NULL = not asked yet
--   heard_from_other  their own words when "other" (max 500 chars)
--   heard_from_at     when they answered
-- Written through PATCH /v1/me/settings; counted on /admin/lesson-questions.
-- Read with the signed-in user itself (users/me, fields=*), like listening_level.
--
-- After running: clear the Directus cache and restart, or users/me does not return the new
-- column:
--   docker exec map-listening-redis redis-cli FLUSHALL && docker restart map-listening-api
-- =====================================================================

BEGIN;

ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS heard_from text;
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS heard_from_other text;
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS heard_from_at timestamptz;

UPDATE directus_permissions
SET fields = fields || ',heard_from'
WHERE collection = 'directus_users'
	AND action = 'read'
	AND permissions::jsonb = '{"id":{"_eq":"$CURRENT_USER"}}'::jsonb
	AND fields IS NOT NULL AND fields <> '*'
	AND NOT (',' || fields || ',') LIKE '%,heard_from,%';

COMMIT;
