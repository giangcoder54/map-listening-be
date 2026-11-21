-- Learner feedback shown on the landing page ("What learners say").
-- Only rows a staff member picks are public: featured = true. featured_name is the name the
-- staff member types for the quote (e.g. "Minh, sinh viên"), never taken from the account,
-- so no learner's real name or email reaches the page without someone choosing it.
ALTER TABLE listening_feedback ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;
ALTER TABLE listening_feedback ADD COLUMN IF NOT EXISTS featured_name varchar(60);
CREATE INDEX IF NOT EXISTS listening_feedback_featured ON listening_feedback (date_updated DESC) WHERE featured;
