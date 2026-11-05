-- =====================================================================
-- Review lessons on the path (kind 'mixed'): no new teaching, the forms of earlier lessons
-- mixed (lib/runs.ts drawMixed).
--
--   listening_lessons.review_of   [lesson_id, ...]  the lessons it reviews (2 or more)
--
-- A review lesson keeps only its own trap and challenge clips: its items are drawn from the pool
-- clips of the lessons it reviews, the forms taking turns. Its explanation is a short recap,
-- shown before the first item; no "said clearly / said naturally" sounds are needed.
-- =====================================================================

BEGIN;

ALTER TABLE listening_lessons ADD COLUMN IF NOT EXISTS review_of jsonb;

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json, v.readonly, v.hidden, v.sort, v.width, v.required, v.note FROM (VALUES
	('listening_lessons', 'review_of', 'cast-json', 'input-code', '{"language":"JSON"}', NULL, NULL, false, true, 41, 'full', false, 'Review lessons (kind mixed): ids of the lessons reviewed, set by the admin lesson page')
) AS v(collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

-- Content editors write it (their policy lists fields one by one)
UPDATE directus_permissions p SET fields = p.fields || ',review_of'
FROM directus_policies pol
WHERE pol.id = p.policy AND pol.name = 'Content Editor Access' AND p.collection = 'listening_lessons'
	AND p.action IN ('create', 'update', 'read') AND p.fields <> '*' AND p.fields NOT LIKE '%review_of%';

COMMIT;
