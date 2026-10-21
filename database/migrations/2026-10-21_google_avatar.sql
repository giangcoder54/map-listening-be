-- =====================================================================
-- Google profile picture of a learner who signs in with Google.
--
--   avatar_url   the "picture" Google sends at each Google sign-in (hook/googleAvatar.ts).
--                A link on googleusercontent.com, not a Directus file: an uploaded avatar
--                (directus_users.avatar) still wins where both exist.
-- Readable by the learner (users/me: header, profile) and on the public user fields
-- (author of a comment); the leaderboard reads it on the server.
-- Learners who signed in with Google before this get theirs at their next Google sign-in.
-- Also declares comments.user_created as a link to the user, so comments show their author.
--
-- After running: clear the Directus cache and restart, or users/me does not return the new
-- column (Directus keeps its schema and permissions in Redis here: REDIS is set):
--   docker exec map-listening-redis redis-cli FLUSHALL && docker restart map-listening-api
-- =====================================================================

BEGIN;

ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS avatar_url text;

-- Both "read users" permissions that list their fields: one's own record, and the public
-- fields of others (id, first_name, last_name, avatar)
UPDATE directus_permissions
SET fields = fields || ',avatar_url'
WHERE collection = 'directus_users'
	AND action = 'read'
	AND fields IS NOT NULL AND fields <> '*'
	AND (',' || fields || ',') LIKE '%,avatar,%'
	AND NOT (',' || fields || ',') LIKE '%,avatar_url,%';

-- Comment authors: comments.user_created / user_updated were never declared as links to
-- directus_users, so `user_created.first_name` (name and picture of who wrote it) came back
-- empty and every comment showed as "Anonymous". Declared here.
INSERT INTO directus_relations (many_collection, many_field, one_collection)
SELECT 'comments', f, 'directus_users'
FROM unnest(ARRAY['user_created', 'user_updated']) AS f
WHERE NOT EXISTS (
	SELECT 1 FROM directus_relations r WHERE r.many_collection = 'comments' AND r.many_field = f
);

COMMIT;
