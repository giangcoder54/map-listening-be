/**
 * Daily goal, XP, streak, leaderboard and spaced review.
 *
 *   GET   /me/engagement          XP today / this week, daily goal, streak, level, freezes,
 *                                 goal days in a row, rewards not shown yet, reviews due
 *   POST  /me/rewards/seen        { ids } the rewards were shown to the learner
 *   GET   /me/settings            daily goal, hidden from the leaderboard, learning goal,
 *                                 practice (how steps 2 and 3 are played, lib/lessons.ts PRACTICE)
 *   PATCH /me/settings            (learning goal: the one-question survey after sign-in)
 *   GET   /leaderboard            ?period=week|month: top learners by XP (+ my rank)
 *   GET   /review/due             clips to review now (answer hidden)
 *   POST  /review/:clipId         { answer } -> right or wrong, next date
 *
 * XP, streak, freezes and rewards: lib/xp.ts (rules, the ledger, the reads). Days are Vietnam days.
 */
import { PRACTICE, UUID_RE, answerOf, practicePrefsOf } from '../lib/lessons';
import { isPremiumUser } from '../lib/premium';
import { DEFAULT_GOAL, TZ, XP, engagementOf, grantRewards, recordPractice } from '../lib/xp';

export { TZ, XP };
/** Days until the next review, by box (0 = just missed) */
export const REVIEW_INTERVALS = [1, 3, 7, 14, 30];
/** Why they practise, one or more, no skip (2026-10-21_learning_goal.sql) */
export const LEARNING_GOALS = ['exam', 'movies', 'work', 'general', 'other'];

/** Same normalisation as the lesson player (listening-lab/[id].vue) */
export const normalizeAnswer = (text: string) =>
	String(text || '').toLowerCase().replace(/[^\w\s']/g, '').replace(/\s+/g, ' ').trim();

const periodStart = (unit: 'week' | 'month') => `date_trunc('${unit}', now() AT TIME ZONE '${TZ}')::date`;

/** Ranked learners of a period, kept 2 minutes: the board is read far more than it changes */
const LEADERBOARD_TTL_MS = 120_000;
const leaderboardCache = new Map<string, { at: number; rows: { user_id: string; xp: number }[] }>();

/** First name + initial of the last name: what other learners see */
/** Name on the leaderboard: first and last name in full ("Giang Nguyễn Thế Trường") */
export const publicName = (first?: string | null, last?: string | null) =>
	[first, last].map((p) => String(p || '').trim()).filter(Boolean).join(' ') || 'Learner';

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
	const { database, logger, services } = context;
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
			const [engagement, due] = await Promise.all([
				engagementOf(database, userId),
				database('listening_reviews').where('user_id', userId).where('due_at', '<=', database.fn.now()).count('* as n').first(),
			]);
			return res.json({ success: true, data: { ...engagement, reviews_due: Number(due?.n) || 0 } });
		} catch (error) {
			return fail(res, 'Load engagement', error);
		}
	});

	router.post('/me/rewards/seen', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 50) : [];
		if (!ids.length) return res.status(400).json({ success: false, message: 'Which rewards?' });
		try {
			await database('user_rewards').where('user_id', userId).whereIn('id', ids).whereNull('seen_at').update({ seen_at: database.fn.now() });
			return res.json({ success: true });
		} catch (error) {
			return fail(res, 'Save rewards seen', error);
		}
	});

	router.get('/me/settings', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		try {
			const row = await database('directus_users').select('daily_goal', 'leaderboard_hidden', 'learning_goals', 'practice_prefs').where('id', userId).first();
			return res.json({
				success: true,
				data: {
					daily_goal: Number(row?.daily_goal) || DEFAULT_GOAL,
					leaderboard_hidden: !!row?.leaderboard_hidden,
					learning_goals: Array.isArray(row?.learning_goals) ? row.learning_goals : null,
					/** null: never set, the page keeps what this browser has */
					practice: row?.practice_prefs ? practicePrefsOf(row.practice_prefs) : null,
				},
			});
		} catch (error) {
			return fail(res, 'Load settings', error);
		}
	});

	// body: { daily_goal?: 20..500, leaderboard_hidden?: boolean, learning_goals?: LEARNING_GOALS[] (1+), learning_goal_other?: string,
	//         practice?: { voice?: 'type' | 'listen', challenge?: 'easy' | 'medium' | 'hard' } }
	router.patch('/me/settings', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		const body = req.body || {};
		const patch: Record<string, any> = {};
		let goals: { learning_goals: string[]; learning_goal_other: string | null; learning_goal_at: string } | null = null;
		if (body.daily_goal !== undefined) {
			const goal = Math.round(Number(body.daily_goal));
			if (!Number.isFinite(goal) || goal < 20 || goal > 500) return res.status(400).json({ success: false, message: 'Daily goal must be 20-500 XP' });
			patch.daily_goal = goal;
		}
		if (body.leaderboard_hidden !== undefined) patch.leaderboard_hidden = body.leaderboard_hidden === true;
		if (body.practice !== undefined) {
			const p = body.practice || {};
			if ((p.voice !== undefined && !(PRACTICE.voice as readonly string[]).includes(p.voice))
				|| (p.challenge !== undefined && !(PRACTICE.challenge as readonly string[]).includes(p.challenge))) {
				return res.status(400).json({ success: false, message: 'Invalid practice settings' });
			}
			// One field at a time: the other one keeps what was saved
			const row = await database('directus_users').select('practice_prefs').where('id', userId).first().catch(() => null);
			patch.practice_prefs = JSON.stringify(practicePrefsOf({ ...practicePrefsOf(row?.practice_prefs), ...p }));
		}
		if (body.learning_goals !== undefined) {
			const list = Array.isArray(body.learning_goals) ? [...new Set(body.learning_goals.map(String))] : [];
			if (!list.length || !list.every((g) => LEARNING_GOALS.includes(g))) {
				return res.status(400).json({ success: false, message: 'Invalid learning goals' });
			}
			goals = {
				learning_goals: list,
				learning_goal_other: list.includes('other') && typeof body.learning_goal_other === 'string'
					? body.learning_goal_other.trim().slice(0, 500) || null
					: null,
				learning_goal_at: new Date().toISOString(),
			};
		}
		if (!Object.keys(patch).length && !goals) return res.status(400).json({ success: false, message: 'Nothing to update' });
		try {
			if (Object.keys(patch).length) await database('directus_users').where('id', userId).update(patch);
			// The site reads learning_goals from users/me, which Directus caches: write it through
			// the users service so that cache is cleared (a plain update leaves the old answer there)
			if (goals) {
				const users = new services.UsersService({ schema: req.schema, accountability: { admin: true } });
				await users.updateOne(userId, goals);
			}
			return res.json({ success: true, data: goals ? { ...patch, learning_goals: goals.learning_goals } : patch });
		} catch (error) {
			return fail(res, 'Save settings', error);
		}
	});

	// ── Leaderboard ───────────────────────────────────────────────────────
	router.get('/leaderboard', async (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		const unit = req.query.period === 'month' ? 'month' : 'week';
		try {
			let cached = leaderboardCache.get(unit);
			if (!cached || Date.now() - cached.at > LEADERBOARD_TTL_MS) {
				const sums = await database.raw(`
					SELECT user_id, sum(xp)::int AS xp FROM user_daily_stats
					WHERE day >= ${periodStart(unit)} GROUP BY user_id HAVING sum(xp) > 0 ORDER BY xp DESC
				`);
				cached = { at: Date.now(), rows: (sums.rows || []).map((r: any) => ({ user_id: r.user_id, xp: Number(r.xp) || 0 })) };
				leaderboardCache.set(unit, cached);
			}
			const ranked = cached.rows;
			const ids = ranked.map((r: any) => r.user_id);
			const users = ids.length
				? await database('directus_users').select('id', 'first_name', 'last_name', 'avatar', 'avatar_url', 'leaderboard_hidden', 'status').whereIn('id', ids)
				: [];
			const byId = new Map(users.map((u: any) => [u.id, u]));
			const visible = ranked.filter((r: any) => {
				const u: any = byId.get(r.user_id);
				return u && u.status === 'active' && (!u.leaderboard_hidden || r.user_id === userId);
			});
			const rows = visible.map((r: any, i: number) => {
				const u: any = byId.get(r.user_id);
				return {
					rank: i + 1,
					name: publicName(u.first_name, u.last_name),
					// An uploaded avatar (file id) first, else their Google picture (a link)
					avatar: u.avatar || null,
					avatar_url: u.avatar ? null : u.avatar_url || null,
					xp: r.xp,
					me: r.user_id === userId,
				};
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
			const [attempt] = await database('listening_attempts').insert({
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
			}).returning('id');
			const won = await recordPractice(database, userId, {
				attempts: 1,
				xp: correct ? { reason: 'review', dedupe: `review:${attempt.id}`, lessonId: r.lesson_id } : null,
			});
			await grantRewards(context, req.schema, userId, won.rewards);
			return res.json({
				success: true,
				data: {
					correct,
					answer,
					transcript: String(r.transcript || '').replace(/[[\]]/g, '') || null,
					mastered,
					next_in_days: mastered ? null : REVIEW_INTERVALS[box] ?? null,
					xp: won.xp,
					rewards: won.rewards,
				},
			});
		} catch (error) {
			return fail(res, 'Save review', error);
		}
	});

}
