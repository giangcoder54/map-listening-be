-- =====================================================================
-- Permissions for the Listening Lab only.
--
-- 1. listening_tests (old exercises) are dropped from every non-admin policy.
-- 2. listening_clips can no longer be read through /items: their transcript holds the
--    answer in [brackets], also for Premium lessons. Learners get clips from the custom
--    API (/v1/listening-lab/...), which hides them on locked lessons.
-- 3. Premium User also gets the Free Access policy: the base every learner has (own
--    profile, plans, own orders, comments). Premium Access stops reading the premium
--    columns of every user.
-- 4. Comments: every learner reads all comments (and the commenter's name and avatar),
--    creates, and edits / deletes only their own.
--
-- Premium itself is decided in the API (lib/premium.ts: is_premium + premium_until).
-- =====================================================================

BEGIN;

CREATE TEMP TABLE pol ON COMMIT DROP AS
SELECT
	(SELECT id FROM directus_policies WHERE name = '$t:public_label') AS public_id,
	(SELECT id FROM directus_policies WHERE name = 'Free Access')     AS free_id,
	(SELECT id FROM directus_policies WHERE name = 'Premium Access')  AS premium_id,
	(SELECT id FROM directus_roles WHERE trim(name) = 'Premium User') AS premium_role;

-- 1 + 2
DELETE FROM directus_permissions
WHERE collection IN ('listening_tests', 'listening_tests_files', 'listening_clips')
  AND policy IN (SELECT id FROM directus_policies WHERE admin_access = false);

-- 3
INSERT INTO directus_access (id, role, "user", policy, sort)
SELECT gen_random_uuid(), pol.premium_role, NULL, pol.free_id, 2
FROM pol
WHERE NOT EXISTS (SELECT 1 FROM directus_access a WHERE a.role = pol.premium_role AND a.policy = pol.free_id);

DELETE FROM directus_permissions
WHERE collection = 'directus_users' AND policy = (SELECT premium_id FROM pol);

-- 4 (Free Access now covers Premium too)
DELETE FROM directus_permissions
WHERE collection = 'comments' AND policy IN ((SELECT free_id FROM pol), (SELECT premium_id FROM pol));

INSERT INTO directus_permissions (collection, action, permissions, validation, presets, fields, policy)
SELECT v.collection, v.action, v.permissions::json, NULL, NULL, v.fields, pol.free_id
FROM pol, (VALUES
	('comments',       'read',   '{}',                                         '*'),
	('comments',       'create', '{}',                                         'lesson_id,parent_id,content,user_created'),
	('comments',       'update', '{"user_created":{"_eq":"$CURRENT_USER"}}',   'content'),
	('comments',       'delete', '{"user_created":{"_eq":"$CURRENT_USER"}}',   '*'),
	-- Other learners: only what a comment shows (own profile: the existing row)
	('directus_users', 'read',   '{}',                                         'id,first_name,last_name,avatar')
) AS v(collection, action, permissions, fields);

COMMIT;
