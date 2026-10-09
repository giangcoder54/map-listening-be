-- =====================================================================
-- Growth: referral, coupons, affiliate, blog, placement test, review,
-- XP / daily goal / leaderboard settings, support messages.
--
--   directus_users        + referral_code, referred_by, referred_at, daily_goal, leaderboard_hidden,
--                           gl_created_at (sign-up date)
--   affiliates            one row per user who applied (status, commission_rate, payout details)
--   referral_clicks       visits through a ?ref= link
--   referral_conversions  one row per paid order of a referred user: a Premium reward (normal
--                         inviter) or a commission (approved affiliate)
--   affiliate_payouts     money paid to an affiliate by hand
--   promotions            + max_redemptions, first_purchase_only,
--                           affiliate_user_id, polar_discount_id, description
--   purchase_histories    + discount_source ('promotion' | 'referral')
--   blog_posts (+ _translations)
--   placement_results     placement test scores (user or guest)
--   listening_reviews     spaced review of missed clips (one row per user x clip)
--   support_messages      contact form
--
-- Every table is read and written by the custom API (/v1/...) with the database
-- directly, no /items permission is needed. Safe to run twice.
-- =====================================================================
BEGIN;

-- ── Users ─────────────────────────────────────────────────────────────
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS referral_code varchar(32);
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS referred_by uuid REFERENCES directus_users(id) ON DELETE SET NULL;
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS referred_at timestamptz;
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS daily_goal integer NOT NULL DEFAULT 50;
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS leaderboard_hidden boolean NOT NULL DEFAULT false;
-- Directus keeps no sign-up date: a ?ref= link only counts for a new account
ALTER TABLE directus_users ADD COLUMN IF NOT EXISTS gl_created_at timestamptz;
UPDATE directus_users u SET gl_created_at = COALESCE(
	(SELECT min(a.timestamp) FROM directus_activity a WHERE a.collection = 'directus_users' AND a.action = 'create' AND a.item = u.id::text),
	(SELECT min(a.timestamp) FROM directus_activity a WHERE a."user" = u.id),
	now())
WHERE gl_created_at IS NULL;
ALTER TABLE directus_users ALTER COLUMN gl_created_at SET DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS directus_users_referral_code_uq ON directus_users (lower(referral_code));
CREATE INDEX IF NOT EXISTS directus_users_referred_by_idx ON directus_users (referred_by);

-- ── Affiliate program ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS affiliates (
	id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id          uuid NOT NULL UNIQUE REFERENCES directus_users(id) ON DELETE CASCADE,
	status           varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
	commission_rate  numeric(5,2),          -- NULL = AFFILIATE_DEFAULT_RATE
	channel_url      varchar(500),          -- where they will promote
	audience         text,                  -- who they reach, how many
	payout_method    varchar(30),           -- bank | paypal | other
	payout_details   text,                  -- account number, holder, PayPal email...
	admin_note       text,
	approved_at      timestamptz,
	date_created     timestamptz NOT NULL DEFAULT now(),
	date_updated     timestamptz
);

CREATE TABLE IF NOT EXISTS referral_clicks (
	id            bigserial PRIMARY KEY,
	referrer_id   uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	anonymous_id  varchar(64),
	landing       varchar(500),
	date_created  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referral_clicks_referrer_idx ON referral_clicks (referrer_id, date_created);
CREATE UNIQUE INDEX IF NOT EXISTS referral_clicks_daily_uq
	ON referral_clicks (referrer_id, anonymous_id, (date_trunc('day', date_created AT TIME ZONE 'UTC')))
	WHERE anonymous_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS affiliate_payouts (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id       uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	amount        bigint NOT NULL,          -- minor unit of currency: VND, or US cents
	currency      varchar(10) NOT NULL,
	method        varchar(30),
	reference     varchar(255),             -- bank transaction id...
	note          text,
	paid_at       timestamptz NOT NULL DEFAULT now(),
	date_created  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referral_conversions (
	id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	purchase_id       uuid NOT NULL REFERENCES purchase_histories(id) ON DELETE CASCADE,
	referrer_id       uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	referred_user_id  uuid REFERENCES directus_users(id) ON DELETE SET NULL,
	kind              varchar(20) NOT NULL CHECK (kind IN ('reward', 'commission')),
	order_amount      bigint,               -- what the buyer paid (minor unit)
	amount            bigint NOT NULL DEFAULT 0,  -- commission (minor unit); 0 for a reward
	currency          varchar(10),
	rate              numeric(5,2),
	reward_days       integer,
	status            varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'void')),
	available_at      timestamptz,          -- commission: payable from then (refund window)
	payout_id         uuid REFERENCES affiliate_payouts(id) ON DELETE SET NULL,
	date_created      timestamptz NOT NULL DEFAULT now(),
	UNIQUE (purchase_id)
);
CREATE INDEX IF NOT EXISTS referral_conversions_referrer_idx ON referral_conversions (referrer_id, status);

-- ── Coupons ───────────────────────────────────────────────────────────
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS description varchar(500);
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS max_redemptions integer;
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS first_purchase_only boolean NOT NULL DEFAULT false;
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS affiliate_user_id uuid REFERENCES directus_users(id) ON DELETE SET NULL;
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS polar_discount_id varchar(64);
ALTER TABLE purchase_histories ADD COLUMN IF NOT EXISTS discount_source varchar(20);

-- ── Blog ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blog_posts (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	status        varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
	slug          varchar(255) NOT NULL UNIQUE,
	cover         varchar(500),             -- Directus file id or an absolute URL
	author        varchar(255),
	tags          varchar(255),             -- comma separated
	published_at  timestamptz,
	date_created  timestamptz NOT NULL DEFAULT now(),
	date_updated  timestamptz
);
CREATE INDEX IF NOT EXISTS blog_posts_published_idx ON blog_posts (status, published_at DESC);

CREATE TABLE IF NOT EXISTS blog_posts_translations (
	id               serial PRIMARY KEY,
	blog_posts_id    uuid NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
	languages_code   varchar(255) NOT NULL REFERENCES languages(code) ON DELETE CASCADE,
	title            varchar(255) NOT NULL,
	excerpt          varchar(500),
	content          text,                  -- markdown
	seo_title        varchar(255),
	seo_description  varchar(500),
	UNIQUE (blog_posts_id, languages_code)
);

-- ── Placement test ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS placement_results (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id       uuid REFERENCES directus_users(id) ON DELETE CASCADE,
	anonymous_id  varchar(64),
	score         integer NOT NULL,
	total         integer NOT NULL,
	level         varchar(20) NOT NULL,
	details       json,
	date_created  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS placement_results_user_idx ON placement_results (user_id, date_created DESC);

-- ── Spaced review ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listening_reviews (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id       uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	clip_id       uuid NOT NULL REFERENCES listening_clips(id) ON DELETE CASCADE,
	lesson_id     uuid REFERENCES listening_lessons(id) ON DELETE CASCADE,
	box           integer NOT NULL DEFAULT 0,   -- 0..4, mastered rows are deleted
	due_at        timestamptz NOT NULL DEFAULT now(),
	lapses        integer NOT NULL DEFAULT 0,
	last_reviewed_at timestamptz,
	date_created  timestamptz NOT NULL DEFAULT now(),
	UNIQUE (user_id, clip_id)
);
CREATE INDEX IF NOT EXISTS listening_reviews_due_idx ON listening_reviews (user_id, due_at);

-- Review answers count for XP: they are attempts with step 'review'
ALTER TABLE listening_attempts ADD COLUMN IF NOT EXISTS source varchar(20);

-- ── Support ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS support_messages (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id       uuid REFERENCES directus_users(id) ON DELETE SET NULL,
	email         varchar(255) NOT NULL,
	name          varchar(255),
	topic         varchar(50),
	message       text NOT NULL,
	status        varchar(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'answered', 'closed')),
	date_created  timestamptz NOT NULL DEFAULT now()
);

COMMIT;

-- Show the new tables in the Directus app too (the site's /admin pages are the main editor)
INSERT INTO directus_collections (collection, icon, note, hidden, singleton)
VALUES
	('affiliates',           'handshake',     'Affiliate applications and rates', false, false),
	('referral_conversions', 'paid',          'Rewards and commissions per paid order', false, false),
	('affiliate_payouts',    'payments',      'Money paid to affiliates', false, false),
	('blog_posts',           'article',       'Blog (edit in /admin/blog)', false, false),
	('placement_results',    'quiz',          'Placement test results', false, false),
	('support_messages',     'support_agent', 'Contact form', false, false)
ON CONFLICT (collection) DO NOTHING;

-- referred_by is a link to the inviting user, not an id to generate. Without this, the
-- Directus app configures the uuid column with special "uuid" the first time someone
-- opens it, and then every new user gets a random referred_by -> sign-up fails with
-- INVALID_FOREIGN_KEY. Declared as a many-to-one so the app shows who invited the user.
UPDATE directus_fields
SET special = 'm2o', interface = 'select-dropdown-m2o', display = 'related-values',
	display_options = '{"template":"{{first_name}} {{last_name}} ({{email}})"}', readonly = true
WHERE collection = 'directus_users' AND field = 'referred_by';
INSERT INTO directus_fields (collection, field, special, interface, display, display_options, readonly, hidden)
SELECT 'directus_users', 'referred_by', 'm2o', 'select-dropdown-m2o', 'related-values',
	'{"template":"{{first_name}} {{last_name}} ({{email}})"}', true, false
WHERE NOT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'directus_users' AND field = 'referred_by');
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_deselect_action)
SELECT 'directus_users', 'referred_by', 'directus_users', 'nullify'
WHERE NOT EXISTS (SELECT 1 FROM directus_relations WHERE many_collection = 'directus_users' AND many_field = 'referred_by');

-- Old referral codes keep working after a user changes theirs: links already shared
-- (and codes already sitting in a visitor's cookie) still reach the same person, and
-- nobody else can take an old code.
CREATE TABLE IF NOT EXISTS referral_code_aliases (
	code          varchar(32) PRIMARY KEY,   -- lower case
	user_id       uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	date_created  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referral_code_aliases_user_idx ON referral_code_aliases (user_id);

-- Owner of the code typed at checkout (a friend's invite code, or the affiliate of a
-- coupon). When the order is paid it becomes the buyer's referrer (directus_users.referred_by)
-- if they have none yet. See resolveCode / recordConversion.
ALTER TABLE purchase_histories ADD COLUMN IF NOT EXISTS referrer_id uuid REFERENCES directus_users(id) ON DELETE SET NULL;
-- Same reason as referred_by above: a link to a user, never an id to generate
INSERT INTO directus_fields (collection, field, special, interface, display, display_options, readonly, hidden)
SELECT 'purchase_histories', 'referrer_id', 'm2o', 'select-dropdown-m2o', 'related-values',
	'{"template":"{{first_name}} {{last_name}} ({{email}})"}', true, false
WHERE NOT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'purchase_histories' AND field = 'referrer_id');
UPDATE directus_fields SET special = 'm2o', interface = 'select-dropdown-m2o', readonly = true
WHERE collection = 'purchase_histories' AND field = 'referrer_id';
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_deselect_action)
SELECT 'purchase_histories', 'referrer_id', 'directus_users', 'nullify'
WHERE NOT EXISTS (SELECT 1 FROM directus_relations WHERE many_collection = 'purchase_histories' AND many_field = 'referrer_id');

-- The code the buyer typed (may be an inviter's old code), kept for reconciliation:
-- referrer_id says who, discount_code says which code
ALTER TABLE purchase_histories ADD COLUMN IF NOT EXISTS discount_code varchar(50);
UPDATE purchase_histories h SET discount_code = lower(p.code)
FROM promotions p WHERE h.promotion_id = p.id AND h.discount_code IS NULL;
INSERT INTO directus_fields (collection, field, interface, readonly, note)
SELECT 'purchase_histories', 'discount_code', 'input', true, 'Code typed at checkout (coupon or invite code, maybe an old one)'
WHERE NOT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'purchase_histories' AND field = 'discount_code');

-- Referral / affiliate settings, edited in Directus (Settings-like singleton). Empty field =
-- env var, else the default in lib/growthConfig.ts. The API re-reads it on save and every minute.
CREATE TABLE IF NOT EXISTS growth_settings (
	id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
	referral_discount_percent numeric,
	referral_reward_days integer,
	polar_referral_discount_id varchar(64),
	affiliate_default_rate numeric,
	affiliate_commission_months integer,
	affiliate_hold_days integer,
	affiliate_countries varchar(255),
	affiliate_min_payout_vnd integer,
	affiliate_min_payout_usd integer,
	affiliate_withhold_threshold_vnd integer,
	affiliate_withhold_rate numeric,
	date_updated timestamptz DEFAULT now()
);
INSERT INTO growth_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

INSERT INTO directus_collections (collection, icon, note, singleton, hidden, accountability)
SELECT 'growth_settings', 'tune', 'Mời bạn bè & affiliate. Để trống = giá trị mặc định', true, false, 'all'
WHERE NOT EXISTS (SELECT 1 FROM directus_collections WHERE collection = 'growth_settings');

INSERT INTO directus_fields (collection, field, special, interface, options, readonly, hidden, sort, width, note)
SELECT 'growth_settings', f.field, f.special, f.interface, f.options::json, f.readonly, f.hidden, f.sort, f.width, f.note
FROM (VALUES
	('id', NULL, 'input', NULL, true, true, 1, 'full', NULL),
	('referral_discount_percent', NULL, 'input', '{"placeholder":"10","min":0,"max":90}', false, false, 2, 'half', 'Mã mời: % giảm đơn trả tiền đầu tiên của người được mời (mặc định 10)'),
	('referral_reward_days', NULL, 'input', '{"placeholder":"30","min":0,"max":365}', false, false, 3, 'half', 'Mã mời: số ngày Premium người mời nhận khi bạn trả tiền (mặc định 30)'),
	('polar_referral_discount_id', NULL, 'input', '{"placeholder":"Discount ID trên Polar","trim":true}', false, false, 4, 'full', 'Discount 10% (Duration: Once) tạo trên Polar. Trống = mã mời chỉ giảm khi chuyển khoản'),
	('affiliate_default_rate', NULL, 'input', '{"placeholder":"30","min":0,"max":90}', false, false, 5, 'half', 'Affiliate: % hoa hồng mặc định (mặc định 30)'),
	('affiliate_commission_months', NULL, 'input', '{"placeholder":"12","min":1,"max":120}', false, false, 6, 'half', 'Affiliate: số tháng được hưởng hoa hồng từ đơn đầu (mặc định 12)'),
	('affiliate_hold_days', NULL, 'input', '{"placeholder":"14","min":0,"max":120}', false, false, 7, 'half', 'Affiliate: số ngày giữ hoa hồng trước khi được rút (mặc định 14)'),
	('affiliate_countries', NULL, 'input', '{"placeholder":"VN"}', false, false, 8, 'half', 'Affiliate: mã nước được đăng ký, cách nhau dấu phẩy, * = tất cả (mặc định VN)'),
	('affiliate_min_payout_vnd', NULL, 'input', '{"placeholder":"200000","min":0}', false, false, 9, 'half', 'Affiliate: số tiền rút tối thiểu, VND (mặc định 200.000)'),
	('affiliate_min_payout_usd', NULL, 'input', '{"placeholder":"5000","min":0}', false, false, 10, 'half', 'Affiliate: số tiền rút tối thiểu, cent USD (mặc định 5000 = $50)'),
	('affiliate_withhold_threshold_vnd', NULL, 'input', '{"placeholder":"5000000","min":0}', false, false, 11, 'half', 'Thuế TNCN: khấu trừ khi một lần trả từ mức này, VND (mặc định 5.000.000)'),
	('affiliate_withhold_rate', NULL, 'input', '{"placeholder":"10","min":0,"max":50}', false, false, 12, 'half', 'Thuế TNCN: % khấu trừ (mặc định 10)'),
	('date_updated', 'date-updated', 'datetime', NULL, true, false, 13, 'full', NULL)
) AS f(field, special, interface, options, readonly, hidden, sort, width, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields d WHERE d.collection = 'growth_settings' AND d.field = f.field);

-- Affiliate bank account as separate fields (payout_details stays for PayPal / other)
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS payout_bank varchar(100);
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS payout_account_number varchar(30);
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS payout_account_name varchar(255);

-- An affiliate asks to be paid (Trang Affiliate); the admin pays it (closes it) or rejects it
CREATE TABLE IF NOT EXISTS affiliate_payout_requests (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
	currency varchar(3) NOT NULL DEFAULT 'vnd',
	amount bigint NOT NULL,
	status varchar(20) NOT NULL DEFAULT 'pending',
	admin_note text,
	payout_id uuid REFERENCES affiliate_payouts(id) ON DELETE SET NULL,
	date_created timestamptz NOT NULL DEFAULT now(),
	date_updated timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_payout_requests_open_uq
	ON affiliate_payout_requests (user_id, currency) WHERE status = 'pending';

-- Self-referral signs on a reward / commission (lib/fraud.ts), and when an affiliate last
-- changed where they get paid
ALTER TABLE referral_conversions ADD COLUMN IF NOT EXISTS flags text[];
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS payout_updated_at timestamptz;


-- Directus admin: show who / what an id points to (name · email, order code...) instead of
-- a bare uuid, for every growth table. Only metadata: no column changes.
WITH links(collection, field, related, template) AS (VALUES
	('affiliates', 'user_id', 'directus_users', '{{first_name}} {{last_name}} · {{email}}'),
	('affiliate_payouts', 'user_id', 'directus_users', '{{first_name}} {{last_name}} · {{email}}'),
	('affiliate_payout_requests', 'user_id', 'directus_users', '{{first_name}} {{last_name}} · {{email}}'),
	('affiliate_payout_requests', 'payout_id', 'affiliate_payouts', '{{amount}} {{currency}} · {{paid_at}}'),
	('referral_conversions', 'referrer_id', 'directus_users', '{{first_name}} {{last_name}} · {{email}}'),
	('referral_conversions', 'referred_user_id', 'directus_users', '{{first_name}} {{last_name}} · {{email}}'),
	('referral_conversions', 'purchase_id', 'purchase_histories', '{{transfer_code}} · {{amount}} {{currency}}'),
	('referral_conversions', 'payout_id', 'affiliate_payouts', '{{amount}} {{currency}} · {{paid_at}}'),
	('referral_clicks', 'referrer_id', 'directus_users', '{{first_name}} {{last_name}} · {{email}}'),
	('referral_code_aliases', 'user_id', 'directus_users', '{{first_name}} {{last_name}} · {{email}}'),
	('promotions', 'affiliate_user_id', 'directus_users', '{{first_name}} {{last_name}} · {{email}}'),
	('purchase_histories', 'referrer_id', 'directus_users', '{{first_name}} {{last_name}} · {{email}}'),
	('purchase_histories', 'user', 'directus_users', '{{first_name}} {{last_name}} · {{email}}'),
	('directus_users', 'referred_by', 'directus_users', '{{first_name}} {{last_name}} · {{email}}'),
	('placement_results', 'user_id', 'directus_users', '{{first_name}} {{last_name}} · {{email}}'),
	('listening_reviews', 'user_id', 'directus_users', '{{first_name}} {{last_name}} · {{email}}'),
	('listening_attempts', 'user_id', 'directus_users', '{{first_name}} {{last_name}} · {{email}}'),
	('listening_progress', 'user_id', 'directus_users', '{{first_name}} {{last_name}} · {{email}}'),
	('listening_lesson_learners', 'user_id', 'directus_users', '{{first_name}} {{last_name}} · {{email}}'),
	('support_messages', 'user_id', 'directus_users', '{{first_name}} {{last_name}} · {{email}}')
),
upd AS (
	UPDATE directus_fields f
	SET special = 'm2o', interface = 'select-dropdown-m2o',
		options = json_build_object('template', l.template), display = 'related-values',
		display_options = json_build_object('template', l.template)
	FROM links l
	WHERE f.collection = l.collection AND f.field = l.field
	RETURNING f.collection, f.field
),
ins AS (
	INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options)
	SELECT l.collection, l.field, 'm2o', 'select-dropdown-m2o', json_build_object('template', l.template), 'related-values', json_build_object('template', l.template)
	FROM links l
	WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = l.collection AND f.field = l.field)
	RETURNING collection, field
)
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_deselect_action)
SELECT l.collection, l.field, l.related, 'nullify'
FROM links l
WHERE NOT EXISTS (SELECT 1 FROM directus_relations r WHERE r.many_collection = l.collection AND r.many_field = l.field);

-- Blog covers: files in the "Blog" folder can be read by anyone (the post page, link previews).
-- v1/blogRoutes.ts moves a cover there when a post is saved. Every other file stays private.
-- Directus reads one rule per policy and collection, so the folder is added to an existing
-- read rule ("... OR folder = Blog"), or a new rule is made for a policy without one.
-- Permissions are cached in Redis: clear the cache after running this (Directus → Settings → Clear cache).
INSERT INTO directus_folders (id, name) VALUES ('a7c3e2d1-5b4f-4e8a-9c6d-2f1b0e9d8c7a', 'Blog') ON CONFLICT (id) DO NOTHING;
UPDATE directus_permissions x
SET permissions = json_build_object('_or', json_build_array(x.permissions, '{"folder":{"_eq":"a7c3e2d1-5b4f-4e8a-9c6d-2f1b0e9d8c7a"}}'::json))
WHERE x.collection = 'directus_files' AND x.action = 'read'
	AND x.permissions IS NOT NULL
	AND x.permissions::text NOT LIKE '%a7c3e2d1-5b4f-4e8a-9c6d-2f1b0e9d8c7a%'
	AND x.policy IN (SELECT id FROM directus_policies WHERE NOT admin_access);
INSERT INTO directus_permissions (collection, action, permissions, fields, policy)
SELECT 'directus_files', 'read', '{"folder":{"_eq":"a7c3e2d1-5b4f-4e8a-9c6d-2f1b0e9d8c7a"}}'::json, '*', p.id
FROM directus_policies p
WHERE NOT p.admin_access
	AND NOT EXISTS (SELECT 1 FROM directus_permissions x WHERE x.policy = p.id AND x.collection = 'directus_files' AND x.action = 'read');
UPDATE directus_files SET folder = 'a7c3e2d1-5b4f-4e8a-9c6d-2f1b0e9d8c7a'
WHERE id::text IN (SELECT cover FROM blog_posts WHERE cover ~ '^[0-9a-f-]{36}$');
