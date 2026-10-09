/**
 * Daily goal, XP, streak, leaderboard and spaced review.
 *
 *   GET   /me/engagement          XP today / this week, daily goal, streak, reviews due
 *   GET   /me/settings            daily goal, hidden from the leaderboard
 *   PATCH /me/settings
 *   GET   /leaderboard            ?period=week|month: top learners by XP (+ my rank)
 *   GET   /review/due             clips to review now (answer hidden)
 *   POST  /review/:clipId         { answer } -> right or wrong, next date
 *
 * XP: 10 per clip answered right (once per clip per day), 20 per lesson finished (once),
 * 5 per review answered right. Days are counted in Vietnam time, like the profile heatmap.
 */
import { UUID_RE, answerOf } from '../lib/lessons';
import { isPremiumUser } from '../lib/premium';

export const TZ = 'Asia/Ho_Chi_Minh';
export const XP = { clip: 10, lesson: 20, review: 5 };
/** Days until the next review, by box (0 = just missed) */
export const REVIEW_INTERVALS = [1, 3, 7, 14, 30];

/** Same normalisation as the lesson player (listening-lab/[id].vue) */
export const normalizeAnswer = (text: string) =>
	String(text || '').toLowerCase().replace(/[^\w\s']/g, '').replace(/\s+/g, ' ').trim();

const periodStart = (unit: 'day' | 'week' | 'month') => `date_trunc('${unit}', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'`;

/** XP of every learner (or one) since a SQL timestamp expression */
export function xpQuery(database: any, startSql: string, userId?: string) {
	const own = userId ? 'AND user_id = ?' : '';
	const bindings = userId ? [userId, userId] : [];
	return database.raw(`
		WITH c AS (
			SELECT user_id,
				COUNT(DISTINCT ((date_created AT TIME ZONE '${TZ}')::date::text || clip_id::text)) FILTER (WHERE source IS DISTINCT FROM 'review')::int AS clips,
				COUNT(*) FILTER (WHERE source = 'review')::int AS reviews
			FROM listening_attempts
			WHERE is_correct AND user_id IS NOT NULL AND date_created >= ${startSql} ${own}
			GROUP BY user_id
		), l AS (
			SELECT user_id, COUNT(*)::int AS lessons
			FROM listening_progress
			WHERE completed_at >= ${startSql} ${own}
			GROUP BY user_id
		)
		SELECT COALESCE(c.user_id, l.user_id) AS user_id,
			(COALESCE(c.clips, 0) * ${XP.clip} + COALESCE(c.reviews, 0) * ${XP.review} + COALESCE(l.lessons, 0) * ${XP.lesson})::int AS xp
		FROM c FULL JOIN l ON l.user_id = c.user_id
	`, bindings);
}

async function xpOf(database: any, userId: string, unit: 'day' | 'week' | 'month') {
	const res = await xpQuery(database, periodStart(unit), userId);
	return Number(res.rows?.[0]?.xp) || 0;
}

/** Days in a row with practice, up to today (or yesterday: today is not over yet) */
export async function streakOf(database: any, userId: string) {
	const res = await database.raw(`
		SELECT DISTINCT to_char((date_created AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS day
		FROM listening_attempts
		WHERE user_id = ? AND date_created >= now() - interval '400 days'
	`, [userId]);
	const days = new Set<string>((res.rows || []).map((r: any) => r.day));
	const today = await database.raw(`SELECT to_char((now() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d`);
	const d = new Date(`${today.rows[0].d}T00:00:00Z`);
	const key = () => d.toISOString().slice(0, 10);
	if (!days.has(key())) d.setUTCDate(d.getUTCDate() - 1);
	let count = 0;
	while (days.has(key())) {
		count++;
		d.setUTCDate(d.getUTCDate() - 1);
	}
	return { streak: count, practiced_today: days.has(today.rows[0].d) };
}

/** First name + initial of the last name: what other learners see */
export const publicName = (first?: string | null, last?: string | null) => {
	const f = String(first || '').trim();
	const l = String(last || '').trim();
	if (!f && !l) return 'Learner';
	return l ? `${f || l} ${f ? `${l[0]}.` : ''}`.trim() : f;
};

/**
 * A missed clip goes (back) to the review queue, due tomorrow. Called by the lesson
 * player's attempts (wrong check or "show answer").
 */
export async function scheduleReview(database: any, userId: string, clipId: string, lessonId: string | null) {
	await database.raw(`
		INSERT INTO listening_reviews (user_id, clip_id, lesson_id, box, due_at, lapses)
		VALUES (?, ?, ?, 0, now() + interval '${REVIEW_INTERVALS[0]} day', 0)
		ON CONFLICT (user_id, clip_id) DO UPDATE SET box = 0, due_at = EXCLUDED.due_at, lapses = listening_reviews.lapses + 1
	`, [userId, clipId, lessonId]);
}

export function registerEngagementRoutes(router: any, context: any) {
	const { database, logger } = context;
	const fail = (res: any, what: string, error: any) => {
		logger?.error?.(`[engagement] ${what} failed: ${String(error)}`);
		return res.status(500).json({ success: false, message: 'Server error' });
	};
	const needUser = (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		if (!userId) res.status(401).json({ success: false, message: 'Unauthorized' });
		return userId as string | null;
	};

	router.get('/me/engagement', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		try {
			const [today, week, streak, user, due] = await Promise.all([
				xpOf(database, userId, 'day'),
				xpOf(database, userId, 'week'),
				streakOf(database, userId),
				database('directus_users').select('daily_goal').where('id', userId).first(),
				database('listening_reviews').where('user_id', userId).where('due_at', '<=', database.fn.now()).count('* as n').first(),
			]);
			return res.json({
				success: true,
				data: {
					xp_today: today,
					xp_week: week,
					daily_goal: Number(user?.daily_goal) || 50,
					...streak,
					reviews_due: Number(due?.n) || 0,
				},
			});
		} catch (error) {
			return fail(res, 'Load engagement', error);
		}
	});

	router.get('/me/settings', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		try {
			const row = await database('directus_users').select('daily_goal', 'leaderboard_hidden').where('id', userId).first();
			return res.json({ success: true, data: { daily_goal: Number(row?.daily_goal) || 50, leaderboard_hidden: !!row?.leaderboard_hidden } });
		} catch (error) {
			return fail(res, 'Load settings', error);
		}
	});

	// body: { daily_goal?: 20..500, leaderboard_hidden?: boolean }
	router.patch('/me/settings', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		const body = req.body || {};
		const patch: Record<string, any> = {};
		if (body.daily_goal !== undefined) {
			const goal = Math.round(Number(body.daily_goal));
			if (!Number.isFinite(goal) || goal < 20 || goal > 500) return res.status(400).json({ success: false, message: 'Daily goal must be 20-500 XP' });
			patch.daily_goal = goal;
		}
		if (body.leaderboard_hidden !== undefined) patch.leaderboard_hidden = body.leaderboard_hidden === true;
		if (!Object.keys(patch).length) return res.status(400).json({ success: false, message: 'Nothing to update' });
		try {
			await database('directus_users').where('id', userId).update(patch);
			return res.json({ success: true, data: patch });
		} catch (error) {
			return fail(res, 'Save settings', error);
		}
	});

	// ── Leaderboard ───────────────────────────────────────────────────────
	router.get('/leaderboard', async (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		const unit = req.query.period === 'month' ? 'month' : 'week';
		try {
			const res1 = await xpQuery(database, periodStart(unit));
			const ranked = (res1.rows || [])
				.map((r: any) => ({ user_id: r.user_id, xp: Number(r.xp) || 0 }))
				.filter((r: any) => r.xp > 0)
				.sort((a: any, b: any) => b.xp - a.xp);
			const ids = ranked.map((r: any) => r.user_id);
			const users = ids.length
				? await database('directus_users').select('id', 'first_name', 'last_name', 'avatar', 'leaderboard_hidden', 'status').whereIn('id', ids)
				: [];
			const byId = new Map(users.map((u: any) => [u.id, u]));
			const visible = ranked.filter((r: any) => {
				const u: any = byId.get(r.user_id);
				return u && u.status === 'active' && (!u.leaderboard_hidden || r.user_id === userId);
			});
			const rows = visible.map((r: any, i: number) => {
				const u: any = byId.get(r.user_id);
				return { rank: i + 1, name: publicName(u.first_name, u.last_name), avatar: u.avatar || null, xp: r.xp, me: r.user_id === userId };
			});
			const mine = rows.find((r: any) => r.me) || null;
			const ends = await database.raw(`SELECT (date_trunc('${unit}', now() AT TIME ZONE '${TZ}') + interval '1 ${unit}') AT TIME ZONE '${TZ}' AS ends_at`);
			return res.json({
				success: true,
				data: { period: unit, ends_at: ends.rows?.[0]?.ends_at, top: rows.slice(0, 50), me: mine, learners: rows.length },
			});
		} catch (error) {
			return fail(res, 'Load leaderboard', error);
		}
	});

	// ── Review ────────────────────────────────────────────────────────────
	router.get('/review/due', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 15));
		try {
			const premium = await isPremiumUser(database, userId, logger);
			const rows = await database('listening_reviews as r')
				.join('listening_clips as c', 'c.id', 'r.clip_id')
				.join('listening_lessons as l', 'l.id', 'c.lesson_id')
				.join('listening_skills as s', 's.id', 'l.skill_id')
				.join('listening_groups as g', 'g.id', 's.group_id')
				.leftJoin('source_videos as sv', 'sv.id', 'c.source_video_id')
				.select(
					'r.clip_id', 'r.box', 'r.due_at', 'c.step', 'c.challenge_mode', 'c.answer', 'c.transcript', 'c.start_time', 'c.end_time', 'c.playback_rate',
					'l.short_id', 'l.text', 's.name as skill_name', 'g.answer_mode',
					'sv.youtube_video_id', 'sv.title as video_title',
					database.raw('(l.is_premium OR s.is_premium OR g.is_premium) AS premium_content'),
				)
				.where('r.user_id', userId)
				.where('r.due_at', '<=', database.fn.now())
				.where('l.status', 'published')
				.whereNotNull('sv.youtube_video_id')
				.orderBy('r.due_at', 'asc')
				.limit(limit * 2);
			const items = rows
				.filter((r: any) => premium || !r.premium_content)
				.slice(0, limit)
				.map((r: any) => {
					const answer = answerOf(r, r.text, r.answer_mode === 'per_clip' ? 'per_clip' : 'one_answer');
					// The sentence around the answer, the answer itself hidden
					const bracket = String(r.transcript || '').match(/\[([^\]]+)\]/);
					const prompt = bracket && normalizeAnswer(bracket[1] || '') === normalizeAnswer(answer)
						? String(r.transcript).replace(/\[[^\]]+\]/, '_____').replace(/[[\]]/g, '')
						: null;
					return {
						clip_id: r.clip_id,
						box: r.box,
						lesson_short_id: r.short_id,
						skill_name: r.skill_name,
						youtube_video_id: r.youtube_video_id,
						video_title: r.video_title,
						start_time: Number(r.start_time) || 0,
						end_time: Number(r.end_time) || 0,
						rate: Number(r.playback_rate) || 1,
						prompt,
						words: answer.split(/\s+/).length,
					};
				});
			const total = await database('listening_reviews').where('user_id', userId).count('* as n').first();
			return res.json({ success: true, data: { items, total: Number(total?.n) || 0 } });
		} catch (error) {
			return fail(res, 'Load review', error);
		}
	});

	router.post('/review/:clipId', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		const clipId = String(req.params.clipId || '');
		if (!UUID_RE.test(clipId)) return res.status(400).json({ success: false, message: 'Invalid clip' });
		const given = String(req.body?.answer ?? '').slice(0, 255);
		const reveal = req.body?.reveal === true;
		try {
			const r = await database('listening_reviews as r')
				.join('listening_clips as c', 'c.id', 'r.clip_id')
				.join('listening_lessons as l', 'l.id', 'c.lesson_id')
				.join('listening_skills as s', 's.id', 'l.skill_id')
				.join('listening_groups as g', 'g.id', 's.group_id')
				.select('r.id', 'r.box', 'c.id as clip_id', 'c.step', 'c.challenge_mode', 'c.answer', 'c.transcript', 'l.id as lesson_id', 'l.text', 'g.answer_mode',
					database.raw('(l.is_premium OR s.is_premium OR g.is_premium) AS premium_content'))
				.where({ 'r.user_id': userId, 'r.clip_id': clipId })
				.first();
			if (!r) return res.status(404).json({ success: false, message: 'Not in your review list' });
			if (r.premium_content && !(await isPremiumUser(database, userId, logger))) {
				return res.status(403).json({ success: false, code: 'PREMIUM_REQUIRED' });
			}
			const answer = answerOf(r, r.text, r.answer_mode === 'per_clip' ? 'per_clip' : 'one_answer');
			const correct = !reveal && normalizeAnswer(given) === normalizeAnswer(answer);

			let box = r.box;
			let mastered = false;
			if (correct) {
				box = r.box + 1;
				mastered = box >= REVIEW_INTERVALS.length;
			} else {
				box = 0;
			}
			if (mastered) {
				await database('listening_reviews').where('id', r.id).delete();
			} else {
				await database('listening_reviews').where('id', r.id).update({
					box,
					due_at: database.raw(`now() + interval '${REVIEW_INTERVALS[box]} day'`),
					lapses: correct ? database.raw('lapses') : database.raw('lapses + 1'),
					last_reviewed_at: database.fn.now(),
				});
			}
			await database('listening_attempts').insert({
				id: database.raw('gen_random_uuid()'),
				user_id: userId,
				clip_id: r.clip_id,
				lesson_id: r.lesson_id,
				step: r.step,
				answer: reveal ? '[REVEALED]' : given,
				is_correct: correct,
				attempt_number: 1,
				listen_count: 1,
				mode: 'phrase',
				source: 'review',
				date_created: database.fn.now(),
			});
			return res.json({
				success: true,
				data: {
					correct,
					answer,
					transcript: String(r.transcript || '').replace(/[[\]]/g, '') || null,
					mastered,
					next_in_days: mastered ? null : REVIEW_INTERVALS[box] ?? null,
					xp: correct ? XP.review : 0,
				},
			});
		} catch (error) {
			return fail(res, 'Save review', error);
		}
	});

}
