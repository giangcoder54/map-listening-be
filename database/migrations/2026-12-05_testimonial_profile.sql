-- A signed-in writer can allow the landing page to show their real name and photo (from their profile) with
-- their quote. Off by default; a guest's quote never has it. Staff still approve every quote first.
ALTER TABLE site_testimonials ADD COLUMN IF NOT EXISTS show_profile boolean NOT NULL DEFAULT false;
