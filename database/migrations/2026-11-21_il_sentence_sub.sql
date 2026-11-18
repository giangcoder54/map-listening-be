-- Intensive Listening: the sentence's Vietnamese translation (the base language) sits in its own column,
-- like the sentence text. Other languages stay in il_translations with key 's<n>:sub'. Safe to run twice.
ALTER TABLE il_sentences ADD COLUMN IF NOT EXISTS sub text;

-- Rollback:
-- ALTER TABLE il_sentences DROP COLUMN IF EXISTS sub;
