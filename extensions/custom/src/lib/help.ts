/**
 * Cùng luyện không đồng thời: a learner who got a question right may leave a hint for the next one; a
 * learner stuck on it may take hints (web repo docs/xu-v2-tasks.md P6). The helper earns a few Kim cương
 * when a hint is used by someone else, up to COIN.help.perDay times a day. No chat, no names: a hint is
 * one short line of a fixed kind, and it must not hold a word of the answer.
 */
import { COIN, earnCoins } from './coins';
import { vnDay } from './days';

export const HINT_KINDS = ['position', 'rule', 'slow', 'letter'] as const;
export type HintKind = (typeof HINT_KINDS)[number];
const MAX_LEN = 140;

export class HelpError extends Error {
	constructor(public code: 'BAD_REQUEST' | 'NOT_YET' | 'HINT_LEAKS' | 'TOO_LONG' | 'ALREADY' | 'NO_HINT' | 'OWN') { super(code); }
}

const words = (s: string) => (s.toLowerCase().match(/[a-z']+/g) || []).filter((w) => w.length >= 3);

/** Does the hint hold a word of the answer? (the answer's words of 3 letters or more, whole words) */
export function leaks(body: string, answer: string) {
	const mine = new Set(words(body));
	return words(answer).some((w) => mine.has(w));
}

/** Check a hint before saving it: its kind, its length, and that it keeps the answer to itself */
export function checkHint(kind: string, body: string, answer: string) {
	if (!HINT_KINDS.includes(kind as HintKind)) throw new HelpError('BAD_REQUEST');
	const text = body.replace(/\s+/g, ' ').trim();
	if (text.length < 1 || (kind !== 'letter' && text.length < 3)) throw new HelpError('BAD_REQUEST');
	if (text.length > MAX_LEN) throw new HelpError('TOO_LONG');
	if (kind === 'letter' && !/^[A-Za-z]$/.test(text)) throw new HelpError('BAD_REQUEST');
	if (kind !== 'letter' && leaks(text, answer)) throw new HelpError('HINT_LEAKS');
	return text;
}

export async function leaveHint(db: any, userId: string, a: { clipId: string; kind: string; body: string }) {
	const clip = await db('listening_clips').select('id', 'lesson_id', 'answer', 'focus_text', 'transcript').where('id', a.clipId).first();
	if (!clip) throw new HelpError('BAD_REQUEST');
	// Only after hearing it right
	const right = await db('listening_attempts').where({ user_id: userId, clip_id: a.clipId, is_correct: true }).first('id');
	if (!right) throw new HelpError('NOT_YET');
	const text = checkHint(a.kind, a.body, [clip.answer, clip.focus_text, clip.transcript].filter(Boolean).join(' '));
	const row = await db('help_hints').insert({ clip_id: clip.id, lesson_id: clip.lesson_id, user_id: userId, kind: a.kind, body: text }).onConflict(['user_id', 'clip_id', 'kind']).ignore().returning('id');
	if (!row.length) throw new HelpError('ALREADY');
	return { id: row[0].id ?? row[0] };
}

/** Hints for a clip, the most used first; never the learner's own. `used` = already taken by this learner. */
export async function hintsFor(db: any, userId: string, clipId: string) {
	const rows = await db('help_hints as h').leftJoin('help_uses as u', function (this: any) { this.on('u.hint_id', 'h.id').andOn('u.user_id', db.raw('?', [userId])); })
		.where('h.clip_id', clipId).where('h.hidden', false).whereNot('h.user_id', userId)
		.orderBy('h.uses', 'desc').limit(6).select('h.id', 'h.kind', 'h.body', 'h.uses', db.raw('u.hint_id IS NOT NULL AS used'));
	return rows.map((r: any) => ({ id: r.id, kind: r.kind, body: r.body, uses: Number(r.uses), used: !!r.used }));
}

/** A learner takes a hint: counted once per learner; the helper earns once per use, up to perDay a day */
export async function useHint(db: any, userId: string, hintId: string, today = vnDay()) {
	return db.transaction(async (trx: any) => {
		const hint = await trx('help_hints').where({ id: hintId, hidden: false }).first();
		if (!hint) throw new HelpError('NO_HINT');
		if (hint.user_id === userId) throw new HelpError('OWN');
		const first = await trx('help_uses').insert({ hint_id: hintId, user_id: userId }).onConflict(['hint_id', 'user_id']).ignore().returning('hint_id');
		if (!first.length) return { body: hint.body, kind: hint.kind, rewarded: false };
		await trx('help_hints').where('id', hintId).increment('uses', 1);
		const todayCount = Number((await trx('coin_events').where({ user_id: hint.user_id, reason: 'help', day: today }).count('* as n').first())?.n) || 0;
		let rewarded = false;
		if (todayCount < COIN.help.perDay && COIN.help.reward > 0) {
			const r = await earnCoins(trx, hint.user_id, { reason: 'help', amount: COIN.help.reward, dedupe: `help:${hintId}:${userId}`, meta: { hint_id: hintId } }, today);
			rewarded = r.added > 0;
		}
		return { body: hint.body, kind: hint.kind, rewarded };
	});
}
