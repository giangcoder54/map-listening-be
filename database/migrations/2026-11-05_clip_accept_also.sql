-- =====================================================================
-- Other spellings accepted as right for a clip, next to its answer (the [bracketed] words or
-- "Đáp án khác"). For a typed answer only: "needa" also right where the answer is "need to".
-- The answer shown to the learner stays the main one.
--
--   listening_clips.accept_also   "needa | neeta"   (separated by | or new lines)
--                                 empty = only the answer is right
-- =====================================================================

BEGIN;

ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS accept_also text;

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json, v.readonly, v.hidden, v.sort, v.width, v.required, v.note FROM (VALUES
	('listening_clips', 'accept_also', NULL, 'input', NULL, NULL, NULL, false, false, 30, 'full', false, 'Other spellings also right when typed, separated by |, e.g. needa. The answer shown stays the main one')
) AS v(collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

-- Content editors write it (their policy lists fields one by one)
UPDATE directus_permissions p SET fields = p.fields || ',accept_also'
FROM directus_policies pol
WHERE pol.id = p.policy AND pol.name = 'Content Editor Access' AND p.collection = 'listening_clips'
	AND p.action IN ('create', 'update', 'read') AND p.fields <> '*' AND p.fields NOT LIKE '%accept_also%';

COMMIT;
