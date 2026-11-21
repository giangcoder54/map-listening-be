-- Intensive Listening: chunks that are almost always reduced in natural speech (sort of → "sorta"), shared by EVERY
-- passage. They work like a trap the author marked, without anyone typing it in each sentence. The team edits them
-- in /admin/library?tab=intensive. Safe to run twice.
--   text   the words as written ("sort of"), matched whole against a sentence
--   kind   linking | confusable | imagine (same as a sentence trap)
--   real   how it is said ("sorta"), shown to the learner
--   note   one line why (optional)
--   skill  slug in listening_skills that teaches it (optional, else the app picks one by kind)
CREATE TABLE IF NOT EXISTS il_chunks (
	id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	text         text NOT NULL,
	kind         text NOT NULL DEFAULT 'linking' CHECK (kind IN ('linking', 'confusable', 'imagine')),
	real         text,
	note         text,
	skill        text,
	active       boolean NOT NULL DEFAULT true,
	date_created timestamptz NOT NULL DEFAULT now(),
	date_updated timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS il_chunks_text_uq ON il_chunks (lower(text));

INSERT INTO il_chunks (text, kind, real, skill) VALUES
	('sort of',    'linking', '"sorta"',      'flap-t'),
	('kind of',    'linking', '"kinda"',      NULL),
	('turns out',  'linking', '"tern-zout"',  NULL),
	('turned out', 'linking', '"tern-dout"',  NULL),
	('a lot of',   'linking', '"a-lo-da"',    'flap-t'),
	('out of',     'linking', '"ou-da"',      'flap-t'),
	('going to',   'linking', '"gonna"',      NULL),
	('want to',    'linking', '"wanna"',      NULL),
	('got to',     'linking', '"gotta"',      NULL),
	('let me',     'linking', '"lemme"',      NULL),
	('give me',    'linking', '"gimme"',      NULL),
	('don''t know','linking', '"dunno"',      NULL)
ON CONFLICT DO NOTHING;

-- Rollback:
-- DROP TABLE IF EXISTS il_chunks;
