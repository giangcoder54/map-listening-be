-- =====================================================================
-- Country of a learner, so Tìm trận / Tìm bạn luyện can pair people of the same country first
-- (lib/match.ts, lib/country.ts).
--
--   directus_users.country   ISO 3166-1 alpha-2 ("VN"), taken from the IP of the learner (Cloudflare CF-IPCountry)
--                            and saved at each visit through GET /v1/country and POST /v1/match.
--   match_queue.country      copy of the learner's country when they join the queue.
--
-- Read and written only through /v1/country, not through the Directus permissions.
-- =====================================================================

BEGIN;

ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS country char(2);
ALTER TABLE match_queue ADD COLUMN IF NOT EXISTS country char(2);
ALTER TABLE directus_users DROP COLUMN IF EXISTS country_confirmed;

COMMIT;
