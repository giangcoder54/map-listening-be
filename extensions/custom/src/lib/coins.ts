/**
 * Xu: the coins learners spend (database/migrations/2026-11-02_rule_flow.sql).
 *
 * XP is a score and never goes down; Xu is what is spent. Same shape as XP (lib/xp.ts):
 *   coin_events   one row per Xu won or spent, dedupe_key makes "once" rules a unique key
 *   user_xp.coins the balance, changed in the same transaction as its row, never summed
 *
 * Earning stops at COIN.cap: what the rule gave above it is written as `wanted` (0 added), so
 * the page can say "your purse is full". Spending locks the user_xp row first: two clicks on
 * "Unlock" never pay twice. Guests have no Xu.
 */
import { vnDay } from './days';

export const COIN = {
	cap: 500,
	/** trap: a trap clip answered right in a lesson or a review, once per clip a day (v1/runRoutes.ts) */
	earn: { lesson: 10, perfect: 5, goal: 10, review: 3, trap: 3 },
	/** Unlock a lesson for good, by lesson kind */
	unlock: { pattern: 150, trap: 150, mixed: 250 } as Record<string, number>,
	weeklyUnlocks: 2,
	freeze: 50,
	/** A rule's test is free once a day; another go the same day costs this */
	retest: 30,
};

export type CoinReason = 'lesson' | 'perfect' | 'goal' | 'streak' | 'review' | 'ad' | 'unlock' | 'premium_day' | 'freeze' | 'retest' | 'refund' | 'admin' | 'trap';
export class CoinError extends Error {
	constructor(public code: 'NOT_ENOUGH' | 'WEEKLY_LIMIT' | 'ALREADY' | 'MAX_FREEZES' | 'NOT_LOCKED') { super(code); }
}

/** The user_xp row, created if needed and locked for this transaction */
async function lockPurse(trx: any, userId: string) {
	await trx('user_xp').insert({ user_id: userId }).onConflict('user_id').ignore();
	return trx('user_xp').where('user_id', userId).forUpdate().first();
}

/**
 * Earn Xu once per dedupe key. Returns what was added (0 when the key was used before or the
 * purse is full) and what the rule gave. Pass a transaction to join the caller's.
 */
export async function earnCoins(
	db: any,
	userId: string,
	rule: { reason: CoinReason; amount: number; dedupe: string; lessonId?: string | null },
	today = vnDay(),
) {
	const run = async (trx: any) => {
		const purse = await lockPurse(trx, userId);
		const added = Math.max(0, Math.min(rule.amount, COIN.cap - (Number(purse.coins) || 0)));
		const row = await trx('coin_events')
			.insert({ user_id: userId, amount: added, wanted: rule.amount, reason: rule.reason, dedupe_key: rule.dedupe, lesson_id: rule.lessonId || null, day: today })
			.onConflict(['user_id', 'dedupe_key']).ignore()
			.returning('id');
		if (!row.length) return { added: 0, wanted: 0, coins: Number(purse.coins) || 0 };
		if (added) {
			await trx('user_xp').where('user_id', userId).update({
				coins: trx.raw('coins + ?', [added]),
				coins_earned_total: trx.raw('coins_earned_total + ?', [added]),
				date_updated: trx.fn.now(),
			});
		}
		return { added, wanted: rule.amount, coins: (Number(purse.coins) || 0) + added };
	};
	return db.isTransaction ? run(db) : db.transaction(run);
}

/** Spend Xu inside the caller's transaction (purse already locked by lockPurse or not) */
async function spend(trx: any, userId: string, price: number, reason: CoinReason, dedupe: string, lessonId: string | null, today: string) {
	const purse = await lockPurse(trx, userId);
	if ((Number(purse.coins) || 0) < price) throw new CoinError('NOT_ENOUGH');
	const row = await trx('coin_events')
		.insert({ user_id: userId, amount: -price, reason, dedupe_key: dedupe, lesson_id: lessonId, day: today })
		.onConflict(['user_id', 'dedupe_key']).ignore()
		.returning('id');
	if (!row.length) throw new CoinError('ALREADY');
	await trx('user_xp').where('user_id', userId).update({ coins: trx.raw('coins - ?', [price]), date_updated: trx.fn.now() });
	return { eventId: Number(row[0].id ?? row[0]), coins: (Number(purse.coins) || 0) - price };
}

/** Monday 00:00 (Vietnam) of this week, as a timestamp */
async function weekStart(db: any, today: string) {
	return (await db.raw(`SELECT (date_trunc('week', ?::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') AS t`, [today])).rows[0].t;
}

export async function unlocksThisWeek(db: any, userId: string, today = vnDay()) {
	const from = await weekStart(db, today);
	const row = await db('listening_unlocks').where('user_id', userId).where('source', 'coins').where('created_at', '>=', from).count('* as n').first();
	return Number(row?.n) || 0;
}

/** Buy a lesson for good. The caller checked it is locked for this learner. */
export async function unlockLesson(db: any, userId: string, lesson: { id: string; kind?: string | null }, today = vnDay()) {
	const price = COIN.unlock[lesson.kind || 'pattern'] ?? COIN.unlock.pattern!;
	return db.transaction(async (trx: any) => {
		await lockPurse(trx, userId);
		if (await trx('listening_unlocks').where({ user_id: userId, lesson_id: lesson.id }).first('lesson_id')) throw new CoinError('ALREADY');
		if ((await unlocksThisWeek(trx, userId, today)) >= COIN.weeklyUnlocks) throw new CoinError('WEEKLY_LIMIT');
		const paid = await spend(trx, userId, price, 'unlock', `unlock:${lesson.id}`, lesson.id, today);
		await trx('listening_unlocks').insert({ user_id: userId, lesson_id: lesson.id, source: 'coins', coin_event_id: paid.eventId });
		return { price, coins: paid.coins };
	});
}

/** Pay for another go at a rule's test today; `n` = goes already taken today (the key holds it) */
export async function payRetest(db: any, userId: string, skillId: string, n: number, today = vnDay()) {
	return db.transaction(async (trx: any) => {
		const paid = await spend(trx, userId, COIN.retest, 'retest', `retest:${skillId}:${today}:${n}`, null, today);
		return { coins: paid.coins };
	});
}

/** Buy a streak freeze (MAX_FREEZES held at most). The key holds the count: a double click buys one. */
export async function buyFreeze(db: any, userId: string, maxFreezes: number, today = vnDay()) {
	return db.transaction(async (trx: any) => {
		const purse = await lockPurse(trx, userId);
		const held = Number(purse.freezes) || 0;
		if (held >= maxFreezes) throw new CoinError('MAX_FREEZES');
		const total = (await trx('coin_events').where({ user_id: userId, reason: 'freeze' }).count('* as n').first())?.n;
		const paid = await spend(trx, userId, COIN.freeze, 'freeze', `freeze:${Number(total) + 1}`, null, today);
		await trx('user_xp').where('user_id', userId).update({ freezes: held + 1 });
		return { coins: paid.coins, freezes: held + 1 };
	});
}

export async function walletOf(db: any, userId: string, maxFreezes: number, today = vnDay()) {
	const [purse, week] = await Promise.all([
		db('user_xp').select('coins', 'freezes').where('user_id', userId).first(),
		unlocksThisWeek(db, userId, today),
	]);
	return {
		coins: Number(purse?.coins) || 0,
		cap: COIN.cap,
		freezes: Number(purse?.freezes) || 0,
		max_freezes: maxFreezes,
		unlocks_left: Math.max(0, COIN.weeklyUnlocks - week),
		weekly_unlocks: COIN.weeklyUnlocks,
		prices: { unlock: COIN.unlock, freeze: COIN.freeze },
	};
}
