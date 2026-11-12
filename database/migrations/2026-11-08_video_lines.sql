-- =====================================================================
-- What a video says, line by line, and what each line means in other languages (Vietsub).
--
--   video_lines                 one turn of speech of a source video: the checked English text,
--                               who says it, when. A clip's transcript is a cut over these lines,
--                               so a line is fixed and translated once for every clip that has it.
--     speaker                   'A', 'B'… changes when another person speaks; NULL: one speaker
--     origin                    'clip' (from a clip's transcript), 'manual', 'asr', 'whisper', 'edit'
--     verified                  checked by ear
--
--   video_line_translations     a line in another language (languages.code: vi-VN, th-TH…).
--                               A new language is new rows, never a new column.
--     source_hash               md5 of the English text it was translated from: when the line is
--                               edited the hashes differ and the translation is out of date
--     origin                    'ai' (machine) or 'human'
--
--   listening_clip_lines        the lines a clip plays, in order.
--     partial                   only part of the line is in the clip (a lead-in cut, a line left
--                               hanging at the end): shown as "…", never translated
--
-- The learner sees the translation once an item is answered, in the page's language; a
-- language with no translation shows nothing.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS video_lines (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	source_video_id uuid NOT NULL REFERENCES source_videos(id) ON DELETE CASCADE,
	start_ms integer NOT NULL,
	end_ms integer NOT NULL,
	speaker varchar(20),
	text text NOT NULL,
	origin varchar(10) NOT NULL DEFAULT 'clip' CHECK (origin IN ('clip', 'manual', 'asr', 'whisper', 'edit')),
	verified boolean NOT NULL DEFAULT false,
	date_created timestamptz NOT NULL DEFAULT now(),
	date_updated timestamptz
);
CREATE INDEX IF NOT EXISTS video_lines_video_time ON video_lines (source_video_id, start_ms);

CREATE TABLE IF NOT EXISTS video_line_translations (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	line_id uuid NOT NULL REFERENCES video_lines(id) ON DELETE CASCADE,
	languages_code varchar(255) NOT NULL REFERENCES languages(code) ON DELETE CASCADE,
	text text NOT NULL,
	source_hash char(32) NOT NULL,
	origin varchar(10) NOT NULL DEFAULT 'ai' CHECK (origin IN ('ai', 'human')),
	date_created timestamptz NOT NULL DEFAULT now(),
	date_updated timestamptz,
	UNIQUE (line_id, languages_code)
);

CREATE TABLE IF NOT EXISTS listening_clip_lines (
	clip_id uuid NOT NULL REFERENCES listening_clips(id) ON DELETE CASCADE,
	line_id uuid NOT NULL REFERENCES video_lines(id) ON DELETE CASCADE,
	sort smallint NOT NULL,
	partial boolean NOT NULL DEFAULT false,
	-- a line may come twice in a clip ("Okay. … Okay.")
	PRIMARY KEY (clip_id, sort)
);
CREATE INDEX IF NOT EXISTS listening_clip_lines_line ON listening_clip_lines (line_id);

COMMIT;
