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
import { FEES } from './rooms';
import { CoopError, buildQuestions, levelOfUser, payFee, type Mode } from './coop';

const STALE_MS = 5 * 60_000;
const AGAIN_MS = 10 * 60_000;

const windowOf = (waitedMs: number) => (waitedMs < 10_000 ? 1 : waitedMs < 20_000 ? 3 : 99);

const autoRoom = (db: any, userId: string) => db('coop_rooms as r').join('coop_members as m', 'm.room_id', 'r.id').where({ 'm.user_id': userId, 'r.auto': true }).whereIn('r.status', ['waiting', 'playing']).first('r.id');

export async function joinQueue(db: any, userId: string, fee: number, mode: Mode = 'duel', today = vnDay()) {
	if (!FEES.includes(fee)) throw new CoopError('BAD_REQUEST');
	const ban = await db('match_bans').where('user_id', userId).where('until', '>', new Date()).first('until');
	if (ban) throw new CoopError('BANNED');
	if (await db('coop_rooms as r').join('coop_members as m', 'm.room_id', 'r.id').where('m.user_id', userId).whereIn('r.status', ['waiting', 'playing']).first('r.id')) throw new CoopError('TOO_MANY');
	if (await db('match_queue').where('user_id', userId).first('user_id')) return matchStatus(db, userId);
	const level = await levelOfUser(db, userId);
	await db.transaction(async (trx: any) => {
		await lockPurse(trx, userId);
		await payFee(trx, userId, 'queue', fee, today);
		await trx('match_queue').insert({ user_id: userId, fee, level, mode }).onConflict('user_id').ignore();
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
	const fits = cands.filter((c: any) => Math.abs(c.level - me.level) <= Math.max(mine, windowOf(now - new Date(c.since).getTime())));
	const other = fits.find((c: any) => c.user_id !== lastOpp) ?? fits[0];
	if (!other) return null;
	let qs;
	try { qs = await buildQuestions(db, me.mode, [userId, other.user_id], [me.level, other.level]); } catch { return null; }
	return db.transaction(async (trx: any) => {
		const rows = await trx('match_queue').whereIn('user_id', [userId, other.user_id]).orderBy('user_id').forUpdate();
		if (rows.length < 2) return null;
		const [r] = await trx('coop_rooms').insert({
			host_id: userId, questions: JSON.stringify(qs), mode: me.mode, fee: me.fee, auto: true, deadline_at: new Date(Date.now() + COIN.coop.readySeconds * 1000),
		}).returning('id');
		const id = (r.id ?? r) as string;
		await trx('coop_members').insert([{ room_id: id, user_id: userId }, { room_id: id, user_id: other.user_id }]);
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
