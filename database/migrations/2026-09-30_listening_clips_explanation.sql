-- =====================================================================
-- A clip can have its own explanation (Markdown), shown under the answer instead of the
-- lesson's. Needed for step 4 "More practice": its clips are other phrases ("let him go"
-- in a "tell him" lesson), so the lesson's explanation is wrong for them.
--
--   listening_clips.explanation_en / explanation_vi   empty = the lesson's (steps 1-3),
--                                                     nothing (step 4, unless it uses a lesson)
-- =====================================================================

BEGIN;

ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS explanation_en text;
ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS explanation_vi text;

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json, v.readonly, v.hidden, v.sort, v.width, v.required, v.note FROM (VALUES
	('listening_clips', 'explanation_en', NULL, 'input-rich-text-md', NULL, NULL, NULL, false, false, 30, 'half', false, 'Explanation of this clip (English). Empty = the lesson''s explanation (steps 1-3)'),
	('listening_clips', 'explanation_vi', NULL, 'input-rich-text-md', NULL, NULL, NULL, false, false, 31, 'half', false, 'Explanation of this clip (Vietnamese). Empty = the lesson''s explanation (steps 1-3)')
) AS v(collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

COMMIT;
