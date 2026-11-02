/**
 * A run: one sitting of a lesson (database/migrations/2026-11-02_rule_flow.sql, listening_runs).
 *
 * The team only writes content: a lesson (one form of a rule) and its pool of clips, each with
 * a role. The server builds the lesson from it, a different one on every go:
 *
 *   pre        3   core + pool, listened to at most 3 times, right or wrong it goes on
 *   (the explanation screen comes here, between pre and voice: the page shows it)
 *   voice      1-2 the core phrase said by other people
 *   practice   5-6 pool + 1 trap, easy to hard, formats from easy to hard (choice, tap, gap, type)
 *   retry          a practice item missed is asked once more at the end of practice
 *   challenge  1   fast or long clip
 *   post       3   pool phrases not met in pre
 *
 * Every item is answered once. The result is stored in the item itself (items jsonb), so a
 * guest's run works the same and the summary needs no query.
 * Pure functions here; the routes (v1/runRoutes.ts) read and write the rows.
 */
import { normalizeAnswer } from '../v1/engagementRoutes';

export const RUN = { pre: 3, voice: 2, practice: 6, challenge: 1, post: 3, maxListens: 3 };

export type Phase = 'pre' | 'voice' | 'practice' | 'retry' | 'challenge' | 'post';
export type Format = 'type' | 'gap' | 'choice' | 'tap';
export const FORMATS: Format[] = ['type', 'gap', 'choice', 'tap'];
export type ItemResult = { correct: boolean; answer: string; listens: number; slow: boolean; hint: boolean };
export type RunItem = { clip_id: string; phase: Phase; format: Format; result?: ItemResult | null };

/** What drawing needs to know of a clip */
export type PoolClip = {
	id: string;
	role: 'core' | 'voice' | 'pool' | 'challenge' | 'trap';
	answer: string;
	focus: string | null;
	difficulty: number | null;
	/** answer_format set by the team: that format whenever the clip supports it */
	forced: string | null;
	/** Wrong choices exist (its own, or other phrases of the lesson / rule) */
	hasChoices: boolean;
};

const words = (s: string) => normalizeAnswer(s).split(' ').filter(Boolean);

/** The focus is part of the answer: a gap or a word to tap makes sense */
const focusFits = (c: PoolClip) => {
	if (!c.focus) return false;
	const f = normalizeAnswer(c.focus);
	return !!f && normalizeAnswer(c.answer).includes(f) && f !== normalizeAnswer(c.answer);
};

export function supports(c: PoolClip, format: Format) {
	if (format === 'type') return true;
	if (format === 'choice') return c.hasChoices;
	return focusFits(c);
}

/**
 * The format of an item. Typing items (pre, voice, retry, post) type the whole phrase, or only
 * the part with the rule when the clip is a long sentence. Practice walks from the easiest
 * format to typing; `n` is the item's place in practice.
 */
export function formatFor(c: PoolClip, phase: Phase, n = 0): Format {
	if (c.forced && (FORMATS as string[]).includes(c.forced) && supports(c, c.forced as Format)) return c.forced as Format;
	const long = focusFits(c) && words(c.answer).length > words(c.focus!).length + 2;
	if (phase === 'challenge') return focusFits(c) ? 'gap' : 'type';
	if (phase !== 'practice') return long ? 'gap' : 'type';
	const ladder: Format[] = ['choice', 'tap', 'gap', 'type'];
	// Early items start low on the ladder, late ones high
	for (let i = Math.min(ladder.length - 1, Math.floor(n / 2)); i < ladder.length; i++) {
		if (supports(c, ladder[i]!)) return ladder[i]!;
	}
	return 'type';
}

function shuffle<T>(list: T[], rand: () => number): T[] {
	const out = [...list];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

/**
 * The items of a "learn" run. `met`: clips this learner answered before (drawn last).
 * A small pool gives a shorter lesson: post never repeats a phrase of pre; practice may reuse
 * pre and post clips when the pool has nothing left.
 */
export function drawLesson(pool: PoolClip[], met: Set<string> = new Set(), rand: () => number = Math.random): RunItem[] {
	const fresh = (role: PoolClip['role']) =>
		shuffle(pool.filter((c) => c.role === role), rand).sort((a, b) => Number(met.has(a.id)) - Number(met.has(b.id)));
	const used = new Set<string>();
	const take = (list: PoolClip[], n: number, ok: (c: PoolClip) => boolean = () => true) => {
		const out: PoolClip[] = [];
		for (const c of list) {
			if (out.length >= n) break;
			if (used.has(c.id) || !ok(c)) continue;
			used.add(c.id);
			out.push(c);
		}
		return out;
	};

	const core = pool.find((c) => c.role === 'core') || null;
	if (core) used.add(core.id);
	const pooled = fresh('pool');
	const pre = [...(core ? [core] : []), ...take(pooled, RUN.pre - (core ? 1 : 0))];
	const preAnswers = new Set(pre.map((c) => normalizeAnswer(c.answer)));
	const post = take(pooled, RUN.post, (c) => !preAnswers.has(normalizeAnswer(c.answer)));
	const voice = take(fresh('voice'), RUN.voice);
	let practice = take(pooled, RUN.practice - 1);
	if (practice.length < 3) practice = [...practice, ...shuffle([...pre, ...post].filter((c) => !practice.includes(c)), rand)].slice(0, RUN.practice - 1);
	practice.sort((a, b) => (a.difficulty ?? 2) - (b.difficulty ?? 2));
	const trap = take(fresh('trap'), 1);
	if (trap.length) practice.splice(Math.ceil(practice.length / 2), 0, trap[0]!);
	const challenge = take(fresh('challenge'), RUN.challenge);

	const item = (c: PoolClip, phase: Phase, n = 0): RunItem => ({ clip_id: c.id, phase, format: formatFor(c, phase, n), result: null });
	return [
		...pre.map((c) => item(c, 'pre')),
		...voice.map((c) => item(c, 'voice')),
		...practice.map((c, n) => item(c, 'practice', n)),
		...challenge.map((c) => item(c, 'challenge')),
		...post.map((c) => item(c, 'post')),
	];
}

/** Right or wrong, by format: the phrase, or only the part with the rule (gap, tap) */
export function isRight(c: PoolClip, format: Format, given: string) {
	const g = normalizeAnswer(given);
	if (!g) return false;
	if ((format === 'gap' || format === 'tap') && focusFits(c)) return g === normalizeAnswer(c.focus!);
	return g === normalizeAnswer(c.answer);
}

/**
 * A practice item missed comes back once, as a typing item, after the last practice item.
 * Returns the new list (unchanged when it already came back).
 */
export function withRetry(items: RunItem[], position: number): RunItem[] {
	const missed = items[position];
	if (!missed || missed.phase !== 'practice') return items;
	if (items.some((it) => it.phase === 'retry' && it.clip_id === missed.clip_id)) return items;
	let last = position;
	items.forEach((it, i) => { if (it.phase === 'practice' || it.phase === 'retry') last = Math.max(last, i); });
	const out = [...items];
	out.splice(last + 1, 0, { clip_id: missed.clip_id, phase: 'retry', format: 'type', result: null });
	return out;
}

/** The end of a run: what the summary shows and what the rewards depend on */
export function summaryOf(items: RunItem[]) {
	const answered = items.filter((it) => it.result);
	const firstWrong = items.findIndex((it) => it.result && !it.result.correct && it.phase !== 'retry');
	const post = items.filter((it) => it.phase === 'post');
	return {
		total: answered.length,
		right: answered.filter((it) => it.result!.correct).length,
		/** Index of the first item missed: "listen again to the first one you missed" */
		first_wrong: firstWrong >= 0 ? firstWrong : null,
		/** Every phrase of the retest right */
		perfect: post.length > 0 && post.every((it) => it.result?.correct),
		/** An answer looked at ("I can't hear it") */
		hinted: answered.some((it) => it.result!.hint),
		finished: items.length > 0 && items.every((it) => it.result),
	};
}
