-- Sentence cards of the daily review are exercises that get harder (choose, type with a hint, type), like the other cards
ALTER TABLE il_review_cards ADD COLUMN IF NOT EXISTS right_streak integer NOT NULL DEFAULT 0;
