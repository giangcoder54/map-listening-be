-- Problems learners report on a card of the daily review (the clip does not say the word, the answer is wrong, the meaning is off...)
CREATE TABLE IF NOT EXISTS review_issues (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid,
	card_kind text NOT NULL,
	card_id text NOT NULL,
	word text,
	video_id text,
	start_ms integer,
	end_ms integer,
	issue text NOT NULL CHECK (issue IN ('subtitle_off','wrong_answer','marked_wrong','video_issue','other')),
	comment text,
	status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','done')),
	date_created timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_issues_status ON review_issues (status, date_created DESC);
