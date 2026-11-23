/**
 * NgÃ´i sao (stars): a bet on a question of a lesson run (web repo docs/xu-ngoi-sao-spec.md F2).
 *
 * Before answering, a learner may put a star on the question. Right: win its value. Wrong: lose its
 * value. A hint taken: the star is void, nothing won or lost. A starred question gets one try (no
 * hearts), so the bet is on the first answer. Each run has `COIN.star.perRun` stars, and a question
 * (clip) takes a star once per learner, ever (star_uses, unique user + clip).
 *
 * The pure rules (starValue, starCheck) are tested without a database; playStar writes the
 * ledger through lib/coins.ts inside the caller's transaction (the answer route's, run row locked).
 */
import { COIN, earnCoins, lockPurse, spend } from './coins';

/** Runs that can carry a star: a challenge or a bank run says nothing until its end, so no bet there */
/** A gold star (Ngôi sao vàng, an item) pays this many times when the answer is right */
export const GOLD_MULT = 3;

export const STAR_MODES = ['learn', 'lesson_test', 'skill_test', 'review'];
/** Items that can: not the first listen before the explanation ('pre', a guess) and not a retry (the answer was just shown) */
export const STAR_PHASES = ['voice', 'practice', 'challenge', 'post', 'test', 'review'];

/**
 * What a question is worth, from the clip's difficulty (1 easy, 2 medium, 3 hard; none = medium).
 * A choice or a word bank is easier to hit by chance: worth `pickPct` % of that.
 */
export function starValue(difficulty: number | null | undefined, format: string, rules = COIN.star) {
	const base = difficulty === 1 ? rules.easy : difficulty === 3 ? rules.hard : rules.medium;
	const pick = format === 'choice' || format === 'bank' || format === 'tap';
	return Math.max(1, Math.round(pick ? (base * rules.pickPct) / 100 : base));
}

export type StarRefusal = 'STARS_OFF' | 'STAR_GUEST' | 'STAR_MODE' | 'STAR_PHASE' | 'STAR_LATE' | 'STAR_NONE_LEFT';

/** May this item take a star now (everything but the purse and the once-per-clip key, checked in playStar)? */
export function starCheck(a: { on: boolean; userId: string | null; mode: string; phase: string; tries: number; used: number; perRun?: number }): { ok: true } | { ok: false; code: StarRefusal } {
	if (!a.on) return { ok: false, code: 'STARS_OFF' };
	if (!a.userId) return { ok: false, code: 'STAR_GUEST' };
	if (!STAR_MODES.includes(a.mode)) return { ok: false, code: 'STAR_MODE' };
	if (!STAR_PHASES.includes(a.phase)) return { ok: false, code: 'STAR_PHASE' };
	// A second try at a typed item: the answer of the first was already judged
	if (a.tries > 0) return { ok: false, code: 'STAR_LATE' };
	if (a.used >= (a.perRun ?? COIN.star.perRun)) return { ok: false, code: 'STAR_NONE_LEFT' };
	return { ok: true };
}

export type StarResult = { used: true; outcome: 'right' | 'wrong' | 'void'; value: number; delta: number; balance: number; stars_left: number };

/** Stars a run has used */
export async function starsUsed(db: any, runId: string) {
	const row = await db('star_uses').where('run_id', runId).count('* as n').first();
	return Number(row?.n) || 0;
}

/** Is there Kim cÆ°Æ¡ng to lose? (locks the purse for the rest of the transaction) */
export async function canAfford(trx: any, userId: string, value: number) {
	const purse = await lockPurse(trx, userId);
	return (Number(purse.coins) || 0) >= value;
}

/**
 * Settle a star once the answer is judged: one star_uses row, one ledger row (none when void).
 * Returns null when the question already took a star (the unique key): nothing is paid twice.
 */
export async function playStar(trx: any, userId: string, a: { runId: string; clipId: string; lessonId: string | null; value: number; correct: boolean; hint: boolean; today: string; perRun?: number; kind?: 'normal' | 'gold'; shielded?: boolean }): Promise<(StarResult & { shield_used: boolean }) | null> {
	// A gold star pays GOLD_MULT times when right; a shield turns a miss into nothing (the caller uses the item up)
	const mult = a.kind === 'gold' ? GOLD_MULT : 1;
	const shieldUsed = !!a.shielded && !a.hint && !a.correct;
	const outcome: StarResult['outcome'] = a.hint || shieldUsed ? 'void' : a.correct ? 'right' : 'wrong';
	const delta = outcome === 'right' ? a.value * mult : outcome === 'wrong' ? -a.value : 0;
	const row = await trx('star_uses')
		.insert({ user_id: userId, run_id: a.runId, clip_id: a.clipId, lesson_id: a.lessonId, kind: a.kind || 'normal', value: a.value, outcome, delta, shielded: shieldUsed })
		.onConflict(['user_id', 'clip_id']).ignore()
		.returning('id');
	if (!row.length) return null;
	const starId = Number(row[0].id ?? row[0]);
	let balance = Number((await lockPurse(trx, userId)).coins) || 0;
	if (outcome !== 'void') {
		const meta = { star_id: starId, run_id: a.runId, clip_id: a.clipId };
		const done = outcome === 'right'
			? await earnCoins(trx, userId, { reason: 'star', amount: delta, dedupe: `star:${a.clipId}`, lessonId: a.lessonId, meta }, a.today)
			: await spend(trx, userId, a.value, 'star', `star:${a.clipId}`, a.lessonId, a.today, meta);
		balance = done.coins;
		const eventId = (done as any).eventId;
		if (eventId) await trx('star_uses').where('id', starId).update({ coin_event_id: eventId });
	}
	const used = await starsUsed(trx, a.runId);
	return { used: true, outcome, value: a.value, delta, balance, stars_left: Math.max(0, (a.perRun ?? COIN.star.perRun) - used), shield_used: shieldUsed };
}

/** What a run's stars did, for its summary: totals and the starred questions that were wrong (to hear again) */
export async function starSummary(db: any, runId: string) {
	const rows = await db('star_uses').select('clip_id', 'lesson_id', 'outcome', 'delta', 'value').where('run_id', runId).orderBy('id');
	return {
		used: rows.length,
		right: rows.filter((r: any) => r.outcome === 'right').length,
		wrong: rows.filter((r: any) => r.outcome === 'wrong').length,
		void: rows.filter((r: any) => r.outcome === 'void').length,
		delta: rows.reduce((n: number, r: any) => n + Number(r.delta), 0),
		missed: rows.filter((r: any) => r.outcome === 'wrong').map((r: any) => ({ clip_id: r.clip_id as string, lesson_id: (r.lesson_id as string) || null, value: Number(r.value) })),
	};
}
