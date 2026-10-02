-- =====================================================================
-- Speed of a clip, any step: 0.75x to 2x. NULL = the default: 1x, or 1.25x for a
-- step-3 "faster" challenge.
-- =====================================================================

BEGIN;

ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS playback_rate real;
ALTER TABLE listening_clips DROP CONSTRAINT IF EXISTS listening_clips_playback_rate_check;
ALTER TABLE listening_clips ADD CONSTRAINT listening_clips_playback_rate_check
	CHECK (playback_rate IS NULL OR (playback_rate >= 0.5 AND playback_rate <= 2));

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json, v.readonly, v.hidden, v.sort, v.width, v.required, v.note FROM (VALUES
	('listening_clips', 'playback_rate', NULL, 'select-dropdown',
		'{"choices":[{"text":"0.75x","value":0.75},{"text":"1x","value":1},{"text":"1.25x","value":1.25},{"text":"1.5x","value":1.5},{"text":"1.75x","value":1.75},{"text":"2x","value":2}],"allowNone":true}',
		NULL, NULL, false, false, 12, 'half', false, 'Speed of the clip. Empty = 1x (1.25x for a step-3 "faster" challenge)')
) AS v(collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

COMMIT;
