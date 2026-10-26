/**
 * XP, streak, streak freezes and rewards (database/migrations/2026-10-26_xp_ledger.sql).
 *
 * Writes: recordPractice() is the only way XP and practice days get in, called by the lesson
 * attempt (a practice day, no XP), the lesson result (lessonXp) and the review. One transaction:
 *   1. streak freezes cover the days missed since the last practice, if there are enough
 *   2. the XP event (if a rule gives some): a repeat of the same dedupe key inserts nothing
 *   3. the day row: + XP, + attempts, today's daily goal
 *   4. lifetime XP; a freeze per 200 XP (2 held at most)
 *   5. the 7th daily goal in a row (14th, 21st...): a Premium day
 * Premium days are given after the commit (grantRewards): Directus' users service is not in
 * the transaction.
 *
 * Reads: engagementOf() for the header pill and the profile, a handful of small rows.
 *
 * Rules, by lesson whatever its number of clips (the profile explains them: engagement.howXp*):
 *   +20 a lesson finished the first time (step 1 all right), +10 if an answer was looked at,
 *   +5 a lesson already finished, done again (once a day per lesson), +5 a review right.
 *   Days are Vietnam days.
 */
import { activatePremiumForUser } from '../utils';

export const TZ = 'Asia/Ho_Chi_Minh';
export const XP = { lesson: 20, lessonRevealed: 10, replay: 5, review: 5 };
/** A streak freeze per this much lifetime XP (10 lessons), at most MAX_FREEZES held */
export const FREEZE_EVERY_XP = 200;
export const MAX_FREEZES = 2;
/** Daily goal reached this many days in a row: REWARD_PREMIUM_DAYS of Premium */
export const GOAL_DAYS_FOR_REWARD = 7;
export const REWARD_PREMIUM_DAYS = 1;
/** Lifetime XP where each level starts (level 1 at 0): about 3, 10, 20, 35, 55, 80, 120 lessons */
export const LEVELS = [0, 60, 200, 400, 700, 1100, 1600, 2400];
/** The daily goal of a learner who never chose one: 2 lessons */
export const DEFAULT_GOAL = 40;

/** amount: when the rule's XP depends on how it was won (a lesson with an answer looked at) */
export type XpRule = { reason: 'lesson' | 'replay' | 'review'; dedupe: string; lessonId?: string | null; amount?: number };
/** key: the user_rewards dedupe key (premium:<day> | freeze:<n>) */
export type NewReward = { kind: 'premium_day' | 'freeze'; days: number; key: string };

const AMOUNT: Record<XpRule['reason'], number> = { lesson: XP.lesson, replay: XP.replay, review: XP.review };

/** 'YYYY-MM-DD' in Vietnam */
export const vnDay = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(date);
const addDays = (day: string, n: number) => {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
};
const dayOf = (v: any) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
/** Monday of the week of `day` (weeks start on Monday, like date_trunc('week')) */
const mondayOf = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

export function levelOf(total: number) {
	let i = 0;
	while (i + 1 < LEVELS.length && total >= LEVELS[i + 1]!) i++;
	return { level: i + 1, from: LEVELS[i]!, to: LEVELS[i + 1] ?? null };
}

/**
 * Freezes cover the days missed between the last practice and yesterday, all of them or none
 * (not enough freezes: the streak is broken, nothing is spent). Needs the user_xp row locked.
 */
async function settleFreezes(trx: any, userId: string, today: string, freezes: number) {
	if (freezes <= 0) return freezes;
	const last = await trx('user_daily_stats').where('user_id', userId).where('day', '<', today).max('day as d').first();
	if (!last?.d) return freezes;
	const missed: string[] = [];
	for (let d = addDays(dayOf(last.d), 1); d < today; d = addDays(d, 1)) missed.push(d);
	if (!missed.length || missed.length > freezes) return freezes;
	await trx('user_daily_stats')
		.insert(missed.map((day) => ({ user_id: userId, day, frozen: true })))
		.onConflict(['user_id', 'day']).ignore();
	await trx('user_xp').where('user_id', userId).update({ freezes: freezes - missed.length, date_updated: trx.fn.now() });
	return freezes - missed.length;
}

/** The user_xp row, created if needed and locked for this transaction */
async function lockUserXp(trx: any, userId: string) {
	await trx('user_xp').insert({ user_id: userId }).onConflict('user_id').ignore();
	return trx('user_xp').where('user_id', userId).forUpdate().first();
}

/** Days in a row up to `today` (or up to yesterday while today is not done) where `ok` holds */
function runOf(days: { day: string; ok: boolean }[], today: string) {
	const ok = new Set(days.filter((d) => d.ok).map((d) => d.day));
	let d = ok.has(today) ? today : addDays(today, -1);
	let n = 0;
	while (ok.has(d)) { n++; d = addDays(d, -1); }
	return n;
}

/**
 * A practice by a signed-in learner: `attempts` answers (0 for the lesson bonus) and, when a
 * rule gives some, its XP. Returns the XP actually won (0 for a repeat) and new rewards.
 * `today` is only passed by the tests (test/xp.test.ts), to play several days.
 */
export async function recordPractice(database: any, userId: string, opts: { attempts?: number; xp?: XpRule | null }, today = vnDay()) {
	return database.transaction(async (trx: any) => {
		const acc = await lockUserXp(trx, userId);
		await settleFreezes(trx, userId, today, Number(acc.freezes) || 0);

		let won = 0;
		if (opts.xp) {
			const amount = opts.xp.amount ?? AMOUNT[opts.xp.reason];
			const row = await trx('xp_events')
				.insert({ user_id: userId, reason: opts.xp.reason, amount, dedupe_key: opts.xp.dedupe, day: today, lesson_id: opts.xp.lessonId || null })
				.onConflict(['user_id', 'dedupe_key']).ignore()
				.returning('id');
			if (row.length) won = amount;
		}

		const user = await trx('directus_users').select('daily_goal').where('id', userId).first();
		const goal = Number(user?.daily_goal) || DEFAULT_GOAL;
		const before = await trx('user_daily_stats').select('xp').where({ user_id: userId, day: today }).first();
		await trx.raw(`
			INSERT INTO user_daily_stats (user_id, day, xp, attempts, goal) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (user_id, day) DO UPDATE SET
				xp = user_daily_stats.xp + EXCLUDED.xp,
				attempts = user_daily_stats.attempts + EXCLUDED.attempts,
				goal = EXCLUDED.goal
		`, [userId, today, won, opts.attempts || 0, goal]);

		const rewards: NewReward[] = [];
		if (won) {
			// Lifetime XP, and a freeze for each 500 reached
			const total = (Number(acc.xp_total) || 0) + won;
			const blocks = Math.floor(total / FREEZE_EVERY_XP);
			const fresh = await trx('user_xp').select('freezes', 'freezes_awarded').where('user_id', userId).first();
			const newBlocks = blocks - (Number(fresh.freezes_awarded) || 0);
			const patch: Record<string, any> = { xp_total: total, date_updated: trx.fn.now() };
			if (newBlocks > 0) {
				patch.freezes_awarded = blocks;
				patch.freezes = Math.min(MAX_FREEZES, (Number(fresh.freezes) || 0) + newBlocks);
				if (patch.freezes > (Number(fresh.freezes) || 0)) {
					await trx('user_rewards').insert({ user_id: userId, kind: 'freeze', dedupe_key: `freeze:${blocks}` }).onConflict(['user_id', 'dedupe_key']).ignore();
					rewards.push({ kind: 'freeze', days: 0, key: `freeze:${blocks}` });
				}
			}
			await trx('user_xp').where('user_id', userId).update(patch);

			// Today's goal just reached: the 7th (14th...) goal day in a row gives a Premium day
			const xpBefore = Number(before?.xp) || 0;
			if (xpBefore < goal && xpBefore + won >= goal) {
				const days = await trx('user_daily_stats').select('day', 'xp', 'goal').where('user_id', userId)
					.where('day', '>', addDays(today, -400)).orderBy('day', 'desc');
				const run = runOf(days.map((d: any) => ({ day: dayOf(d.day), ok: d.xp >= d.goal })), today);
				if (run > 0 && run % GOAL_DAYS_FOR_REWARD === 0) {
					const added = await trx('user_rewards')
						.insert({ user_id: userId, kind: 'premium_day', dedupe_key: `premium:${today}`, days: REWARD_PREMIUM_DAYS })
						.onConflict(['user_id', 'dedupe_key']).ignore()
						.returning('id');
					if (added.length) rewards.push({ kind: 'premium_day', days: REWARD_PREMIUM_DAYS, key: `premium:${today}` });
				}
			}
		}
		return { xp: won, rewards };
	});
}

/**
 * Premium days won (after recordPractice committed): added to the end of their current
 * Premium, or from now. A lifetime member has nothing to add: the reward stays at 0 days.
 */
export async function grantRewards(context: any, schema: any, userId: string, rewards: NewReward[]) {
	const won = rewards.filter((r) => r.kind === 'premium_day');
	const days = won.reduce((n, r) => n + r.days, 0);
	if (!days) return;
	const { database, logger, services } = context;
	try {
		const u = await database('directus_users').select('is_premium', 'premium_until', 'subscription_type').where('id', userId).first();
		if (!u) return;
		if (u.is_premium && (u.subscription_type === 'lifetime' || !u.premium_until)) {
			await database('user_rewards').where({ user_id: userId, kind: 'premium_day' }).whereIn('dedupe_key', won.map((r) => r.key)).update({ days: 0 });
			return;
		}
		const current = u.is_premium && u.premium_until ? new Date(u.premium_until) : null;
		const from = current && current.getTime() > Date.now() ? current : new Date();
		const end = new Date(from.getTime() + days * 86400_000).toISOString();
		const usersService = new services.UsersService({ schema, accountability: { admin: true } });
		await activatePremiumForUser(userId, end, u.subscription_type || 'premium', usersService, database, logger);
		logger?.info?.(`[xp] ${userId} won ${days} Premium day(s) for ${GOAL_DAYS_FOR_REWARD} goal days in a row`);
	} catch (error) {
		logger?.error?.(`[xp] Premium reward for ${userId} not given: ${String(error)}`);
	}
}

/** Header pill and profile: today, this week, streak, level, freezes, rewards not shown yet */
export async function engagementOf(database: any, userId: string, today = vnDay()) {
	// Missed days a freeze can cover are covered on the first look too, not only on the next answer
	const acc = await database.transaction(async (trx: any) => {
		const row = await lockUserXp(trx, userId);
		const freezes = await settleFreezes(trx, userId, today, Number(row.freezes) || 0);
		return { ...row, freezes };
	});
	const weekStart = mondayOf(today);
	const [days, user, rewards] = await Promise.all([
		database('user_daily_stats').select('day', 'xp', 'attempts', 'goal', 'frozen').where('user_id', userId)
			.where('day', '>', addDays(today, -400)).orderBy('day', 'desc'),
		database('directus_users').select('daily_goal').where('id', userId).first(),
		database('user_rewards').select('id', 'kind', 'days').where('user_id', userId).whereNull('seen_at').orderBy('id'),
	]);
	const rows = days.map((d: any) => ({ ...d, day: dayOf(d.day) }));
	const todayRow = rows.find((d: any) => d.day === today);
	const goal = Number(user?.daily_goal) || DEFAULT_GOAL;
	const xpToday = Number(todayRow?.xp) || 0;
	// Past days keep the goal they had; today's is the one set now (it may have just changed)
	const goalRun = runOf(rows.map((d: any) => ({ day: d.day, ok: d.xp >= (d.day === today ? goal : d.goal) })), today);
	return {
		xp_today: xpToday,
		xp_week: rows.filter((d: any) => d.day >= weekStart && d.day <= today).reduce((n: number, d: any) => n + d.xp, 0),
		daily_goal: goal,
		streak: runOf(rows.map((d: any) => ({ day: d.day, ok: d.attempts > 0 || d.frozen })), today),
		practiced_today: (Number(todayRow?.attempts) || 0) > 0,
		xp_total: Number(acc.xp_total) || 0,
		...levelOf(Number(acc.xp_total) || 0),
		// Where every level starts: the profile's badges
		levels: LEVELS,
		freezes: acc.freezes,
		max_freezes: MAX_FREEZES,
		freeze_every: FREEZE_EVERY_XP,
		// Days in a row with the daily goal reached (today counts once reached)
		goal_days: goalRun,
		goal_met_today: xpToday >= goal,
		reward_every: GOAL_DAYS_FOR_REWARD,
		rewards_new: rewards.map((r: any) => ({ id: Number(r.id), kind: r.kind, days: r.days })),
	};
}

/**
 * The result card of a lesson (POST /listening-lab/lessons/:key/progress), once the server
 * found step 1 all right:
 *   - first time: +20, or +10 if an answer of step 1 was looked at ("Show answer")
 *   - finished on an earlier day: +5, once a day, and only when step 1 was answered right
 *     again today (calling the endpoint alone gives nothing; nor does a second go the same day)
 * kind: what the XP was for, null when nothing was won (already counted today).
 */
export async function lessonXp(database: any, userId: string, lessonId: string, today = vnDay()) {
	const step1 = database('listening_clips').select('id').where({ lesson_id: lessonId, step: 'type' });
	const revealed = await database('listening_attempts')
		.where({ user_id: userId, answer: '[REVEALED]' }).whereIn('clip_id', step1).first('id');
	const first = await recordPractice(database, userId, {
		xp: { reason: 'lesson', dedupe: `lesson:${lessonId}`, lessonId, amount: revealed ? XP.lessonRevealed : XP.lesson },
	}, today);
	if (first.xp) return { ...first, kind: revealed ? 'revealed' as const : 'new' as const };

	const none = { xp: 0, rewards: [] as NewReward[], kind: null };
	const firstDone = await database('xp_events').where({ user_id: userId, dedupe_key: `lesson:${lessonId}` }).first('day');
	if (!firstDone || dayOf(firstDone.day) >= today) return none;
	const dayStart = (await database.raw(`SELECT (?::date::timestamp AT TIME ZONE '${TZ}') AS t`, [today])).rows[0].t;
	const notToday = await database('listening_clips as c')
		.where({ 'c.lesson_id': lessonId, 'c.step': 'type' })
		.whereNotExists(database('listening_attempts as a').whereRaw('a.clip_id = c.id')
			.where({ 'a.user_id': userId, 'a.is_correct': true }).where('a.date_created', '>=', dayStart))
		.first('c.id');
	if (notToday) return none;
	const again = await recordPractice(database, userId, { xp: { reason: 'replay', dedupe: `replay:${lessonId}:${today}`, lessonId } }, today);
	return { ...again, kind: again.xp ? 'replay' as const : null };
}
