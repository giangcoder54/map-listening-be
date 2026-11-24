/**
 * Tìm trận / Tìm bạn luyện: automatic matchmaking for Đấu and for Luyện cùng (web repo docs/duel-and-coop-spec.md section 2.2).
 *
 * A learner joins the queue of one fee (the fee is taken at once and kept by the queue). The learners of the same mode and fee are
 * matched by level (anyone else before the opponent of the last 10 minutes, who is still matched when nobody else waits), the range widening with the wait: up to 1 level apart in the first 10 s, up to 3 until 20 s, anyone after.
 * When two meet, a duel room is made with both (`auto`: each
 * presses "ready" in lib/coop.ts readyCoop) and both leave the queue. Leaving the queue (or 5 minutes of nothing) gives the fee back.
 * The browser polls matchStatus(); every poll also tries to find a match for that learner, so there is no job to run.
 */
import { COIN, earnCoins, lockPurse } from './coins';
import { vnDay } from './days';
import { countryOf } from './country';
import { isEstablished } from './trust';
import { FEES } from './rooms';
import { CoopError, buildQuestions, levelOfUser, payFee, pickLesson, type Mode } from './coop';

const STALE_MS = 5 * 60_000;
const AGAIN_MS = 10 * 60_000;

const windowOf = (waitedMs: number) => (waitedMs < 10_000 ? 1 : waitedMs < 20_000 ? 3 : 99);
// learners of the same country are paired first: another country is accepted once one of the two has waited this long
const SAME_COUNTRY_MS = 15_000;

const autoRoom = (db: any, userId: string) => db('coop_rooms as r').join('coop_members as m', 'm.room_id', 'r.id').where({ 'm.user_id': userId, 'r.auto': true }).whereIn('r.status', ['waiting', 'playing']).first('r.id');

export async function joinQueue(db: any, userId: string, fee: number, mode: Mode = 'duel', today = vnDay()) {
	// Luyện cùng has one fee (what the lesson costs on top is taken when the room starts); Đấu has the stakes
	if (mode === 'practice') fee = COIN.coop.deposit;
	if (!FEES.includes(fee)) throw new CoopError('BAD_REQUEST');
	const ban = await db('match_bans').where('user_id', userId).where('until', '>', new Date()).first('until');
	if (ban) throw new CoopError('BANNED');
	if (await db('coop_rooms as r').join('coop_members as m', 'm.room_id', 'r.id').where('m.user_id', userId).whereIn('r.status', ['waiting', 'playing']).first('r.id')) throw new CoopError('TOO_MANY');
	if (await db('match_queue').where('user_id', userId).first('user_id')) return matchStatus(db, userId);
	// A paid duel moves Kim cương between players: not from a throwaway account (lib/trust.ts)
	if (mode === 'duel' && fee > 0 && !(await isEstablished(db, userId))) throw new CoopError('NEW_ACCOUNT');
	const level = await levelOfUser(db, userId);
	const country = await countryOf(db, userId);
	await db.transaction(async (trx: any) => {
		await lockPurse(trx, userId);
		// Checked again with the purse locked: two clicks at once pay one fee, the second finds the learner queued
		if (await trx('match_queue').where('user_id', userId).first('user_id')) return;
		await payFee(trx, userId, 'queue', fee, today);
		await trx('match_queue').insert({ user_id: userId, fee, level, mode, country });
	});
	return matchStatus(db, userId);
}

export async function cancelQueue(db: any, userId: string, today = vnDay()) {
	return db.transaction(async (trx: any) => {
		const row = await trx('match_queue').where('user_id', userId).forUpdate().first();
		if (!row) return { cancelled: false };
		await trx('match_queue').where('user_id', userId).delete();
		await earnCoins(trx, userId, { reason: 'refund', amount: row.fee, dedupe: `match_refund:${userId}:${Date.now()}`, meta: { queue: true } }, today);
		return { cancelled: true };
	});
}

/** Look for an opponent for this learner; returns the new room's id, or null (keep waiting) */
export async function tryMatch(db: any, userId: string): Promise<string | null> {
	const me = await db('match_queue').where('user_id', userId).first();
	if (!me) return null;
	const now = Date.now();
	const mine = windowOf(now - new Date(me.since).getTime());
	const cands = await db('match_queue').where({ fee: me.fee, mode: me.mode }).whereNot('user_id', userId).orderBy('since').limit(30);
	// the opponent of the last 10 minutes is the last choice: anyone else first, the same one if nobody else is waiting
	const last = await db('coop_members as m').join('coop_rooms as r', 'r.id', 'm.room_id').where({ 'm.user_id': userId, 'r.mode': me.mode }).where('r.created_at', '>', new Date(now - AGAIN_MS)).orderBy('r.created_at', 'desc').first('r.id');
	const lastOpp = last ? (await db('coop_members').where('room_id', last.id).whereNot('user_id', userId).first('user_id'))?.user_id : null;
	const waitOf = (c: any) => now - new Date(c.since).getTime();
	const fits = cands.filter((c: any) => Math.abs(c.level - me.level) <= Math.max(mine, windowOf(waitOf(c))));
	// same country first; another country only after one of the two has waited a while (an unknown country is not held back)
	const sameCountry = (c: any) => !me.country || !c.country || me.country === c.country;
	const patient = (c: any) => Math.max(waitOf(me), waitOf(c)) >= SAME_COUNTRY_MS;
	const ok = fits.filter((c: any) => sameCountry(c) || patient(c));
	const pool = ok.some(sameCountry) ? ok.filter(sameCountry) : ok;
	const other = pool.find((c: any) => c.user_id !== lastOpp) ?? pool[0];
	if (!other) return null;
	let qs: any[]; let lesson: { id: string | null; prices: Record<string, number> } | null = null;
	try {
		if (me.mode === 'practice') { const p = await pickLesson(db, [userId, other.user_id]); qs = p.questions; lesson = p; }
		else qs = await buildQuestions(db, me.mode, [userId, other.user_id], [me.level, other.level]);
	} catch { return null; }
	return db.transaction(async (trx: any) => {
		const rows = await trx('match_queue').whereIn('user_id', [userId, other.user_id]).orderBy('user_id').forUpdate();
		if (rows.length < 2) return null;
		const [r] = await trx('coop_rooms').insert({
			host_id: userId, questions: JSON.stringify(qs), lesson_id: lesson?.id ?? null, mode: me.mode, fee: me.fee, auto: true, deadline_at: new Date(Date.now() + COIN.coop.readySeconds * 1000),
		}).returning('id');
		const id = (r.id ?? r) as string;
		await trx('coop_members').insert([{ room_id: id, user_id: userId, lesson_price: lesson?.prices[userId] ?? 0 }, { room_id: id, user_id: other.user_id, lesson_price: lesson?.prices[other.user_id] ?? 0 }]);
		await trx('match_queue').whereIn('user_id', [userId, other.user_id]).delete();
		return id;
	});
}

export async function matchStatus(db: any, userId: string) {
	const q = await db('match_queue').where('user_id', userId).first();
	if (q) {
		const room = await tryMatch(db, userId);
		if (room) return { status: 'matched', room_id: room };
		const waited = Date.now() - new Date(q.since).getTime();
		const w = windowOf(waited);
		return { status: 'searching', fee: q.fee, mode: q.mode, level: q.level, waited_ms: waited, range: w >= 99 ? null : w };
	}
	const room = await autoRoom(db, userId);
	return room ? { status: 'matched', room_id: room.id } : { status: 'idle' };
}

/** Learners who have waited too long: the fee goes back, they leave the queue */
export async function sweepQueue(db: any, today = vnDay()) {
	const stale = await db('match_queue').where('since', '<', new Date(Date.now() - STALE_MS)).pluck('user_id');
	for (const id of stale) await cancelQueue(db, id, today).catch(() => null);
	return stale.length as number;
}
