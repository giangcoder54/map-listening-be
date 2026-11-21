-- Intensive Listening: what learners say about the flow, and how they behave in it.
--   il_feedback     the card on the result (rating 1 bad .. 3 good, tags, a comment), one row per learner (or guest browser) and passage
--   il_diag_votes   a thumb on one diagnosis the result gave ("you know the word but not its sound"): vote 1 / -1
--   il_attempts.practice   the "practise the key words you missed" round at the end: { total, done, right }
CREATE TABLE IF NOT EXISTS il_feedback (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	lesson_id uuid NOT NULL REFERENCES il_lessons(id) ON DELETE CASCADE,
	user_id uuid,
	anonymous_id varchar(64),
	rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 3),
	tags text[] NOT NULL DEFAULT '{}',
	comment text,
	locale varchar(10),
	status varchar(20) NOT NULL DEFAULT 'new',
	date_created timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS il_feedback_user_lesson ON il_feedback (lesson_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS il_feedback_anon_lesson ON il_feedback (lesson_id, anonymous_id) WHERE user_id IS NULL;

CREATE TABLE IF NOT EXISTS il_diag_votes (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	lesson_id uuid NOT NULL REFERENCES il_lessons(id) ON DELETE CASCADE,
	user_id uuid,
	anonymous_id varchar(64),
	sentence_n smallint NOT NULL,
	word text NOT NULL,
	outcome text NOT NULL,
	vote smallint NOT NULL CHECK (vote IN (-1, 1)),
	date_created timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS il_diag_votes_user ON il_diag_votes (lesson_id, user_id, sentence_n, word) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS il_diag_votes_anon ON il_diag_votes (lesson_id, anonymous_id, sentence_n, word) WHERE user_id IS NULL;

ALTER TABLE il_attempts ADD COLUMN IF NOT EXISTS practice jsonb;
