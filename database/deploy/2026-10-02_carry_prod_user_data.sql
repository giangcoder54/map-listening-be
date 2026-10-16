-- =====================================================================
-- Deploy of the lesson flow: the local DB replaces prod, prod keeps its users.
--
-- Run in the NEW database (restored from the local dump), with the OLD prod database
-- renamed to map_listening_old next to it. Prod is the truth for everything users did:
--
--   directus_users, purchase_histories   copied, prod values win (premium, orders...)
--   directus_sessions                    replaced by prod's, so nobody is logged out
--   directus_files                       files only prod has (avatars...); the files
--                                        themselves stay in ./uploads on the server
--   listening_attempts, listening_quota_clips, comments
--                                        rows only prod has (clip / lesson must exist)
--   listening_target_learners            -> listening_lesson_learners, learners_count
--   listening_progress                   built from the attempts, like the lesson schema migration
--
-- Content (groups, skills, lessons, clips, videos, plans) comes from the local DB only.
--
--   docker exec -i map-listening-db psql -U postgres -d map-listening -v ON_ERROR_STOP=1 \
--     -v old='dbname=map_listening_old user=postgres' < database/deploy/2026-10-02_carry_prod_user_data.sql
-- =====================================================================
BEGIN;

CREATE EXTENSION IF NOT EXISTS dblink;
SELECT set_config('carry.conn', :'old', false);

-- Copy the columns both databases have from an old-DB table.
--   mode 'upsert'  : old values overwrite rows with the same key
--   mode 'missing' : only rows the new DB does not have
--   filter         : SQL condition on the incoming row (alias x)
CREATE FUNCTION pg_temp.carry(tbl text, key text, mode text, filter text DEFAULT 'true') RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
	conn text := current_setting('carry.conn');
	cols text;
	defs text;
	sets text;
	n bigint;
BEGIN
	SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum),
		string_agg(quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum),
		string_agg(format('%1$I = EXCLUDED.%1$I', a.attname), ', ' ORDER BY a.attnum) FILTER (WHERE a.attname <> key)
	INTO cols, defs, sets
	FROM pg_attribute a
	WHERE a.attrelid = tbl::regclass AND a.attnum > 0 AND NOT a.attisdropped
		AND a.attname IN (SELECT r.c FROM dblink(conn, format(
			'SELECT column_name::text FROM information_schema.columns WHERE table_schema = ''public'' AND table_name = %L', tbl)) AS r(c text));

	EXECUTE format('INSERT INTO %I (%s) SELECT %s FROM dblink(%L, %L) AS x(%s) WHERE %s ON CONFLICT (%I) %s',
		tbl, cols, cols, conn, format('SELECT %s FROM %I', cols, tbl), defs, filter, key,
		CASE mode WHEN 'upsert' THEN 'DO UPDATE SET ' || sets ELSE 'DO NOTHING' END);
	GET DIAGNOSTICS n = ROW_COUNT;
	RAISE NOTICE '% (%): % rows', tbl, mode, n;
	RETURN n;
END $$;

SELECT pg_temp.carry('directus_files', 'id', 'missing');
SELECT pg_temp.carry('directus_users', 'id', 'upsert');
SELECT pg_temp.carry('purchase_histories', 'id', 'upsert');

DELETE FROM directus_sessions;
SELECT pg_temp.carry('directus_sessions', 'token', 'missing',
	'x."user" IS NULL OR x."user" IN (SELECT id FROM directus_users)');

SELECT pg_temp.carry('listening_attempts', 'id', 'missing',
	'x.clip_id IN (SELECT id FROM listening_clips) AND (x.user_id IS NULL OR x.user_id IN (SELECT id FROM directus_users))');
UPDATE listening_attempts a SET lesson_id = c.lesson_id, step = c.step
FROM listening_clips c
WHERE c.id = a.clip_id AND a.lesson_id IS NULL AND c.lesson_id IS NOT NULL;

SELECT pg_temp.carry('listening_quota_clips', 'id', 'missing', 'x.clip_id IN (SELECT id FROM listening_clips)');

-- comments.target_id (old) = comments.lesson_id (new): lesson ids are the target ids
SELECT pg_temp.carry('comments', 'id', 'missing',
	'x.user_created IS NULL OR x.user_created IN (SELECT id FROM directus_users)');
UPDATE comments c SET lesson_id = o.target_id
FROM dblink(current_setting('carry.conn'), 'SELECT id, target_id FROM comments') AS o(id uuid, target_id uuid)
WHERE o.id = c.id AND c.lesson_id IS NULL AND o.target_id IN (SELECT id FROM listening_lessons);

INSERT INTO listening_lesson_learners (lesson_id, user_id, anonymous_id, learner_key, date_created)
SELECT o.target_id, o.user_id, o.anonymous_id, o.learner_key, o.date_created
FROM dblink(current_setting('carry.conn'), 'SELECT target_id, user_id, anonymous_id, learner_key, date_created FROM listening_target_learners')
	AS o(target_id uuid, user_id uuid, anonymous_id varchar, learner_key varchar, date_created timestamptz)
WHERE o.target_id IN (SELECT id FROM listening_lessons)
	AND (o.user_id IS NULL OR o.user_id IN (SELECT id FROM directus_users))
ON CONFLICT (lesson_id, learner_key) DO NOTHING;

UPDATE listening_lessons l SET learners_count = GREATEST(l.learners_count, o.learners_count)
FROM dblink(current_setting('carry.conn'), 'SELECT id, learners_count FROM listening_targets') AS o(id uuid, learners_count bigint)
WHERE o.id = l.id AND o.learners_count > l.learners_count;

-- Finished = one right answer (one-answer groups) / every clip right (per-clip groups)
INSERT INTO listening_progress (user_id, lesson_id, status, completed_at, date_created, date_updated)
SELECT x.user_id, x.lesson_id,
	CASE WHEN (x.answer_mode = 'per_clip' AND x.correct_clips >= x.total_clips AND x.total_clips > 0)
		OR (x.answer_mode <> 'per_clip' AND x.correct_clips > 0) THEN 'completed' ELSE 'in_progress' END,
	CASE WHEN (x.answer_mode = 'per_clip' AND x.correct_clips >= x.total_clips AND x.total_clips > 0)
		OR (x.answer_mode <> 'per_clip' AND x.correct_clips > 0) THEN x.last_correct END,
	x.first_at, x.last_at
FROM (
	SELECT a.user_id, a.lesson_id, g.answer_mode,
		COUNT(DISTINCT a.clip_id) FILTER (WHERE a.is_correct) AS correct_clips,
		(SELECT COUNT(*) FROM listening_clips c WHERE c.lesson_id = a.lesson_id) AS total_clips,
		MAX(a.date_created) FILTER (WHERE a.is_correct) AS last_correct,
		MIN(a.date_created) AS first_at, MAX(a.date_created) AS last_at
	FROM listening_attempts a
	JOIN listening_lessons l ON l.id = a.lesson_id
	JOIN listening_skills s ON s.id = l.skill_id
	JOIN listening_groups g ON g.id = s.group_id
	WHERE a.user_id IS NOT NULL
	GROUP BY a.user_id, a.lesson_id, g.answer_mode
) x
ON CONFLICT (user_id, lesson_id) DO NOTHING;

-- What did not make it (clips / lessons that no longer exist): check before going live
SELECT 'old users' AS what, n FROM dblink(current_setting('carry.conn'), 'SELECT count(*) FROM directus_users') AS o(n bigint)
UNION ALL SELECT 'new users', count(*) FROM directus_users
UNION ALL SELECT 'old orders', n FROM dblink(current_setting('carry.conn'), 'SELECT count(*) FROM purchase_histories') AS o(n bigint)
UNION ALL SELECT 'new orders', count(*) FROM purchase_histories
UNION ALL SELECT 'old attempts', n FROM dblink(current_setting('carry.conn'), 'SELECT count(*) FROM listening_attempts') AS o(n bigint)
UNION ALL SELECT 'new attempts', count(*) FROM listening_attempts;

DROP EXTENSION dblink;

COMMIT;
