-- "Words that start alike" (the daily review's look-alike answers) is a prefix search; the primary key cannot serve LIKE 'res%'
-- with the database's collation, so it read all 1.2 million words every time (about 2 seconds).
CREATE INDEX IF NOT EXISTS wiktionary_en_w_prefix ON wiktionary_en (w text_pattern_ops);
