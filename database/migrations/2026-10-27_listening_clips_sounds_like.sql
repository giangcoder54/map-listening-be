-- =====================================================================
-- How the phrase really sounds in a clip, for learners who cannot hear it ("off you go"
-- said fast: "o-fyu-GO"). Shown after a second wrong try, and under the answer.
--
--   listening_clips.sounds_like   empty = nothing shown
-- =====================================================================

BEGIN;

ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS sounds_like text;

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json, v.readonly, v.hidden, v.sort, v.width, v.required, v.note FROM (VALUES
	('listening_clips', 'sounds_like', NULL, 'input', NULL, NULL, NULL, false, false, 29, 'full', false, 'How the phrase sounds in this clip, e.g. o-fyu-GO. Shown after 2 wrong tries and under the answer')
) AS v(collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

COMMIT;
