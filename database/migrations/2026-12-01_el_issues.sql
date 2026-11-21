-- Problems learners report while doing an Extensive lesson (wrong subtitle, answer marked wrong...); same shape as il_issues
CREATE TABLE IF NOT EXISTS el_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id uuid NOT NULL REFERENCES el_lessons(id) ON DELETE CASCADE,
  user_id uuid,
  issue text NOT NULL CHECK (issue IN ('subtitle_off','wrong_answer','marked_wrong','video_issue','other')),
  comment text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','done')),
  date_created timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS el_issues_status_idx ON el_issues (status, date_created DESC);
