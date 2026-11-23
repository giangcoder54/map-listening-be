/**
 * Phòng Đấu, the first version: not at the same time (web repo docs/xu-v2-tasks.md P7).
 *
 * A learner opens a room (2 or 3 players, a fee in Kim cương); others join. When it is full each player
 * answers the same questions alone, any time within a day. Fees go into a pot; the house keeps
 * COIN.room.rakePct % (never paid out to anyone); the rest goes to the best score, a tie broken by time,
 * a tie still by splitting. Kim cương are not money: nothing here can be taken out of the app.
 * A room not full by its deadline gives every fee back; a player who has not finished by the deadline scores 0.
 */
import { COIN, CoinError, earnCoins, lockPurse, spend } from './coins';
import { secureRand } from './chests';
import { vnDay } from './days';
import { BASE_LANG } from './extensive';

export const FEES = [10, 20, 50, 100];
const DAY_MS = 86400_000;

export class RoomError extends Error {
	constructor(public code: 'BAD_REQUEST' | 'NOT_ENOUGH' | 'NO_ROOM' | 'FULL' | 'JOINED' | 'NOT_MEMBER' | 'NOT_PLAYING' | 'DONE' | 'NO_QUESTIONS' | 'TOO_MANY') { super(code); }
}

export type Member = { user_id: string; score: number | null; time_ms: number | null };

/** The pot's split: the best score wins, time breaks a tie, a tie still splits what is left after the house's share */
export function split(members: Member[], fee: number, rakePct: number) {
	const pot = fee * members.length;
	const prize = pot - Math.floor((pot * rakePct) / 100);
	const best = members.reduce((b, m) => ((m.score ?? 0) > b ? (m.score ?? 0) : b), 0);
	let top = members.filter((m) => (m.score ?? 0) === best);
	const fastest = Math.min(...top.map((m) => m.time_ms ?? Infinity));
	if (Number.isFinite(fastest)) top = top.filter((m) => (m.time_ms ?? Infinity) === fastest);
	const each = Math.floor(prize / top.length);
	return { pot, prize, winners: top.map((m) => m.user_id), each };
}

async function questionIds(trx: any, n: number) {
	const rows = await trx('dyk_cards').where('status', 'approved').pluck('id');
	const pool = [...rows];
	for (let i = pool.length - 1; i > 0; i--) { const j = secureRand(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
	return pool.slice(0, n) as string[];
}

export async function createRoom(db: any, userId: string, o: { fee: number; size: number; today?: string }) {
	if (!FEES.includes(o.fee) || (o.size !== 2 && o.size !== 3)) throw new RoomError('BAD_REQUEST');
	const today = o.today || vnDay();
	return db.transaction(async (trx: any) => {
		await lockPurse(trx, userId);
		// One waiting room each: stops a learner from filling the list
		const mine = await trx('rooms').where({ creator_id: userId, status: 'open' }).first('id');
		if (mine) throw new RoomError('TOO_MANY');
		const ids = await questionIds(trx, COIN.room.questions);
		if (ids.length < 3) throw new RoomError('NO_QUESTIONS');
		const [r] = await trx('rooms').insert({ creator_id: userId, fee: o.fee, size: o.size, questions: JSON.stringify(ids), deadline: new Date(Date.now() + DAY_MS) }).returning('id');
		const id = r.id ?? r;
		await pay(trx, userId, id, o.fee, today);
		await trx('room_members').insert({ room_id: id, user_id: userId });
		return id as string;
	});
}

async function pay(trx: any, userId: string, roomId: string, fee: number, today: string) {
	if (fee <= 0) return;
	try { await spend(trx, userId, fee, 'room_fee', `room_fee:${roomId}:${userId}`, null, today, { room_id: roomId }); }
	catch (e) { if (e instanceof CoinError && e.code === 'NOT_ENOUGH') throw new RoomError('NOT_ENOUGH'); throw e; }
}

export async function joinRoom(db: any, userId: string, roomId: string, today = vnDay()) {
	return db.transaction(async (trx: any) => {
		await lockPurse(trx, userId);
		const room = await trx('rooms').where('id', roomId).forUpdate().first();
		if (!room || room.status !== 'open') throw new RoomError('NO_ROOM');
		if (await trx('room_members').where({ room_id: roomId, user_id: userId }).first('user_id')) throw new RoomError('JOINED');
		const n = Number((await trx('room_members').where('room_id', roomId).count('* as n').first())?.n) || 0;
		if (n >= room.size) throw new RoomError('FULL');
		await pay(trx, userId, roomId, room.fee, today);
		await trx('room_members').insert({ room_id: roomId, user_id: userId });
		if (n + 1 >= room.size) await trx('rooms').where('id', roomId).update({ status: 'playing', deadline: new Date(Date.now() + DAY_MS) });
		return { filled: n + 1 >= room.size };
	});
}

/** What a player sees: the questions without answers, and their own answers so far */
export async function roomView(db: any, userId: string, roomId: string, lang: string) {
	const room = await db('rooms').where('id', roomId).first();
	if (!room) throw new RoomError('NO_ROOM');
	const members = await db('room_members as m').join('directus_users as u', 'u.id', 'm.user_id').where('m.room_id', roomId)
		.select('m.user_id', 'm.score', 'm.time_ms', 'm.finished_at', 'm.prize', 'm.answers', 'u.first_name', 'u.last_name');
	const me = members.find((m: any) => m.user_id === userId);
	const done = room.status === 'done' || room.status === 'cancelled';
	const out: any = {
		id: room.id, fee: room.fee, size: room.size, status: room.status, deadline: room.deadline, joined: !!me, questions_n: (room.questions as string[]).length,
		players: members.map((m: any) => ({
			you: m.user_id === userId, name: [m.first_name, String(m.last_name || '').slice(0, 1)].filter(Boolean).join(' ') || 'Learner',
			finished: !!m.finished_at, ...(done || m.user_id === userId ? { score: m.score, time_ms: m.time_ms } : {}), ...(done ? { prize: m.prize } : {}),
		})),
	};
	if (me && room.status === 'playing' && !me.finished_at) {
		const qs: any[] = [];
		const ans = (me.answers as any[]) || [];
		for (const id of room.questions as string[]) {
			const c = await db('dyk_cards').where('id', id).first();
			if (!c) continue;
			const tr = lang === BASE_LANG ? new Map() : new Map<string, string>((await db('dyk_translations').select('key', 'text').where({ card_id: id, lang })).map((r: any) => [r.key, r.text]));
			const say = (k: string, b: string) => tr.get(k) || b;
			qs.push({ question: say('question', c.question), options: (c.options as string[]).map((o, i) => say(`option${i}`, o)), video: { id: c.youtube_video_id, start: Number(c.clip_start), end: Number(c.clip_end) } });
		}
		out.questions = qs;
		out.answered = ans.length;
	}
	return out;
}

/** The next question, one try each, in order; the last one closes the player's round and may settle the room */
export async function answerRoom(db: any, userId: string, roomId: string, a: { index: number; choice: number }, today = vnDay()) {
	return db.transaction(async (trx: any) => {
		const room = await trx('rooms').where('id', roomId).forUpdate().first();
		if (!room) throw new RoomError('NO_ROOM');
		if (room.status !== 'playing') throw new RoomError('NOT_PLAYING');
		const me = await trx('room_members').where({ room_id: roomId, user_id: userId }).forUpdate().first();
		if (!me) throw new RoomError('NOT_MEMBER');
		if (me.finished_at) throw new RoomError('DONE');
		const ids = room.questions as string[];
		const answers: any[] = me.answers || [];
		if (a.index !== answers.length || !Number.isInteger(a.choice) || a.choice < 0 || a.choice > 2 || a.index >= ids.length) throw new RoomError('BAD_REQUEST');
		const card = await trx('dyk_cards').where('id', ids[a.index]).first('correct');
		const correct = Number(card?.correct) === a.choice;
		answers.push({ i: a.index, choice: a.choice, correct, at: Date.now() });
		const finished = answers.length >= ids.length;
		const patch: any = { answers: JSON.stringify(answers) };
		if (finished) {
			patch.finished_at = trx.fn.now();
			patch.score = answers.filter((x) => x.correct).length;
			patch.time_ms = answers[answers.length - 1].at - answers[0].at;
		}
		await trx('room_members').where({ room_id: roomId, user_id: userId }).update(patch);
		let settled = false;
		if (finished) {
			const left = Number((await trx('room_members').where('room_id', roomId).whereNull('finished_at').count('* as n').first())?.n) || 0;
			if (!left) { await settle(trx, roomId, today); settled = true; }
		}
		return { correct, finished, settled, score: finished ? patch.score : null };
	});
}

/** Pay the room out (inside a transaction with the room locked) */
async function settle(trx: any, roomId: string, today: string) {
	const room = await trx('rooms').where('id', roomId).first();
	if (!room || room.status !== 'playing') return;
	const members: Member[] = await trx('room_members').where('room_id', roomId).select('user_id', 'score', 'time_ms');
	const s = split(members, room.fee, COIN.room.rakePct);
	for (const id of s.winners) {
		if (s.each > 0) await earnCoins(trx, id, { reason: 'room_prize', amount: s.each, dedupe: `room_prize:${roomId}:${id}`, meta: { room_id: roomId } }, today);
		await trx('room_members').where({ room_id: roomId, user_id: id }).update({ prize: s.each });
	}
	await trx('rooms').where('id', roomId).update({ status: 'done', done_at: trx.fn.now() });
}

/** Rooms past their deadline: not full = fees back; playing = paid out with who finished (the others scored 0) */
export async function sweepRooms(db: any, today = vnDay()) {
	const late = await db('rooms').whereIn('status', ['open', 'playing']).where('deadline', '<', db.fn.now()).pluck('id');
	for (const id of late) {
		await db.transaction(async (trx: any) => {
			const room = await trx('rooms').where('id', id).forUpdate().first();
			if (!room || !['open', 'playing'].includes(room.status)) return;
			if (room.status === 'open') {
				for (const m of await trx('room_members').where('room_id', id).pluck('user_id')) {
					if (room.fee > 0) await earnCoins(trx, m, { reason: 'refund', amount: room.fee, dedupe: `room_refund:${id}:${m}`, meta: { room_id: id } }, today);
				}
				await trx('rooms').where('id', id).update({ status: 'cancelled', done_at: trx.fn.now() });
			} else {
				await trx('room_members').where('room_id', id).whereNull('finished_at').update({ score: 0 });
				await settle(trx, id, today);
			}
		});
	}
	return late.length;
}

export async function listRooms(db: any, userId: string) {
	const open = await db('rooms as r').where('r.status', 'open').whereNot('r.creator_id', userId)
		.whereNotExists(db('room_members as m').whereRaw('m.room_id = r.id').where('m.user_id', userId))
		.select('r.id', 'r.fee', 'r.size', 'r.deadline', db.raw('(select count(*) from room_members m where m.room_id = r.id)::int as joined')).orderBy('r.created_at', 'desc').limit(20);
	const mine = await db('rooms as r').join('room_members as me', 'me.room_id', 'r.id').where('me.user_id', userId)
		.select('r.id', 'r.fee', 'r.size', 'r.status', 'r.deadline', 'me.finished_at', 'me.score', 'me.prize', db.raw('(select count(*) from room_members m where m.room_id = r.id)::int as joined')).orderBy('r.created_at', 'desc').limit(20);
	return { open, mine, fees: FEES, default_fee: COIN.room.fee, rake_pct: COIN.room.rakePct };
}
