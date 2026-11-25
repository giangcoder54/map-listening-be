-- Intensive Listening on a whole video: sentences are grouped in parts ("chặng"). A passage of one part works as before.
-- Safe to run twice.
ALTER TABLE il_sentences ADD COLUMN IF NOT EXISTS part smallint NOT NULL DEFAULT 1;

-- Rollback:
-- ALTER TABLE il_sentences DROP COLUMN IF EXISTS part;
