-- Free vs bought with Kim cương, every feature (decided 2026-11-24). Premium is no longer sold, so is_premium
-- means "costs Kim cương". Free = every way in plus one whole loop; the rest is depth.
--   Listening Lab  the first 3 rules of Connected Speech whole; in every other rule its first lesson; the rest costs Kim cương
--   Practice bank  a video is free when one of its clips is in a free Listening Lab lesson
--   Extensive      Level 1-6 free, and the first 3 lessons (lowest Level) of every topic; the rest costs Kim cương
--   Intensive      the first passage of every Level in every topic free; the rest costs Kim cương
-- Lesson flags only: the rule (skill) and group flags are cleared, so one lesson's flag decides (lib/lessons.ts).
BEGIN;

-- ── Listening Lab ──────────────────────────────────────────────────────────────
UPDATE listening_groups SET is_premium = false WHERE is_premium;
UPDATE listening_skills SET is_premium = false WHERE is_premium;

WITH ranked AS (
	SELECT l.id, l.kind,
		row_number() OVER (PARTITION BY l.skill_id ORDER BY l.sort, l.date_created) AS n,
		dense_rank() OVER (PARTITION BY s.group_id ORDER BY s.sort, s.id) AS rule_no,
		g.name AS group_name
	FROM listening_lessons l
	JOIN listening_skills s ON s.id = l.skill_id
	JOIN listening_groups g ON g.id = s.group_id
	WHERE l.kind IN ('pattern', 'mixed', 'trap')
)
UPDATE listening_lessons l
SET is_premium = NOT (r.n = 1 OR (r.group_name = 'Connected Speech' AND r.rule_no <= 3))
FROM ranked r
WHERE r.id = l.id;

-- ── Practice bank ──────────────────────────────────────────────────────────────
UPDATE practice_videos p
SET is_premium = NOT EXISTS (
	SELECT 1 FROM listening_clips c JOIN listening_lessons l ON l.id = c.lesson_id
	WHERE c.source_video_id = p.source_video_id AND l.kind IN ('pattern', 'mixed', 'trap') AND NOT l.is_premium
);

-- ── Extensive ──────────────────────────────────────────────────────────────────
WITH ranked AS (
	SELECT id, level, row_number() OVER (PARTITION BY topic ORDER BY level, date_created) AS n
	FROM el_lessons
)
UPDATE el_lessons l
SET is_premium = NOT (r.level <= 6 OR r.n <= 3)
FROM ranked r
WHERE r.id = l.id;

-- ── Intensive ──────────────────────────────────────────────────────────────────
WITH ranked AS (
	SELECT l.id, row_number() OVER (
		PARTITION BY COALESCE(l.topic, coalesce(t.topic, CASE WHEN ct.apply_all THEN ct.topic END, t.ai_topic, ct.topic)), l.level
		ORDER BY l.date_created) AS n
	FROM il_lessons l
	JOIN source_videos sv ON sv.id = l.source_video_id
	LEFT JOIN video_tags t ON t.source_video_id = sv.id
	LEFT JOIN channel_tags ct ON ct.channel_name = sv.channel_name
)
UPDATE il_lessons l
SET is_premium = r.n > 1
FROM ranked r
WHERE r.id = l.id;

COMMIT;
