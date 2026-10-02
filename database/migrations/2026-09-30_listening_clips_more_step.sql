-- =====================================================================
-- Listening Lab: step 4 "More practice" is made of the lesson's own clips (step = 'more'),
-- chosen by the admin instead of the first clip of other lessons. A 'more' clip either:
--   - has its own video (source_video_id, start/end, transcript, answer), or
--   - points to another lesson (practice_lesson_id): its step-1 clip and its text are
--     used. Answering it only counts for the lesson being played, never for that lesson.
-- =====================================================================

BEGIN;

ALTER TABLE listening_clips DROP CONSTRAINT IF EXISTS listening_clips_step_check;
ALTER TABLE listening_clips ADD CONSTRAINT listening_clips_step_check CHECK (step IN ('type', 'voice', 'challenge', 'more'));

ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS practice_lesson_id uuid REFERENCES listening_lessons(id) ON DELETE CASCADE;

UPDATE directus_fields
SET options = '{"choices":[{"text":"1 · Type the phrase","value":"type"},{"text":"2 · Another voice","value":"voice"},{"text":"3 · Challenge","value":"challenge"},{"text":"4 · More practice","value":"more"}]}'
WHERE collection = 'listening_clips' AND field = 'step';

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, note)
SELECT 'listening_clips', 'practice_lesson_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{text}}"}', 'related-values', '{"template":"{{text}}"}', false, false, 24, 'half', false,
	'Step 4 only: practise another lesson (its step-1 clip and text). Leave empty to use this clip''s own video.'
WHERE NOT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'listening_clips' AND field = 'practice_lesson_id');

INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, junction_field, sort_field, one_deselect_action)
SELECT 'listening_clips', 'practice_lesson_id', 'listening_lessons', NULL, NULL, NULL, 'nullify'
WHERE NOT EXISTS (SELECT 1 FROM directus_relations WHERE many_collection = 'listening_clips' AND many_field = 'practice_lesson_id');

UPDATE directus_fields
SET note = 'Step 1 type (required: a published lesson needs one, else it is hidden) · Step 2 another voice · Step 3 challenge · Step 4 more practice. Drag to order clips inside a step.'
WHERE collection = 'listening_lessons' AND field = 'clips';

UPDATE directus_fields
SET note = 'Every published lesson needs at least one "1 · Type the phrase" clip.'
WHERE collection = 'listening_clips' AND field = 'step';

COMMIT;
