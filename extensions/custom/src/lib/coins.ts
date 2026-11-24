/**
 * Kim cương (Gems, called Xu before 2026-11-21): the coins learners spend
 * (database/migrations/2026-11-02_rule_flow.sql, 2026-12-10_gems_v2_p0.sql).
 *
 * XP is a score and never goes down; Kim cương is what is spent. Same shape as XP (lib/xp.ts):
 *   coin_events   one row per Kim cương won or spent, dedupe_key makes "once" rules a unique key
 *   user_xp.coins the balance, changed in the same transaction as its row, never summed
 *   user_xp.coins_debt  what a chargeback could not take back; Kim cương earned later pay it first
 * The ledger rule, checked each night (checkLedger): sum(coin_events.amount) = coins - coins_debt.
 *
 * No cap on the purse and no daily limit on earning (docs/xu-economy-plan.md). Spending locks the
 * user_xp row first: two clicks on "Unlock" never pay twice. Guests have no Kim cương.
 * The numbers below are the defaults; growth_settings.coin_settings overrides them (applyCoinSettings).
 */
import { vnDay } from './days';

const DEFAULTS = {
	earn: {
		/** A lesson finished the first time, and without a miss; free lessons pay more than Premium ones: free is where Kim cương are earned */
		lesson: 70, lessonPremium: 30, perfect: 20, perfectPremium: 10,
		/** A lesson done again: the first go of the day, then a later one, at most `replayLaterMax` a day per lesson */
		replay: 6, replayLater: 2, replayLaterMax: 3,
		/** Share (%) of a run's answers right without a hint for its lesson Kim cương: a run clicked through on hints pays nothing */
		learnedPct: 50,
		review: 10,
		/** Trap right: the first time ever, then once a day per clip */
		trap: 5, trapAgain: 1,
		skillTest: 50,
	},
	/** Daily goal reached: Kim cương by the days in a row, and a one-off bonus at these lengths */
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
	/**
	 * Ngôi sao (lib/stars.ts): stars a run has, what a question is worth by its difficulty, and the
	 * share of that a choice or a word bank is worth (they are easier to hit by chance)
	 */
	star: { perRun: 2, easy: 5, medium: 10, hard: 15, pickPct: 50 },
	/** Cards (dare or truth): Kim cuong to leave a dare that is not done, and a truth answered right; the way back when the purse is low (hear `need` right in a free lesson, take `prize`) */
	card: { skip: 50, truthRight: 40 },
	recovery: { below: 20, need: 10, prize: 50 },
	/** Help hints: the helper reward when a hint is used, and the most such rewards a day */
	help: { reward: 8, perDay: 20 },
	/** Rooms: the default fee, the share the house keeps (never paid out), questions in a round */
	room: { fee: 20, rakePct: 10, questions: 5 },
	/** coop: deposit = Luyện cùng's deposit (given back when the room is finished, with the reward); duelSeconds = time to type the hidden phrase after the clip; duelLead = ms from "ready" to the clip playing on both screens */
	coop: { questions: 5, practiceQuestions: 3, reward: 10, perDay: 3, duelSeconds: 12, duelReveal: 5, deposit: 50, duelLead: 4000, readySeconds: 12 },
};
type CoinNumbers = typeof DEFAULTS;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** The numbers in use: the defaults with growth_settings.coin_settings on top. Read COIN.x at call time, never copy it at import. */
export const COIN: CoinNumbers = clone(DEFAULTS);

/** A whole number from 0 up, else null */
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : null);

/**
 * Lay the admin's overrides (growth_settings.coin_settings, an object or its JSON text) over the
 * defaults. Only known keys and whole numbers >= 0 are taken; anything else keeps the default, so a
 * typo in the admin never breaks earning or spending. Called by refreshGrowthConfig.
 */
export function applyCoinSettings(input: unknown) {
	let o: any = input;
	if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = null; } }
	const next = clone(DEFAULTS);
	if (o && typeof o === 'object' && !Array.isArray(o)) {
		for (const key of Object.keys(next) as (keyof CoinNumbers)[]) {
			const want = o[key];
			if (want === undefined || want === null) continue;
			const base: any = next[key];
			if (typeof base === 'number') {
				const n = count(want);
				if (n !== null) (next as any)[key] = n;
			} else if (Array.isArray(base)) {
				// streakDay: [{ from, xu }], longest streak first
				if (Array.isArray(want) && want.length && want.every((r: any) => count(r?.from) !== null && count(r?.xu) !== null)) {
					(next as any)[key] = want.map((r: any) => ({ from: r.from, xu: r.xu })).sort((a: any, b: any) => b.from - a.from);
				}
			} else if (typeof want === 'object' && !Array.isArray(want)) {
				// earn / unlock: known keys only; streakMilestone: any day count
				const free = key === 'streakMilestone';
				for (const k of Object.keys(want)) {
					const n = count(want[k]);
					if (n === null) continue;
					if (free ? count(Number(k)) !== null && Number(k) > 0 : k in base) base[k] = n;
				}
			}
		}
	}
	for (const key of Object.keys(COIN) as (keyof CoinNumbers)[]) delete (COIN as any)[key];
	Object.assign(COIN, next);
	return COIN;
}

/** Xu for a day with the goal reached, by the days in a row (today included) */
export const streakDayXu = (days: number) => COIN.streakDay.find((s) => days >= s.from)?.xu ?? 0;

export type CoinReason = 'lesson' | 'perfect' | 'goal' | 'streak' | 'review' | 'ad' | 'unlock' | 'premium_day' | 'freeze' | 'retest' | 'refund' | 'admin' | 'trap' | 'streak_milestone' | 'skill_test' | 'replay' | 'phrase_unlock' | 'ai' | 'challenge' | 'bank'
	// Kim cương v2 (2026-12-10_gems_v2_p0.sql)
	| 'star' | 'chest' | 'card' | 'card_skip' | 'recovery' | 'purchase' | 'chargeback' | 'room_fee' | 'room_prize' | 'help' | 'coop';
export class CoinError extends Error {
	constructor(public code: 'NOT_ENOUGH' | 'ALREADY' | 'MAX_FREEZES' | 'NOT_LOCKED') { super(code); }
}

/** The user_xp row, created if needed and locked for this transaction */
export async function lockPurse(trx: any, userId: string) {
	await trx('user_xp').insert({ user_id: userId }).onConflict('user_id').ignore();
	return trx('user_xp').where('user_id', userId).forUpdate().first();
}

/** Where a ledger row came from: { star_id }, { chest_open_id }, { card_draw_id }, { order_id }... */
export type CoinMeta = Record<string, string | number | boolean | null>;

/**
 * Earn Kim cương once per dedupe key. Returns what was added (0 when the key was used before) and
 * what the rule gave. A debt left by a chargeback is paid first: the row says the whole amount, the
 * purse gets what is left after the debt. Pass a transaction to join the caller's.
 */
export async function earnCoins(
	db: any,
	userId: string,
	rule: { reason: CoinReason; amount: number; dedupe: string; lessonId?: string | null; meta?: CoinMeta | null },
	today = vnDay(),
) {
	const run = async (trx: any) => {
		const purse = await lockPurse(trx, userId);
		const coins = Number(purse.coins) || 0;
		const debt = Number(purse.coins_debt) || 0;
		const added = Math.max(0, rule.amount);
		const repay = Math.min(debt, added);
		const after = coins + added - repay;
		const row = await trx('coin_events')
			.insert({
				user_id: userId, amount: added, wanted: rule.amount, reason: rule.reason, dedupe_key: rule.dedupe,
				lesson_id: rule.lessonId || null, day: today, meta: rule.meta ? JSON.stringify(rule.meta) : null, balance_after: after,
			})
			.onConflict(['user_id', 'dedupe_key']).ignore()
			.returning('id');
		if (!row.length) return { added: 0, wanted: 0, coins };
		if (added) {
			await trx('user_xp').where('user_id', userId).update({
				coins: after,
				coins_debt: debt - repay,
				coins_earned_total: trx.raw('coins_earned_total + ?', [added]),
				date_updated: trx.fn.now(),
			});
		}
		return { added, wanted: rule.amount, coins: after, eventId: Number(row[0].id ?? row[0]) };
	};
	return db.isTransaction ? run(db) : db.transaction(run);
}

/** Spend Kim cương inside the caller's transaction (purse already locked by lockPurse or not) */
export async function spend(trx: any, userId: string, price: number, reason: CoinReason, dedupe: string, lessonId: string | null, today: string, meta?: CoinMeta | null) {
	const purse = await lockPurse(trx, userId);
	const coins = Number(purse.coins) || 0;
	if (coins < price) throw new CoinError('NOT_ENOUGH');
	const row = await trx('coin_events')
		.insert({ user_id: userId, amount: -price, reason, dedupe_key: dedupe, lesson_id: lessonId, day: today, meta: meta ? JSON.stringify(meta) : null, balance_after: coins - price })
		.onConflict(['user_id', 'dedupe_key']).ignore()
		.returning('id');
	if (!row.length) throw new CoinError('ALREADY');
	await trx('user_xp').where('user_id', userId).update({ coins: trx.raw('coins - ?', [price]), date_updated: trx.fn.now() });
	return { eventId: Number(row[0].id ?? row[0]), coins: coins - price };
}

/**
 * Take back Kim cương (a refunded or charged-back purchase), once per key. The row says the whole
 * amount; what the purse cannot cover becomes coins_debt, paid by the next Kim cương earned.
 */
export async function takeBack(db: any, userId: string, amount: number, reason: Extract<CoinReason, 'chargeback' | 'admin'>, dedupe: string, meta?: CoinMeta | null, today = vnDay()) {
	const run = async (trx: any) => {
		const purse = await lockPurse(trx, userId);
		const coins = Number(purse.coins) || 0;
		const want = Math.max(0, Math.floor(amount));
		if (!want) return { taken: 0, debt: Number(purse.coins_debt) || 0, coins };
		const fromPurse = Math.min(coins, want);
		const row = await trx('coin_events')
			.insert({ user_id: userId, amount: -want, reason, dedupe_key: dedupe, day: today, meta: meta ? JSON.stringify(meta) : null, balance_after: coins - fromPurse })
			.onConflict(['user_id', 'dedupe_key']).ignore()
			.returning('id');
		if (!row.length) throw new CoinError('ALREADY');
		const debt = (Number(purse.coins_debt) || 0) + want - fromPurse;
		await trx('user_xp').where('user_id', userId).update({ coins: coins - fromPurse, coins_debt: debt, date_updated: trx.fn.now() });
		return { taken: want, debt, coins: coins - fromPurse };
	};
	return db.isTransaction ? run(db) : db.transaction(run);
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
	const purse = await db('user_xp').select('coins', 'coins_debt', 'freezes').where('user_id', userId).first();
	return {
		coins: Number(purse?.coins) || 0,
		debt: Number(purse?.coins_debt) || 0,
		freezes: Number(purse?.freezes) || 0,
		max_freezes: maxFreezes,
		prices: { unlock: COIN.unlock, freeze: COIN.freeze, phrase: COIN.phrase, ai_check: COIN.aiCheck },
	};
}
