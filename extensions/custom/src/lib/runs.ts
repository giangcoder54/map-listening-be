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
/** Skip-ahead of one lesson: a few new phrases, 2 listens, no slow play nor "I can't hear it" */
export const LESSON_TEST = { size: 4, maxListens: 2 };
/** Listens per item by run mode */
export const MAX_LISTENS: Record<string, number> = { learn: RUN.maxListens, review: RUN.maxListens, lesson_test: LESSON_TEST.maxListens, skill_test: LESSON_TEST.maxListens };

export type Phase = 'pre' | 'voice' | 'practice' | 'retry' | 'challenge' | 'post' | 'test' | 'review';
export type Format = 'type' | 'gap' | 'choice' | 'tap';
export const FORMATS: Format[] = ['type', 'gap', 'choice', 'tap'];
export type ItemResult = { correct: boolean; answer: string; listens: number; slow: boolean; hint: boolean };
/** lesson_id: the form the clip belongs to (tests of a rule and reviews mix forms) */
export type RunItem = { clip_id: string; phase: Phase; format: Format; lesson_id?: string; result?: ItemResult | null };

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

/** Clips not met first, in random order */
const freshFirst = (list: PoolClip[], met: Set<string>, rand: () => number) =>
	shuffle(list, rand).sort((a, b) => Number(met.has(a.id)) - Number(met.has(b.id)));

/** Difficulty wanted for the n-th test item: easy and medium mostly, a hard one in five */
const DIFFICULTY_CYCLE = [1, 2, 2, 1, 3];

/**
 * A skip-ahead or final test, drawn for each learner and each try from the pool and trap
 * clips of the given forms (one form: a lesson's skip-ahead; every form of a rule: the
 * rule's test). The rules every draw keeps:
 *   - the forms take turns, so each one is asked about (as evenly as `size` allows)
 *   - at least one trap when the forms have one
 *   - difficulties mixed (DIFFICULTY_CYCLE), clips the learner has not met first
 * Items are typed (the whole phrase, or the part with the rule for a long sentence).
 */
export function drawTest(
	forms: { lessonId: string; clips: PoolClip[] }[],
	size: number,
	met: Set<string> = new Set(),
	rand: () => number = Math.random,
): RunItem[] {
	const queues = shuffle(forms, rand)
		.map((f) => ({ lessonId: f.lessonId, left: freshFirst(f.clips.filter((c) => c.role === 'pool' || c.role === 'trap'), met, rand) }))
		.filter((q) => q.left.length);
	const picked: { lessonId: string; clip: PoolClip }[] = [];
	// Not met comes first, then the difficulty wanted among those
	const takeFrom = (q: (typeof queues)[number], want: number) => {
		const fresh = q.left.filter((c) => !met.has(c.id)).length || q.left.length;
		const i = Math.max(0, q.left.slice(0, fresh).findIndex((c) => (c.difficulty ?? 2) === want));
		return q.left.splice(i, 1)[0]!;
	};
	let turn = 0;
	while (picked.length < size && queues.some((q) => q.left.length)) {
		const q = queues[turn % queues.length]!;
		turn++;
		if (!q.left.length) continue;
		picked.push({ lessonId: q.lessonId, clip: takeFrom(q, DIFFICULTY_CYCLE[picked.length % DIFFICULTY_CYCLE.length]!) });
	}
	// A trap that did not come up in turn replaces a pick of the same form, so the forms stay even
	if (picked.length && !picked.some((p) => p.clip.role === 'trap')) {
		const q = queues.find((x) => x.left.some((c) => c.role === 'trap'));
		if (q) {
			const trap = q.left.splice(q.left.findIndex((c) => c.role === 'trap'), 1)[0]!;
			let at = picked.map((p) => p.lessonId).lastIndexOf(q.lessonId);
			if (at < 0) at = picked.length - 1;
			picked[at] = { lessonId: q.lessonId, clip: trap };
		}
	}
	return shuffle(picked, rand).map((p) => ({ clip_id: p.clip.id, lesson_id: p.lessonId, phase: 'test', format: formatFor(p.clip, 'post'), result: null }));
}

/**
 * A review: one new clip for each form due (in the order given, most overdue first), at most
 * `limit`. Clips the learner has met come last, so a review is a phrase not heard before
 * whenever the pool still has one.
 */
export function drawReview(
	due: { lessonId: string; clips: PoolClip[] }[],
	limit: number,
	met: Set<string> = new Set(),
	rand: () => number = Math.random,
): RunItem[] {
	const out: RunItem[] = [];
	for (const form of due) {
		if (out.length >= limit) break;
		const clip = freshFirst(form.clips.filter((c) => c.role === 'pool' || c.role === 'trap' || c.role === 'core'), met, rand)[0];
		if (clip) out.push({ clip_id: clip.id, lesson_id: form.lessonId, phase: 'review', format: formatFor(clip, 'post'), result: null });
	}
	return out;
}

/** Passed a skip-ahead or final test: at least `ratio` of the items right */
export const passed = (items: RunItem[], ratio: number) => {
	const done = items.filter((it) => it.result);
	return done.length > 0 && done.filter((it) => it.result!.correct).length / done.length >= ratio - 1e-9;
};

/** The forms missed most in a test, worst first: where to send a learner who failed */
export function weakestForms(items: RunItem[]) {
	const miss = new Map<string, number>();
	for (const it of items) if (it.lesson_id && it.result && !it.result.correct) miss.set(it.lesson_id, (miss.get(it.lesson_id) || 0) + 1);
	return [...miss.entries()].sort((a, b) => b[1] - a[1]).map(([lessonId, missed]) => ({ lessonId, missed }));
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
