-- =====================================================================
-- Library videos can also be a Yarn clip (getyarn.io): a few seconds cut from a film or a
-- show, embedded as is. Such a row has yarn_clip_id set and no youtube_video_id; its clips
-- play the whole Yarn clip (no start / end), at 1x (the Yarn player cannot change speed).
--
--   source_videos.yarn_clip_id   "59390c93-4f14-4813-9382-900493800358" from
--                                https://getyarn.io/yarn-clip/<id>
-- =====================================================================

BEGIN;

ALTER TABLE source_videos ADD COLUMN IF NOT EXISTS yarn_clip_id varchar(64);
CREATE UNIQUE INDEX IF NOT EXISTS source_videos_yarn_clip_id_key ON source_videos (yarn_clip_id) WHERE yarn_clip_id IS NOT NULL;

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json, v.readonly, v.hidden, v.sort, v.width, v.required, v.note FROM (VALUES
	('source_videos', 'yarn_clip_id', NULL, 'input', NULL, NULL, NULL, false, false, 5, 'half', false, 'Yarn clip id (getyarn.io/yarn-clip/<id>). Set = a Yarn clip, not a YouTube video')
) AS v(collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

COMMIT;
