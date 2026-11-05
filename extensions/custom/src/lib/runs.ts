/**
 * A run: one sitting of a lesson (database/migrations/2026-11-02_rule_flow.sql, listening_runs).
 *
 * The team only writes content: a lesson (one form of a rule) and its pool of clips, each with
 * a role. The server builds the lesson from it, a different one on every go:
 *
 *   pre        2   core + pool, listened to at most 3 times, right or wrong it goes on
 *   (the explanation screen comes here, between pre and voice: the page shows it)
 *   voice      1-2 the core phrase said by other people
 *   practice   4   the steps the team wrote (listening_lessons.practice: 3 pool + 1 trap, each a
 *                  choice, a word bank or a gap); none written: 3 pool + 1 trap drawn, formats
 *                  from easy to hard (choice, bank, gap)
 *   challenge  1   fast or long clip
 *   retry          a practice item missed is asked once more, at the very end
 *
 * Every item is answered once. The result is stored in the item itself (items jsonb), so a
 * guest's run works the same and the summary needs no query.
 * Pure functions here; the routes (v1/runRoutes.ts) read and write the rows.
 */
import { normalizeAnswer } from '../v1/engagementRoutes';
import { MIXED, reviewOfValue } from './lessons';

export const RUN = { pre: 2, voice: 2, practice: 4, challenge: 1, maxListens: 3 };
/** Skip-ahead of one lesson: a few new phrases, 2 listens, no slow play nor "I can't hear it" */
export const LESSON_TEST = { size: 4, maxListens: 2 };
/** Listens per item by run mode */
export const MAX_LISTENS: Record<string, number> = { learn: RUN.maxListens, review: RUN.maxListens, lesson_test: LESSON_TEST.maxListens, skill_test: LESSON_TEST.maxListens };
/** Tries (hearts) at a typed item; tests and picked answers (choice, word bank) get one */
export const TRIES = 3;
export function triesFor(mode: string, format: Format) {
	return (mode === 'learn' || mode === 'review') && (format === 'type' || format === 'gap') ? TRIES : 1;
}

/** 'post' (a final check of 2 new phrases) is no longer drawn: only older runs have it */
export type Phase = 'pre' | 'voice' | 'practice' | 'retry' | 'challenge' | 'post' | 'test' | 'review';
/** bank: the words of the part with the rule, mixed with wrong ones, put back in order */
export type Format = 'type' | 'gap' | 'choice' | 'tap' | 'bank';
export const FORMATS: Format[] = ['type', 'gap', 'choice', 'tap', 'bank'];
/** time_ms: from the item shown to its last answer (older runs have none) */
export type ItemResult = { correct: boolean; answer: string; listens: number; slow: boolean; hint: boolean; time_ms?: number | null };
/**
 * lesson_id: the form the clip belongs to (tests of a rule and reviews mix forms)
 * wrong: the wrong choices or extra tiles of a step the team wrote (else the clip's own)
 */
/** tries: wrong answers given so far at a typed item, before its last one (result) */
export type RunItem = { clip_id: string; phase: Phase; format: Format; lesson_id?: string; wrong?: string[]; tries?: number; result?: ItemResult | null };

/**
 * A step of the practice the team wrote (listening_lessons.practice). prompt: the question the
 * learner reads instead of the format's own ("Phân biệt tell them và tell him"), optional
 */
export type PracticeStep = { clip_id: string; format: 'choice' | 'bank' | 'gap'; wrong: string[]; prompt?: string };
export const PROMPT_MAX = 120;
/** wrong: least wrong answers a step needs, by format (a choice needs 2+ options in all) */
export const PRACTICE = { steps: 4, traps: 1, wrong: { choice: 1, bank: 2 }, formats: ['choice', 'bank', 'gap'] as const };

/** The steps of listening_lessons.practice, whatever the column holds */
export function practiceOf(value: unknown): PracticeStep[] {
	const list = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
	if (!Array.isArray(list)) return [];
	return list
		.filter((s: any) => s && typeof s.clip_id === 'string' && (PRACTICE.formats as readonly string[]).includes(s.format))
		.map((s: any) => ({
			clip_id: s.clip_id,
			format: s.format,
			wrong: Array.isArray(s.wrong) ? s.wrong.map((w: unknown) => String(w ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean) : [],
			...(promptOf(s.prompt) ? { prompt: promptOf(s.prompt) } : {}),
		}));
}

/** A step's question, one line, cut to PROMPT_MAX ('' = none) */
export function promptOf(value: unknown): string {
	return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, PROMPT_MAX) : '';
}

/** What drawing needs to know of a clip */
export type PoolClip = {
	id: string;
	role: 'core' | 'voice' | 'pool' | 'challenge' | 'trap';
	answer: string;
	focus: string | null;
	difficulty: number | null;
	/** answer_format set by the team: that format whenever the clip supports it */
	forced: string | null;
	/** The clip has wrong choices of its own (nothing is borrowed from other clips) */
	hasChoices: boolean;
	/** Those wrong choices */
	wrong?: string[];
};

const words = (s: string) => normalizeAnswer(s).split(' ').filter(Boolean);

/** The focus is part of the answer: a gap or a word to tap makes sense */
export const focusFits = (c: Pick<PoolClip, 'answer' | 'focus'>) => {
	if (!c.focus) return false;
	const f = normalizeAnswer(c.focus);
	return !!f && normalizeAnswer(c.answer).includes(f) && f !== normalizeAnswer(c.answer);
};

/** What a choice, a word bank, a gap or a tap asks for: the part with the rule, else the phrase */
export const targetOf = (c: Pick<PoolClip, 'answer' | 'focus'>) => (focusFits(c) ? c.focus!.replace(/\s+/g, ' ').trim() : c.answer);

export function supports(c: PoolClip, format: Format) {
	if (format === 'type') return true;
	if (format === 'choice' || format === 'bank') return c.hasChoices;
	return focusFits(c);
}

/** A random source that gives the same draws for the same seed (resuming must not reshuffle) */
function seeded(seed: string) {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
	return () => {
		h = Math.imul(h ^ (h >>> 15), 2246822507);
		h = Math.imul(h ^ (h >>> 13), 3266489909);
		return ((h ^= h >>> 16) >>> 0) / 4294967296;
	};
}

/** The choices of a choice item: what it asks for and the wrong ones, in a fixed order per clip */
export function choicesFor(c: PoolClip, wrong: string[]): string[] | null {
	const target = targetOf(c);
	const seen = new Set([normalizeAnswer(target)]);
	const out: string[] = [];
	for (const w of wrong) {
		const k = normalizeAnswer(w);
		if (!k || seen.has(k)) continue;
		seen.add(k);
		out.push(w.replace(/\s+/g, ' ').trim());
		if (out.length >= 5) break;
	}
	return out.length ? shuffle([target, ...out], seeded(`${c.id}:choices`)) : null;
}

/**
 * The tiles of a word bank: the words of what it asks for, and wrong words (the ones of the
 * wrong choices that are not in the answer), mixed in a fixed order per clip.
 */
export function tilesFor(c: PoolClip, wrong: string[]): string[] {
	const right = targetOf(c).split(/\s+/).filter(Boolean);
	const seen = new Set(right.map(normalizeAnswer));
	const extra: string[] = [];
	for (const w of wrong.flatMap((x) => x.split(/\s+/))) {
		const k = normalizeAnswer(w);
		if (!k || seen.has(k)) continue;
		seen.add(k);
		extra.push(w);
		if (extra.length >= 5) break;
	}
	return shuffle([...right, ...extra], seeded(`${c.id}:tiles`));
}

/**
 * The format of an item. Typing items (pre, voice, retry, tests, reviews) type the whole phrase, or only
 * the part with the rule when the clip is a long sentence. Practice walks from the easiest
 * format to typing; `n` is the item's place in practice.
 */
export function formatFor(c: PoolClip, phase: Phase, n = 0): Format {
	if (c.forced && (FORMATS as string[]).includes(c.forced) && supports(c, c.forced as Format)) return c.forced as Format;
	const long = focusFits(c) && words(c.answer).length > words(c.focus!).length + 2;
	if (phase === 'challenge') return focusFits(c) ? 'gap' : 'type';
	if (phase !== 'practice') return long ? 'gap' : 'type';
	const ladder: Format[] = ['choice', 'bank', 'gap'];
	// The n-th item starts at the n-th step of the ladder, climbs, then comes back down
	const start = Math.min(ladder.length - 1, n);
	for (let i = start; i < ladder.length; i++) if (supports(c, ladder[i]!)) return ladder[i]!;
	for (let i = start - 1; i >= 0; i--) if (supports(c, ladder[i]!)) return ladder[i]!;
	return 'type';
}

/**
 * The format a written step is asked in: its own, unless the clip lost what it needs. A gap
 * whose [bracketed] answer is the whole of what is asked is typed in the subtitle line.
 */
function stepFormat(c: PoolClip, step: PracticeStep, n: number): Format {
	if (step.format === 'gap') return focusFits(c) ? 'gap' : 'type';
	if (step.wrong.length || c.hasChoices) return step.format;
	return formatFor(c, 'practice', n);
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
 * `script`: the practice the team wrote; its clips are kept out of pre. Without one, practice
 * is drawn; it may reuse pre clips when the pool has nothing left.
 */
export function drawLesson(pool: PoolClip[], met: Set<string> = new Set(), rand: () => number = Math.random, script: PracticeStep[] = []): RunItem[] {
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

	const byId = new Map(pool.map((c) => [c.id, c]));
	const steps = script.filter((s) => byId.has(s.clip_id) && byId.get(s.clip_id)!.role !== 'core');
	for (const s of steps) used.add(s.clip_id);

	const core = pool.find((c) => c.role === 'core') || null;
	if (core) used.add(core.id);
	const pooled = fresh('pool');
	const pre = [...(core ? [core] : []), ...take(pooled, RUN.pre - (core ? 1 : 0))];
	const voice = take(fresh('voice'), RUN.voice);
	const challenge = take(fresh('challenge'), RUN.challenge);

	const item = (c: PoolClip, phase: Phase, n = 0): RunItem => ({ clip_id: c.id, phase, format: formatFor(c, phase, n), result: null });
	let practiceItems: RunItem[];
	if (steps.length) {
		practiceItems = steps.map((s, n) => {
			const c = byId.get(s.clip_id)!;
			return { clip_id: c.id, phase: 'practice', format: stepFormat(c, s, n), ...(s.wrong.length ? { wrong: s.wrong } : {}), result: null };
		});
	} else {
		let practice = take(pooled, RUN.practice - 1);
		if (practice.length < 2) practice = [...practice, ...shuffle(pre.filter((c) => !practice.includes(c)), rand)].slice(0, RUN.practice - 1);
		practice.sort((a, b) => (a.difficulty ?? 2) - (b.difficulty ?? 2));
		const trap = take(fresh('trap'), 1);
		if (trap.length) practice.splice(Math.ceil(practice.length / 2), 0, trap[0]!);
		practiceItems = practice.map((c, n) => item(c, 'practice', n));
	}

	return [
		...pre.map((c) => item(c, 'pre')),
		...voice.map((c) => item(c, 'voice')),
		...practiceItems,
		...challenge.map((c) => item(c, 'challenge')),
	];
}

/**
 * A lesson run still in progress fits the lesson as it is now: drawn with today's sizes, and
 * its practice is the one written (same clips, same wrong answers), or a drawn one when none
 * is written. Else the learner starts again on the lesson as the team left it.
 */
export function fitsLesson(items: RunItem[], script: PracticeStep[], has: (clipId: string) => boolean): boolean {
	if (!items.every((it) => has(it.clip_id))) return false;
	const count = (phase: Phase) => items.filter((it) => it.phase === phase).length;
	if (count('pre') > RUN.pre || count('post') > 0 || count('practice') > RUN.practice) return false;
	const key = (clipId: string, wrong?: string[]) => `${clipId}:${(wrong || []).join('|')}`;
	const practice = items.filter((it) => it.phase === 'practice').map((it) => key(it.clip_id, it.wrong));
	const steps = script.filter((s) => has(s.clip_id)).map((s) => key(s.clip_id, s.wrong));
	if (!steps.length) return items.every((it) => !it.wrong);
	return practice.join(',') === steps.join(',');
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
	return shuffle(picked, rand).map((p) => ({ clip_id: p.clip.id, lesson_id: p.lessonId, phase: 'test', format: formatFor(p.clip, 'test'), result: null }));
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
		if (clip) out.push({ clip_id: clip.id, lesson_id: form.lessonId, phase: 'review', format: formatFor(clip, 'review'), result: null });
	}
	return out;
}

/**
 * A review lesson on the path (kind 'mixed', listening_lessons.review_of): no first test and
 * no explanation in between (its recap shows first), only practice, then a challenge.
 * `script`: the steps the team set (listening_lessons.practice: clips of the lessons reviewed
 * or its own trap, each with a format and wrong answers), played in that order. Without one:
 *   - MIXED.items pool clips of the lessons reviewed, the forms taking turns (never two of one
 *     form in a row while another has clips left), clips not in those lessons' practice
 *     (`practiced`) first, then clips the learner has not met, asked
 *     as MIXED.formats (mostly choices and word banks, the wrong answers made by mixUps)
 *   - its own trap (else one of the lessons reviewed) in the second half, as a choice
 * Then its own challenge (else one of the lessons reviewed) at the end.
 * A missed item comes back at the end, as in any lesson (withRetry).
 */
export { MIXED, reviewOfValue };

type Form = { lessonId: string; clips: PoolClip[] };
type Picked = { lessonId: string | null; clip: PoolClip };

/** The format asked for, when the clip allows it; else the nearest on the practice ladder */
function mixedFormat(c: PoolClip, want: Format, n: number): Format {
	if (c.forced && (FORMATS as string[]).includes(c.forced) && supports(c, c.forced as Format)) return c.forced as Format;
	if (want === 'gap') return focusFits(c) ? 'gap' : 'type';
	return supports(c, want) ? want : formatFor(c, 'practice', n);
}

/** Where a clip of a review lesson comes from: one of the lessons reviewed, or its own (null) */
function findClip(forms: Form[], own: PoolClip[], id: string): Picked | null {
	const mine = own.find((c) => c.id === id);
	if (mine) return { lessonId: null, clip: mine };
	for (const f of forms) {
		const c = f.clips.find((x) => x.id === id);
		if (c) return { lessonId: f.lessonId, clip: c };
	}
	return null;
}

export function drawMixed(
	forms: Form[],
	own: PoolClip[],
	met: Set<string> = new Set(),
	rand: () => number = Math.random,
	script: PracticeStep[] = [],
	practiced: Set<string> = new Set(),
): RunItem[] {
	// Own clips carry no lesson_id: the run's lesson is theirs
	const item = (p: Picked, format: Format, phase: Phase = 'practice', wrong?: string[]): RunItem => ({
		clip_id: p.clip.id, ...(p.lessonId ? { lesson_id: p.lessonId } : {}), phase, format, ...(wrong?.length ? { wrong } : {}), result: null,
	});
	const fromForms = (role: PoolClip['role']) => forms.flatMap((f) => f.clips.filter((c) => c.role === role).map((clip) => ({ lessonId: f.lessonId as string | null, clip })));
	const one = (role: PoolClip['role'], skip: Set<string> = new Set()) => {
		const mine = freshFirst(own.filter((c) => c.role === role && !skip.has(c.id)), met, rand).map((clip) => ({ lessonId: null as string | null, clip }));
		const theirs = shuffle(fromForms(role).filter((p) => !skip.has(p.clip.id)), rand).sort((a, b) => Number(practiced.has(a.clip.id)) - Number(practiced.has(b.clip.id)));
		return mine[0] || theirs[0] || null;
	};

	let items: RunItem[] = [];
	const steps = script.map((s) => ({ s, p: findClip(forms, own, s.clip_id) })).filter((x): x is { s: PracticeStep; p: Picked } => !!x.p);
	if (steps.length) {
		items = steps.map(({ s, p }, n) => item(p, stepFormat(p.clip, s, n), 'practice', s.wrong));
	} else {
		const queues = shuffle(forms, rand)
			// Clips not in the lesson's practice first (heard there already), then those not met
			.map((f) => ({ lessonId: f.lessonId, left: freshFirst(f.clips.filter((c) => c.role === 'pool'), met, rand).sort((a, b) => Number(practiced.has(a.id)) - Number(practiced.has(b.id))) }))
			.filter((q) => q.left.length);
		const picked: Picked[] = [];
		let turn = 0;
		while (picked.length < MIXED.items && queues.some((q) => q.left.length)) {
			const q = queues[turn % queues.length]!;
			turn++;
			if (q.left.length) picked.push({ lessonId: q.lessonId, clip: q.left.shift()! });
		}
		items = picked.map((p, n) => item(p, mixedFormat(p.clip, MIXED.formats[n] ?? 'gap', n)));
		const trap = one('trap');
		if (trap && items.length) items.splice(Math.min(items.length, Math.ceil(items.length * 0.6)), 0, item(trap, mixedFormat(trap.clip, 'choice', 0)));
	}
	const challenge = one('challenge', new Set(items.map((it) => it.clip_id)));
	if (challenge) items.push(item(challenge, formatFor(challenge.clip, 'challenge'), 'challenge'));
	return items;
}

/**
 * A review run left halfway is taken up again while every clip is still there, it was drawn
 * for review, and its practice is the one the team set (same clips, same wrong answers), or a
 * drawn one when none is set.
 */
export function fitsMixed(items: RunItem[], has: (clipId: string, lessonId?: string) => boolean, script: PracticeStep[] = []): boolean {
	if (!items.length || !items.every((it) => (it.phase === 'practice' || it.phase === 'retry' || it.phase === 'challenge') && has(it.clip_id, it.lesson_id))) return false;
	const key = (clipId: string, wrong?: string[]) => `${clipId}:${(wrong || []).join('|')}`;
	const practice = items.filter((it) => it.phase === 'practice').map((it) => key(it.clip_id, it.wrong));
	const steps = script.map((s) => key(s.clip_id, s.wrong));
	if (!steps.length) return items.every((it) => !it.wrong);
	return practice.join(',') === steps.join(',');
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

/** Right or wrong, by format: the phrase, or only the part with the rule (gap, tap, choice, bank) */
export function isRight(c: PoolClip, format: Format, given: string) {
	const g = normalizeAnswer(given);
	if (!g) return false;
	if (format === 'type') return g === normalizeAnswer(c.answer);
	return g === normalizeAnswer(targetOf(c));
}

/**
 * A practice item missed comes back once, typed (`format`: the gap of a long sentence, else the
 * whole phrase), at the end of the lesson (after the challenge), in the order they were missed.
 * Returns the new list (unchanged when it already came back).
 */
export function withRetry(items: RunItem[], position: number, format: Format = 'type'): RunItem[] {
	const missed = items[position];
	if (!missed || missed.phase !== 'practice') return items;
	if (items.some((it) => it.phase === 'retry' && it.clip_id === missed.clip_id)) return items;
	// lesson_id: a review lesson's items come from the lessons it reviews
	return [...items, { clip_id: missed.clip_id, ...(missed.lesson_id ? { lesson_id: missed.lesson_id } : {}), phase: 'retry', format, result: null }];
}

/** The end of a run: what the summary shows and what the rewards depend on */
export function summaryOf(items: RunItem[]) {
	const answered = items.filter((it) => it.result);
	// After the explanation: other voices, practice (a retry means a miss there) and the challenge
	const taught = items.filter((it) => it.phase === 'voice' || it.phase === 'practice' || it.phase === 'challenge');
	return {
		total: answered.length,
		right: answered.filter((it) => it.result!.correct).length,
		/** Time spent answering, summed over the items */
		answer_ms: answered.reduce((n, it) => n + (Number(it.result!.time_ms) || 0), 0),
		/** Every item after the explanation right at once, no answer looked at */
		perfect: taught.length > 0 && taught.every((it) => it.result?.correct && !it.result.hint),
		/** An answer looked at ("I can't hear it") */
		hinted: answered.some((it) => it.result!.hint),
		finished: items.length > 0 && items.every((it) => it.result),
	};
}
