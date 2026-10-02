-- =====================================================================
-- Library videos keep their YouTube transcript, so the admin clip editor does not fetch it
-- again each time, and videos can be searched by what is said in them.
--
--   source_videos.transcript             [{ text, start, end }] in ms, [] = no transcript
--   source_videos.transcript_updated_at  when it was fetched (NULL = never)
-- =====================================================================

BEGIN;

ALTER TABLE source_videos ADD COLUMN IF NOT EXISTS transcript jsonb;
ALTER TABLE source_videos ADD COLUMN IF NOT EXISTS transcript_updated_at timestamptz;

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json, v.readonly, v.hidden, v.sort, v.width, v.required, v.note FROM (VALUES
	('source_videos', 'transcript', 'cast-json', 'input-code', '{"language":"JSON"}', NULL, NULL, true, true, 20, 'full', false, 'YouTube transcript, filled by the admin lesson editor'),
	('source_videos', 'transcript_updated_at', NULL, 'datetime', NULL, 'datetime', NULL, true, false, 21, 'half', false, 'When the transcript was fetched')
) AS v(collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

COMMIT;
