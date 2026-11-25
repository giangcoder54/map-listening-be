-- Quotes in the daily review popup: one short line to keep a learner going, picked per Vietnam day.
-- Collected by the team (Kho_quotes_GuideLingo_tong_hop.xlsx), loaded by docs/giao-trinh/tools/quotes_load.py,
-- managed in the admin (/admin/library?tab=quotes).
--   quote: the line in English (a quoted line stays English in every language)
--   meaning, author: base language (vi-VN); other languages in review_quote_translations (key: meaning | author)
--   An English learner gets no meaning line: the quote is already in their language.
-- Only approved quotes are shown.

CREATE TABLE IF NOT EXISTS review_quotes (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	quote text NOT NULL,
	meaning text,
	author varchar(200),
	topic varchar(60),
	status varchar(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
	date_created timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_quotes_status ON review_quotes (status);
CREATE UNIQUE INDEX IF NOT EXISTS review_quotes_quote ON review_quotes (lower(quote));

CREATE TABLE IF NOT EXISTS review_quote_translations (
	quote_id uuid NOT NULL REFERENCES review_quotes(id) ON DELETE CASCADE,
	lang varchar(10) NOT NULL,
	key varchar(20) NOT NULL,
	text text NOT NULL,
	PRIMARY KEY (quote_id, lang, key)
);
