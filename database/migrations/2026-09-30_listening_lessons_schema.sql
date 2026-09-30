-- =====================================================================
-- Listening Lab: new lesson schema (additive - old tables stay untouched)
--
--   listening_groups      Connected Speech, Numbers...     answer_mode, is_premium
--   listening_skills      H-dropping, Linking Words...     group_id, category, is_premium
--   listening_lessons     "tell him"                       skill_id, text (= answer), is_premium, sort
--   listening_clips       + lesson_id, step (type|voice|challenge), challenge_mode, answer
--   listening_attempts    + lesson_id, step
--   listening_progress    one row per user x lesson        status, step_results, score
--   listening_lesson_learners  who practised a lesson (users + guests) -> learners_count
--   comments              + lesson_id
--
-- Premium: a lesson is locked for free learners when its group, its skill or the lesson
-- itself has is_premium = true.
--
-- Data is copied from listening_types / listening_targets / listening_targets_listening_types.
-- Ids are kept (group/skill = type id, lesson = target id), so URLs (short_id), attempts,
-- comments and learners keep pointing at the same thing. Safe to run twice.
-- =====================================================================
BEGIN;

-- ── Tables ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listening_groups (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	status        varchar(20)  NOT NULL DEFAULT 'published',
	sort          integer,
	name          varchar(255) NOT NULL,
	slug          varchar(255) NOT NULL UNIQUE,
	answer_mode   varchar(20)  NOT NULL DEFAULT 'one_answer' CHECK (answer_mode IN ('one_answer', 'per_clip')),
	is_premium    boolean      NOT NULL DEFAULT false,
	date_created  timestamptz  DEFAULT now(),
	date_updated  timestamptz
);

CREATE TABLE IF NOT EXISTS listening_groups_translations (
	id                   serial PRIMARY KEY,
	listening_groups_id  uuid REFERENCES listening_groups(id) ON DELETE CASCADE,
	languages_code       varchar(255) REFERENCES languages(code) ON DELETE SET NULL,
	description          text
);

CREATE TABLE IF NOT EXISTS listening_skills (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	status        varchar(20)  NOT NULL DEFAULT 'published',
	sort          integer,
	group_id      uuid NOT NULL REFERENCES listening_groups(id) ON DELETE RESTRICT,
	name          varchar(255) NOT NULL,
	slug          varchar(255) NOT NULL UNIQUE,
	category      varchar(100),
	is_premium    boolean      NOT NULL DEFAULT false,
	date_created  timestamptz  DEFAULT now(),
	date_updated  timestamptz
);
CREATE INDEX IF NOT EXISTS listening_skills_group_idx ON listening_skills (group_id, sort);

CREATE TABLE IF NOT EXISTS listening_skills_translations (
	id                   serial PRIMARY KEY,
	listening_skills_id  uuid REFERENCES listening_skills(id) ON DELETE CASCADE,
	languages_code       varchar(255) REFERENCES languages(code) ON DELETE SET NULL,
	description          text,
	example              varchar(255)
);

CREATE TABLE IF NOT EXISTS listening_lessons (
	id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	status          varchar(20)  NOT NULL DEFAULT 'draft',
	sort            integer,
	skill_id        uuid NOT NULL REFERENCES listening_skills(id) ON DELETE RESTRICT,
	short_id        varchar(20)  NOT NULL UNIQUE,
	slug            varchar(255) UNIQUE,
	text            varchar(255) NOT NULL,
	difficulty      varchar(20)  NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
	is_premium      boolean      NOT NULL DEFAULT false,
	learners_count  integer      NOT NULL DEFAULT 0,
	date_created    timestamptz  DEFAULT now(),
	date_updated    timestamptz
);
CREATE INDEX IF NOT EXISTS listening_lessons_skill_idx ON listening_lessons (skill_id, sort);

CREATE TABLE IF NOT EXISTS listening_lessons_translations (
	id                    serial PRIMARY KEY,
	listening_lessons_id  uuid REFERENCES listening_lessons(id) ON DELETE CASCADE,
	languages_code        varchar(255) REFERENCES languages(code) ON DELETE SET NULL,
	explanation           text,
	tips                  text
);

ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS lesson_id uuid REFERENCES listening_lessons(id) ON DELETE CASCADE;
ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS step varchar(20);
ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS challenge_mode varchar(20);
ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS answer varchar(500);
DO $$ BEGIN
	ALTER TABLE listening_clips ADD CONSTRAINT listening_clips_step_check CHECK (step IN ('type', 'voice', 'challenge'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
	ALTER TABLE listening_clips ADD CONSTRAINT listening_clips_challenge_mode_check CHECK (challenge_mode IN ('sentence', 'speed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS listening_clips_lesson_step_idx ON listening_clips (lesson_id, step, sort);

ALTER TABLE listening_attempts ADD COLUMN IF NOT EXISTS lesson_id uuid REFERENCES listening_lessons(id) ON DELETE CASCADE;
ALTER TABLE listening_attempts ADD COLUMN IF NOT EXISTS step varchar(20);
CREATE INDEX IF NOT EXISTS listening_attempts_user_lesson_idx ON listening_attempts (user_id, lesson_id);

CREATE TABLE IF NOT EXISTS listening_progress (
	id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id        uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	lesson_id      uuid NOT NULL REFERENCES listening_lessons(id) ON DELETE CASCADE,
	status         varchar(20) NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
	step_results   json,
	score          integer,
	completed_at   timestamptz,
	date_created   timestamptz DEFAULT now(),
	date_updated   timestamptz DEFAULT now(),
	UNIQUE (user_id, lesson_id)
);

CREATE TABLE IF NOT EXISTS listening_lesson_learners (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	lesson_id     uuid NOT NULL REFERENCES listening_lessons(id) ON DELETE CASCADE,
	user_id       uuid REFERENCES directus_users(id) ON DELETE SET NULL,
	anonymous_id  varchar(64),
	learner_key   varchar(80) NOT NULL,
	date_created  timestamptz NOT NULL DEFAULT now(),
	UNIQUE (lesson_id, learner_key)
);

ALTER TABLE comments ADD COLUMN IF NOT EXISTS lesson_id uuid REFERENCES listening_lessons(id) ON DELETE CASCADE;

-- ── Data: groups = top-level types ────────────────────────────────────
INSERT INTO listening_groups (id, status, sort, name, slug, answer_mode, date_created)
SELECT t.id, COALESCE(t.status, 'published'), t.sort, t.name, t.slug,
	CASE WHEN t.answer_mode = 'per_clip' THEN 'per_clip' ELSE 'one_answer' END,
	COALESCE(t.date_created, now())
FROM listening_types t
WHERE t.parent_id IS NULL
ON CONFLICT (id) DO NOTHING;

INSERT INTO listening_groups_translations (listening_groups_id, languages_code, description)
SELECT tr.listening_types_id, tr.languages_code, tr.description
FROM listening_types_translations tr
JOIN listening_groups g ON g.id = tr.listening_types_id
WHERE NOT EXISTS (SELECT 1 FROM listening_groups_translations x
	WHERE x.listening_groups_id = tr.listening_types_id AND x.languages_code IS NOT DISTINCT FROM tr.languages_code);

-- ── Data: skills ──────────────────────────────────────────────────────
-- Leaf types below a group become skills (Linking Words, H-dropping...). A type between
-- them (Elision) is not a level any more: it becomes the `category` label of its children.
WITH RECURSIVE tree AS (
	SELECT t.id, t.parent_id, t.id AS group_id, NULL::varchar AS category, 0 AS depth
	FROM listening_types t WHERE t.parent_id IS NULL
	UNION ALL
	SELECT c.id, c.parent_id, tree.group_id,
		CASE WHEN tree.depth >= 1 THEN (SELECT name FROM listening_types WHERE id = tree.id) ELSE tree.category END,
		tree.depth + 1
	FROM listening_types c JOIN tree ON c.parent_id = tree.id
)
INSERT INTO listening_skills (id, status, sort, group_id, name, slug, category, date_created)
SELECT t.id, COALESCE(t.status, 'published'), t.sort, tree.group_id, t.name, t.slug, tree.category, COALESCE(t.date_created, now())
FROM tree JOIN listening_types t ON t.id = tree.id
WHERE tree.depth >= 1
	AND NOT EXISTS (SELECT 1 FROM listening_types c WHERE c.parent_id = t.id)
ON CONFLICT (id) DO NOTHING;

INSERT INTO listening_skills_translations (listening_skills_id, languages_code, description, example)
SELECT tr.listening_types_id, tr.languages_code, tr.description, tr.example
FROM listening_types_translations tr
JOIN listening_skills s ON s.id = tr.listening_types_id
WHERE NOT EXISTS (SELECT 1 FROM listening_skills_translations x
	WHERE x.listening_skills_id = tr.listening_types_id AND x.languages_code IS NOT DISTINCT FROM tr.languages_code);

-- A group without sub-types (Numbers, Single Word...) gets one skill of the same name,
-- so every lesson has a skill. Split it into real skills later (Years, Prices...).
INSERT INTO listening_skills (status, sort, group_id, name, slug)
SELECT 'published', 1, g.id, g.name, g.slug
FROM listening_groups g
WHERE NOT EXISTS (SELECT 1 FROM listening_skills s WHERE s.group_id = g.id)
	AND NOT EXISTS (SELECT 1 FROM listening_skills s WHERE s.slug = g.slug);

-- Lessons tagged only with a group or a middle type (no skill): "Mixed" skill of that group
INSERT INTO listening_skills (status, sort, group_id, name, slug)
SELECT 'published', 999, g.id, 'Mixed', g.slug || '-mixed'
FROM listening_groups g
WHERE EXISTS (SELECT 1 FROM listening_skills s WHERE s.group_id = g.id AND s.slug <> g.slug)
	AND NOT EXISTS (SELECT 1 FROM listening_skills s WHERE s.slug = g.slug || '-mixed');

-- ── Data: lessons ─────────────────────────────────────────────────────
-- Skill of a lesson = its deepest type that is a skill; otherwise the group's own
-- skill (Numbers) or its "Mixed" skill (Connected Speech lessons without a sub-type).
WITH RECURSIVE tree AS (
	SELECT id, id AS group_id, 0 AS depth FROM listening_types WHERE parent_id IS NULL
	UNION ALL
	SELECT c.id, tree.group_id, tree.depth + 1 FROM listening_types c JOIN tree ON c.parent_id = tree.id
),
picked AS (
	SELECT DISTINCT ON (l.listening_targets_id)
		l.listening_targets_id AS target_id,
		CASE WHEN s.id IS NOT NULL THEN s.id
			ELSE COALESCE(
				(SELECT id FROM listening_skills WHERE slug = g.slug || '-mixed'),
				(SELECT id FROM listening_skills WHERE slug = g.slug AND group_id = g.id))
		END AS skill_id
	FROM listening_targets_listening_types l
	JOIN tree ON tree.id = l.listening_types_id
	JOIN listening_groups g ON g.id = tree.group_id
	LEFT JOIN listening_skills s ON s.id = l.listening_types_id
	WHERE l.listening_targets_id IS NOT NULL
	ORDER BY l.listening_targets_id, (s.id IS NOT NULL) DESC, tree.depth DESC, l.listening_types_id
)
INSERT INTO listening_lessons (id, status, skill_id, short_id, slug, text, difficulty, is_premium, learners_count, date_created, date_updated)
SELECT t.id, COALESCE(t.status, 'draft'), p.skill_id, t.short_id, t.slug, t.text,
	CASE WHEN lower(t.difficulty) IN ('easy', 'medium', 'hard') THEN lower(t.difficulty) ELSE 'medium' END,
	t.is_free IS DISTINCT FROM true,
	COALESCE(t.learners_count, 0), t.date_created, t.date_updated
FROM listening_targets t
JOIN picked p ON p.target_id = t.id
WHERE p.skill_id IS NOT NULL AND t.short_id IS NOT NULL AND t.text IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Lessons without any type: Connected Speech > Mixed, to be sorted by hand
INSERT INTO listening_lessons (id, status, skill_id, short_id, slug, text, difficulty, is_premium, learners_count, date_created, date_updated)
SELECT t.id, COALESCE(t.status, 'draft'), s.id, t.short_id, t.slug, t.text,
	CASE WHEN lower(t.difficulty) IN ('easy', 'medium', 'hard') THEN lower(t.difficulty) ELSE 'medium' END,
	t.is_free IS DISTINCT FROM true, COALESCE(t.learners_count, 0), t.date_created, t.date_updated
FROM listening_targets t
JOIN listening_skills s ON s.slug = 'connected-speech-mixed'
WHERE t.short_id IS NOT NULL AND t.text IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM listening_targets_listening_types l WHERE l.listening_targets_id = t.id AND l.listening_types_id IS NOT NULL)
ON CONFLICT (id) DO NOTHING;

-- Order inside a skill: easy -> hard, then oldest first (the order used until now)
UPDATE listening_lessons l SET sort = o.rn
FROM (
	SELECT id, ROW_NUMBER() OVER (PARTITION BY skill_id ORDER BY
		CASE difficulty WHEN 'easy' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, date_created NULLS LAST, id) AS rn
	FROM listening_lessons
) o
WHERE o.id = l.id AND l.sort IS NULL;

INSERT INTO listening_lessons_translations (listening_lessons_id, languages_code, explanation, tips)
SELECT tr.listening_targets_id, tr.languages_code, tr.explanation, tr.tips
FROM listening_targets_translations tr
JOIN listening_lessons l ON l.id = tr.listening_targets_id
WHERE NOT EXISTS (SELECT 1 FROM listening_lessons_translations x
	WHERE x.listening_lessons_id = tr.listening_targets_id AND x.languages_code IS NOT DISTINCT FROM tr.languages_code);

-- ── Data: clips -> lesson + step ──────────────────────────────────────
-- One-answer groups: clip 1 = type, 2 = voice, 3 = challenge (1.25x), 4+ = voice.
-- Per-clip groups (Numbers, Spelling...): every clip is step 1, answer = the [bracketed] part.
UPDATE listening_clips c SET lesson_id = c.target_id
WHERE c.lesson_id IS NULL AND EXISTS (SELECT 1 FROM listening_lessons l WHERE l.id = c.target_id);

WITH ranked AS (
	SELECT c.id, g.answer_mode,
		ROW_NUMBER() OVER (PARTITION BY c.lesson_id ORDER BY c.sort NULLS LAST, c.date_created NULLS LAST, c.id) AS rn
	FROM listening_clips c
	JOIN listening_lessons l ON l.id = c.lesson_id
	JOIN listening_skills s ON s.id = l.skill_id
	JOIN listening_groups g ON g.id = s.group_id
	WHERE c.step IS NULL
)
UPDATE listening_clips c SET
	step = CASE
		WHEN r.answer_mode = 'per_clip' THEN 'type'
		WHEN r.rn = 1 THEN 'type'
		WHEN r.rn = 3 THEN 'challenge'
		ELSE 'voice' END,
	challenge_mode = CASE WHEN r.answer_mode <> 'per_clip' AND r.rn = 3 THEN 'speed' END,
	answer = CASE WHEN r.answer_mode = 'per_clip' THEN NULLIF(trim(substring(c.transcript FROM '\[([^\]]+)\]')), '') END,
	sort = r.rn
FROM ranked r
WHERE r.id = c.id;

-- ── Data: attempts, progress, learners, comments ──────────────────────
UPDATE listening_attempts a SET lesson_id = c.lesson_id, step = c.step
FROM listening_clips c
WHERE c.id = a.clip_id AND a.lesson_id IS NULL AND c.lesson_id IS NOT NULL;

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

INSERT INTO listening_lesson_learners (lesson_id, user_id, anonymous_id, learner_key, date_created)
SELECT tl.target_id, tl.user_id, tl.anonymous_id, tl.learner_key, tl.date_created
FROM listening_target_learners tl
JOIN listening_lessons l ON l.id = tl.target_id
ON CONFLICT (lesson_id, learner_key) DO NOTHING;

UPDATE comments c SET lesson_id = c.target_id
WHERE c.lesson_id IS NULL AND EXISTS (SELECT 1 FROM listening_lessons l WHERE l.id = c.target_id);

-- ── Directus: collections ─────────────────────────────────────────────
INSERT INTO directus_collections (collection, icon, note, display_template, sort_field, archive_field, archive_value, unarchive_value, accountability, hidden, singleton, sort, "group", collapse)
VALUES
	('listening_lab', 'headphones', 'Listening Lab: groups > skills > lessons > clips', NULL, NULL, NULL, NULL, NULL, 'all', false, false, 1, NULL, 'open'),
	('listening_groups', 'folder', 'Connected Speech, Numbers... Premium here locks every lesson in the group.', '{{name}}', 'sort', 'status', 'archived', 'draft', 'all', false, false, 1, 'listening_lab', 'open'),
	('listening_skills', 'category', 'H-dropping, Linking Words... Every lesson belongs to one skill.', '{{name}}', 'sort', 'status', 'archived', 'draft', 'all', false, false, 2, 'listening_lab', 'open'),
	('listening_lessons', 'school', 'One phrase to catch ("tell him"). Its clips are the steps of the lesson.', '{{text}}', 'sort', 'status', 'archived', 'draft', 'all', false, false, 3, 'listening_lab', 'open'),
	('listening_progress', 'trending_up', 'Progress of each learner in each lesson.', NULL, NULL, NULL, NULL, NULL, 'all', false, false, 4, 'listening_lab', 'open'),
	('listening_groups_translations', 'translate', NULL, NULL, NULL, NULL, NULL, NULL, 'all', true, false, NULL, 'listening_groups', 'open'),
	('listening_skills_translations', 'translate', NULL, NULL, NULL, NULL, NULL, NULL, 'all', true, false, NULL, 'listening_skills', 'open'),
	('listening_lessons_translations', 'translate', NULL, NULL, NULL, NULL, NULL, NULL, 'all', true, false, NULL, 'listening_lessons', 'open'),
	('listening_lesson_learners', 'group', NULL, NULL, NULL, NULL, NULL, NULL, 'all', true, false, NULL, 'listening_lab', 'open')
ON CONFLICT (collection) DO NOTHING;

-- ── Directus: fields (only the ones that need an interface / special) ─
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json,
	v.readonly, v.hidden, v.sort, v.width, v.required, v.note
FROM (VALUES
	-- groups
	('listening_groups', 'id', 'uuid', 'input', NULL, NULL, NULL, true, true, 1, 'full', false, NULL),
	('listening_groups', 'status', NULL, 'select-dropdown', '{"choices":[{"text":"Published","value":"published"},{"text":"Draft","value":"draft"},{"text":"Archived","value":"archived"}]}', 'labels', NULL, false, false, 2, 'half', false, NULL),
	('listening_groups', 'sort', NULL, 'input', NULL, NULL, NULL, false, true, 3, 'full', false, NULL),
	('listening_groups', 'name', NULL, 'input', NULL, NULL, NULL, false, false, 4, 'half', true, NULL),
	('listening_groups', 'slug', NULL, 'input', '{"slug":true}', NULL, NULL, false, false, 5, 'half', true, 'Used in the URL: /listening-lab/group/<slug>'),
	('listening_groups', 'answer_mode', NULL, 'select-dropdown', '{"choices":[{"text":"One answer per lesson (the lesson text)","value":"one_answer"},{"text":"One answer per clip (numbers, names...)","value":"per_clip"}]}', 'labels', NULL, false, false, 6, 'half', true, NULL),
	('listening_groups', 'is_premium', 'cast-boolean', 'boolean', '{"label":"Premium: lock every lesson of this group"}', 'boolean', NULL, false, false, 7, 'half', false, NULL),
	('listening_groups', 'translations', 'translations', 'translations', '{"languageField":"name"}', NULL, NULL, false, false, 8, 'full', false, NULL),
	('listening_groups', 'skills', 'o2m', 'list-o2m', '{"enableCreate":true,"enableSelect":false}', 'related-values', '{"template":"{{name}}"}', false, false, 9, 'full', false, NULL),
	('listening_groups', 'date_created', 'date-created', 'datetime', NULL, 'datetime', '{"relative":true}', true, true, 10, 'half', false, NULL),
	('listening_groups', 'date_updated', 'date-updated', 'datetime', NULL, 'datetime', '{"relative":true}', true, true, 11, 'half', false, NULL),
	('listening_groups_translations', 'id', NULL, NULL, NULL, NULL, NULL, false, true, 1, 'full', false, NULL),
	('listening_groups_translations', 'listening_groups_id', NULL, NULL, NULL, NULL, NULL, false, true, 2, 'full', false, NULL),
	('listening_groups_translations', 'languages_code', NULL, NULL, NULL, NULL, NULL, false, true, 3, 'full', false, NULL),
	('listening_groups_translations', 'description', NULL, 'input-multiline', NULL, NULL, NULL, false, false, 4, 'full', false, NULL),
	-- skills
	('listening_skills', 'id', 'uuid', 'input', NULL, NULL, NULL, true, true, 1, 'full', false, NULL),
	('listening_skills', 'status', NULL, 'select-dropdown', '{"choices":[{"text":"Published","value":"published"},{"text":"Draft","value":"draft"},{"text":"Archived","value":"archived"}]}', 'labels', NULL, false, false, 2, 'half', false, NULL),
	('listening_skills', 'sort', NULL, 'input', NULL, NULL, NULL, false, true, 3, 'full', false, NULL),
	('listening_skills', 'group_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{name}}"}', 'related-values', '{"template":"{{name}}"}', false, false, 4, 'half', true, NULL),
	('listening_skills', 'name', NULL, 'input', NULL, NULL, NULL, false, false, 5, 'half', true, NULL),
	('listening_skills', 'slug', NULL, 'input', '{"slug":true}', NULL, NULL, false, false, 6, 'half', true, 'Used in the URL: /listening-lab/skill/<slug>'),
	('listening_skills', 'category', NULL, 'input', '{"placeholder":"Optional label, e.g. Elision"}', NULL, NULL, false, false, 7, 'half', false, NULL),
	('listening_skills', 'is_premium', 'cast-boolean', 'boolean', '{"label":"Premium: lock every lesson of this skill"}', 'boolean', NULL, false, false, 8, 'half', false, NULL),
	('listening_skills', 'translations', 'translations', 'translations', '{"languageField":"name"}', NULL, NULL, false, false, 9, 'full', false, NULL),
	('listening_skills', 'lessons', 'o2m', 'list-o2m', '{"enableCreate":true,"enableSelect":false}', 'related-values', '{"template":"{{text}}"}', false, false, 10, 'full', false, NULL),
	('listening_skills', 'date_created', 'date-created', 'datetime', NULL, 'datetime', '{"relative":true}', true, true, 11, 'half', false, NULL),
	('listening_skills', 'date_updated', 'date-updated', 'datetime', NULL, 'datetime', '{"relative":true}', true, true, 12, 'half', false, NULL),
	('listening_skills_translations', 'id', NULL, NULL, NULL, NULL, NULL, false, true, 1, 'full', false, NULL),
	('listening_skills_translations', 'listening_skills_id', NULL, NULL, NULL, NULL, NULL, false, true, 2, 'full', false, NULL),
	('listening_skills_translations', 'languages_code', NULL, NULL, NULL, NULL, NULL, false, true, 3, 'full', false, NULL),
	('listening_skills_translations', 'description', NULL, 'input-multiline', NULL, NULL, NULL, false, false, 4, 'full', false, NULL),
	('listening_skills_translations', 'example', NULL, 'input', '{"placeholder":"tell him → \"tell-im\""}', NULL, NULL, false, false, 5, 'full', false, NULL),
	-- lessons
	('listening_lessons', 'id', 'uuid', 'input', NULL, NULL, NULL, true, true, 1, 'full', false, NULL),
	('listening_lessons', 'status', NULL, 'select-dropdown', '{"choices":[{"text":"Published","value":"published"},{"text":"Draft","value":"draft"},{"text":"Archived","value":"archived"}]}', 'labels', NULL, false, false, 2, 'half', false, NULL),
	('listening_lessons', 'sort', NULL, 'input', NULL, NULL, NULL, false, true, 3, 'full', false, NULL),
	('listening_lessons', 'skill_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{group_id.name}} › {{name}}"}', 'related-values', '{"template":"{{name}}"}', false, false, 4, 'half', true, NULL),
	('listening_lessons', 'text', NULL, 'input', NULL, NULL, NULL, false, false, 5, 'half', true, 'The phrase to catch = the answer (one-answer groups), or a title (per-clip groups)'),
	('listening_lessons', 'difficulty', NULL, 'select-dropdown', '{"choices":[{"text":"Easy","value":"easy"},{"text":"Medium","value":"medium"},{"text":"Hard","value":"hard"}]}', 'labels', NULL, false, false, 6, 'half', true, NULL),
	('listening_lessons', 'is_premium', 'cast-boolean', 'boolean', '{"label":"Premium lesson"}', 'boolean', NULL, false, false, 7, 'half', false, NULL),
	('listening_lessons', 'short_id', NULL, 'input', NULL, NULL, NULL, true, false, 8, 'half', false, 'Generated. URL: /listening-lab/<short_id>'),
	('listening_lessons', 'slug', NULL, 'input', NULL, NULL, NULL, true, true, 9, 'half', false, NULL),
	('listening_lessons', 'learners_count', NULL, 'input', NULL, NULL, NULL, true, false, 10, 'half', false, NULL),
	('listening_lessons', 'translations', 'translations', 'translations', '{"languageField":"name"}', NULL, NULL, false, false, 11, 'full', false, NULL),
	('listening_lessons', 'clips', 'o2m', 'list-o2m', '{"enableSelect":false,"fields":["step","challenge_mode","answer","transcript"]}', 'related-values', '{"template":"{{step}} · {{transcript}}"}', false, false, 12, 'full', false, 'Step 1 type · Step 2 another voice · Step 3 challenge. Drag to order clips inside a step.'),
	('listening_lessons', 'date_created', 'date-created', 'datetime', NULL, 'datetime', '{"relative":true}', true, true, 13, 'half', false, NULL),
	('listening_lessons', 'date_updated', 'date-updated', 'datetime', NULL, 'datetime', '{"relative":true}', true, true, 14, 'half', false, NULL),
	('listening_lessons_translations', 'id', NULL, NULL, NULL, NULL, NULL, false, true, 1, 'full', false, NULL),
	('listening_lessons_translations', 'listening_lessons_id', NULL, NULL, NULL, NULL, NULL, false, true, 2, 'full', false, NULL),
	('listening_lessons_translations', 'languages_code', NULL, NULL, NULL, NULL, NULL, false, true, 3, 'full', false, NULL),
	('listening_lessons_translations', 'explanation', NULL, 'input-rich-text-md', NULL, NULL, NULL, false, false, 4, 'full', false, NULL),
	('listening_lessons_translations', 'tips', NULL, 'input-multiline', NULL, NULL, NULL, false, false, 5, 'full', false, NULL),
	-- clips (new fields)
	('listening_clips', 'lesson_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{text}}"}', 'related-values', '{"template":"{{text}}"}', false, false, 20, 'half', false, NULL),
	('listening_clips', 'step', NULL, 'select-dropdown', '{"choices":[{"text":"1 · Type the phrase","value":"type"},{"text":"2 · Another voice","value":"voice"},{"text":"3 · Challenge","value":"challenge"}]}', 'labels', NULL, false, false, 21, 'half', false, NULL),
	('listening_clips', 'challenge_mode', NULL, 'select-dropdown', '{"choices":[{"text":"Whole sentence","value":"sentence"},{"text":"Faster (1.25x)","value":"speed"}],"allowNone":true}', 'labels', NULL, false, false, 22, 'half', false, 'Step 3 only'),
	('listening_clips', 'answer', NULL, 'input', NULL, NULL, NULL, false, false, 23, 'half', false, 'Empty = the lesson text. Set it for per-clip groups (the number / name) and for a "whole sentence" challenge.'),
	-- attempts / comments / progress
	('listening_attempts', 'lesson_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{text}}"}', 'related-values', '{"template":"{{text}}"}', true, false, 20, 'half', false, NULL),
	('listening_attempts', 'step', NULL, 'input', NULL, NULL, NULL, true, false, 21, 'half', false, NULL),
	('comments', 'lesson_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{text}}"}', 'related-values', '{"template":"{{text}}"}', false, false, 20, 'half', false, NULL),
	('listening_progress', 'id', 'uuid', 'input', NULL, NULL, NULL, true, true, 1, 'full', false, NULL),
	('listening_progress', 'user_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{email}}"}', 'user', NULL, true, false, 2, 'half', false, NULL),
	('listening_progress', 'lesson_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{text}}"}', 'related-values', '{"template":"{{text}}"}', true, false, 3, 'half', false, NULL),
	('listening_progress', 'status', NULL, 'select-dropdown', '{"choices":[{"text":"In progress","value":"in_progress"},{"text":"Completed","value":"completed"}]}', 'labels', NULL, true, false, 4, 'half', false, NULL),
	('listening_progress', 'score', NULL, 'input', NULL, NULL, NULL, true, false, 5, 'half', false, NULL),
	('listening_progress', 'step_results', 'cast-json', 'input-code', '{"language":"JSON"}', NULL, NULL, true, false, 6, 'full', false, NULL),
	('listening_progress', 'completed_at', NULL, 'datetime', NULL, 'datetime', '{"relative":true}', true, false, 7, 'half', false, NULL),
	('listening_progress', 'date_created', 'date-created', 'datetime', NULL, 'datetime', '{"relative":true}', true, true, 8, 'half', false, NULL),
	('listening_progress', 'date_updated', 'date-updated', 'datetime', NULL, 'datetime', '{"relative":true}', true, true, 9, 'half', false, NULL)
) AS v(collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

-- ── Directus: relations ───────────────────────────────────────────────
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, junction_field, sort_field, one_deselect_action)
SELECT * FROM (VALUES
	('listening_groups_translations', 'listening_groups_id', 'listening_groups', 'translations', 'languages_code', NULL, 'nullify'),
	('listening_groups_translations', 'languages_code', 'languages', NULL, 'listening_groups_id', NULL, 'nullify'),
	('listening_skills', 'group_id', 'listening_groups', 'skills', NULL, 'sort', 'nullify'),
	('listening_skills_translations', 'listening_skills_id', 'listening_skills', 'translations', 'languages_code', NULL, 'nullify'),
	('listening_skills_translations', 'languages_code', 'languages', NULL, 'listening_skills_id', NULL, 'nullify'),
	('listening_lessons', 'skill_id', 'listening_skills', 'lessons', NULL, 'sort', 'nullify'),
	('listening_lessons_translations', 'listening_lessons_id', 'listening_lessons', 'translations', 'languages_code', NULL, 'nullify'),
	('listening_lessons_translations', 'languages_code', 'languages', NULL, 'listening_lessons_id', NULL, 'nullify'),
	('listening_clips', 'lesson_id', 'listening_lessons', 'clips', NULL, 'sort', 'nullify'),
	('listening_attempts', 'lesson_id', 'listening_lessons', NULL, NULL, NULL, 'nullify'),
	('listening_progress', 'user_id', 'directus_users', NULL, NULL, NULL, 'nullify'),
	('listening_progress', 'lesson_id', 'listening_lessons', NULL, NULL, NULL, 'nullify'),
	('listening_lesson_learners', 'lesson_id', 'listening_lessons', NULL, NULL, NULL, 'nullify'),
	('listening_lesson_learners', 'user_id', 'directus_users', NULL, NULL, NULL, 'nullify'),
	('comments', 'lesson_id', 'listening_lessons', NULL, NULL, NULL, 'nullify')
) AS v(many_collection, many_field, one_collection, one_field, junction_field, sort_field, one_deselect_action)
WHERE NOT EXISTS (SELECT 1 FROM directus_relations r WHERE r.many_collection = v.many_collection AND r.many_field = v.many_field);

COMMIT;
