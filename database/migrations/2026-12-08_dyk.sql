-- "Bạn có biết?" daily card on the landing page (spec: Claude Docs "Bạn có biết? — spec thẻ mỗi ngày trên landing").
-- A card = a hook + a 5-15 s clip + a question with 3 options + a one-line answer, and the lesson it leads to.
--   kind: il (Intensive lesson) | el (Extensive lesson) | cs (connected speech rule; lesson_key = skill slug)
--   The clip must lie inside the lesson's own range (tools/dyk_write.py checks it).
-- Text is in Vietnamese here (the base language); other languages go in dyk_translations
-- (key: hook | question | answer | option0 | option1 | option2).
-- dyk_schedule: one card per Vietnam day. The route fills a missing day on first request.

CREATE TABLE IF NOT EXISTS dyk_cards (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	kind varchar(4) NOT NULL CHECK (kind IN ('il', 'el', 'cs')),
	lesson_key varchar(80) NOT NULL,
	youtube_video_id varchar(20) NOT NULL,
	clip_start numeric(7, 2) NOT NULL,
	clip_end numeric(7, 2) NOT NULL,
	hook text NOT NULL,
	question text NOT NULL,
	options text[] NOT NULL,
	correct smallint NOT NULL,
	answer text NOT NULL,
	-- the English sentence of the clip that holds the answer, shown after answering
	line text,
	topic varchar(60),
	status varchar(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
	date_created timestamptz NOT NULL DEFAULT now(),
	CHECK (clip_end > clip_start),
	CHECK (array_length(options, 1) = 3 AND correct BETWEEN 0 AND 2)
);
CREATE INDEX IF NOT EXISTS dyk_cards_status ON dyk_cards (status);

CREATE TABLE IF NOT EXISTS dyk_translations (
	card_id uuid NOT NULL REFERENCES dyk_cards(id) ON DELETE CASCADE,
	lang varchar(10) NOT NULL,
	key varchar(20) NOT NULL,
	text text NOT NULL,
	PRIMARY KEY (card_id, lang, key)
);

CREATE TABLE IF NOT EXISTS dyk_schedule (
	day date PRIMARY KEY,
	card_id uuid NOT NULL REFERENCES dyk_cards(id),
	picked_by varchar(10) NOT NULL DEFAULT 'auto'
);
CREATE INDEX IF NOT EXISTS dyk_schedule_card ON dyk_schedule (card_id);

-- The card's own events: learning_events.event = 'dyk', step = view | play | answer | right | cta_start | cta_lesson,
-- path = card id. Only visitors of variant B of the landing A/B test send them.
ALTER TABLE learning_events DROP CONSTRAINT IF EXISTS learning_events_event_check;
ALTER TABLE learning_events ADD CONSTRAINT learning_events_event_check
	CHECK (event::text = ANY (ARRAY['visit', 'lesson_open', 'lesson_start', 'step', 'result', 'landing', 'skip', 'setting', 'dyk']));

ALTER TABLE dyk_cards ADD COLUMN IF NOT EXISTS line text;
-- the bait above the button: what else the lesson holds (only things inside the lesson's range)
ALTER TABLE dyk_cards ADD COLUMN IF NOT EXISTS tease text;
