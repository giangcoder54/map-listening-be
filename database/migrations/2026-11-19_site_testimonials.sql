-- "What learners say" on the landing page, written by anyone (guest or signed in).
-- Nothing is public until an admin sets status = 'approved' (Admin > Góp ý trang chủ).
--   name       the name shown under the quote; the writer types it, an admin may edit it
--   user_id    set when the writer was signed in (kept for the admin, never shown)
--   anonymous_id  the guest's browser id (gl_anon_id), one pending/approved quote per writer
CREATE TABLE IF NOT EXISTS site_testimonials (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid REFERENCES directus_users(id) ON DELETE SET NULL,
	anonymous_id varchar(64),
	name varchar(60),
	quote text NOT NULL CHECK (char_length(quote) BETWEEN 20 AND 500),
	locale varchar(10),
	status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
	date_created timestamptz NOT NULL DEFAULT now(),
	date_updated timestamptz NOT NULL DEFAULT now(),
	CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS site_testimonials_user ON site_testimonials (user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS site_testimonials_anon ON site_testimonials (anonymous_id) WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS site_testimonials_status ON site_testimonials (status, date_created DESC);
