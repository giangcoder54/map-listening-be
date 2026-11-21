-- One row per subtitle line of the published, hand-made transcripts, so "a line where this word is said" is an index lookup
-- (the daily review finds clips of other videos this way; scanning every transcript took about a second per word).
-- Triggers on source_videos (bottom of this file) keep it in step with every write; refresh_transcript_lines() fills it the
-- first time and can repair it (the review route calls it once when it starts). It reads no transcript unless a video
-- needs (re)loading, so a refresh with nothing new takes milliseconds.
CREATE TABLE IF NOT EXISTS transcript_lines (
	video_id text NOT NULL,
	n integer NOT NULL,
	start_ms integer NOT NULL,
	end_ms integer NOT NULL,
	text text NOT NULL,
	tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
	PRIMARY KEY (video_id, n)
);
-- The videos whose lines are loaded, and the version of the video they were loaded from (a few thousand rows: cheap to compare)
CREATE TABLE IF NOT EXISTS transcript_line_videos (video_id text PRIMARY KEY, src_updated timestamptz);
CREATE INDEX IF NOT EXISTS transcript_lines_tsv ON transcript_lines USING gin (tsv);

CREATE OR REPLACE FUNCTION refresh_transcript_lines() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	-- Videos whose lines are out of date (unpublished, no longer hand-made, or edited since): their lines go
	CREATE TEMP TABLE IF NOT EXISTS _stale_tl (video_id text) ON COMMIT DROP;
	INSERT INTO _stale_tl SELECT v.video_id FROM transcript_line_videos v WHERE NOT EXISTS (
		SELECT 1 FROM source_videos sv WHERE sv.youtube_video_id = v.video_id AND sv.status = 'published' AND sv.transcript_kind = 'manual'
			AND coalesce(sv.date_updated, sv.date_created) IS NOT DISTINCT FROM v.src_updated);
	IF EXISTS (SELECT 1 FROM _stale_tl) THEN   -- nothing stale: the big table is not touched at all
		DELETE FROM transcript_lines WHERE video_id IN (SELECT video_id FROM _stale_tl);
		DELETE FROM transcript_line_videos WHERE video_id IN (SELECT video_id FROM _stale_tl);
	END IF;
	-- Only the videos not loaded yet are opened: their ids are found first, without touching the (large) transcripts
	CREATE TEMP TABLE IF NOT EXISTS _todo_tl (id uuid, vid text, upd timestamptz) ON COMMIT DROP;
	INSERT INTO _todo_tl
		SELECT sv.id, sv.youtube_video_id, coalesce(sv.date_updated, sv.date_created) FROM source_videos sv
		WHERE sv.status = 'published' AND sv.transcript_kind = 'manual' AND sv.youtube_video_id IS NOT NULL
			AND NOT EXISTS (SELECT 1 FROM transcript_line_videos v WHERE v.video_id = sv.youtube_video_id);
	INSERT INTO transcript_lines (video_id, n, start_ms, end_ms, text)
	SELECT t.vid, c.n::int, (c.v->>'start')::int, (c.v->>'end')::int, c.v->>'text'
	FROM _todo_tl t JOIN source_videos sv ON sv.id = t.id
	CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(sv.transcript) = 'array' THEN sv.transcript ELSE '[]'::jsonb END) WITH ORDINALITY AS c(v, n)
	WHERE c.v->>'text' IS NOT NULL AND c.v->>'start' ~ '^[0-9]+$' AND c.v->>'end' ~ '^[0-9]+$'
	ON CONFLICT DO NOTHING;
	INSERT INTO transcript_line_videos SELECT DISTINCT vid, upd FROM _todo_tl ON CONFLICT DO NOTHING;
	DELETE FROM _stale_tl; DELETE FROM _todo_tl;
END $$;

-- The lines follow the video as it is written: when a video is added, edited, published, unpublished or deleted (by the admin, a route,
-- a script or plain SQL), its lines are replaced in the same transaction -- only that video's, a few milliseconds. Nothing has to
-- look for changes afterwards. (refresh_transcript_lines() above only fills the table the first time, or repairs it.)
CREATE OR REPLACE FUNCTION transcript_lines_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND NEW.transcript IS NOT DISTINCT FROM OLD.transcript AND NEW.transcript_kind IS NOT DISTINCT FROM OLD.transcript_kind
		AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.youtube_video_id IS NOT DISTINCT FROM OLD.youtube_video_id THEN
		RETURN NEW;
	END IF;
	IF TG_OP <> 'INSERT' THEN
		DELETE FROM transcript_lines WHERE video_id = OLD.youtube_video_id;
		DELETE FROM transcript_line_videos WHERE video_id = OLD.youtube_video_id;
	END IF;
	IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
	IF NEW.status = 'published' AND NEW.transcript_kind = 'manual' AND NEW.youtube_video_id IS NOT NULL AND jsonb_typeof(NEW.transcript) = 'array' THEN
		DELETE FROM transcript_lines WHERE video_id = NEW.youtube_video_id;
		INSERT INTO transcript_lines (video_id, n, start_ms, end_ms, text)
		SELECT NEW.youtube_video_id, c.n::int, (c.v->>'start')::int, (c.v->>'end')::int, c.v->>'text'
		FROM jsonb_array_elements(NEW.transcript) WITH ORDINALITY AS c(v, n)
		WHERE c.v->>'text' IS NOT NULL AND c.v->>'start' ~ '^[0-9]+$' AND c.v->>'end' ~ '^[0-9]+$'
		ON CONFLICT DO NOTHING;
		INSERT INTO transcript_line_videos VALUES (NEW.youtube_video_id, coalesce(NEW.date_updated, NEW.date_created))
		ON CONFLICT (video_id) DO UPDATE SET src_updated = EXCLUDED.src_updated;
	END IF;
	RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS transcript_lines_invalidate_upd ON source_videos;
DROP TRIGGER IF EXISTS transcript_lines_invalidate_del ON source_videos;
DROP FUNCTION IF EXISTS transcript_lines_invalidate();
DROP TRIGGER IF EXISTS transcript_lines_sync_ins_upd ON source_videos;
CREATE TRIGGER transcript_lines_sync_ins_upd AFTER INSERT OR UPDATE OF transcript, transcript_kind, status, youtube_video_id ON source_videos
	FOR EACH ROW EXECUTE FUNCTION transcript_lines_sync();
DROP TRIGGER IF EXISTS transcript_lines_sync_del ON source_videos;
CREATE TRIGGER transcript_lines_sync_del AFTER DELETE ON source_videos FOR EACH ROW EXECUTE FUNCTION transcript_lines_sync();

SELECT refresh_transcript_lines();
