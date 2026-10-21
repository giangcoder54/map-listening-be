-- =====================================================================
-- Answers to the short questions the lesson page asks (optional, one tap):
--
--   kind = 'result'       one question on the result card, picked from what happened in
--                         the lesson (goal, challenge, skill_more, first_level, enough, length).
--                         answer = 'skip' when it was passed over.
--   kind = 'explanation'  "Was this explanation clear?" under each clip's explanation.
--                         answer = up | down | still_unclear | need_example | wrong | too_long
--   kind = 'issue'        "Report a problem" on a clip, sent by the learner when they see one.
--                         answer = subtitle_off | wrong_answer | marked_wrong | video_issue | other
--
--   context   what the lesson looked like when it was asked: tries, revealed, score,
--             explanation source ('clip' | 'lesson')...
--   learner_key   'u:<user id>' or 'a:<anonymous id>': one row per learner, question,
--                 lesson and clip; answering again updates it.
--   status    new | done (for issues: fixed or not)
-- Read on /admin/feedback (tab "Questions").
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS listening_answers (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	kind varchar(20) NOT NULL CHECK (kind IN ('result', 'explanation', 'issue')),
	question varchar(40) NOT NULL,
	answer varchar(40) NOT NULL,
	comment text,
	lesson_id uuid NOT NULL REFERENCES listening_lessons(id) ON DELETE CASCADE,
	clip_id uuid REFERENCES listening_clips(id) ON DELETE CASCADE,
	step varchar(20),
	user_id uuid REFERENCES directus_users(id) ON DELETE SET NULL,
	anonymous_id varchar(64),
	learner_key varchar(80) NOT NULL,
	context jsonb NOT NULL DEFAULT '{}'::jsonb,
	locale varchar(10),
	status varchar(20) NOT NULL DEFAULT 'new',
	date_created timestamptz NOT NULL DEFAULT now(),
	date_updated timestamptz NOT NULL DEFAULT now(),
	CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS listening_answers_once
	ON listening_answers (question, lesson_id, learner_key, (COALESCE(clip_id, '00000000-0000-0000-0000-000000000000'::uuid)));
CREATE INDEX IF NOT EXISTS listening_answers_question_date ON listening_answers (kind, question, date_updated DESC);
CREATE INDEX IF NOT EXISTS listening_answers_clip ON listening_answers (clip_id) WHERE clip_id IS NOT NULL;

INSERT INTO directus_collections (collection, icon, note, hidden, singleton, accountability, sort_field)
SELECT 'listening_answers', 'quiz', 'Answers to the lesson page questions', false, false, 'all', NULL
WHERE NOT EXISTS (SELECT 1 FROM directus_collections WHERE collection = 'listening_answers');

COMMIT;
