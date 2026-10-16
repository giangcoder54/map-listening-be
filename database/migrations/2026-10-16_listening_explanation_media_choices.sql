-- =====================================================================
-- 1. An explanation can show an image and / or a YouTube video, above its Markdown.
--
--      listening_lessons.explanation_image   file id (directus_files) or an https:// link
--      listening_lessons.explanation_video   YouTube link (?t= / &start= = where it starts)
--      listening_clips.explanation_image     the clip's own; empty = the lesson's (steps 1-3),
--      listening_clips.explanation_video     or the practised lesson's (step 4 "another lesson")
--
--    Like blog covers: uploaded images go to the "Lesson media" folder, readable by anyone
--    (the page only gets their id once the lesson is open); a link is shown as it is.
--
-- 2. A clip can be answered by picking among choices instead of typing.
--
--      listening_clips.answer_format   'type' (NULL) | 'choice'
--      listening_clips.choices         ["wrong 1", "wrong 2", ...]; NULL = picked by the server
--                                      from the other lessons of the skill
--
-- Permissions are cached in Redis: clear the cache after running this
-- (Directus → Settings → Clear cache, or restart the API).
-- =====================================================================

BEGIN;

ALTER TABLE listening_lessons ADD COLUMN IF NOT EXISTS explanation_image text;
ALTER TABLE listening_lessons ADD COLUMN IF NOT EXISTS explanation_video text;
ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS explanation_image text;
ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS explanation_video text;
ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS answer_format text;
ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS choices jsonb;

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json, v.readonly, v.hidden, v.sort, v.width, v.required, v.note FROM (VALUES
	('listening_lessons', 'explanation_image', NULL, 'input', NULL, NULL, NULL, false, false, 40, 'half', false, 'Image shown with the explanation: file id (Lesson media folder) or https:// link'),
	('listening_lessons', 'explanation_video', NULL, 'input', NULL, NULL, NULL, false, false, 41, 'half', false, 'YouTube link shown with the explanation (?t= = start)'),
	('listening_clips', 'explanation_image', NULL, 'input', NULL, NULL, NULL, false, false, 32, 'half', false, 'Image of this clip''s explanation: file id or https:// link. Empty = the lesson''s (steps 1-3)'),
	('listening_clips', 'explanation_video', NULL, 'input', NULL, NULL, NULL, false, false, 33, 'half', false, 'YouTube link of this clip''s explanation. Empty = the lesson''s (steps 1-3)'),
	('listening_clips', 'answer_format', NULL, 'select-dropdown', '{"choices":[{"text":"Type","value":"type"},{"text":"Pick among choices","value":"choice"}]}', NULL, NULL, false, false, 34, 'half', false, 'Empty = type the answer'),
	('listening_clips', 'choices', 'cast-json', 'tags', NULL, NULL, NULL, false, false, 35, 'half', false, 'Wrong choices. Empty = other lessons of the skill')
) AS v(collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

-- "Lesson media" folder: readable by anyone. Directus reads one rule per policy and
-- collection, so the folder is added to an existing read rule ("... OR folder = Lesson media"),
-- or a new rule is made for a policy without one.
INSERT INTO directus_folders (id, name) VALUES ('5f0c2b7e-8d41-4a9e-b3c6-1e7d9a4f2c80', 'Lesson media') ON CONFLICT (id) DO NOTHING;
UPDATE directus_permissions x
SET permissions = json_build_object('_or', json_build_array(x.permissions, '{"folder":{"_eq":"5f0c2b7e-8d41-4a9e-b3c6-1e7d9a4f2c80"}}'::json))
WHERE x.collection = 'directus_files' AND x.action = 'read'
	AND x.permissions IS NOT NULL
	AND x.permissions::text <> '{}'
	AND x.permissions::text NOT LIKE '%5f0c2b7e-8d41-4a9e-b3c6-1e7d9a4f2c80%'
	AND x.policy IN (SELECT id FROM directus_policies WHERE NOT admin_access);
INSERT INTO directus_permissions (collection, action, permissions, fields, policy)
SELECT 'directus_files', 'read', '{"folder":{"_eq":"5f0c2b7e-8d41-4a9e-b3c6-1e7d9a4f2c80"}}'::json, '*', p.id
FROM directus_policies p
WHERE NOT p.admin_access
	AND NOT EXISTS (SELECT 1 FROM directus_permissions x WHERE x.policy = p.id AND x.collection = 'directus_files' AND x.action = 'read');

COMMIT;
