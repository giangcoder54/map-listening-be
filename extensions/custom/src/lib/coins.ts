/**
 * Xu: the coins learners spend (database/migrations/2026-11-02_rule_flow.sql).
 *
 * XP is a score and never goes down; Xu is what is spent. Same shape as XP (lib/xp.ts):
 *   coin_events   one row per Xu won or spent, dedupe_key makes "once" rules a unique key
 *   user_xp.coins the balance, changed in the same transaction as its row, never summed
 *
 * No cap on the purse and no daily limit on earning (docs/xu-economy-plan.md). Spending locks the
 * user_xp row first: two clicks on "Unlock" never pay twice. Guests have no Xu.
 */
import { vnDay } from './days';

export const COIN = {
	earn: {
		/** A lesson finished the first time, and without a miss; free lessons pay more than Premium ones: free is where Xu are earned */
		lesson: 70, lessonPremium: 30, perfect: 20, perfectPremium: 10,
		/** A lesson done again: the first go of the day, then every later one (a day, per lesson) */
		replay: 6, replayLater: 2,
		review: 10,
		/** Trap right: the first time ever, then once a day per clip */
		trap: 5, trapAgain: 1,
		skillTest: 50,
	},
	/** Daily goal reached: Xu by the days in a row, and a one-off bonus at these lengths */
	streakDay: [{ from: 30, xu: 20 }, { from: 7, xu: 15 }, { from: 1, xu: 10 }],
	streakMilestone: { 7: 50, 30: 200, 100: 500, 365: 1500 } as Record<number, number>,
	/** Unlock a lesson for good, by lesson kind */
	unlock: { pattern: 100, trap: 100, mixed: 150 } as Record<string, number>,
	/** Unlock a Phrase Lab phrase for good; it covers the phrase's AI checks */
	phrase: 25,
	/** A free phrase's AI check beyond the free ones of the day */
	aiCheck: 5,
	aiFreePerDay: 3,
	/** A bought phrase or Premium: AI checks a day per phrase */
	aiPerPhrasePerDay: 20,
	freeze: 50,
	/** A rule's test is free once a day; another go the same day costs this */
	retest: 30,
};

/** Xu for a day with the goal reached, by the days in a row (today included) */
export const streakDayXu = (days: number) => COIN.streakDay.find((s) => days >= s.from)?.xu ?? 0;

export type CoinReason = 'lesson' | 'perfect' | 'goal' | 'streak' | 'review' | 'ad' | 'unlock' | 'premium_day' | 'freeze' | 'retest' | 'refund' | 'admin' | 'trap' | 'streak_milestone' | 'skill_test' | 'replay' | 'phrase_unlock' | 'ai' | 'challenge' | 'bank';
export class CoinError extends Error {
	constructor(public code: 'NOT_ENOUGH' | 'ALREADY' | 'MAX_FREEZES' | 'NOT_LOCKED') { super(code); }
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
		const added = Math.max(0, rule.amount);
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
export async function spend(trx: any, userId: string, price: number, reason: CoinReason, dedupe: string, lessonId: string | null, today: string) {
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

/** Buy a lesson for good. The caller checked it is locked for this learner. */
export async function unlockLesson(db: any, userId: string, lesson: { id: string; kind?: string | null }, today = vnDay()) {
	const price = COIN.unlock[lesson.kind || 'pattern'] ?? COIN.unlock.pattern!;
	return db.transaction(async (trx: any) => {
		await lockPurse(trx, userId);
		if (await trx('listening_unlocks').where({ user_id: userId, lesson_id: lesson.id }).first('lesson_id')) throw new CoinError('ALREADY');
		const paid = await spend(trx, userId, price, 'unlock', `unlock:${lesson.id}`, lesson.id, today);
		await trx('listening_unlocks').insert({ user_id: userId, lesson_id: lesson.id, source: 'coins', coin_event_id: paid.eventId });
		return { price, coins: paid.coins };
	});
}

/** Open a weekly challenge round for good (lib/challenges.ts priceOf), kept with the lessons bought */
export async function unlockChallenge(db: any, userId: string, lessonId: string, price: number, today = vnDay()) {
	return db.transaction(async (trx: any) => {
		await lockPurse(trx, userId);
		if (await trx('listening_unlocks').where({ user_id: userId, lesson_id: lessonId }).first('lesson_id')) throw new CoinError('ALREADY');
		const paid = await spend(trx, userId, price, 'unlock', `unlock:${lessonId}`, lessonId, today);
		await trx('listening_unlocks').insert({ user_id: userId, lesson_id: lessonId, source: 'coins', coin_event_id: paid.eventId });
		return { price, coins: paid.coins };
	});
}

/** Open a Premium bank video for good (lib/bank.ts bankPrice) */
export async function unlockBankVideo(db: any, userId: string, practiceId: string, price: number, today = vnDay()) {
	return db.transaction(async (trx: any) => {
		await lockPurse(trx, userId);
		if (await trx('practice_video_unlocks').where({ user_id: userId, practice_id: practiceId }).first('practice_id')) throw new CoinError('ALREADY');
		const paid = await spend(trx, userId, price, 'unlock', `unlock:bank:${practiceId}`, null, today);
		await trx('practice_video_unlocks').insert({ user_id: userId, practice_id: practiceId, source: 'coins', coin_event_id: paid.eventId });
		return { price, coins: paid.coins };
	});
}

/** Buy a Phrase Lab phrase for good (covers its AI checks) */
export async function unlockPhrase(db: any, userId: string, phraseId: string, today = vnDay()) {
	return db.transaction(async (trx: any) => {
		await lockPurse(trx, userId);
		if (await trx('phrase_unlocks').where({ user_id: userId, phrase_id: phraseId }).first('phrase_id')) throw new CoinError('ALREADY');
		const paid = await spend(trx, userId, COIN.phrase, 'phrase_unlock', `phrase_unlock:${phraseId}`, null, today);
		await trx('phrase_unlocks').insert({ user_id: userId, phrase_id: phraseId, source: 'coins', coin_event_id: paid.eventId });
		return { price: COIN.phrase, coins: paid.coins };
	});
}

/** Pay for one AI check of a free phrase; `key` is unique per check, so a retry never pays twice */
export async function payAiCheck(db: any, userId: string, key: string, today = vnDay()) {
	return db.transaction(async (trx: any) => {
		const paid = await spend(trx, userId, COIN.aiCheck, 'ai', `ai:${key}`, null, today);
		return { coins: paid.coins };
	});
}

/** The AI did not answer: give the check's Xu back (once) */
export async function refundAiCheck(db: any, userId: string, key: string, today = vnDay()) {
	return earnCoins(db, userId, { reason: 'refund', amount: COIN.aiCheck, dedupe: `refund:ai:${key}` }, today);
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

export async function walletOf(db: any, userId: string, maxFreezes: number) {
	const purse = await db('user_xp').select('coins', 'freezes').where('user_id', userId).first();
	return {
		coins: Number(purse?.coins) || 0,
		freezes: Number(purse?.freezes) || 0,
		max_freezes: maxFreezes,
		prices: { unlock: COIN.unlock, freeze: COIN.freeze, phrase: COIN.phrase, ai_check: COIN.aiCheck },
	};
}
