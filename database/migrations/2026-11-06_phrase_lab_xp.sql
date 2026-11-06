-- Phrase Lab XP goes to the XP ledger (lib/xp.ts recordPractice), like lessons and reviews.
-- Run after 2026-10-19_phrase_lab.sql and 2026-11-02_rule_flow.sql.
--   phrase:        +20, a phrase learned the first time   (dedupe phrase:<phrase id>)
--   phrase_review: +5, a phrase review right, once a day  (dedupe phrase_review:<phrase id>:<day>)

ALTER TABLE xp_events DROP CONSTRAINT IF EXISTS xp_events_reason_check;
ALTER TABLE xp_events ADD CONSTRAINT xp_events_reason_check
	CHECK (reason IN ('lesson', 'replay', 'review', 'lesson_test', 'skill_test', 'phrase', 'phrase_review'));
