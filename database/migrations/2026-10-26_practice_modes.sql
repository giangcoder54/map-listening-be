-- =====================================================================
-- How each learner likes to practise, and where a lesson gets in their way
-- (lib/lessons.ts PRACTICE, v1/engagementRoutes.ts /me/settings, v1/eventRoutes.ts,
-- v1/adminDashboardRoutes.ts `practice`). Run before the backend that uses it.
--
-- 1. directus_users.practice_prefs  { voice: 'type' | 'listen', challenge: 'easy' | 'medium' | 'hard' }
--      voice      step 2 (same phrase, another speaker): type it again, or only listen and
--                 say "I heard it"
--      challenge  step 3, how much of the sentence is typed: the phrase only (easy, also at
--                 1x for a "faster" clip), about half the words (medium), all of it (hard,
--                 what every learner had before)
--    NULL = the defaults (type, medium). Guests keep theirs in the browser only.
--
-- 2. learning_events, two more events:
--      skip     "Skip this step" pressed, step = voice | challenge | more
--      setting  a practice setting chosen, step = voice_type | voice_listen |
--               challenge_easy | challenge_medium | challenge_hard
--
-- 3. listening_attempts: an attempt of step 2 in "listen" mode is answer '[HEARD]',
--    is_correct false, mode 'listen' (not a typed answer: left out of the tries and the
--    accuracy). Step 3 attempts carry their level in mode: sentence_easy, sentence_medium,
--    speed_easy; 'sentence' and 'speed' stay the hard level. No schema change for these.
-- =====================================================================

BEGIN;

ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS practice_prefs jsonb;

ALTER TABLE learning_events DROP CONSTRAINT IF EXISTS learning_events_event_check;
ALTER TABLE learning_events ADD CONSTRAINT learning_events_event_check
	CHECK (event IN ('visit', 'lesson_open', 'lesson_start', 'step', 'result', 'landing', 'skip', 'setting'));

COMMIT;
