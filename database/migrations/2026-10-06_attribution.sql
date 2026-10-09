-- Where a learner came from (first visit before sign-up): UTM tags, ad click ids,
-- in-app browser or referrer site. Written once per account by POST /v1/attribution/attach.
-- Safe to run twice.
--
--   directus_users  + utm_source, utm_medium, utm_campaign, utm_content, utm_term,
--                     signup_referrer (host), signup_landing (path), first_seen_at
--
-- NULL utm_source = account created before tracking (or the visitor blocked cookies).
-- '(direct)' = typed the address / bookmark / app without a referrer.

ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS utm_source varchar(100);
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS utm_medium varchar(100);
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS utm_campaign varchar(150);
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS utm_content varchar(150);
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS utm_term varchar(150);
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS signup_referrer varchar(255);
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS signup_landing varchar(500);
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS first_seen_at timestamptz;

CREATE INDEX IF NOT EXISTS directus_users_utm_source_idx ON directus_users (utm_source, utm_medium);
