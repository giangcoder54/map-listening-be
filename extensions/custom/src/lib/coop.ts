/**
 * Phòng Đấu và Luyện cùng, two learners at the same time (web repo docs/duel-and-coop-spec.md).
 *
 * Questions are "gap" questions made from published clips (lib/cards.ts buildGap); the room keeps its own copy.
 * The server holds the truth and the clock; browsers hear changes over the WebSocket (lib/coopHub.ts) and may poll getState().
 *
 * Mode "duel" (Đấu): a fee from each player into a pot. One question is: "listen" (both screens play the clip at the same
 * moment: the state says play_in ms), then "answer" (COIN.coop.duelSeconds starting when the clip is over), then "reveal"
 * (a short pause). A right answer is worth 500 + up to 500 for speed. The best total takes the pot less the house share
 * (lib/rooms.ts split), the time breaks a tie, leaving mid-duel forfeits. Rooms are made by the queue (lib/match.ts, `auto`:
 * both press "ready" within COIN.coop.readySeconds, or the room is closed and the fees go back) or by a friend's link.
 *
 * Mode "practice" (Luyện cùng): a deposit (COIN.coop.deposit) from each player, no clock. Each picks alone ("answer"); same
 * pick = straight to "reveal"; different = "discuss" (chat, each may change the pick, then lock it); when both are locked the
 * answer shows. Both right at the end of the talk = a team star. When all questions are done every player gets the deposit
 * back and COIN.coop.reward (at most COIN.coop.perDay rooms a day); leaving midway loses the deposit, the other is refunded.
 * A room idle for IDLE_MIN minutes is closed.
 */
import { COIN, CoinError, earnCoins, lockPurse, spend } from './coins';
import { vnDay } from './days';
import { levelOf } from './xp';
import { diffWords, isRight, tokens } from './intensive';
import { FEES, split, type Member } from './rooms';
import { isEstablished } from './trust';

export const SIZE = 2;
const IDLE_MIN = 30;
const MAX_MSG = 300;
const BAN_MIN = 2;

export class CoopError extends Error {
	constructor(public code: 'BAD_REQUEST' | 'NO_ROOM' | 'FULL' | 'JOINED' | 'NOT_MEMBER' | 'NOT_HOST' | 'NOT_READY' | 'NOT_PLAYING' | 'NO_QUESTIONS' | 'TOO_MANY' | 'SLOW_DOWN' | 'NOT_ENOUGH' | 'BANNED' | 'QUEUED' | 'NEW_ACCOUNT') { super(code); }
}

/** The old gap question (rooms made before Đấu was typed) */
export type Q = { clip_id: string; blank: string; options: string[]; correct: number; word: string; video_id: string; start: number; end: number };

export type Mode = 'practice' | 'duel';

const answerMs = () => COIN.coop.duelSeconds * 1000;
/** From "ready" to the end of the clip (and a little over), when the answer clock starts */
const listenMs = (q: { start: number; end: number }) => COIN.coop.duelLead + Math.round(Math.min(20, Math.max(1, q.end - q.start)) * 1000) + 600;
/** A right answer: 500, and up to 500 more for a quick one */
export const pointsOf = (correct: boolean, ms: number) => (correct ? 500 + Math.round(500 * Math.max(0, 1 - ms / answerMs())) : 0);


export async function levelOfUser(db: any, userId: string) {
	const row = await db('user_xp').where('user_id', userId).first('xp_total');
	return levelOf(Number(row?.xp_total) || 0).level;
}

/** A Luyện cùng question: the whole sentence is typed. The text never leaves the server before the answer is shown. */
export type DictQ = { kind: 'dict'; source: 'il' | 'clip'; ref_id: string; text: string; video_id: string; start: number; end: number };

/**
 * Sentences to type: short Intensive sentences (they have traps, so there is something to talk about) first, short clips of
 * the lessons to fill up; not ones these players had in the last 30 days; not two from one lesson.
 */
export async function buildDictation(db: any, userIds: string[], n = COIN.coop.practiceQuestions) {
	const seen = await db.raw(
		`select distinct q->>'ref_id' as id from coop_rooms r, jsonb_array_elements(r.questions) q
		 where r.created_at > now() - interval '30 days' and r.id in (select room_id from coop_members where user_id = any(?::uuid[])) limit 600`, [userIds]).catch(() => ({ rows: [] }));
	const exclude: string[] = (seen.rows || []).map((r: any) => r.id).filter(Boolean);
	const out: DictQ[] = [];
	const il = await db('il_sentences as s').join('il_lessons as l', 'l.id', 's.lesson_id').join('source_videos as sv', 'sv.id', 'l.source_video_id')
		.where('l.status', 'published').whereNotNull('sv.youtube_video_id')
		// a whole video done in parts is not drawn from
		.whereRaw('not exists (select 1 from il_sentences p where p.lesson_id = l.id and p.part > 1)').whereRaw('s.end_ms - s.start_ms between 1500 and 8000').whereRaw('char_length(s.text) between 15 and 120')
		.modify((q: any) => { if (exclude.length) q.whereNotIn('s.id', exclude); })
		.select('s.id', 's.text', 's.start_ms', 's.end_ms', 'sv.youtube_video_id', 'l.id as lesson')
		.orderByRaw(`(s.traps::text not in ('[]','{}','null')) desc, random()`).limit(40);
	const lessons = new Set<string>();
	for (const r of il) {
		if (out.length >= n || lessons.has(r.lesson)) continue;
		lessons.add(r.lesson);
		out.push({ kind: 'dict', source: 'il', ref_id: r.id, text: String(r.text).trim(), video_id: r.youtube_video_id, start: Number(r.start_ms) / 1000, end: Number(r.end_ms) / 1000 });
	}
	if (out.length < n) {
		const clips = await db('listening_clips as c').join('source_videos as sv', 'sv.id', 'c.source_video_id')
			.where('c.status', 'published').whereNotNull('c.transcript').whereNotNull('c.start_time').whereNotNull('c.end_time').whereNotNull('sv.youtube_video_id')
			.whereRaw('char_length(c.transcript) between 25 and 90').whereRaw('(c.end_time - c.start_time) between 1.5 and 8')
			.modify((q: any) => { if (exclude.length) q.whereNotIn('c.id', exclude); })
			.select('c.id', 'c.transcript', 'c.start_time', 'c.end_time', 'sv.youtube_video_id').orderByRaw('random()').limit(n);
		for (const c of clips) if (out.length < n) out.push({ kind: 'dict', source: 'clip', ref_id: c.id, text: String(c.transcript).trim(), video_id: c.youtube_video_id, start: Number(c.start_time), end: Number(c.end_time) });
	}
	if (out.length < 2) throw new CoopError('NO_QUESTIONS');
	return out;
}

/** Sentence ids (Intensive sentences, clips) these players had in a room in the last 30 days */
async function seenRefs(db: any, userIds: string[]): Promise<string[]> {
	const seen = await db.raw(
		`select distinct q->>'ref_id' as id from coop_rooms r, jsonb_array_elements(r.questions) q
		 where r.created_at > now() - interval '30 days' and r.id in (select room_id from coop_members where user_id = any(?::uuid[])) limit 1500`, [userIds]).catch(() => ({ rows: [] }));
	return (seen.rows || []).map((r: any) => r.id).filter(Boolean);
}

/** A Luyện cùng room: one lesson of the Listening Lab, what each player pays for it (0 if they have it), and its sentences to type */
export type LessonPick = { id: string | null; prices: Record<string, number>; questions: DictQ[] };

/**
 * The lesson for two players. A lesson costs a player its unlock price unless they bought it; the pick
 * prefers one both lack (both buy it), then one that one of them lacks, then one both have; never one a player cannot
 * pay for. Not a lesson whose sentences they typed in the last 30 days. With no such lesson: short random sentences, nobody pays.
 */
export async function pickLesson(db: any, userIds: string[]): Promise<LessonPick> {
	const n = COIN.coop.practiceQuestions;
	const own = new Map<string, Set<string>>(userIds.map((u) => [u, new Set<string>()]));
	for (const r of await db('listening_unlocks').whereIn('user_id', userIds).select('user_id', 'lesson_id')) own.get(r.user_id)!.add(r.lesson_id);
	const purse = new Map<string, number>();
	for (const r of await db('user_xp').whereIn('user_id', userIds).select('user_id', 'coins')) purse.set(r.user_id, Number(r.coins) || 0);
	const exclude = new Set(await seenRefs(db, userIds));
	const rows = await db('listening_lessons as l').join('listening_clips as c', 'c.lesson_id', 'l.id').join('source_videos as sv', 'sv.id', 'c.source_video_id')
		.leftJoin('listening_skills as k', 'k.id', 'l.skill_id').leftJoin('listening_groups as g', 'g.id', 'k.group_id')
		.where('l.status', 'published').whereIn('l.kind', ['pattern', 'trap']).where('c.status', 'published')
		.whereNotNull('c.transcript').whereNotNull('c.start_time').whereNotNull('c.end_time').whereNotNull('sv.youtube_video_id')
		.whereRaw('char_length(c.transcript) between 15 and 140').whereRaw('(c.end_time - c.start_time) between 1.5 and 12')
		.select('l.id as lesson', 'l.kind', db.raw('(coalesce(l.is_premium, false) or coalesce(k.is_premium, false) or coalesce(g.is_premium, false)) as paid'),
			'c.id as clip', 'c.transcript', 'c.start_time', 'c.end_time', 'c.sort', 'sv.youtube_video_id');
	const by = new Map<string, { kind: string; paid: boolean; clips: any[] }>();
	for (const r of rows) {
		if (exclude.has(r.clip)) continue;
		const l = by.get(r.lesson) || { kind: r.kind, paid: !!r.paid, clips: [] as any[] };
		l.clips.push(r); by.set(r.lesson, l);
	}
	const options: { id: string; prices: Record<string, number>; tier: number; clips: any[] }[] = [];
	for (const [id, l] of by) {
		if (l.clips.length < Math.min(5, n)) continue;
		const cost = l.paid ? COIN.unlock[l.kind] ?? COIN.unlock.pattern! : 0;
		const prices: Record<string, number> = {};
		for (const u of userIds) prices[u] = own.get(u)!.has(id) ? 0 : cost;
		if (userIds.some((u) => prices[u]! > (purse.get(u) ?? 0))) continue;
		options.push({ id, prices, tier: userIds.filter((u) => prices[u]! > 0).length, clips: l.clips });
	}
	if (options.length) {
		const best = Math.max(...options.map((o) => o.tier));
		const top = options.filter((o) => o.tier === best);
		const o = top[Math.floor(Math.random() * top.length)]!;
		const clips = o.clips.sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0)).slice(0, n);
		return { id: o.id, prices: o.prices, questions: clips.map((c) => ({ kind: 'dict' as const, source: 'clip' as const, ref_id: c.clip, text: String(c.transcript).trim(), video_id: c.youtube_video_id, start: Number(c.start_time), end: Number(c.end_time) })) };
	}
	return { id: null, prices: Object.fromEntries(userIds.map((u) => [u, 0])), questions: await buildDictation(db, userIds, n) };
}

/** Friend room, both in: pick the lesson and what each pays (the pay itself is taken when the room starts) */
async function assignLesson(trx: any, room: any) {
	const ids: string[] = await trx('coop_members').where('room_id', room.id).pluck('user_id');
	const pick = await pickLesson(trx, ids);
	await trx('coop_rooms').where('id', room.id).update({ questions: JSON.stringify(pick.questions), lesson_id: pick.id });
	for (const u of ids) await trx('coop_members').where({ room_id: room.id, user_id: u }).update({ lesson_price: pick.prices[u] ?? 0 });
}

/** The room starts: whoever lacks the lesson pays for it and keeps it (the unlock of the lesson, as when bought one by one) */
async function chargeLesson(trx: any, room: any, today: string) {
	const lesson = room.lesson_id;
	if (!lesson) return;
	for (const m of await trx('coop_members').where('room_id', room.id).select('user_id', 'lesson_price')) {
		const price = Number(m.lesson_price) || 0;
		if (price <= 0 || (await trx('listening_unlocks').where({ user_id: m.user_id, lesson_id: lesson }).first('lesson_id'))) continue;
		await lockPurse(trx, m.user_id);
		try {
			const paid = await spend(trx, m.user_id, price, 'unlock', `unlock:${lesson}`, lesson, today);
			await trx('listening_unlocks').insert({ user_id: m.user_id, lesson_id: lesson, source: 'coins', coin_event_id: paid.eventId });
		} catch (e) { if (e instanceof CoinError && e.code === 'NOT_ENOUGH') throw new CoopError('NOT_ENOUGH'); throw e; }
	}
}

/** Đấu question: the sentence with a phrase of 1-3 words hidden, typed back. The phrase is a trap of an Intensive sentence or the answer of a clip. */
export type ClozeQ = { kind: 'cloze'; source: 'il' | 'clip'; ref_id: string; text: string; blank: string; answer: string; video_id: string; start: number; end: number };
const GAP = '_____';
/** The sentence with the first whole-word match of `phrase` hidden, and the phrase as written; null if the phrase is not in it */
const hide = (text: string, phrase: string) => {
	const esc = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
	const m = new RegExp(`(^|[^A-Za-z'])(${esc})(?![A-Za-z'])`, 'i').exec(text);
	if (!m) return null;
	const at = m.index + m[1]!.length;
	return { blank: text.slice(0, at) + GAP + text.slice(at + m[2]!.length), answer: text.slice(at, at + m[2]!.length) };
};
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

export async function buildCloze(db: any, userIds: string[], n = COIN.coop.questions) {
	const seen = await db.raw(
		`select distinct q->>'ref_id' as id from coop_rooms r, jsonb_array_elements(r.questions) q
		 where r.created_at > now() - interval '30 days' and r.id in (select room_id from coop_members where user_id = any(?::uuid[])) limit 800`, [userIds]).catch(() => ({ rows: [] }));
	const exclude: string[] = (seen.rows || []).map((r: any) => r.id).filter(Boolean);
	const out: ClozeQ[] = [];
	const il = await db('il_sentences as s').join('il_lessons as l', 'l.id', 's.lesson_id').join('source_videos as sv', 'sv.id', 'l.source_video_id')
		.where('l.status', 'published').whereNotNull('sv.youtube_video_id')
		// a whole video done in parts is not drawn from
		.whereRaw('not exists (select 1 from il_sentences p where p.lesson_id = l.id and p.part > 1)').whereRaw('s.end_ms - s.start_ms between 1500 and 9000').whereRaw('char_length(s.text) between 15 and 140')
		.whereRaw(`s.traps::text not in ('[]','{}','null')`)
		.modify((q: any) => { if (exclude.length) q.whereNotIn('s.id', exclude); })
		.select('s.id', 's.text', 's.traps', 's.start_ms', 's.end_ms', 'sv.youtube_video_id', 'l.id as lesson').orderByRaw('random()').limit(80);
	const lessons = new Set<string>();
	for (const r of il) {
		if (out.length >= n || lessons.has(r.lesson)) continue;
		const traps: any[] = (Array.isArray(r.traps) ? r.traps : []).sort(() => Math.random() - 0.5);
		for (const t of traps) {
			const phrase = String(t?.text || '').trim();
			if (!phrase || words(phrase) > 3) continue;
			const h = hide(String(r.text), phrase);
			if (!h) continue;
			lessons.add(r.lesson);
			out.push({ kind: 'cloze', source: 'il', ref_id: r.id, text: String(r.text).trim(), blank: h.blank, answer: h.answer, video_id: r.youtube_video_id, start: Number(r.start_ms) / 1000, end: Number(r.end_ms) / 1000 });
			break;
		}
	}
	if (out.length < n) {
		const clips = await db('listening_clips as c').join('source_videos as sv', 'sv.id', 'c.source_video_id')
			.where('c.status', 'published').whereNotNull('c.transcript').whereNotNull('c.answer').whereNotNull('c.start_time').whereNotNull('c.end_time').whereNotNull('sv.youtube_video_id')
			.whereRaw('char_length(c.transcript) between 15 and 140').whereRaw('(c.end_time - c.start_time) between 1.5 and 9')
			.modify((q: any) => { if (exclude.length) q.whereNotIn('c.id', exclude); })
			.select('c.id', 'c.transcript', 'c.answer', 'c.start_time', 'c.end_time', 'sv.youtube_video_id').orderByRaw('random()').limit(60);
		for (const c of clips) {
			if (out.length >= n) break;
			const phrase = String(c.answer || '').trim();
			if (!phrase || words(phrase) > 3) continue;
			const h = hide(String(c.transcript), phrase);
			if (h) out.push({ kind: 'cloze', source: 'clip', ref_id: c.id, text: String(c.transcript).trim(), blank: h.blank, answer: h.answer, video_id: c.youtube_video_id, start: Number(c.start_time), end: Number(c.end_time) });
		}
	}
	if (out.length < 3) throw new CoopError('NO_QUESTIONS');
	return out;
}

/** The questions of a room: Đấu hides a phrase of 1-3 words (typed back, quick), Luyện cùng types whole sentences. Both feed the data of what learners mishear. */
export async function buildQuestions(db: any, mode: Mode, userIds: string[], _levels: number[]): Promise<any[]> {
	return mode === 'duel' ? buildCloze(db, userIds, COIN.coop.questions) : buildDictation(db, userIds, COIN.coop.practiceQuestions);
}

export async function payFee(trx: any, userId: string, roomId: string, fee: number, today: string) {
	if (fee <= 0) return;
	try { await spend(trx, userId, fee, 'room_fee', `coop_fee:${roomId}:${userId}:${Date.now()}`, null, today, { room_id: roomId }); }
	catch (e) { if (e instanceof CoinError && e.code === 'NOT_ENOUGH') throw new CoopError('NOT_ENOUGH'); throw e; }
}

/** The fee back. `once`: a room closes only once, so the key is stable (a double call pays nothing twice); a guest who leaves and joins again may be refunded again */
export async function refund(trx: any, room: any, userIds: string[], today: string, once = true) {
	if (room.fee <= 0) return;
	for (const u of userIds) await earnCoins(trx, u, { reason: 'refund', amount: room.fee, dedupe: `coop_refund:${room.id}:${u}${once ? '' : `:${Date.now()}`}`, meta: { room_id: room.id } }, today);
}

export async function banFor(trx: any, userId: string) {
	await trx('match_bans').insert({ user_id: userId, until: new Date(Date.now() + BAN_MIN * 60_000) }).onConflict('user_id').merge();
}

export async function createCoop(db: any, userId: string, o: { mode?: Mode; fee?: number; today?: string } = {}) {
	const mode: Mode = o.mode === 'duel' ? 'duel' : 'practice';
	// Luyện cùng: a fixed fee (COIN.coop.deposit, 50) for being together, spent; the lesson is paid on top by whoever lacks it
	const fee = mode === 'duel' ? Number(o.fee) : COIN.coop.deposit;
	if (mode === 'duel' && !FEES.includes(fee)) throw new CoopError('BAD_REQUEST');
	const today = o.today || vnDay();
	if (await busyRoom(db, userId)) throw new CoopError('TOO_MANY');
	if (await db('match_queue').where('user_id', userId).first('user_id')) throw new CoopError('QUEUED');
	// A paid duel moves Kim cương between players: not from a throwaway account (lib/trust.ts)
	if (mode === 'duel' && fee > 0 && !(await isEstablished(db, userId))) throw new CoopError('NEW_ACCOUNT');
	// Đấu: its questions now; Luyện cùng: the lesson is picked when both are in (assignLesson)
	const qs = mode === 'duel' ? await buildQuestions(db, mode, [userId], [await levelOfUser(db, userId)]) : [];
	return db.transaction(async (trx: any) => {
		if (fee > 0) await lockPurse(trx, userId);
		const [r] = await trx('coop_rooms').insert({ host_id: userId, questions: JSON.stringify(qs), mode, fee }).returning('id');
		const id = r.id ?? r;
		await payFee(trx, userId, id, fee, today);
		await trx('coop_members').insert({ room_id: id, user_id: userId });
		return id as string;
	});
}

const busyRoom = (db: any, userId: string) => db('coop_rooms as r').join('coop_members as m', 'm.room_id', 'r.id').where('m.user_id', userId).whereIn('r.status', ['waiting', 'playing']).first('r.id');

export async function joinCoop(db: any, userId: string, roomId: string, today = vnDay()) {
	return db.transaction(async (trx: any) => {
		await lockPurse(trx, userId);
		const room = await trx('coop_rooms').where('id', roomId).forUpdate().first();
		if (!room || room.status !== 'waiting' || room.auto) throw new CoopError('NO_ROOM');
		if (await trx('coop_members').where({ room_id: roomId, user_id: userId }).first('user_id')) throw new CoopError('JOINED');
		if (await busyRoom(trx, userId)) throw new CoopError('TOO_MANY');
		if (await trx('match_queue').where('user_id', userId).first('user_id')) throw new CoopError('QUEUED');
		const n = Number((await trx('coop_members').where('room_id', roomId).count('* as n').first())?.n) || 0;
		if (n >= SIZE) throw new CoopError('FULL');
		if (room.mode === 'duel' && room.fee > 0 && !(await isEstablished(trx, userId))) throw new CoopError('NEW_ACCOUNT');
		await payFee(trx, userId, roomId, room.fee, today);
		await trx('coop_members').insert({ room_id: roomId, user_id: userId });
		await trx('coop_rooms').where('id', roomId).update({ phase_at: trx.fn.now() });
		return { joined: true };
	});
}

const touch = (trx: any, id: string) => trx('coop_rooms').where('id', id).update({ phase_at: trx.fn.now() });

/** A duel question starts: both screens play the clip at the same moment, the answer clock starts when it is over */
const toListen = (trx: any, room: any, idx: number) =>
	trx('coop_rooms').where('id', room.id).update({ idx, phase: 'listen', play_seq: room.play_seq + 1, phase_at: trx.fn.now(), deadline_at: new Date(Date.now() + listenMs((room.questions as DictQ[])[idx]!)) });
const toAnswer = (trx: any, room: any) =>
	trx('coop_rooms').where('id', room.id).update({ phase: 'answer', phase_at: trx.fn.now(), deadline_at: new Date(Date.now() + answerMs()) });

/** The room starts (needs its lock): a duel with the shared clip, a practice with the first pick */
async function begin(trx: any, room: any) {
	if (room.mode === 'duel') {
		await trx('coop_rooms').where('id', room.id).update({ status: 'playing' });
		await toListen(trx, { ...room, play_seq: 0 }, 0);
	} else {
		if (!room.lesson_id && !(room.questions as any[]).length) await assignLesson(trx, room);
		await chargeLesson(trx, { ...room, lesson_id: (await trx('coop_rooms').where('id', room.id).first('lesson_id'))?.lesson_id }, vnDay());
		await trx('coop_rooms').where('id', room.id).update({ status: 'playing', idx: 0, phase: 'answer', play_seq: 1, phase_at: trx.fn.now(), deadline_at: null });
	}
}

export async function startCoop(db: any, userId: string, roomId: string) {
	return db.transaction(async (trx: any) => {
		const room = await trx('coop_rooms').where('id', roomId).forUpdate().first();
		if (!room) throw new CoopError('NO_ROOM');
		if (room.host_id !== userId) throw new CoopError('NOT_HOST');
		if (room.status !== 'waiting' || room.auto) throw new CoopError('NOT_READY');
		const n = Number((await trx('coop_members').where('room_id', roomId).count('* as n').first())?.n) || 0;
		if (n < SIZE) throw new CoopError('NOT_READY');
		await begin(trx, room);
		return { started: true };
	});
}

/** A room made by the queue: each player says "ready"; the second one starts it */
export async function readyCoop(db: any, userId: string, roomId: string) {
	return db.transaction(async (trx: any) => {
		const room = await trx('coop_rooms').where('id', roomId).forUpdate().first();
		if (!room) throw new CoopError('NO_ROOM');
		await memberOf(trx, roomId, userId);
		if (room.status !== 'waiting' || !room.auto) return { started: room.status === 'playing' };
		if (room.deadline_at && Date.now() > new Date(room.deadline_at).getTime()) return { started: false };
		await trx('coop_members').where({ room_id: roomId, user_id: userId }).update({ ready: true });
		const left = Number((await trx('coop_members').where({ room_id: roomId, ready: false }).count('* as n').first())?.n) || 0;
		const n = Number((await trx('coop_members').where('room_id', roomId).count('* as n').first())?.n) || 0;
		if (left === 0 && n >= SIZE) { await begin(trx, room); return { started: true }; }
		return { started: false };
	});
}

async function memberOf(trx: any, roomId: string, userId: string) {
	const m = await trx('coop_members').where({ room_id: roomId, user_id: userId }).first('user_id');
	if (!m) throw new CoopError('NOT_MEMBER');
}

/** Play the clip again, for everyone in the room (practice only: a duel hears it once, together) */
export async function playCoop(db: any, userId: string, roomId: string) {
	return db.transaction(async (trx: any) => {
		const room = await trx('coop_rooms').where('id', roomId).forUpdate().first();
		if (!room) throw new CoopError('NO_ROOM');
		await memberOf(trx, roomId, userId);
		if (room.status !== 'playing' || room.mode === 'duel') throw new CoopError('NOT_PLAYING');
		await trx('coop_rooms').where('id', roomId).update({ play_seq: room.play_seq + 1, phase_at: trx.fn.now() });
		return { play_seq: room.play_seq + 1 };
	});
}

/** A word typed for another one, counted: what learners really hear instead (spelling slips are not counted) */
async function logMishears(trx: any, q: DictQ, words: { w: string; status: string; typed?: string }[]) {
	for (const w of words) {
		if (w.status !== 'wrong' || !w.typed) continue;
		await trx.raw(
			`insert into dict_mishears (source, ref_id, word, heard) values (?, ?, ?, ?)
			 on conflict (source, ref_id, word, heard) do update set n = dict_mishears.n + 1`, [q.source, q.ref_id, w.w.slice(0, 60), w.typed.slice(0, 60)]);
	}
}

/**
 * Show the answer: grade every typed text against the sentence (what was heard wrongly is counted in dict_mishears).
 * Practice: the text after the talk is graded, both right = a team star. Duel: a right text (>= 85%) is worth 500 + speed,
 * a wrong one a part of 400 by the words it got.
 */
async function toReveal(trx: any, room: any) {
	let stars = room.stars;
	const q = (room.questions as DictQ[])[room.idx]!;
	const rows = await trx('coop_answers').where({ room_id: room.id, idx: room.idx });
	let all = rows.length >= SIZE;
	for (const a of rows) {
		const g = diffWords(refOf(q), a.typed2 ?? a.typed ?? '');
		const ok = isRight(g);
		if (!ok) all = false;
		const points = room.mode === 'duel' ? (ok ? pointsOf(true, a.ms ?? answerMs()) : Math.round((400 * g.right) / Math.max(1, g.total))) : 0;
		await trx('coop_answers').where({ room_id: room.id, idx: room.idx, user_id: a.user_id }).update({ correct: ok, points });
		await logMishears(trx, q, g.words);
	}
	if (all && room.mode !== 'duel') stars += 1;
	await trx('coop_rooms').where('id', room.id).update({ phase: 'reveal', stars, phase_at: trx.fn.now(), deadline_at: room.mode === 'duel' ? new Date(Date.now() + COIN.coop.duelReveal * 1000) : null });
}

/** One typed sentence per player per question. Duel: only while "answer"; the second answer (or the clock) shows the answer. Practice: see answerTyped. */
export async function answerCoop(db: any, userId: string, roomId: string, a: { idx: number; text?: string }) {
	return db.transaction(async (trx: any) => {
		const room = await trx('coop_rooms').where('id', roomId).forUpdate().first();
		if (!room) throw new CoopError('NO_ROOM');
		await memberOf(trx, roomId, userId);
		if (room.status !== 'playing') throw new CoopError('NOT_PLAYING');
		if (a.idx !== room.idx) throw new CoopError('BAD_REQUEST');
		const text = String(a.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
		if (room.mode !== 'duel') return answerTyped(trx, room, userId, text);
		if (!text || room.phase !== 'answer') throw new CoopError('BAD_REQUEST');
		if (room.deadline_at && Date.now() > new Date(room.deadline_at).getTime() + 500) throw new CoopError('BAD_REQUEST');
		const ms = Math.min(answerMs(), Math.max(0, Date.now() - new Date(room.phase_at).getTime()));
		const ins = await trx('coop_answers').insert({ room_id: roomId, idx: room.idx, user_id: userId, choice: 0, correct: false, typed: text, ms }).onConflict(['room_id', 'idx', 'user_id']).ignore().returning('user_id');
		if (!ins.length) throw new CoopError('BAD_REQUEST');
		const rows = await trx('coop_answers').where({ room_id: roomId, idx: room.idx });
		const members = Number((await trx('coop_members').where('room_id', roomId).count('* as n').first())?.n) || 0;
		if (rows.length < members) return { revealed: false };
		await toReveal(trx, room);
		return { revealed: true };
	});
}

/**
 * Luyện cùng: a typed sentence. "answer": each types alone and sends; when both have sent, the same text (or both right) shows the
 * answer at once, otherwise it is "discuss": both texts are open to both, each may type again until locked (lockCoop).
 */
async function answerTyped(trx: any, room: any, userId: string, text: string) {
	if (!text) throw new CoopError('BAD_REQUEST');
	if (room.phase === 'discuss') {
		const n = await trx('coop_answers').where({ room_id: room.id, idx: room.idx, user_id: userId, locked: false }).update({ typed2: text });
		if (!n) throw new CoopError('BAD_REQUEST');
		await touch(trx, room.id);
		return { revealed: false };
	}
	if (room.phase !== 'answer') throw new CoopError('BAD_REQUEST');
	const ins = await trx('coop_answers').insert({ room_id: room.id, idx: room.idx, user_id: userId, choice: 0, correct: false, typed: text }).onConflict(['room_id', 'idx', 'user_id']).ignore().returning('user_id');
	if (!ins.length) throw new CoopError('BAD_REQUEST');
	const rows = await trx('coop_answers').where({ room_id: room.id, idx: room.idx });
	const members = Number((await trx('coop_members').where('room_id', room.id).count('* as n').first())?.n) || 0;
	if (rows.length < members) { await touch(trx, room.id); return { revealed: false }; }
	const q = (room.questions as DictQ[])[room.idx]!;
	const same = new Set(rows.map((r: any) => tokens(r.typed).join(' '))).size === 1;
	const bothAll = rows.every((r: any) => { const g = diffWords(q.text, r.typed); return g.total > 0 && g.right === g.total; });
	if (same || bothAll) { await toReveal(trx, room); return { revealed: true }; }
	await trx('coop_rooms').where('id', room.id).update({ phase: 'discuss', phase_at: trx.fn.now() });
	return { revealed: false };
}

/** Practice: "I am sure". When both have locked, the answer shows. */
export async function lockCoop(db: any, userId: string, roomId: string, idx: number) {
	return db.transaction(async (trx: any) => {
		const room = await trx('coop_rooms').where('id', roomId).forUpdate().first();
		if (!room) throw new CoopError('NO_ROOM');
		await memberOf(trx, roomId, userId);
		if (room.status !== 'playing' || room.mode === 'duel' || room.phase !== 'discuss' || idx !== room.idx) throw new CoopError('BAD_REQUEST');
		await trx('coop_answers').where({ room_id: roomId, idx: room.idx, user_id: userId }).update({ locked: true });
		const open = Number((await trx('coop_answers').where({ room_id: roomId, idx: room.idx, locked: false }).count('* as n').first())?.n) || 0;
		if (open === 0) { await toReveal(trx, room); return { revealed: true }; }
		await touch(trx, roomId);
		return { revealed: false };
	});
}

/** On to the next question, or close the room: practice gives the deposit back and a reward, a duel pays the pot */
async function advance(trx: any, room: any, today: string, forfeit?: string) {
	const last = room.idx + 1 >= (room.questions as any[]).length;
	if (!last && !forfeit) {
		if (room.mode === 'duel') await toListen(trx, room, room.idx + 1);
		else await trx('coop_rooms').where('id', room.id).update({ idx: room.idx + 1, phase: 'answer', play_seq: room.play_seq + 1, phase_at: trx.fn.now(), deadline_at: null });
		return { done: false, idx: room.idx + 1 };
	}
	await trx('coop_rooms').where('id', room.id).update({ status: 'done', done_at: trx.fn.now(), deadline_at: null });
	if (room.mode === 'duel') await settleDuel(trx, room, today, forfeit);
	return { done: true, idx: room.idx };
}

/** Next question (from "reveal"), practice only: a duel moves on by its own clock. Safe to press twice: the idx must match. */
export async function nextCoop(db: any, userId: string, roomId: string, idx: number, today = vnDay()) {
	return db.transaction(async (trx: any) => {
		const room = await trx('coop_rooms').where('id', roomId).forUpdate().first();
		if (!room) throw new CoopError('NO_ROOM');
		await memberOf(trx, roomId, userId);
		if (room.status === 'done') return { done: true, idx: room.idx };
		if (room.status !== 'playing') throw new CoopError('NOT_PLAYING');
		if (room.mode === 'duel' || idx !== room.idx || room.phase !== 'reveal') return { done: false, idx: room.idx };
		return advance(trx, room, today);
	});
}

/**
 * The clock: a duel's listen -> answer -> reveal -> next question, and a queue room nobody readied.
 * Returns true when something changed. Cheap when there is nothing to do, so getState and the hub's ticker call it freely.
 */
export async function advanceDue(db: any, roomId: string, today = vnDay()) {
	const peek = await db('coop_rooms').where('id', roomId).first('mode', 'status', 'deadline_at', 'auto');
	if (!peek || !peek.deadline_at || Date.now() < new Date(peek.deadline_at).getTime()) return false;
	const waitingAuto = peek.status === 'waiting' && peek.auto;
	if (!waitingAuto && (peek.mode !== 'duel' || peek.status !== 'playing')) return false;
	return db.transaction(async (trx: any) => {
		const room = await trx('coop_rooms').where('id', roomId).forUpdate().first();
		if (!room || !room.deadline_at || Date.now() < new Date(room.deadline_at).getTime()) return false;
		if (room.status === 'waiting' && room.auto) {
			// nobody started it in time: the fees go back, and whoever did not press "ready" cannot search for a moment
			const members = await trx('coop_members').where('room_id', roomId).select('user_id', 'ready');
			await refund(trx, room, members.map((m: any) => m.user_id), today);
			for (const m of members) if (!m.ready) await banFor(trx, m.user_id);
			await trx('coop_rooms').where('id', roomId).update({ status: 'cancelled', done_at: trx.fn.now(), deadline_at: null });
			return true;
		}
		if (room.mode !== 'duel' || room.status !== 'playing') return false;
		if (room.phase === 'listen') await toAnswer(trx, room);
		else if (room.phase === 'answer') await toReveal(trx, room);
		else await advance(trx, room, today);
		return true;
	});
}

/** What a typed text is graded against: the hidden phrase (a Đấu question) or the whole sentence */
const refOf = (q: any) => (q.kind === 'cloze' ? String(q.answer).toLowerCase() : String(q.text));

/** Points of one answer: typed questions keep them in `points`; an old gap room is worth by right + speed */
const ptsOf = (questions: any[], x: any) => (questions[x.idx]?.kind === 'dict' || questions[x.idx]?.kind === 'cloze' ? Number(x.points) || 0 : pointsOf(!!x.correct, x.ms ?? answerMs()));

/** Scores from the answers: points (right + speed), then the time taken (an unanswered question counts the full clock) */
async function settleDuel(trx: any, room: any, today: string, forfeit?: string) {
	const total = (room.questions as any[]).length;
	const members: Member[] = [];
	for (const m of await trx('coop_members').where('room_id', room.id).select('user_id')) {
		const ans = await trx('coop_answers').where({ room_id: room.id, user_id: m.user_id });
		const score = ans.reduce((n: number, x: any) => n + ptsOf(room.questions, x), 0);
		const time = ans.reduce((n: number, x: any) => n + (x.ms ?? 0), 0) + (total - ans.length) * answerMs();
		const forfeited = forfeit === m.user_id;
		await trx('coop_members').where({ room_id: room.id, user_id: m.user_id }).update({ score: forfeited ? 0 : score, time_ms: time });
		members.push({ user_id: m.user_id, score: forfeited ? -1 : score, time_ms: time });
	}
	const s = split(members, room.fee, COIN.room.rakePct);
	for (const id of s.winners) {
		if (s.each > 0) await earnCoins(trx, id, { reason: 'room_prize', amount: s.each, dedupe: `coop_prize:${room.id}:${id}`, meta: { room_id: room.id } }, today);
		await trx('coop_members').where({ room_id: room.id, user_id: id }).update({ prize: s.each });
	}
}

export async function chatCoop(db: any, userId: string, roomId: string, text: string) {
	const body = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_MSG);
	if (!body) throw new CoopError('BAD_REQUEST');
	const room = await db('coop_rooms').where('id', roomId).first('id', 'mode', 'status');
	if (!room) throw new CoopError('NO_ROOM');
	await memberOf(db, roomId, userId);
	if (room.mode === 'duel' && room.status === 'playing') throw new CoopError('NOT_PLAYING');
	const recent = Number((await db('coop_messages').where({ room_id: roomId, user_id: userId }).where('created_at', '>', new Date(Date.now() - 10_000)).count('* as n').first())?.n) || 0;
	if (recent >= 5) throw new CoopError('SLOW_DOWN');
	await db('coop_messages').insert({ room_id: roomId, user_id: userId, body });
	return { ok: true };
}

export async function leaveCoop(db: any, userId: string, roomId: string, today = vnDay()) {
	return db.transaction(async (trx: any) => {
		const room = await trx('coop_rooms').where('id', roomId).forUpdate().first();
		if (!room) throw new CoopError('NO_ROOM');
		await memberOf(trx, roomId, userId);
		if (room.status === 'waiting') {
			// a guest leaving a friend's room takes the fee back and the room keeps waiting; the host leaving (or anyone leaving a queue room) closes it and refunds everyone
			if (room.host_id !== userId && !room.auto) {
				await trx('coop_members').where({ room_id: roomId, user_id: userId }).delete();
				await refund(trx, room, [userId], today, false);
			} else {
				await refund(trx, room, await trx('coop_members').where('room_id', roomId).pluck('user_id'), today);
				await trx('coop_rooms').where('id', roomId).update({ status: 'cancelled', done_at: trx.fn.now(), deadline_at: null });
				if (room.auto) await banFor(trx, userId);
			}
		} else if (room.status === 'playing') {
			// leaving a duel forfeits it; leaving a practice loses the deposit and the one who stays gets theirs back
			if (room.mode === 'duel') await advance(trx, room, today, userId);
			else {
				await refund(trx, room, (await trx('coop_members').where('room_id', roomId).pluck('user_id')).filter((u: string) => u !== userId), today);
				await trx('coop_rooms').where('id', roomId).update({ status: 'cancelled', done_at: trx.fn.now(), deadline_at: null });
			}
		}
		return { left: true };
	});
}

/**
 * Presence. The page pings every 10 s; a member silent for PRESENCE_MS has left the room (as if they pressed "Leave":
 * a duel is forfeited, a practice loses the deposit). `bye` is sent when the tab closes: the member then has only
 * BYE_MS left, so the other player does not wait long, while a reload (which pings again at once) costs nothing.
 */
export const PRESENCE_MS = 45_000;
const BYE_MS = 10_000;

export async function pingCoop(db: any, userId: string, roomId: string, bye = false) {
	if (!/^[0-9a-f-]{36}$/i.test(roomId)) return { ok: false };
	const at = new Date(Date.now() - (bye ? PRESENCE_MS - BYE_MS : 0));
	await db('coop_members').where({ room_id: roomId, user_id: userId }).update({ last_seen: at });
	return { ok: true };
}

/** Members of open rooms who went silent leave their rooms. Returns the rooms that changed (to push to the one who stays). */
export async function sweepPresence(db: any, today = vnDay()) {
	const stale = await db('coop_members as m').join('coop_rooms as r', 'r.id', 'm.room_id').whereIn('r.status', ['waiting', 'playing'])
		.whereRaw('coalesce(m.last_seen, m.joined_at) < ?', [new Date(Date.now() - PRESENCE_MS)]).select('m.user_id', 'm.room_id');
	const changed = new Set<string>();
	for (const s of stale) {
		try { await leaveCoop(db, s.user_id, s.room_id, today); changed.add(s.room_id); } catch { /* the room closed meanwhile */ }
	}
	return [...changed];
}

const nameOf = (u: any) => [u.first_name, String(u.last_name || '').slice(0, 1)].filter(Boolean).join(' ') || 'Learner';

/**
 * What a player's browser needs now. The right answer and the full sentence stay on the server until "reveal";
 * before that the other player only shows as "answered" (a duel) or with the first pick (practice "discuss").
 * `since` is the last chat id the browser has.
 */
export async function getState(db: any, userId: string, roomId: string, since = 0) {
	await advanceDue(db, roomId);
	const room = await db('coop_rooms').where('id', roomId).first();
	if (!room) throw new CoopError('NO_ROOM');
	const members = await db('coop_members as m').join('directus_users as u', 'u.id', 'm.user_id').where('m.room_id', roomId).select('m.user_id', 'm.ready', 'm.lesson_price', 'u.first_name', 'u.last_name', 'u.country').orderBy('m.joined_at');
	const levels = new Map<string, number>();
	for (const m of members) levels.set(m.user_id, await levelOfUser(db, m.user_id));
	const me = members.find((m: any) => m.user_id === userId);
	const qs = room.questions as any[];
	const timed = room.status === 'playing' && room.deadline_at ? Math.max(0, new Date(room.deadline_at).getTime() - Date.now()) : null;
	const out: any = {
		id: room.id, status: room.status, joined: !!me, is_host: room.host_id === userId, size: SIZE, total: qs.length, idx: room.idx, phase: room.phase, play_seq: room.play_seq,
		mode: room.mode, fee: room.fee, auto: room.auto, seconds: COIN.coop.duelSeconds, rake_pct: COIN.room.rakePct, stars: room.stars,
		ends_in: room.mode === 'duel' ? timed : room.status === 'waiting' && room.auto && room.deadline_at ? Math.max(0, new Date(room.deadline_at).getTime() - Date.now()) : null,
		play_in: room.mode === 'duel' && room.status === 'playing' && room.phase === 'listen' ? Math.max(0, new Date(room.phase_at).getTime() + COIN.coop.duelLead - Date.now()) : null,
		reward: COIN.coop.reward, players: members.map((m: any) => ({ you: m.user_id === userId, host: m.user_id === room.host_id, name: nameOf(m), country: m.country ? String(m.country).trim() : null, ready: !!m.ready, level: levels.get(m.user_id) || 1 })),
	};
	if (!me) return out;
	if (room.mode !== 'duel' && room.lesson_id) {
		// Luyện cùng: the lesson and what this player pays for it (the fee for being together is in `fee`)
		const l = await db('listening_lessons').where('id', room.lesson_id).first('text', 'kind');
		out.lesson = { title: l?.text || '', price: Number(me.lesson_price) || 0 };
	}
	if (room.status === 'playing' || room.status === 'done') {
		const i = room.status === 'done' ? qs.length - 1 : room.idx;
		const q = qs[i] as any;
		const typed = q.kind === 'dict' || q.kind === 'cloze';
		out.question = q.kind === 'cloze'
			? { kind: 'cloze', blank: q.blank, words: words(q.answer), video: { id: q.video_id, start: q.start, end: q.end } }
			: typed
			? { kind: 'dict', words: tokens(q.text).length, video: { id: q.video_id, start: q.start, end: q.end } }
			: { kind: 'gap', blank: q.blank, options: q.options, video: { id: q.video_id, start: q.start, end: q.end } };
		const ans = await db('coop_answers').where({ room_id: roomId, idx: i });
		const mine = ans.find((a: any) => a.user_id === userId);
		const textOf = (a: any) => (a ? (a.typed2 ?? a.typed ?? null) : null);
		out.my_choice = mine ? mine.choice : null;
		out.my_final = mine ? (mine.choice2 ?? mine.choice) : null;
		out.my_text = textOf(mine);
		out.my_locked = !!mine?.locked;
		out.answered = ans.length;
		if (typed && room.phase === 'discuss') {
			// both texts are open now (the sentence is not)
			out.picks = members.map((m: any) => { const a = ans.find((x: any) => x.user_id === m.user_id); return { you: m.user_id === userId, name: nameOf(m), text: textOf(a), locked: !!a?.locked }; });
		}
		if (room.phase === 'reveal' || room.status === 'done') {
			out.reveal = typed
				? {
					sentence: q.text, ...(q.kind === 'cloze' ? { answer: q.answer } : {}),
					picks: members.map((m: any) => { const a = ans.find((x: any) => x.user_id === m.user_id); const g = diffWords(refOf(q), textOf(a) ?? ''); return { you: m.user_id === userId, name: nameOf(m), text: textOf(a), words: g.words, right: g.right, total: g.total, ok: isRight(g), points: room.mode === 'duel' && a ? ptsOf(qs, a) : 0, ms: a?.ms ?? null }; }),
				}
				: {
					correct: q.correct, word: q.word, sentence: q.blank.replace('_____', q.word),
					picks: members.map((m: any) => { const a = ans.find((x: any) => x.user_id === m.user_id); return { you: m.user_id === userId, name: nameOf(m), choice: a ? (a.choice2 ?? a.choice) : null, first: a?.choice ?? null, points: room.mode === 'duel' ? pointsOf(!!a?.correct, a?.ms ?? answerMs()) : 0, ms: a?.ms ?? null }; }),
				};
		}
		const mineAll = await db('coop_answers').where({ room_id: roomId, user_id: userId });
		out.my_right = mineAll.filter((x: any) => x.correct && (x.idx < room.idx || room.phase === 'reveal' || room.status === 'done')).length;
		if (room.mode === 'duel') {
			// the score so far (the answers of questions already shown)
			const scoreOf = async (uid: string) => (await db('coop_answers').where({ room_id: roomId, user_id: uid })).filter((x: any) => x.idx < room.idx || room.phase === 'reveal' || room.status === 'done').reduce((n: number, x: any) => n + ptsOf(qs, x), 0);
			out.scores = await Promise.all(members.map(async (m: any) => ({ you: m.user_id === userId, name: nameOf(m), points: await scoreOf(m.user_id) })));
		}
		if (room.status === 'done') {
			const rows = await db('coop_members').where('room_id', roomId).select('user_id', 'score', 'time_ms', 'prize');
			if (room.mode === 'duel') out.results = members.map((m: any) => { const r = rows.find((x: any) => x.user_id === m.user_id); return { you: m.user_id === userId, name: nameOf(m), score: r?.score ?? 0, time_ms: r?.time_ms ?? 0, prize: r?.prize ?? 0 }; });
			else out.paid = rows.find((r: any) => r.user_id === userId)?.prize ?? 0;
			const all = await db('coop_answers').where('room_id', roomId);
			out.review = (qs as any[]).map((x, n) => ({
				sentence: x.kind === 'dict' || x.kind === 'cloze' ? x.text : x.blank.replace('_____', x.word), video: { id: x.video_id, start: x.start, end: x.end },
				picks: members.map((m: any) => { const a = all.find((r: any) => r.idx === n && r.user_id === m.user_id); return { you: m.user_id === userId, correct: !!a?.correct, points: room.mode === 'duel' && a ? ptsOf(qs, a) : 0 }; }),
			}));
		}
	}
	const msgs = await db('coop_messages').where('room_id', roomId).where('id', '>', since).orderBy('id').limit(100);
	out.messages = msgs.map((m: any) => ({ id: Number(m.id), you: m.user_id === userId, name: nameOf(members.find((x: any) => x.user_id === m.user_id) || {}), body: m.body }));
	return out;
}

/** The lobby. A visitor (userId null) sees the rooms waiting and who is around, with no room or results of their own */
export async function listCoop(db: any, userId: string | null) {
	const waiting = await db('coop_rooms as r').join('directus_users as u', 'u.id', 'r.host_id').where('r.status', 'waiting').where('r.auto', false).modify((q: any) => { if (userId) q.whereNot('r.host_id', userId); })
		.where('r.phase_at', '>', new Date(Date.now() - 30 * 60_000))
		.select('r.id', 'r.mode', 'r.fee', 'u.first_name', 'u.last_name', 'r.created_at').orderBy('r.created_at', 'desc').limit(20);
	const mine = !userId ? null : await db('coop_rooms as r').join('coop_members as m', 'm.room_id', 'r.id').where('m.user_id', userId).whereIn('r.status', ['waiting', 'playing']).first('r.id', 'r.status');
	// who is around, per mode: players in a room being played, and players waiting in the match queue
	const playing: Record<string, number> = { duel: 0, practice: 0 };
	for (const r of await db('coop_members as m').join('coop_rooms as r', 'r.id', 'm.room_id').where('r.status', 'playing').groupBy('r.mode').select('r.mode').count('* as n')) playing[r.mode] = Number(r.n) || 0;
	const searching: Record<string, number> = { duel: 0, practice: 0 };
	for (const q of await db('match_queue').groupBy('mode').select('mode').count('* as n')) searching[q.mode] = Number(q.n) || 0;
	const recent = !userId ? [] : await db('coop_members as m').join('coop_rooms as r', 'r.id', 'm.room_id').where({ 'm.user_id': userId, 'r.mode': 'duel', 'r.status': 'done' }).orderBy('r.done_at', 'desc').limit(5).select('r.id', 'm.prize', 'm.score', 'r.fee');
	const items = [];
	for (const r of recent) {
		const other = await db('coop_members as m').join('directus_users as u', 'u.id', 'm.user_id').where('m.room_id', r.id).whereNot('m.user_id', userId).first('m.score', 'u.first_name', 'u.last_name');
		items.push({ id: r.id, won: (r.prize || 0) > 0, delta: (r.prize || 0) > 0 ? (r.prize || 0) - r.fee : -r.fee, you: r.score ?? 0, them: other?.score ?? 0, name: other ? nameOf(other) : '' });
	}
	return {
		waiting: waiting.map((w: any) => ({ id: w.id, host: nameOf(w), mode: w.mode, fee: w.fee })), mine: mine || null, reward: COIN.coop.reward, deposit: COIN.coop.deposit, per_day: COIN.coop.perDay,
		fees: FEES, rake_pct: COIN.room.rakePct, playing, searching, recent: items,
	};
}

/** Rooms nobody has touched for a while: a waiting room is closed and the fees go back; practice is closed and refunded; a duel is scored with what was answered */
export async function sweepCoop(db: any, today = vnDay()) {
	const idle = await db('coop_rooms').whereIn('status', ['waiting', 'playing']).where('phase_at', '<', new Date(Date.now() - IDLE_MIN * 60_000)).pluck('id');
	for (const id of idle) {
		await db.transaction(async (trx: any) => {
			const room = await trx('coop_rooms').where('id', id).forUpdate().first();
			if (!room || !['waiting', 'playing'].includes(room.status)) return;
			if (room.status === 'playing' && room.mode === 'duel') { await advance(trx, room, today, 'nobody'); return; }
			await refund(trx, room, await trx('coop_members').where('room_id', id).pluck('user_id'), today);
			await trx('coop_rooms').where('id', id).update({ status: 'cancelled', done_at: trx.fn.now(), deadline_at: null });
		});
	}
	return idle.length as number;
}
