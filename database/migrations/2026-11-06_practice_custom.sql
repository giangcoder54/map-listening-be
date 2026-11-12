-- =====================================================================
-- Practice set up by the admin, and traps that teach (lib/runs.ts, lib/mistakes.ts).
--
--   listening_lessons.practice        now 2-8 steps, any of them on a trap clip; a choice step may
--                                     carry `why`: { "<wrong answer>": "why it is wrong" }
--   listening_lessons.practice_shuffle  true = each learner gets the steps in a new order (so the
--                                     trap is not always the last one)
--   listening_lessons.trap_draw       traps drawn into the lesson's skip-ahead test (0-3, default 1)
--   listening_clips.trap_reason_vi/en one line shown after a trap clip is answered: why the rule
--                                     does not apply here ("Will ở cuối câu luôn đọc đủ")
--   coin_events.reason 'trap'         Xu for a trap answered right (once per clip per day)
-- =====================================================================

BEGIN;

ALTER TABLE listening_lessons ADD COLUMN IF NOT EXISTS practice_shuffle boolean NOT NULL DEFAULT false;
ALTER TABLE listening_lessons ADD COLUMN IF NOT EXISTS trap_draw smallint NOT NULL DEFAULT 1;
ALTER TABLE listening_lessons DROP CONSTRAINT IF EXISTS listening_lessons_trap_draw_check;
ALTER TABLE listening_lessons ADD CONSTRAINT listening_lessons_trap_draw_check CHECK (trap_draw BETWEEN 0 AND 3);

ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS trap_reason_vi text;
ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS trap_reason_en text;

ALTER TABLE coin_events DROP CONSTRAINT IF EXISTS coin_events_reason_check;
ALTER TABLE coin_events ADD CONSTRAINT coin_events_reason_check CHECK (reason IN ('lesson', 'perfect', 'goal', 'streak', 'review', 'ad', 'unlock', 'premium_day', 'freeze', 'retest', 'refund', 'admin', 'trap'));

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json, v.readonly, v.hidden, v.sort, v.width, v.required, v.note FROM (VALUES
	('listening_lessons', 'practice_shuffle', 'cast-boolean', 'boolean', NULL, NULL, NULL, false, true, 41, 'half', false, 'Practice steps in a new order for each learner'),
	('listening_lessons', 'trap_draw', NULL, 'input', NULL, NULL, NULL, false, true, 42, 'half', false, 'Trap clips drawn into the skip-ahead test (0-3)'),
	('listening_clips', 'trap_reason_vi', NULL, 'input', NULL, NULL, NULL, false, false, 31, 'half', false, 'Trap clip: why the rule does not apply here, one line (Vietnamese)'),
	('listening_clips', 'trap_reason_en', NULL, 'input', NULL, NULL, NULL, false, false, 32, 'half', false, 'Trap clip: why the rule does not apply here, one line (English)')
) AS v(collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

-- Content editors write them (their policy lists fields one by one)
UPDATE directus_permissions p SET fields = p.fields || ',practice_shuffle,trap_draw'
FROM directus_policies pol
WHERE pol.id = p.policy AND pol.name = 'Content Editor Access' AND p.collection = 'listening_lessons'
	AND p.action IN ('create', 'update', 'read') AND p.fields <> '*' AND p.fields NOT LIKE '%practice_shuffle%';
UPDATE directus_permissions p SET fields = p.fields || ',trap_reason_vi,trap_reason_en'
FROM directus_policies pol
WHERE pol.id = p.policy AND pol.name = 'Content Editor Access' AND p.collection = 'listening_clips'
	AND p.action IN ('create', 'update', 'read') AND p.fields <> '*' AND p.fields NOT LIKE '%trap_reason_vi%';

COMMIT;
