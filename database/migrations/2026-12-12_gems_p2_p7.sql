-- Kim cương v2, P2-P7 (web repo docs/xu-v2-tasks.md, docs/xu-v2-backend.md mục 5-7).
--
--   P2  cards, card_translations, card_draws, recovery_progress   Sự thật hay Thử thách, nhiệm vụ hồi phục
--   P3  items, user_items, chests, chest_drops, chest_pity, chest_opens, badges, user_badges
--   P4  xu_packs, purchase_histories.product_type / pack_code / coins
--   P5  shares, user_badges.shown
--   P6  help_hints, help_uses
--   P7  rooms, room_members
--
-- Only adds tables, columns and seed rows: safe to run before the code is deployed.

-- ── P2: Sự thật hay Thử thách ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cards (
	id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	kind        varchar(5)  NOT NULL CHECK (kind IN ('truth', 'dare')),
	-- truth: explore (from dyk_cards), gap_pick (made from a clip). dare: correct_n, streak_n, no_replay, hard_n, star_n
	type        varchar(30) NOT NULL,
	difficulty  smallint    NOT NULL DEFAULT 1 CHECK (difficulty BETWEEN 1 AND 4),
	level_min   smallint,
	level_max   smallint,
	-- { dyk_card_id } for a truth made by hand; null for a template
	source      jsonb,
	-- dare: { metric: 'correct', n: 100, filter: { difficulty: 3 } }
	goal        jsonb,
	-- { coins: 70 } or { item: 'shield' } or { chest: 'silver' }
	reward      jsonb       NOT NULL,
	weight      smallint    NOT NULL DEFAULT 10,
	hidden      boolean     NOT NULL DEFAULT false,
	status      varchar(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'archived')),
	created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cards_pick ON cards (kind, status, difficulty);

CREATE TABLE IF NOT EXISTS card_translations (
	card_id uuid        NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
	lang    varchar(10) NOT NULL,
	title   text,
	body    text,
	PRIMARY KEY (card_id, lang)
);

CREATE TABLE IF NOT EXISTS card_draws (
	id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id         uuid        NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	day             date        NOT NULL,
	card_id         uuid        NOT NULL REFERENCES cards(id),
	kind            varchar(5)  NOT NULL,
	status          varchar(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'skipped')),
	progress        integer     NOT NULL DEFAULT 0,
	goal_n          integer,
	-- a truth made from a clip: the question and its answer, kept on the server
	payload         jsonb,
	correct         boolean,
	reward_event_id bigint REFERENCES coin_events(id) ON DELETE SET NULL,
	created_at      timestamptz NOT NULL DEFAULT now(),
	done_at         timestamptz,
	UNIQUE (user_id, day)
);
-- A dare not done blocks the next draw: one open row per learner (a truth is closed the day it is answered)
CREATE UNIQUE INDEX IF NOT EXISTS card_draws_one_open ON card_draws (user_id) WHERE status = 'open';

-- The way back when the purse is empty: hear 10 questions right in a free lesson, take 50
CREATE TABLE IF NOT EXISTS recovery_progress (
	user_id uuid    NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	day     date    NOT NULL,
	n       integer NOT NULL DEFAULT 0,
	claimed boolean NOT NULL DEFAULT false,
	PRIMARY KEY (user_id, day)
);

-- ── P3: rương và vật phẩm ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS items (
	code         varchar(30) PRIMARY KEY,
	-- shield, gold_star, extra_star, gems, badge, premium_day
	kind         varchar(20) NOT NULL,
	params       jsonb,
	rarity       smallint    NOT NULL DEFAULT 1,
	-- worth in Kim cương: only for the admin's price calculator
	value        integer     NOT NULL DEFAULT 0,
	expires_days smallint,
	active       boolean     NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS item_translations (
	code varchar(30) NOT NULL REFERENCES items(code) ON DELETE CASCADE,
	lang varchar(10) NOT NULL,
	name text,
	body text,
	PRIMARY KEY (code, lang)
);
CREATE TABLE IF NOT EXISTS user_items (
	id         bigserial PRIMARY KEY,
	user_id    uuid        NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	item_code  varchar(30) NOT NULL REFERENCES items(code),
	expires_at timestamptz,
	used_at    timestamptz,
	source     varchar(20) NOT NULL,
	source_id  text,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_items_live ON user_items (user_id, item_code) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS chests (
	code       varchar(30) PRIMARY KEY,
	tier       smallint    NOT NULL,
	price      integer     NOT NULL CHECK (price >= 0),
	rolls      smallint    NOT NULL DEFAULT 1,
	-- after pity_n opens without pity_item, the next one holds it
	pity_n     smallint,
	pity_item  varchar(30) REFERENCES items(code),
	-- one open per account (the new learner's chest)
	once       boolean     NOT NULL DEFAULT false,
	starts_at  timestamptz,
	ends_at    timestamptz,
	active     boolean     NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS chest_translations (
	code varchar(30) NOT NULL REFERENCES chests(code) ON DELETE CASCADE,
	lang varchar(10) NOT NULL,
	name text,
	body text,
	PRIMARY KEY (code, lang)
);
CREATE TABLE IF NOT EXISTS chest_drops (
	id         serial PRIMARY KEY,
	chest_code varchar(30) NOT NULL REFERENCES chests(code) ON DELETE CASCADE,
	item_code  varchar(30) NOT NULL REFERENCES items(code),
	weight     integer     NOT NULL CHECK (weight > 0),
	-- always in the chest, besides the rolls
	guaranteed boolean     NOT NULL DEFAULT false,
	-- what a learner who has Premium gets instead (a "free lesson" is worth nothing to them)
	premium_alt varchar(30) REFERENCES items(code)
);
CREATE INDEX IF NOT EXISTS chest_drops_chest ON chest_drops (chest_code);
CREATE TABLE IF NOT EXISTS chest_pity (
	user_id    uuid        NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	chest_code varchar(30) NOT NULL REFERENCES chests(code) ON DELETE CASCADE,
	misses     smallint    NOT NULL DEFAULT 0,
	PRIMARY KEY (user_id, chest_code)
);
CREATE TABLE IF NOT EXISTS chest_opens (
	-- the client's request_id: a double click opens once
	id            uuid PRIMARY KEY,
	user_id       uuid        NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	chest_code    varchar(30) NOT NULL REFERENCES chests(code),
	price         integer     NOT NULL,
	coin_event_id bigint REFERENCES coin_events(id) ON DELETE SET NULL,
	result        jsonb       NOT NULL,
	created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chest_opens_user ON chest_opens (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS badges (
	code       varchar(30) PRIMARY KEY,
	-- a numbered badge: only this many are ever made (null = no limit)
	serial_max integer,
	rarity     smallint NOT NULL DEFAULT 1,
	name_vi    text,
	name_en    text
);
CREATE TABLE IF NOT EXISTS user_badges (
	user_id    uuid        NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	badge_code varchar(30) NOT NULL REFERENCES badges(code),
	serial_no  integer,
	-- 1..3 = on the public profile's shelf, null = not shown
	shown      smallint CHECK (shown BETWEEN 1 AND 3),
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, badge_code)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_badges_serial ON user_badges (badge_code, serial_no) WHERE serial_no IS NOT NULL;

-- "Thêm 1 Ngôi sao" used before a run: the run has that many more
ALTER TABLE listening_runs ADD COLUMN IF NOT EXISTS extra_stars smallint NOT NULL DEFAULT 0;
-- star_uses: a gold star's win is x3, a shield turns a loss into nothing
ALTER TABLE star_uses ADD COLUMN IF NOT EXISTS shielded boolean NOT NULL DEFAULT false;

-- ── P4: nạp Kim cương ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS xu_packs (
	code       varchar(30) PRIMARY KEY,
	price_vnd  integer     NOT NULL CHECK (price_vnd > 0),
	-- Kim cương before any bonus
	coins      integer     NOT NULL CHECK (coins > 0),
	bonus_pct  smallint    NOT NULL DEFAULT 0,
	-- 2 = the first top-up of an account gets twice (1 = no first-time bonus)
	first_mult numeric(3,1) NOT NULL DEFAULT 1,
	active     boolean     NOT NULL DEFAULT true,
	sort       smallint    NOT NULL DEFAULT 0
);
ALTER TABLE purchase_histories ADD COLUMN IF NOT EXISTS product_type varchar(10) NOT NULL DEFAULT 'plan';
ALTER TABLE purchase_histories ADD COLUMN IF NOT EXISTS pack_code varchar(30);
ALTER TABLE purchase_histories ADD COLUMN IF NOT EXISTS coins integer;

-- ── P5: khoe thành tích ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shares (
	id         varchar(12) PRIMARY KEY,
	user_id    uuid        NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	kind       varchar(20) NOT NULL,
	data       jsonb       NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shares_user ON shares (user_id, created_at DESC);

-- ── P6: cùng luyện không đồng thời ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS help_hints (
	id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	clip_id    uuid        NOT NULL REFERENCES listening_clips(id) ON DELETE CASCADE,
	lesson_id  uuid        REFERENCES listening_lessons(id) ON DELETE SET NULL,
	user_id    uuid        NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	-- position (where the phrase is), rule (what rule it follows), slow (listen slowly to the part), letter (first letter)
	kind       varchar(10) NOT NULL CHECK (kind IN ('position', 'rule', 'slow', 'letter')),
	body       text        NOT NULL,
	uses       integer     NOT NULL DEFAULT 0,
	hidden     boolean     NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS help_hints_clip ON help_hints (clip_id) WHERE NOT hidden;
-- a hint can be left once per clip per learner
CREATE UNIQUE INDEX IF NOT EXISTS help_hints_one ON help_hints (user_id, clip_id, kind);
CREATE TABLE IF NOT EXISTS help_uses (
	hint_id    uuid        NOT NULL REFERENCES help_hints(id) ON DELETE CASCADE,
	user_id    uuid        NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	thanked    boolean     NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (hint_id, user_id)
);

-- ── P7: Phòng Đấu (không đồng thời) ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rooms (
	id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	creator_id uuid        NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	fee        integer     NOT NULL CHECK (fee >= 0),
	size       smallint    NOT NULL CHECK (size BETWEEN 2 AND 3),
	-- open: waiting for players. playing: full, each plays alone. done: paid out. cancelled: fees given back
	status     varchar(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'playing', 'done', 'cancelled')),
	-- the ordered dyk_cards ids of the round (same questions for everyone)
	questions  jsonb       NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	-- open rooms not full by then are cancelled; playing rooms are settled with who has finished
	deadline   timestamptz NOT NULL,
	done_at    timestamptz
);
CREATE INDEX IF NOT EXISTS rooms_open ON rooms (status, created_at);
CREATE TABLE IF NOT EXISTS room_members (
	room_id     uuid        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
	user_id     uuid        NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	score       integer,
	time_ms     integer,
	answers     jsonb       NOT NULL DEFAULT '[]'::jsonb,
	finished_at timestamptz,
	prize       integer     NOT NULL DEFAULT 0,
	joined_at   timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS room_members_user ON room_members (user_id);

-- ── Seed: vật phẩm, huy hiệu, rương, gói nạp, thẻ ─────────────────────────────────────────────
INSERT INTO items (code, kind, params, rarity, value, expires_days) VALUES
	('shield',        'shield',       NULL,                  1,  60, 30),
	('gold_star',     'gold_star',    '{"mult":3}',          2, 120, 30),
	('extra_star',    'extra_star',   '{"n":1}',             1,  80, 30),
	('gems_50',       'gems',         '{"amount":50}',       1,  50, NULL),
	('gems_100',      'gems',         '{"amount":100}',      1, 100, NULL),
	('gems_300',      'gems',         '{"amount":300}',      2, 300, NULL),
	('gems_800',      'gems',         '{"amount":800}',      3, 800, NULL),
	('premium_day',   'premium_day',  '{"days":1}',          2, 100, NULL),
	('badge_silver',  'badge',        '{"badge":"silver"}',  2,  40, NULL),
	('badge_gold',    'badge',        '{"badge":"gold"}',    3, 150, NULL),
	('badge_platinum','badge',        '{"badge":"platinum"}',4, 400, NULL)
ON CONFLICT (code) DO NOTHING;

INSERT INTO item_translations (code, lang, name, body) VALUES
	('shield',         'vi', 'Khiên',              'Đặt Ngôi sao mà trả lời sai: không bị trừ Kim cương.'),
	('shield',         'en', 'Shield',             'A star that misses loses nothing.'),
	('gold_star',      'vi', 'Ngôi sao vàng',      'Đặt lên một câu: đúng thì nhận gấp 3.'),
	('gold_star',      'en', 'Gold star',          'Put it on one question: a right answer pays 3 times.'),
	('extra_star',     'vi', 'Thêm 1 Ngôi sao',    'Dùng trước khi vào bài: bài đó có thêm một Ngôi sao.'),
	('extra_star',     'en', 'One more star',      'Use it before a run: that run has one more star.'),
	('gems_50',        'vi', '50 Kim cương',       NULL), ('gems_50',        'en', '50 Gems',   NULL),
	('gems_100',       'vi', '100 Kim cương',      NULL), ('gems_100',       'en', '100 Gems',  NULL),
	('gems_300',       'vi', '300 Kim cương',      NULL), ('gems_300',       'en', '300 Gems',  NULL),
	('gems_800',       'vi', '800 Kim cương',      NULL), ('gems_800',       'en', '800 Gems',  NULL),
	('premium_day',    'vi', '1 ngày Premium',     'Mở mọi bài trong một ngày.'),
	('premium_day',    'en', '1 day of Premium',   'Every lesson open for a day.'),
	('badge_silver',   'vi', 'Huy hiệu Bạc',       NULL), ('badge_silver',   'en', 'Silver badge',   NULL),
	('badge_gold',     'vi', 'Huy hiệu Vàng',      NULL), ('badge_gold',     'en', 'Gold badge',     NULL),
	('badge_platinum', 'vi', 'Huy hiệu Bạch kim',  NULL), ('badge_platinum', 'en', 'Platinum badge', NULL)
ON CONFLICT (code, lang) DO NOTHING;

INSERT INTO badges (code, serial_max, rarity, name_vi, name_en) VALUES
	('first_chest', NULL, 1, 'Rương đầu tiên',   'First chest'),
	('silver',      NULL, 2, 'Huy hiệu Bạc',     'Silver badge'),
	('gold',        5000, 3, 'Huy hiệu Vàng',    'Gold badge'),
	('platinum',    500,  4, 'Huy hiệu Bạch kim','Platinum badge')
ON CONFLICT (code) DO NOTHING;

INSERT INTO chests (code, tier, price, rolls, pity_n, pity_item, once) VALUES
	('newbie',   0,    0, 2, NULL, NULL, true),
	('bronze',   1,  150, 2, 8, 'gold_star', false),
	('silver',   2,  400, 3, 6, 'gold_star', false),
	('gold',     3, 1000, 4, 5, 'gems_800', false),
	('platinum', 4, 2500, 5, 4, 'badge_platinum', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO chest_translations (code, lang, name, body) VALUES
	('newbie',   'vi', 'Rương chào mừng', 'Quà cho người mới, mở một lần.'), ('newbie',   'en', 'Welcome chest', 'A gift for new learners, opened once.'),
	('bronze',   'vi', 'Rương Đồng',      NULL), ('bronze',   'en', 'Bronze chest',   NULL),
	('silver',   'vi', 'Rương Bạc',       NULL), ('silver',   'en', 'Silver chest',   NULL),
	('gold',     'vi', 'Rương Vàng',      NULL), ('gold',     'en', 'Gold chest',     NULL),
	('platinum', 'vi', 'Rương Bạch kim',  NULL), ('platinum', 'en', 'Platinum chest', NULL)
ON CONFLICT (code, lang) DO NOTHING;

-- Weights tuned so a chest is worth about 85-95% of its price (see /admin/chests, the price calculator).
-- A learner who has Premium: a "premium_day" is worth less, so it turns into Kim cương (premium_alt).
INSERT INTO chest_drops (chest_code, item_code, weight, guaranteed, premium_alt)
SELECT * FROM (VALUES
	('newbie',   'gems_100',    1, true,  NULL),
	('newbie',   'shield',     50, false, NULL),
	('newbie',   'extra_star', 50, false, NULL),
	('bronze',   'gems_50',    40, false, NULL), ('bronze', 'shield',     25, false, NULL), ('bronze', 'extra_star', 20, false, NULL),
	('bronze',   'gems_100',   10, false, NULL), ('bronze', 'gold_star',   5, false, NULL),
	('silver',   'gems_100',   30, false, NULL), ('silver', 'shield',     20, false, NULL), ('silver', 'extra_star', 15, false, NULL),
	('silver',   'gold_star',  20, false, NULL), ('silver', 'gems_300',    8, false, NULL), ('silver', 'badge_silver', 5, false, NULL),
	('silver',   'premium_day', 2, false, 'gems_100'),
	('gold',     'gems_300',   30, false, NULL), ('gold',   'gold_star',   20, false, NULL), ('gold',   'gems_100',    15, false, NULL),
	('gold',     'shield',     10, false, NULL), ('gold',   'premium_day', 10, false, 'gems_100'), ('gold', 'badge_gold', 5, false, NULL),
	('gold',     'gems_800',    3, false, NULL), ('gold',   'extra_star',   7, false, NULL),
	('platinum', 'gems_300',   20, false, NULL), ('platinum', 'gold_star', 20, false, NULL), ('platinum', 'gems_800', 25, false, NULL),
	('platinum', 'premium_day', 10, false, 'gems_300'), ('platinum', 'badge_gold', 10, false, NULL), ('platinum', 'shield', 8, false, NULL),
	('platinum', 'badge_platinum', 6, false, NULL),
	('platinum', 'badge_platinum', 1, true, NULL)
) AS d (chest_code, item_code, weight, guaranteed, premium_alt)
WHERE NOT EXISTS (SELECT 1 FROM chest_drops);

-- 1.000đ = 40 Kim cương (docs/xu-ngoi-sao-spec.md mục 3.1)
INSERT INTO xu_packs (code, price_vnd, coins, bonus_pct, first_mult, sort) VALUES
	('p10',   10000,   400,  0, 1, 1),
	('p20',   20000,   800,  0, 2, 2),
	('p50',   50000,  2000, 10, 1, 3),
	('p100', 100000,  4000, 20, 1, 4),
	('p200', 200000,  8000, 30, 1, 5)
ON CONFLICT (code) DO NOTHING;

-- Thử thách: templates the team reviews in /admin/cards (goal.n counts right answers by the rule)
INSERT INTO cards (kind, type, difficulty, level_min, level_max, goal, reward, weight, status)
SELECT * FROM (VALUES
	('dare', 'correct_n', 1, NULL::smallint, NULL::smallint, '{"metric":"correct","n":20}'::jsonb,  '{"coins":60}'::jsonb,   20, 'approved'),
	('dare', 'correct_n', 2, NULL, NULL, '{"metric":"correct","n":50}'::jsonb,                      '{"coins":150}'::jsonb,  20, 'approved'),
	('dare', 'correct_n', 3, NULL, NULL, '{"metric":"correct","n":100}'::jsonb,                     '{"coins":300}'::jsonb,  15, 'approved'),
	('dare', 'correct_n', 4, 3,    NULL, '{"metric":"correct","n":100}'::jsonb,                     '{"chest":"silver"}'::jsonb, 5, 'approved'),
	('dare', 'hard_n',    2, NULL, NULL, '{"metric":"correct","n":10,"filter":{"difficulty":3}}'::jsonb, '{"coins":200}'::jsonb, 15, 'approved'),
	('dare', 'hard_n',    3, 2,    NULL, '{"metric":"correct","n":25,"filter":{"difficulty":3}}'::jsonb, '{"item":"gold_star"}'::jsonb, 10, 'approved'),
	('dare', 'no_replay', 2, NULL, NULL, '{"metric":"correct","n":20,"filter":{"listens":1}}'::jsonb,  '{"coins":180}'::jsonb, 15, 'approved'),
	('dare', 'no_replay', 3, 2,    NULL, '{"metric":"correct","n":40,"filter":{"listens":1}}'::jsonb,  '{"item":"shield"}'::jsonb, 10, 'approved'),
	('dare', 'star_n',    2, NULL, NULL, '{"metric":"star_right","n":3}'::jsonb,                      '{"coins":120}'::jsonb, 15, 'approved'),
	('dare', 'star_n',    3, 2,    NULL, '{"metric":"star_right","n":8}'::jsonb,                      '{"item":"extra_star"}'::jsonb, 10, 'approved')
) AS d (kind, type, difficulty, level_min, level_max, goal, reward, weight, status)
WHERE NOT EXISTS (SELECT 1 FROM cards WHERE kind = 'dare');

INSERT INTO card_translations (card_id, lang, title, body)
SELECT c.id, 'vi',
	CASE c.type
		WHEN 'correct_n' THEN 'Nghe đúng ' || (c.goal->>'n') || ' câu'
		WHEN 'hard_n'    THEN 'Nghe đúng ' || (c.goal->>'n') || ' câu khó'
		WHEN 'no_replay' THEN 'Nghe đúng ' || (c.goal->>'n') || ' câu chỉ nghe một lần'
		WHEN 'star_n'    THEN 'Đặt Ngôi sao đúng ' || (c.goal->>'n') || ' lần'
	END,
	'Làm xong lúc nào cũng được, không hết hạn. Thử thách này đang mở thì chưa rút thẻ mới.'
FROM cards c WHERE c.kind = 'dare'
ON CONFLICT (card_id, lang) DO NOTHING;
INSERT INTO card_translations (card_id, lang, title, body)
SELECT c.id, 'en',
	CASE c.type
		WHEN 'correct_n' THEN 'Get ' || (c.goal->>'n') || ' right'
		WHEN 'hard_n'    THEN 'Get ' || (c.goal->>'n') || ' hard ones right'
		WHEN 'no_replay' THEN 'Get ' || (c.goal->>'n') || ' right on a single listen'
		WHEN 'star_n'    THEN 'Win ' || (c.goal->>'n') || ' stars'
	END,
	'Finish whenever you like, it does not expire. While it is open there is no new card.'
FROM cards c WHERE c.kind = 'dare'
ON CONFLICT (card_id, lang) DO NOTHING;

-- Sự thật "explore": one card per approved dyk_cards row (question, options and answer are read from it)
INSERT INTO cards (kind, type, difficulty, source, reward, weight, status)
SELECT 'truth', 'explore', 1, jsonb_build_object('dyk_card_id', d.id), '{"coins":40}'::jsonb, 20, 'approved'
FROM dyk_cards d
WHERE d.status = 'approved' AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.source->>'dyk_card_id' = d.id::text);
-- Sự thật "gap_pick": a template, the question is made from a clip when it is drawn
INSERT INTO cards (kind, type, difficulty, reward, weight, status)
SELECT 'truth', 'gap_pick', 2, '{"coins":50}'::jsonb, 30, 'approved'
WHERE NOT EXISTS (SELECT 1 FROM cards WHERE type = 'gap_pick');

-- A charged-back top-up flags the account (admin sees it on the order)
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS gems_flagged boolean NOT NULL DEFAULT false;
