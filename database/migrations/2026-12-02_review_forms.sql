-- Listening Lab forms join the daily review (one session, one count): a form card gets the same two columns the other cards have.
--   right_streak  rights in a row: 0 choose among the wrong answers, 1+ type it (a NEW clip of the form each time)
--   suspended_at  "known, don't ask again": the card leaves review, nothing is deleted
ALTER TABLE listening_review_cards ADD COLUMN IF NOT EXISTS right_streak integer NOT NULL DEFAULT 0;
ALTER TABLE listening_review_cards ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
CREATE INDEX IF NOT EXISTS listening_review_cards_live ON listening_review_cards (user_id, due) WHERE suspended_at IS NULL;
-- Rollback: ALTER TABLE listening_review_cards DROP COLUMN IF EXISTS right_streak, DROP COLUMN IF EXISTS suspended_at;
