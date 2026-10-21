-- =====================================================================
-- Phrase Lab (docs/phrase-lab-roadmap.md in the web repo): everyday phrases from films.
--
--   phrase_types        "Opening a conversation"   12 situations, is_premium
--     phrases           "Got a second?"            text, text_linked, ipa, kind, is_premium
--       phrase_clips    a YouTube line that says it (start/end in seconds)
--   phrase_progress     user x phrase: level 1..4 + the FSRS card (ts-fsrs)
--   phrase_review_logs  every lesson finish / review answer: XP, reaction time, analytics
--
-- kind: reaction (No way!) | situational (Got a second?) | frame (Mind if I...?)
-- level: 1 recognise, 2 understand, 3 recall, 4 can use (see lib/phrases.ts)
-- Text fields that depend on the learner's language live in *_translations
-- (vi-VN filled by the admin import, en-US optional; the API falls back to vi-VN).
-- The site reads and writes through /v1/phrases routes only (no Directus permissions).
--
-- Not related to phrase_requests (learners asking for Listening Lab phrases).
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS phrase_types (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	status        varchar(20)  NOT NULL DEFAULT 'published',
	sort          integer,
	name          varchar(255) NOT NULL,
	slug          varchar(255) NOT NULL UNIQUE,
	icon          varchar(50),
	is_premium    boolean      NOT NULL DEFAULT false,
	date_created  timestamptz  DEFAULT now(),
	date_updated  timestamptz
);

CREATE TABLE IF NOT EXISTS phrase_types_translations (
	id               serial PRIMARY KEY,
	phrase_types_id  uuid NOT NULL REFERENCES phrase_types(id) ON DELETE CASCADE,
	languages_code   varchar(255) NOT NULL REFERENCES languages(code) ON DELETE CASCADE,
	name             varchar(255),
	description      text,
	UNIQUE (phrase_types_id, languages_code)
);

CREATE TABLE IF NOT EXISTS phrases (
	id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	status          varchar(20)  NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
	sort            integer,
	type_id         uuid NOT NULL REFERENCES phrase_types(id) ON DELETE RESTRICT,
	slug            varchar(255) NOT NULL UNIQUE,
	text            varchar(255) NOT NULL,
	text_normalized varchar(255) NOT NULL UNIQUE,  -- "got a second" : one row per phrase
	text_linked     varchar(255),                  -- "Got‿a second?"
	ipa             varchar(255),
	kind            varchar(20)  NOT NULL DEFAULT 'situational' CHECK (kind IN ('reaction', 'situational', 'frame')),
	is_premium      boolean      NOT NULL DEFAULT false,
	learners_count  integer      NOT NULL DEFAULT 0,
	user_created    uuid REFERENCES directus_users(id) ON DELETE SET NULL,
	date_created    timestamptz  DEFAULT now(),
	date_updated    timestamptz
);
CREATE INDEX IF NOT EXISTS phrases_type_idx ON phrases (type_id, sort);

CREATE TABLE IF NOT EXISTS phrases_translations (
	id              serial PRIMARY KEY,
	phrases_id      uuid NOT NULL REFERENCES phrases(id) ON DELETE CASCADE,
	languages_code  varchar(255) NOT NULL REFERENCES languages(code) ON DELETE CASCADE,
	meaning         varchar(500),       -- "Rảnh chút không?"
	usage           text,               -- when to use it
	avoid           text,               -- when not to
	similar_phrases jsonb NOT NULL DEFAULT '[]'::jsonb,         -- [{ "text": "Got a minute?", "note": "same" }]
	replies         jsonb NOT NULL DEFAULT '[]'::jsonb,         -- ["Sure, what's up?"]
	wrong_meanings  jsonb NOT NULL DEFAULT '[]'::jsonb,         -- traps for the quiz (literal meaning…)
	situations      jsonb NOT NULL DEFAULT '[]'::jsonb,         -- ["Bạn muốn nhờ đồng nghiệp xem giúp file"]
	UNIQUE (phrases_id, languages_code)
);

CREATE TABLE IF NOT EXISTS phrase_clips (
	id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	status            varchar(20)  NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published')),
	sort              integer,
	phrase_id         uuid NOT NULL REFERENCES phrases(id) ON DELETE CASCADE,
	source_video_id   uuid REFERENCES source_videos(id) ON DELETE SET NULL,
	youtube_video_id  varchar(20)  NOT NULL,
	start_time        numeric(10, 2) NOT NULL,   -- the line that says the phrase
	end_time          numeric(10, 2) NOT NULL,
	line_text         varchar(500),              -- the whole line, as said
	context           varchar(500),              -- what is going on (learner language: vi)
	date_created      timestamptz  DEFAULT now(),
	CHECK (end_time > start_time),
	UNIQUE (phrase_id, youtube_video_id, start_time)
);
CREATE INDEX IF NOT EXISTS phrase_clips_phrase_idx ON phrase_clips (phrase_id, sort);

CREATE TABLE IF NOT EXISTS phrase_progress (
	id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id         uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	phrase_id       uuid NOT NULL REFERENCES phrases(id) ON DELETE CASCADE,
	level           smallint NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 4),
	learned_at      timestamptz NOT NULL DEFAULT now(),
	reflex_days     jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ "day": "2026-10-19", "situation": 0 }] right reflex answers
	-- FSRS card (ts-fsrs Card)
	due             timestamptz NOT NULL DEFAULT now(),
	stability       double precision NOT NULL DEFAULT 0,
	difficulty      double precision NOT NULL DEFAULT 0,
	elapsed_days    integer NOT NULL DEFAULT 0,
	scheduled_days  integer NOT NULL DEFAULT 0,
	learning_steps  integer NOT NULL DEFAULT 0,
	reps            integer NOT NULL DEFAULT 0,
	lapses          integer NOT NULL DEFAULT 0,
	state           smallint NOT NULL DEFAULT 0,
	last_review     timestamptz,
	date_updated    timestamptz DEFAULT now(),
	UNIQUE (user_id, phrase_id)
);
CREATE INDEX IF NOT EXISTS phrase_progress_due_idx ON phrase_progress (user_id, due);

CREATE TABLE IF NOT EXISTS phrase_review_logs (
	id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id          uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	phrase_id        uuid NOT NULL REFERENCES phrases(id) ON DELETE CASCADE,
	mode             varchar(20) NOT NULL CHECK (mode IN ('lesson', 'choose', 'next_line', 'reflex')),
	rating           smallint NOT NULL,        -- ts-fsrs Rating: 1 again, 2 hard, 3 good, 4 easy
	correct          boolean NOT NULL,
	ms               integer,                  -- time to answer
	level_before     smallint,
	level_after      smallint,
	clip_id          uuid REFERENCES phrase_clips(id) ON DELETE SET NULL,
	situation_index  smallint,
	date_created     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phrase_review_logs_user_idx ON phrase_review_logs (user_id, date_created DESC);

-- ── Types ─────────────────────────────────────────────────────────────
INSERT INTO phrase_types (sort, name, slug, icon) VALUES
	(1,  'Starting a conversation', 'starting-a-conversation', 'message-circle'),
	(2,  'Reactions & surprise',    'reactions',               'zap'),
	(3,  'Agreeing & empathy',      'agreeing',                'thumbs-up'),
	(4,  'Saying no politely',      'saying-no',               'hand'),
	(5,  'Apologising',             'apologising',             'heart-crack'),
	(6,  'Thanks & replies',        'thanks',                  'gift'),
	(7,  'Asking for favours',      'asking-favours',          'hand-helping'),
	(8,  'Comforting',              'comforting',              'heart-handshake'),
	(9,  'Annoyed',                 'annoyed',                 'angry'),
	(10, 'Teasing & sarcasm',       'teasing',                 'laugh'),
	(11, 'Ending a conversation',   'ending-a-conversation',   'log-out'),
	(12, 'At work',                 'at-work',                 'briefcase')
ON CONFLICT (slug) DO NOTHING;

CREATE TEMP TABLE type_copy (slug text, lang text, name text, description text) ON COMMIT DROP;
INSERT INTO type_copy VALUES
	('starting-a-conversation', 'en-US', 'Starting a conversation', 'Ways to start talking or get someone''s attention.'),
	('starting-a-conversation', 'vi-VN', 'Mở lời, bắt chuyện', 'Cách bắt đầu câu chuyện hoặc gọi ai đó.'),
	('reactions', 'en-US', 'Reactions & surprise', 'Quick reactions when something is surprising, great or hard to believe.'),
	('reactions', 'vi-VN', 'Phản ứng, ngạc nhiên', 'Phản ứng nhanh khi bất ngờ, vui hay không tin nổi.'),
	('agreeing', 'en-US', 'Agreeing & empathy', 'Say you agree, or that you understand how they feel.'),
	('agreeing', 'vi-VN', 'Đồng ý, đồng cảm', 'Nói mình đồng ý, hoặc hiểu cảm giác của người kia.'),
	('saying-no', 'en-US', 'Saying no politely', 'Turn down an offer or invitation without sounding rude.'),
	('saying-no', 'vi-VN', 'Từ chối khéo', 'Từ chối lời mời hay đề nghị mà không bất lịch sự.'),
	('apologising', 'en-US', 'Apologising', 'Say sorry and own a mistake.'),
	('apologising', 'vi-VN', 'Xin lỗi, nhận lỗi', 'Xin lỗi và nhận phần lỗi về mình.'),
	('thanks', 'en-US', 'Thanks & replies', 'Thank someone, and answer when they thank you.'),
	('thanks', 'vi-VN', 'Cảm ơn và đáp lời', 'Cảm ơn, và đáp lại khi được cảm ơn.'),
	('asking-favours', 'en-US', 'Asking for favours', 'Ask for help or permission.'),
	('asking-favours', 'vi-VN', 'Nhờ vả, đề nghị', 'Nhờ giúp đỡ hoặc xin phép.'),
	('comforting', 'en-US', 'Comforting', 'Support someone who is having a hard time.'),
	('comforting', 'vi-VN', 'An ủi, động viên', 'Động viên người đang gặp chuyện khó khăn.'),
	('annoyed', 'en-US', 'Annoyed', 'Show you are annoyed or want to be left alone.'),
	('annoyed', 'vi-VN', 'Bực bội', 'Thể hiện sự khó chịu, hoặc muốn được yên.'),
	('teasing', 'en-US', 'Teasing & sarcasm', 'Playful teasing and sarcastic replies.'),
	('teasing', 'vi-VN', 'Trêu chọc, mỉa mai', 'Câu trêu đùa và đáp lại kiểu mỉa mai.'),
	('ending-a-conversation', 'en-US', 'Ending a conversation', 'Wrap up a chat and say goodbye naturally.'),
	('ending-a-conversation', 'vi-VN', 'Kết thúc cuộc nói chuyện', 'Kết thúc câu chuyện và chào tạm biệt tự nhiên.'),
	('at-work', 'en-US', 'At work', 'Everyday phrases at the office and in meetings.'),
	('at-work', 'vi-VN', 'Công sở', 'Câu hay dùng ở văn phòng và trong cuộc họp.');

INSERT INTO phrase_types_translations (phrase_types_id, languages_code, name, description)
SELECT t.id, c.lang, c.name, c.description
FROM type_copy c
JOIN phrase_types t ON t.slug = c.slug
JOIN languages l ON l.code = c.lang
ON CONFLICT (phrase_types_id, languages_code) DO NOTHING;

-- Free limits, editable in growth_settings (lib/growthConfig.ts; empty = env, then default)
ALTER TABLE growth_settings ADD COLUMN IF NOT EXISTS phrase_free_new_per_day integer;  -- default 3
ALTER TABLE growth_settings ADD COLUMN IF NOT EXISTS phrase_free_per_type integer;     -- default 3
ALTER TABLE growth_settings ADD COLUMN IF NOT EXISTS phrase_free_clips integer;        -- default 2

-- Shown in the Directus app (the site uses /v1/phrases routes)
INSERT INTO directus_collections (collection, icon, note, hidden, singleton, accountability, sort_field)
SELECT v.collection, v.icon, v.note, v.hidden, false, 'all', v.sort_field
FROM (VALUES
	('phrase_types', 'category', 'Phrase Lab: situations', false, 'sort'),
	('phrase_types_translations', 'translate', NULL, true, NULL),
	('phrases', 'forum', 'Phrase Lab: everyday phrases (edit on /admin/phrases)', false, 'sort'),
	('phrases_translations', 'translate', NULL, true, NULL),
	('phrase_clips', 'movie', 'Phrase Lab: film lines that say a phrase', false, 'sort'),
	('phrase_progress', 'trending_up', 'Phrase Lab: level + FSRS card per learner and phrase', false, NULL),
	('phrase_review_logs', 'history', 'Phrase Lab: lesson finishes and review answers', false, NULL)
) AS v(collection, icon, note, hidden, sort_field)
WHERE NOT EXISTS (SELECT 1 FROM directus_collections c WHERE c.collection = v.collection);

COMMIT;
