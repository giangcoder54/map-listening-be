-- Intensive Listening: "Khám phá", shown on the result after a passage: what the video teaches, said simply, so the
-- learner also leaves knowing something new. Base (Vietnamese) in il_lessons.explore; other languages in il_translations
-- with key 'explore'. Text format: blocks split by a blank line; a block "## Heading" is a small heading, a block whose
-- lines start with "- " is a list, any other block is a paragraph. Safe to run twice.
ALTER TABLE il_lessons ADD COLUMN IF NOT EXISTS explore text;

-- Rollback:
-- ALTER TABLE il_lessons DROP COLUMN IF EXISTS explore;
