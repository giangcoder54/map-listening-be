-- =====================================================================
-- Feedback on a lesson, sent from its result card (optional): a rating, a few tags and a
-- comment. One row per learner (or guest browser) and lesson: sending again updates it.
-- Read and closed by staff on /admin/feedback.
--
--   rating    1 = not good, 2 = okay, 3 = good
--   tags      ["too_hard", "too_easy", "wrong_answer", "subtitle_off", "unclear_explanation", "video_issue"]
--   score     % right when it was sent (the result card's), for context
--   status    new | done
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS listening_feedback (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	lesson_id uuid NOT NULL REFERENCES listening_lessons(id) ON DELETE CASCADE,
	user_id uuid REFERENCES directus_users(id) ON DELETE SET NULL,
	anonymous_id varchar(64),
	rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 3),
	tags jsonb NOT NULL DEFAULT '[]'::jsonb,
	comment text,
	score smallint,
	locale varchar(10),
	status varchar(20) NOT NULL DEFAULT 'new',
	date_created timestamptz NOT NULL DEFAULT now(),
	date_updated timestamptz NOT NULL DEFAULT now(),
	CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS listening_feedback_user_lesson ON listening_feedback (lesson_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS listening_feedback_anon_lesson ON listening_feedback (lesson_id, anonymous_id) WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS listening_feedback_status_date ON listening_feedback (status, date_created DESC);

-- Shown in the Directus app (read-only use; the site writes through /v1 routes)
INSERT INTO directus_collections (collection, icon, note, hidden, singleton, accountability, sort_field)
SELECT 'listening_feedback', 'feedback', 'Lesson feedback from the result card', false, false, 'all', NULL
WHERE NOT EXISTS (SELECT 1 FROM directus_collections WHERE collection = 'listening_feedback');

COMMIT;
