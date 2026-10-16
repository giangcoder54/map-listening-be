-- Content Editor: someone hired to make lessons and blog posts. Safe to run twice.
--
--   directus_roles     "Content Editor" (fixed id, the API checks it: lib/staff.ts)
--   directus_policies  "Content Editor Access": the Listening Lab content, the video library
--                      and file uploads. Nothing on users, orders, affiliates, wallet,
--                      prices or settings. The role also gets Free + Premium Access so the
--                      editor can use the site like a premium learner.
--   listening_lessons  + user_created: who made the lesson (set by the API hook), for the
--                      editor's own numbers on /admin/lessons
--
-- Admin pages an editor sees: Lessons, Video library, Transcript -> AI, Blog. The dashboard,
-- growth, traffic, coupons, affiliates and support stay admins only (API and pages).
--
-- Give someone the role: Directus > User Directory > the user > Role = Content Editor
-- (or: UPDATE directus_users SET role = '6f1c2b3a-9d4e-4c5b-8a7f-3e2d1c0b9a01' WHERE email = '...').
--
--   docker exec -i map-listening-db psql -U postgres -d map-listening -v ON_ERROR_STOP=1 \
--     < database/migrations/2026-10-15_content_editor.sql

BEGIN;

INSERT INTO directus_roles (id, name, icon, description)
VALUES ('6f1c2b3a-9d4e-4c5b-8a7f-3e2d1c0b9a01', 'Content Editor', 'edit_note', 'Makes lessons and blog posts. No access to users, sales or settings.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO directus_policies (id, name, icon, description, admin_access, app_access)
VALUES ('6f1c2b3a-9d4e-4c5b-8a7f-3e2d1c0b9a02', 'Content Editor Access', 'edit_note', 'Listening Lab content, video library and uploads.', false, false)
ON CONFLICT (id) DO NOTHING;

-- Role -> policies: its own + what learners get (Free, Premium)
INSERT INTO directus_access (id, role, policy, sort)
SELECT gen_random_uuid(), '6f1c2b3a-9d4e-4c5b-8a7f-3e2d1c0b9a01', p.id,
	CASE p.name WHEN 'Content Editor Access' THEN 1 WHEN 'Free Access' THEN 2 ELSE 3 END
FROM directus_policies p
WHERE p.name IN ('Content Editor Access', 'Free Access', 'Premium Access')
	AND NOT EXISTS (SELECT 1 FROM directus_access a WHERE a.role = '6f1c2b3a-9d4e-4c5b-8a7f-3e2d1c0b9a01' AND a.policy = p.id);

-- Permissions of the editor policy. An editor:
--   reads every lesson (to see what exists), but changes only the lessons they made;
--   never sets is_premium (an admin decides what is paid), learners_count or the author;
--   deletes only their own lessons that were never published (published_at stays once set,
--   so unpublishing does not make a lesson deletable again);
--   changes clips / translations of their own lessons only. Adding a clip or a translation
--   to someone else's lesson is refused by the API hook (hook/editorScope.ts): a create
--   permission cannot look at the parent lesson.
DELETE FROM directus_permissions WHERE policy = '6f1c2b3a-9d4e-4c5b-8a7f-3e2d1c0b9a02';
INSERT INTO directus_permissions (collection, action, permissions, validation, presets, fields, policy)
SELECT c, a, p::json, NULL, NULL, f, '6f1c2b3a-9d4e-4c5b-8a7f-3e2d1c0b9a02'
FROM (VALUES
	-- groups and skills: read (the admin decides the structure)
	('listening_groups', 'read', '{}', '*'), ('listening_groups_translations', 'read', '{}', '*'),
	('listening_skills', 'read', '{}', '*'), ('listening_skills_translations', 'read', '{}', '*'),
	-- lessons (short_id, slug, sort and the author are set by the create hook, so they are listed)
	('listening_lessons', 'read', '{}', '*'),
	('listening_lessons', 'create', '{}', 'status,sort,skill_id,short_id,slug,text,difficulty,user_created,translations,clips'),
	('listening_lessons', 'update', '{"user_created":{"_eq":"$CURRENT_USER"}}', 'status,sort,skill_id,text,difficulty,translations,clips'),
	('listening_lessons', 'delete', '{"_and":[{"user_created":{"_eq":"$CURRENT_USER"}},{"published_at":{"_null":true}}]}', '*'),
	('listening_lessons_translations', 'read', '{}', '*'),
	('listening_lessons_translations', 'create', '{}', '*'),
	('listening_lessons_translations', 'update', '{"listening_lessons_id":{"user_created":{"_eq":"$CURRENT_USER"}}}', 'explanation,tips'),
	('listening_lessons_translations', 'delete', '{"listening_lessons_id":{"user_created":{"_eq":"$CURRENT_USER"}}}', '*'),
	('listening_clips', 'read', '{}', '*'),
	('listening_clips', 'create', '{}', '*'),
	('listening_clips', 'update', '{"lesson_id":{"user_created":{"_eq":"$CURRENT_USER"}}}', '*'),
	('listening_clips', 'delete', '{"lesson_id":{"user_created":{"_eq":"$CURRENT_USER"}}}', '*'),
	-- video library
	('source_videos', 'create', '{}', '*'), ('source_videos', 'read', '{}', '*'), ('source_videos', 'update', '{}', '*'),
	-- uploads (blog covers)
	('directus_files', 'create', '{}', '*'), ('directus_files', 'read', '{}', '*'), ('directus_folders', 'read', '{}', '*'),
	('languages', 'read', '{}', '*')
) AS x(c, a, p, f);

-- Who made a lesson (filled by the create hook; older lessons stay empty = made by the admin).
-- Registered in Directus as a read-only "created by" relation so the API can expand
-- user_created.first_name and the Directus app shows it.
ALTER TABLE listening_lessons ADD COLUMN IF NOT EXISTS user_created uuid REFERENCES directus_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS listening_lessons_user_created_idx ON listening_lessons (user_created);
INSERT INTO directus_fields (collection, field, special, interface, display, readonly, hidden, width)
SELECT 'listening_lessons', 'user_created', 'user-created', 'select-dropdown-m2o', 'user', true, false, 'half'
WHERE NOT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'listening_lessons' AND field = 'user_created');
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_deselect_action)
SELECT 'listening_lessons', 'user_created', 'directus_users', 'nullify'
WHERE NOT EXISTS (SELECT 1 FROM directus_relations WHERE many_collection = 'listening_lessons' AND many_field = 'user_created');

COMMIT;
