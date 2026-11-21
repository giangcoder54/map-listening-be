-- Problems learners report while doing an Intensive passage (wrong subtitle, answer marked wrong...)
CREATE TABLE IF NOT EXISTS il_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id uuid NOT NULL REFERENCES il_lessons(id) ON DELETE CASCADE,
  sentence_n int,
  user_id uuid,
  issue text NOT NULL CHECK (issue IN ('subtitle_off','wrong_answer','marked_wrong','video_issue','other')),
  comment text,
  typed text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','done')),
  date_created timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS il_issues_status_idx ON il_issues (status, date_created DESC);
