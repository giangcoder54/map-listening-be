-- =====================================================================
-- Which subtitles a library video's transcript came from (v1/youtube.ts pickCaptionTrack).
--
--   source_videos.transcript_kind   'manual'  English subtitles made by a person
--                                   'asr'     YouTube's automatic English subtitles
--                                   'none'    the video has no English subtitles
--                                   NULL      not known yet (fetched before this column)
--   source_videos.transcript_lang   the subtitle track's language code: en, en-US, en-GB…
--
-- Automatic subtitles are written as heard by a machine (no capitals or punctuation, wrong
-- words), so clips from them need their words checked by ear.
-- =====================================================================

BEGIN;

ALTER TABLE source_videos ADD COLUMN IF NOT EXISTS transcript_kind varchar(10);
ALTER TABLE source_videos ADD COLUMN IF NOT EXISTS transcript_lang varchar(20);
ALTER TABLE source_videos DROP CONSTRAINT IF EXISTS source_videos_transcript_kind_check;
ALTER TABLE source_videos ADD CONSTRAINT source_videos_transcript_kind_check
	CHECK (transcript_kind IS NULL OR transcript_kind IN ('manual', 'asr', 'none'));

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json, v.readonly, v.hidden, v.sort, v.width, v.required, v.note FROM (VALUES
	('source_videos', 'transcript_kind', NULL, 'select-dropdown',
		'{"choices":[{"text":"Made by a person","value":"manual"},{"text":"Automatic (YouTube)","value":"asr"},{"text":"No English subtitles","value":"none"}]}',
		'labels', NULL, true, false, 22, 'half', false, 'Where the transcript came from: subtitles made by a person, or YouTube''s automatic ones'),
	('source_videos', 'transcript_lang', NULL, 'input', NULL, NULL, NULL, true, false, 23, 'half', false, 'Language code of the subtitle track (en, en-US…)')
) AS v(collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

-- Videos already fetched with no lines at all: no English subtitles
UPDATE source_videos SET transcript_kind = 'none'
WHERE transcript_kind IS NULL AND transcript_updated_at IS NOT NULL AND jsonb_array_length(COALESCE(transcript, '[]'::jsonb)) = 0;

COMMIT;
