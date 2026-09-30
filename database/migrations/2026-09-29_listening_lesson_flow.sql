-- =====================================================================
-- Listening Lab: lesson flow (5 steps per challenge)
--
--   1. type      – type the phrase            (clip sort 1)
--   2. voice     – same phrase, other speaker (clip sort 2)
--   3. challenge – full sentence / faster     (clip sort 3, else clip 1)
--   4. more      – other challenges of the same skill (their clip sort 1)
--   5. result
--
-- Only ADDS columns and Directus metadata. Nothing is dropped or renamed.
-- Safe to run twice.
-- =====================================================================
BEGIN;

-- ── Columns ──────────────────────────────────────────────────────────
-- How a challenge is graded. NULL = inherit from the parent type.
--   single_answer: one answer for the whole challenge (Connected Speech, Single Word)
--   per_clip     : every clip has its own answer (Similar Sounds, Spelling, Numbers)
ALTER TABLE listening_types ADD COLUMN IF NOT EXISTS answer_mode varchar(20);

-- Steps of the lesson flow. NULL = inherit from the parent type.
-- [{ "key": "type|voice|challenge|more|clips", "premium": bool, "mode": "sentence|speed", "count": int }]
ALTER TABLE listening_types ADD COLUMN IF NOT EXISTS flow_config json;

-- Short example shown on the skill card, e.g. "tell him → tell-im"
ALTER TABLE listening_types_translations ADD COLUMN IF NOT EXISTS example varchar(255);

-- Order of clips inside a challenge: 1 = step 1, 2 = step 2, 3 = step 3
ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS sort integer;

-- What the learner was asked to type
ALTER TABLE listening_attempts ADD COLUMN IF NOT EXISTS mode varchar(20) NOT NULL DEFAULT 'phrase';

-- ── Backfill ─────────────────────────────────────────────────────────
-- Top-level groups get an explicit answer_mode (replaces guessing from the name)
UPDATE listening_types
SET answer_mode = CASE WHEN name ~* 'similar|spelling|number' THEN 'per_clip' ELSE 'single_answer' END
WHERE parent_id IS NULL AND answer_mode IS NULL;

-- Default flow, set once on each top-level group; sub-types inherit it
UPDATE listening_types
SET flow_config = '[
  {"key": "type",      "premium": false},
  {"key": "voice",     "premium": false},
  {"key": "challenge", "premium": true,  "mode": "sentence"},
  {"key": "more",      "premium": false, "count": 3}
]'::json
WHERE parent_id IS NULL AND flow_config IS NULL AND answer_mode = 'single_answer';

UPDATE listening_types
SET flow_config = '[{"key": "clips", "premium": false}]'::json
WHERE parent_id IS NULL AND flow_config IS NULL AND answer_mode = 'per_clip';

-- Existing clips keep the order they were created in
UPDATE listening_clips c
SET sort = s.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY date_created NULLS LAST, id) AS rn
  FROM listening_clips
) s
WHERE s.id = c.id AND c.sort IS NULL;

-- H-dropping belongs under Elision
UPDATE listening_types
SET parent_id = (SELECT id FROM listening_types WHERE slug = 'elision' OR name = 'Elision' ORDER BY slug = 'elision' DESC LIMIT 1)
WHERE slug = 'h-dropping'
  AND EXISTS (SELECT 1 FROM listening_types WHERE slug = 'elision' OR name = 'Elision');

-- ── Directus: fields in the admin ────────────────────────────────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, width, sort, note)
SELECT 'listening_types', 'answer_mode', NULL, 'select-dropdown',
  '{"choices":[{"text":"One answer per challenge","value":"single_answer"},{"text":"One answer per clip","value":"per_clip"}],"allowNone":true}'::json,
  'labels', 'half', 12, 'Empty = same as the parent type'
WHERE NOT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'listening_types' AND field = 'answer_mode');

INSERT INTO directus_fields (collection, field, special, interface, options, display, width, sort, note)
SELECT 'listening_types', 'flow_config', 'cast-json', 'list',
  '{"template":"{{key}} {{mode}}","addLabel":"Add step","fields":[
    {"field":"key","name":"Step","type":"string","meta":{"field":"key","type":"string","width":"half","interface":"select-dropdown","options":{"choices":[
      {"text":"1. Type the phrase","value":"type"},
      {"text":"2. Another voice","value":"voice"},
      {"text":"3. Challenge","value":"challenge"},
      {"text":"4. More of this skill","value":"more"},
      {"text":"Every clip (per-clip types)","value":"clips"}]}}},
    {"field":"premium","name":"Premium","type":"boolean","meta":{"field":"premium","type":"boolean","width":"half","interface":"boolean"}},
    {"field":"mode","name":"Challenge mode","type":"string","meta":{"field":"mode","type":"string","width":"half","interface":"select-dropdown","options":{"allowNone":true,"choices":[
      {"text":"Type the whole sentence","value":"sentence"},
      {"text":"Faster playback (1.25x)","value":"speed"}]}}},
    {"field":"count","name":"How many (step 4)","type":"integer","meta":{"field":"count","type":"integer","width":"half","interface":"input"}}
  ]}'::json,
  NULL, 'full', 13, 'Empty = same as the parent type. Set once on a top-level group.'
WHERE NOT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'listening_types' AND field = 'flow_config');

INSERT INTO directus_fields (collection, field, interface, width, sort, note)
SELECT 'listening_types_translations', 'example', 'input', 'full', 10, 'Shown on the skill card, e.g. tell him → tell-im'
WHERE NOT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'listening_types_translations' AND field = 'example');

INSERT INTO directus_fields (collection, field, interface, hidden, width, sort)
SELECT 'listening_clips', 'sort', 'input', true, 'half', 6
WHERE NOT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'listening_clips' AND field = 'sort');

INSERT INTO directus_fields (collection, field, interface, options, display, width, sort)
SELECT 'listening_attempts', 'mode', 'select-dropdown',
  '{"choices":[{"text":"Phrase","value":"phrase"},{"text":"Sentence","value":"sentence"},{"text":"Speed","value":"speed"}]}'::json,
  'labels', 'half', 20
WHERE NOT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'listening_attempts' AND field = 'mode');

-- Drag & drop clips in the collection list and inside a challenge (O2M)
UPDATE directus_collections SET sort_field = 'sort' WHERE collection = 'listening_clips';
UPDATE directus_relations SET sort_field = 'sort'
WHERE many_collection = 'listening_clips' AND many_field = 'target_id' AND one_collection = 'listening_targets';

COMMIT;
