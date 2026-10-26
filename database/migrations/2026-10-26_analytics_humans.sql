-- =====================================================================
-- Real visitors only, and the home page ear test (v1/eventRoutes.ts, v1/adminDashboardRoutes.ts):
--
-- 1. learning_events.human: the row came from a browser that scrolled, tapped, clicked or
--    typed (the site waits for that before sending anything; known bots are dropped by the
--    server). Rows from before this have no such check: they stay false and the visitor
--    numbers of the dashboard leave them out, so its counting starts again from this deploy.
--
-- 2. event 'landing': the ear test on the home page, step = play | answer | right | cta
--    (played the clip / picked an answer / picked the right one / clicked on to the lessons).
-- =====================================================================

BEGIN;

ALTER TABLE learning_events ADD COLUMN IF NOT EXISTS human boolean NOT NULL DEFAULT false;
ALTER TABLE learning_events ALTER COLUMN human SET DEFAULT true;

ALTER TABLE learning_events DROP CONSTRAINT IF EXISTS learning_events_event_check;
ALTER TABLE learning_events ADD CONSTRAINT learning_events_event_check
	CHECK (event IN ('visit', 'lesson_open', 'lesson_start', 'step', 'result', 'landing'));

CREATE INDEX IF NOT EXISTS learning_events_human_day ON learning_events (day) WHERE human;

COMMIT;
