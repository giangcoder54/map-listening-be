-- Readable URLs: a passage by its title (/listening-lab/intensive/you-cant-unboil-an-egg), a result by the
-- learner's go number at that passage (?result=3) instead of uuids. short_id links keep working.
CREATE OR REPLACE FUNCTION il_slugify(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT trim(both '-' from regexp_replace(lower(regexp_replace(coalesce(t, ''), '[''’]', '', 'g')), '[^a-z0-9]+', '-', 'g'))
$$;
ALTER TABLE il_lessons ADD COLUMN IF NOT EXISTS slug text;
UPDATE il_lessons SET slug = il_slugify(title) WHERE slug IS NULL;
-- Two passages with the same title: the later one gets its short_id on the end
UPDATE il_lessons l SET slug = l.slug || '-' || l.short_id
WHERE EXISTS (SELECT 1 FROM il_lessons o WHERE o.slug = l.slug AND o.date_created < l.date_created);
CREATE UNIQUE INDEX IF NOT EXISTS il_lessons_slug_key ON il_lessons (slug);
-- New passages get one from their title
CREATE OR REPLACE FUNCTION il_lessons_slug() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    NEW.slug := il_slugify(NEW.title);
    IF EXISTS (SELECT 1 FROM il_lessons WHERE slug = NEW.slug AND id IS DISTINCT FROM NEW.id) THEN NEW.slug := NEW.slug || '-' || NEW.short_id; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS il_lessons_slug_trg ON il_lessons;
CREATE TRIGGER il_lessons_slug_trg BEFORE INSERT ON il_lessons FOR EACH ROW EXECUTE FUNCTION il_lessons_slug();

-- The learner's go number at a passage (1, 2, 3...)
ALTER TABLE il_attempts ADD COLUMN IF NOT EXISTS seq int;
UPDATE il_attempts a SET seq = x.n FROM (
  SELECT id, row_number() OVER (PARTITION BY user_id, lesson_id ORDER BY date_created) AS n FROM il_attempts
) x WHERE x.id = a.id AND a.seq IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS il_attempts_seq_key ON il_attempts (user_id, lesson_id, seq);
