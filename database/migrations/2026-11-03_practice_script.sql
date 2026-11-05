-- =====================================================================
-- The practice of a lesson, written by the team instead of drawn (lib/runs.ts drawLesson):
-- 4 steps, 3 pool clips and 1 trap, each asked as a choice, a word bank or a gap.
--
--   listening_lessons.practice   [{ clip_id, format: choice|bank|gap, wrong: [text] }]
--                                wrong: the wrong choices (choice) or the extra tiles (bank)
--                                empty = practice drawn from the pool as before
-- Clips used here are not drawn into the first test nor the final check of the same run.
-- =====================================================================

BEGIN;

ALTER TABLE listening_lessons ADD COLUMN IF NOT EXISTS practice jsonb;

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json, v.readonly, v.hidden, v.sort, v.width, v.required, v.note FROM (VALUES
	('listening_lessons', 'practice', 'cast-json', 'input-code', '{"language":"JSON"}', NULL, NULL, false, true, 40, 'full', false, 'Practice steps [{ clip_id, format: choice|bank|gap, wrong: [text] }], set by the admin lesson page. Empty = drawn from the pool')
) AS v(collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

-- Answers keep their format: the word bank is new
ALTER TABLE listening_attempts DROP CONSTRAINT IF EXISTS listening_attempts_format_check;
ALTER TABLE listening_attempts ADD CONSTRAINT listening_attempts_format_check
	CHECK (format IN ('type', 'gap', 'choice', 'tap', 'bank', 'identify', 'speak'));

-- Content editors write it (their policy lists fields one by one)
UPDATE directus_permissions p SET fields = p.fields || ',practice'
FROM directus_policies pol
WHERE pol.id = p.policy AND pol.name = 'Content Editor Access' AND p.collection = 'listening_lessons'
	AND p.action IN ('create', 'update', 'read') AND p.fields <> '*' AND p.fields NOT LIKE '%practice%';

COMMIT;
