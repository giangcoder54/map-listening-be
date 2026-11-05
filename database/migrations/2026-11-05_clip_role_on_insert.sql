-- =====================================================================
-- A clip added with a role keeps it.
--
-- listening_clips_role_from_step (2026-11-02_rule_flow.sql) gives a role from `step` to clips
-- saved without one, but on INSERT it also overwrote a role that was sent: a trap clip
-- (step 'more') added from the admin's "Câu bẫy" section was saved as 'pool'.
-- Now an explicit role is never overwritten, on INSERT as on UPDATE.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION listening_clips_role_from_step() RETURNS trigger AS $$
BEGIN
	IF NEW.step IS NULL OR NEW.lesson_id IS NULL THEN RETURN NEW; END IF;
	IF TG_OP = 'INSERT' AND NEW.role IS NOT NULL THEN RETURN NEW; END IF;
	IF TG_OP = 'UPDATE' AND NEW.role IS NOT NULL AND NEW.role IS DISTINCT FROM OLD.role THEN RETURN NEW; END IF;
	IF TG_OP = 'UPDATE' AND NEW.role IS NOT NULL AND NEW.step IS NOT DISTINCT FROM OLD.step THEN RETURN NEW; END IF;
	NEW.role := CASE NEW.step
		WHEN 'type' THEN CASE WHEN EXISTS (
				SELECT 1 FROM listening_clips c WHERE c.lesson_id = NEW.lesson_id AND c.role = 'core' AND c.id <> NEW.id
			) THEN 'pool' ELSE 'core' END
		WHEN 'voice' THEN 'voice'
		WHEN 'challenge' THEN 'challenge'
		ELSE 'pool'
	END;
	RETURN NEW;
END $$ LANGUAGE plpgsql;

COMMIT;
