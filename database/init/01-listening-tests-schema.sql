-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Listening Tests table
CREATE TABLE IF NOT EXISTS listening_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  status varchar(20) NOT NULL DEFAULT 'draft',
  title varchar(255) NOT NULL,
  slug varchar(255) UNIQUE NOT NULL,
  description text,

  type varchar(50) NOT NULL DEFAULT 'map_labelling',
  level varchar(50) NOT NULL DEFAULT 'basic',
  accent varchar(50) NOT NULL DEFAULT 'british',

  duration_seconds integer,
  question_count integer NOT NULL DEFAULT 0,
  is_free boolean NOT NULL DEFAULT true,

  thumbnail uuid REFERENCES directus_files(id) ON DELETE SET NULL,
  map_image uuid REFERENCES directus_files(id) ON DELETE SET NULL,
  audio_file uuid REFERENCES directus_files(id) ON DELETE SET NULL,

  instruction_text text,
  transcript text,
  prosody_script text,

  date_created timestamptz DEFAULT now(),
  date_updated timestamptz DEFAULT now()
);

-- Listening Questions table
CREATE TABLE IF NOT EXISTS listening_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  test uuid NOT NULL REFERENCES listening_tests(id) ON DELETE CASCADE,
  sort integer,

  question_text varchar(255) NOT NULL,
  question_type varchar(50) NOT NULL DEFAULT 'map_label',
  correct_answer varchar(50),

  explanation text,
  transcript_evidence text,

  score integer NOT NULL DEFAULT 1,

  date_created timestamptz DEFAULT now(),
  date_updated timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listening_questions_test
ON listening_questions(test);

-- Listening Options table
CREATE TABLE IF NOT EXISTS listening_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  test uuid NOT NULL REFERENCES listening_tests(id) ON DELETE CASCADE,
  sort integer,

  label varchar(10) NOT NULL,
  description text,

  x numeric(5,2),
  y numeric(5,2),

  is_distractor boolean NOT NULL DEFAULT false,

  date_created timestamptz DEFAULT now(),
  date_updated timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listening_options_test
ON listening_options(test);
