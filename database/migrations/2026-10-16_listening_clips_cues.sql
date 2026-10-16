-- =====================================================================
-- Subtitle lines of a clip: the learner page shows the line being said, like YouTube
-- subtitles, instead of the whole transcript at once.
--
--   listening_clips.cues   [{ start, text }]  start in seconds (video time), text as the
--                          learner sees it ([brackets] = the blank). A line lasts until the
--                          next one starts, the last one until end_time.
--                          NULL = old clip: the page uses the lines of the video's stored
--                          transcript in [start_time, end_time], else splits the sentences.
--
-- transcript stays filled (the lines joined): search, answers and older pages use it.
-- =====================================================================

BEGIN;

ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS cues jsonb;

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json, v.readonly, v.hidden, v.sort, v.width, v.required, v.note FROM (VALUES
	('listening_clips', 'cues', 'cast-json', 'input-code', '{"language":"JSON"}', NULL, NULL, false, false, 10, 'full', false, 'Subtitle lines [{ start (s), text }], set by the admin clip editor. Empty = from the video transcript')
) AS v(collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

COMMIT;
