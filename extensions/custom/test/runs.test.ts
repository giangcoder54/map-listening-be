/**
 * Lesson runs (src/lib/runs.ts) and Xu (src/lib/coins.ts).
 *
 *   npm run test:runs      (needs the local stack: docker compose up)
 *
 * Drawing and checking are pure; Xu run against the real database, each test in a
 * transaction rolled back at the end (like test/xp.test.ts).
 */
import { after, before, beforeEach, afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
	MIXED, RUN, choicesFor, drawLesson, drawMixed, drawReview, drawTest, fitsLesson, fitsMixed, formatFor, isRight, passed, practiceOf, reviewOfValue,
	summaryOf, tilesFor, weakestForms, withRetry,
	type PoolClip, type PracticeStep, type RunItem,
} from '../src/lib/runs';
import { gradeOf, masteryOf, schedule } from '../src/lib/review';
import { mixUps } from '../src/lib/mixups';
import { Rating } from 'ts-fsrs';
import { COIN, CoinError, buyFreeze, earnCoins, unlockLesson, walletOf } from '../src/lib/coins';
import { loadLessonGraph } from '../src/lib/lessons';

const PNPM = '/directus/node_modules/.pnpm';
const knexDir = readdirSync(PNPM).find((d) => d.startsWith('knex@'));
if (!knexDir) throw new Error(`knex not found in ${PNPM}: run this inside the API container (npm run test:runs)`);
const knex = createRequire(`${PNPM}/${knexDir}/node_modules/knex/package.json`)('knex');

let n = 0;
const clip = (role: PoolClip['role'], over: Partial<PoolClip> = {}): PoolClip => ({
	id: `c${++n}`, role, answer: `phrase number ${n}`, focus: null, difficulty: null, forced: null, hasChoices: true, ...over,
});
/** A full lesson: core, 2 voice, 12 pool, a challenge, a trap */
const fullPool = () => [clip('core'), clip('voice'), clip('voice'), ...Array.from({ length: 12 }, () => clip('pool')), clip('challenge'), clip('trap')];
const phases = (items: RunItem[]) => items.map((it) => it.phase);

describe('drawing a lesson', () => {
	test('a full pool gives every part, in order', () => {
		const items = drawLesson(fullPool());
		const count = (p: string) => items.filter((it) => it.phase === p).length;
		assert.equal(count('pre'), RUN.pre);
		assert.equal(count('voice'), 2);
		assert.equal(count('practice'), RUN.practice, '3 pool + the trap');
		assert.equal(count('challenge'), 1);
		assert.equal(count('post'), 0, 'no final check');
		const order = ['pre', 'voice', 'practice', 'challenge'];
		const seen = [...new Set(phases(items))];
		assert.deepEqual(seen, order);
	});

	test('the core clip opens the lesson', () => {
		const pool = fullPool();
		assert.equal(drawLesson(pool)[0]!.clip_id, pool[0]!.id);
	});

	test('no clip twice among pre and the pool part of practice', () => {
		const items = drawLesson(fullPool());
		const ids = items.filter((it) => it.phase !== 'voice').map((it) => it.clip_id);
		assert.equal(new Set(ids).size, ids.length);
	});

	test('clips not met yet come first', () => {
		const pool = fullPool();
		const met = new Set(pool.filter((c) => c.role === 'pool').slice(0, 10).map((c) => c.id));
		const items = drawLesson(pool, met);
		const pre = items.filter((it) => it.phase === 'pre').slice(1);
		for (const it of pre) assert.ok(!met.has(it.clip_id), 'the 2 new pool clips go to the first test');
	});

	test('a lesson with only a core clip still plays', () => {
		const items = drawLesson([clip('core')]);
		assert.ok(items.length >= 1);
		assert.equal(items[0]!.phase, 'pre');
	});

	test('an empty pool gives nothing', () => {
		assert.deepEqual(drawLesson([]), []);
	});
});

describe('practice written by the team', () => {
	const script = (pool: PoolClip[]): PracticeStep[] => {
		const pooled = pool.filter((c) => c.role === 'pool');
		const trap = pool.find((c) => c.role === 'trap')!;
		return [
			{ clip_id: pooled[0]!.id, format: 'choice', wrong: ["tell 'em", 'tell her'] },
			{ clip_id: pooled[1]!.id, format: 'bank', wrong: ['her', 'them'] },
			{ clip_id: trap.id, format: 'choice', wrong: ['take her'] },
			{ clip_id: pooled[2]!.id, format: 'gap', wrong: [] },
		];
	};

	test('its steps are the practice, in the order written, with their wrong answers', () => {
		const pool = fullPool();
		pool[5]!.focus = 'number';
		const steps = script(pool);
		const practice = drawLesson(pool, new Set(), Math.random, steps).filter((it) => it.phase === 'practice');
		assert.deepEqual(practice.map((it) => it.clip_id), steps.map((s) => s.clip_id));
		assert.deepEqual(practice.map((it) => it.format), ['choice', 'bank', 'choice', 'gap']);
		assert.deepEqual(practice[0]!.wrong, ["tell 'em", 'tell her']);
		assert.equal(practice[3]!.wrong, undefined, 'a step with no wrong answers carries none');
	});

	test('its clips are kept out of the first test', () => {
		for (let k = 0; k < 30; k++) {
			const pool = fullPool();
			const steps = script(pool);
			const items = drawLesson(pool, new Set(), Math.random, steps);
			const used = new Set(steps.map((s) => s.clip_id));
			for (const it of items.filter((x) => x.phase === 'pre')) assert.ok(!used.has(it.clip_id));
		}
	});

	test('a gap on a short [bracketed] answer is typed in the subtitle line', () => {
		const pool = fullPool();
		const steps: PracticeStep[] = [{ clip_id: pool[3]!.id, format: 'gap', wrong: [] }];
		const practice = drawLesson(pool, new Set(), Math.random, steps).filter((it) => it.phase === 'practice');
		assert.equal(practice.length, 1);
		assert.equal(practice[0]!.format, 'type');
	});

	test('a choice with no wrong answer at all falls back to a format the clip can do', () => {
		const pool = fullPool();
		pool[3]!.hasChoices = false;
		const steps: PracticeStep[] = [{ clip_id: pool[3]!.id, format: 'choice', wrong: [] }];
		const practice = drawLesson(pool, new Set(), Math.random, steps).filter((it) => it.phase === 'practice');
		assert.equal(practice[0]!.format, 'type');
	});

	test('a run left halfway is taken up again only while it fits the lesson', () => {
		const pool = fullPool();
		const steps = script(pool);
		const has = (id: string) => pool.some((c) => c.id === id);
		const items = drawLesson(pool, new Set(), Math.random, steps);
		assert.ok(fitsLesson(items, steps, has), 'same lesson');
		assert.ok(!fitsLesson(items, [], has), 'the practice was removed');
		assert.ok(!fitsLesson(items, [steps[1]!, steps[0]!, steps[2]!, steps[3]!], has), 'steps reordered');
		assert.ok(!fitsLesson(items, [{ ...steps[0]!, wrong: ['other'] }, ...steps.slice(1)], has), 'wrong answers changed');
		assert.ok(!fitsLesson(items, steps, (id) => id !== items[0]!.clip_id && has(id)), 'a clip is gone');
		const drawn = drawLesson(pool);
		assert.ok(fitsLesson(drawn, [], has), 'drawn practice, none written');
		assert.ok(!fitsLesson(drawn, steps, has), 'a practice was written since');
		const old = [...drawn, { clip_id: pool[3]!.id, phase: 'pre' as const, format: 'type' as const }];
		assert.ok(!fitsLesson(old, [], has), 'drawn with the old sizes');
	});

	test('steps on clips gone from the lesson are dropped; none left: practice is drawn', () => {
		const items = drawLesson(fullPool(), new Set(), Math.random, [{ clip_id: 'gone', format: 'choice', wrong: ['x'] }]);
		assert.equal(items.filter((it) => it.phase === 'practice').length, RUN.practice);
	});

	test('the column is read whatever it holds', () => {
		assert.deepEqual(practiceOf(null), []);
		assert.deepEqual(practiceOf('not json'), []);
		assert.deepEqual(practiceOf([{ clip_id: 'a', format: 'type' }, { clip_id: 'b', format: 'bank', wrong: [' her  ', '', 3] }]), [
			{ clip_id: 'b', format: 'bank', wrong: ['her', '3'] },
		]);
	});
});

describe('choices and word banks', () => {
	const c = clip('pool', { id: 'fixed', answer: 'I will tell him about it', focus: 'tell him' });
	test('a choice asks for the part with the rule, with the wrong answers, no duplicate', () => {
		const list = choicesFor(c, ["tell 'em", 'TELL HIM', 'tell her'])!;
		assert.equal(list.length, 3);
		assert.ok(list.includes('tell him') && list.includes("tell 'em") && list.includes('tell her'));
		assert.deepEqual(choicesFor(c, ["tell 'em", 'tell her']), choicesFor(c, ["tell 'em", 'tell her']), 'same order on every load');
	});
	test('no wrong answer: no choice item', () => assert.equal(choicesFor(c, []), null));
	test('a short phrase is chosen whole', () => {
		assert.ok(choicesFor(clip('pool', { answer: 'tell him', focus: 'tell him' }), ['tell them'])!.includes('tell him'));
	});
	test('a word bank: the words asked for and wrong words not in them', () => {
		const tiles = tilesFor(c, ["tell 'em", 'tell her']);
		assert.deepEqual([...tiles].sort(), ["'em", 'her', 'him', 'tell']);
	});
});

describe('formats', () => {
	const sentence = (over: Partial<PoolClip> = {}) => clip('pool', { answer: 'I will tell him about it tomorrow', focus: 'tell him', ...over });

	test('drawn practice climbs from choosing to filling the gap', () => {
		const c = sentence();
		assert.equal(formatFor(c, 'practice', 0), 'choice');
		assert.equal(formatFor(c, 'practice', 1), 'bank');
		assert.equal(formatFor(c, 'practice', 2), 'gap');
		assert.equal(formatFor(c, 'practice', 3), 'gap');
	});

	test('a format the clip cannot do is skipped', () => {
		assert.equal(formatFor(clip('pool', { hasChoices: false }), 'practice', 0), 'type', 'no choices, no focus');
		assert.equal(formatFor(sentence({ hasChoices: false }), 'practice', 0), 'gap');
		assert.equal(formatFor(clip('pool'), 'practice', 2), 'bank', 'no focus: back down the ladder');
	});

	test('a long sentence is typed as a gap, a short phrase in full', () => {
		assert.equal(formatFor(sentence(), 'pre'), 'gap');
		assert.equal(formatFor(clip('pool', { answer: 'tell him', focus: 'tell him' }), 'pre'), 'type');
	});

	test('a focus that is not in the answer is ignored', () => {
		assert.equal(formatFor(sentence({ focus: 'not there' }), 'pre'), 'type');
	});

	test('the format set by the team wins when the clip supports it', () => {
		assert.equal(formatFor(sentence({ forced: 'type' }), 'practice', 0), 'type');
		assert.equal(formatFor(clip('pool', { forced: 'gap' }), 'pre'), 'type', 'no focus: no gap');
	});

	test('a challenge is typed unless the team made it a word bank or a choice', () => {
		assert.equal(formatFor(clip('challenge', { answer: 'tell him', hasChoices: false }), 'challenge'), 'type');
		assert.equal(formatFor(sentence({ role: 'challenge', hasChoices: false }), 'challenge'), 'gap');
		assert.equal(formatFor(clip('challenge', { forced: 'bank' }), 'challenge'), 'bank');
		assert.equal(formatFor(sentence({ role: 'challenge', forced: 'choice' }), 'challenge'), 'choice');
		assert.equal(formatFor(clip('challenge', { forced: 'bank', hasChoices: false }), 'challenge'), 'type', 'no wrong words: typed');
	});
});

describe('checking an answer', () => {
	const c = clip('pool', { answer: "I'll tell him tomorrow", focus: 'tell him' });
	test('typing: the whole phrase, case and punctuation aside', () => {
		assert.ok(isRight(c, 'type', "i'll TELL him tomorrow!"));
		assert.ok(!isRight(c, 'type', 'tell him'));
	});
	test('gap, tap, choice and word bank: only the part with the rule', () => {
		assert.ok(isRight(c, 'gap', 'Tell him'));
		assert.ok(isRight(c, 'tap', 'tell him'));
		assert.ok(isRight(c, 'choice', 'tell him'));
		assert.ok(isRight(c, 'bank', 'tell him'));
		assert.ok(!isRight(c, 'bank', 'him tell'), 'the words in order');
		assert.ok(!isRight(c, 'gap', 'tell them'));
	});
	test('a short phrase is the whole answer in every format', () => {
		const short = clip('pool', { answer: 'Tell him', focus: 'tell him' });
		assert.ok(isRight(short, 'choice', 'tell him'));
		assert.ok(isRight(short, 'bank', 'Tell him'));
	});
	test('an empty answer is wrong', () => assert.ok(!isRight(c, 'type', '  ')));
});

describe('retry and summary', () => {
	const items = (): RunItem[] => [
		{ clip_id: 'a', phase: 'pre', format: 'type' },
		{ clip_id: 'b', phase: 'practice', format: 'choice' },
		{ clip_id: 'c', phase: 'practice', format: 'type' },
		{ clip_id: 'd', phase: 'challenge', format: 'type' },
	];
	test('a practice item missed comes back once, at the end after the challenge', () => {
		const once = withRetry(items(), 1);
		assert.deepEqual(phases(once), ['pre', 'practice', 'practice', 'challenge', 'retry']);
		assert.equal(once[4]!.clip_id, 'b');
		assert.equal(withRetry(once, 1).length, once.length, 'not twice');
		assert.equal(once[4]!.format, 'type');
		assert.equal(withRetry(items(), 1, 'gap')[4]!.format, 'gap', 'a long sentence comes back as its gap');
		const both = withRetry(once, 2);
		assert.deepEqual(both.slice(4).map((it) => it.clip_id), ['b', 'c'], 'in the order missed');
	});
	test('a first-test or challenge miss does not come back', () => {
		assert.equal(withRetry(items(), 0).length, 4);
		assert.equal(withRetry(items(), 3).length, 4);
	});
	test('summary: perfect lesson, hint, time', () => {
		const list = items();
		const r = (correct: boolean, hint = false) => ({ correct, answer: 'x', listens: 1, slow: false, hint, time_ms: 1000 });
		list[0]!.result = r(true);
		list[1]!.result = r(false);
		list[2]!.result = r(true, true);
		list[3]!.result = r(true);
		const s = summaryOf(list);
		assert.equal(s.answer_ms, 4000);
		assert.equal(s.perfect, false, 'a practice item missed');
		assert.equal(s.hinted, true);
		assert.equal(s.finished, true);
		assert.equal(s.right, 3);
		list[1]!.result = r(true);
		assert.equal(summaryOf(list).perfect, false, 'an answer looked at');
		list[2]!.result = r(true);
		assert.equal(summaryOf(list).perfect, true, 'everything after the explanation right');
		list[0]!.result = r(false);
		assert.equal(summaryOf(list).perfect, true, 'the first test, before the explanation, does not count');
	});
});

describe('skip-ahead and final tests', () => {
	const form = (lessonId: string, pool = 6, traps = 1, difficulties = [1, 2, 3]) => ({
		lessonId,
		clips: [
			...Array.from({ length: pool }, (_, i) => clip('pool', { difficulty: difficulties[i % difficulties.length]! })),
			...Array.from({ length: traps }, () => clip('trap')),
			clip('core'), clip('voice'),
		],
	});

	test('the size asked, from pool and trap clips only', () => {
		const items = drawTest([form('a')], 4);
		assert.equal(items.length, 4);
		assert.ok(items.every((it) => it.phase === 'test' && it.lesson_id === 'a'));
	});

	test('every form of the rule is asked about, evenly', () => {
		for (let k = 0; k < 30; k++) {
			const items = drawTest([form('a'), form('b'), form('c'), form('d')], 8);
			const per = new Map<string, number>();
			for (const it of items) per.set(it.lesson_id!, (per.get(it.lesson_id!) || 0) + 1);
			assert.deepEqual([...per.values()].sort(), [2, 2, 2, 2]);
		}
	});

	test('a trap is always there when the forms have one', () => {
		for (let k = 0; k < 50; k++) {
			const f = [form('a', 8, 0), form('b', 8, 1)];
			const traps = new Set(f.flatMap((x) => x.clips.filter((c) => c.role === 'trap').map((c) => c.id)));
			assert.ok(drawTest(f, 3).some((it) => traps.has(it.clip_id)));
		}
	});

	test('difficulties are mixed, not all hard', () => {
		const items = drawTest([form('a', 9, 0)], 5);
		const all = form('a').clips; // ids differ: look the drawn ones up by difficulty through a fresh pool
		const f = form('x', 9, 0);
		const drawn = drawTest([f], 5).map((it) => f.clips.find((c) => c.id === it.clip_id)!.difficulty);
		assert.ok(items.length === 5 && all.length > 0);
		assert.ok(drawn.filter((d) => d === 3).length <= 1, `at most one hard in five: ${drawn}`);
		assert.ok(drawn.includes(1) && drawn.includes(2));
	});

	test('clips not met come first; a small pool gives a shorter test', () => {
		const f = form('a', 6, 0);
		const met = new Set(f.clips.slice(0, 3).map((c) => c.id));
		for (const it of drawTest([f], 3, met)) assert.ok(!met.has(it.clip_id));
		assert.equal(drawTest([form('b', 2, 0)], 5).length, 2);
	});

	test('pass mark and weakest forms', () => {
		const r = (correct: boolean) => ({ correct, answer: '', listens: 1, slow: false, hint: false });
		const items = [
			{ clip_id: '1', lesson_id: 'a', phase: 'test', format: 'type', result: r(true) },
			{ clip_id: '2', lesson_id: 'a', phase: 'test', format: 'type', result: r(true) },
			{ clip_id: '3', lesson_id: 'b', phase: 'test', format: 'type', result: r(false) },
			{ clip_id: '4', lesson_id: 'b', phase: 'test', format: 'type', result: r(true) },
			{ clip_id: '5', lesson_id: 'c', phase: 'test', format: 'type', result: r(true) },
		] as RunItem[];
		assert.equal(passed(items, 0.8), true, '4/5 = 80%');
		items[0]!.result = r(false);
		assert.equal(passed(items, 0.8), false, '3/5');
		assert.deepEqual(weakestForms(items).map((w) => w.lessonId).sort(), ['a', 'b']);
	});
});

describe('review lessons on the path', () => {
	const forms = () => ['a', 'b', 'c'].map((id) => ({ lessonId: id, clips: [...Array.from({ length: 4 }, () => clip('pool')), clip('trap'), clip('challenge')] }));

	test('6 pool clips, the forms taking turns, then the trap and the challenge', () => {
		const items = drawMixed(forms(), []);
		const practice = items.filter((it) => it.phase === 'practice');
		assert.equal(practice.length, MIXED.items + 1, '6 + the trap');
		const pooled = practice.filter((it, i) => i !== Math.ceil(MIXED.items * 0.6));
		for (let i = 1; i < pooled.length; i++) assert.notEqual(pooled[i]!.lesson_id, pooled[i - 1]!.lesson_id, 'never one form twice in a row');
		assert.equal(items.at(-1)!.phase, 'challenge');
		assert.ok(!items.some((it) => it.phase === 'pre' || it.phase === 'voice'), 'no first test, no other voice');
	});

	test('its own trap and challenge come first, clips not met before the others', () => {
		const f = forms();
		const own = [clip('trap'), clip('challenge')];
		const met = new Set(f[0]!.clips.slice(0, 3).map((c) => c.id));
		const items = drawMixed(f, own, met);
		const trap = items.find((it) => it.clip_id === own[0]!.id)!;
		assert.ok(trap && !trap.lesson_id, 'its own trap, no lesson_id: the run\'s lesson');
		assert.equal(items.at(-1)!.clip_id, own[1]!.id);
		const fromA = items.filter((it) => it.lesson_id === 'a').map((it) => it.clip_id);
		assert.equal(fromA[0], f[0]!.clips[3]!.id, 'the one not met first');
	});

	test('a missed item comes back with the lesson it came from', () => {
		const items = drawMixed(forms(), []);
		const again = withRetry(items, 0);
		assert.equal(again.at(-1)!.phase, 'retry');
		assert.equal(again.at(-1)!.lesson_id, items[0]!.lesson_id);
	});

	test('a run left halfway is taken up while its clips are there', () => {
		const f = forms();
		const items = drawMixed(f, []);
		const has = (id: string, lessonId?: string) => f.some((x) => x.lessonId === lessonId && x.clips.some((c) => c.id === id));
		assert.ok(fitsMixed(items, has));
		assert.ok(!fitsMixed(items, (id, l) => id !== items[0]!.clip_id && has(id, l)), 'a clip is gone');
		assert.ok(!fitsMixed(drawLesson(fullPool()), () => true), 'drawn as a plain lesson');
	});

	test('clips not in the practice of the lessons reviewed come first', () => {
		const f = forms();
		const practiced = new Set(f.flatMap((x) => x.clips.slice(0, 2).map((c) => c.id)));
		const items = drawMixed(f, [], new Set(), Math.random, [], practiced);
		const pooled = items.filter((it) => it.phase === 'practice' && it.lesson_id && f.some((x) => x.clips.find((c) => c.id === it.clip_id)?.role === 'pool'));
		assert.equal(pooled.length, MIXED.items);
		assert.ok(pooled.every((it) => !practiced.has(it.clip_id)), '2 left in each lesson: 6 not used in practice');
	});

	test('mostly choices and word banks, few typed', () => {
		const items = drawMixed(forms(), []);
		const asked = items.filter((it) => it.phase === 'practice').map((it) => it.format);
		assert.equal(asked.filter((f) => f === 'choice').length, 4, '3 + the trap');
		assert.equal(asked.filter((f) => f === 'bank').length, 2);
		assert.ok(asked.filter((f) => f === 'type' || f === 'gap').length <= 1);
	});

	test('the steps the team set are played as set, then a challenge', () => {
		const f = forms();
		const own = [clip('trap')];
		const script = [
			{ clip_id: f[1]!.clips[0]!.id, format: 'choice' as const, wrong: ['x one', 'x two'] },
			{ clip_id: own[0]!.id, format: 'choice' as const, wrong: ['y one', 'y two'] },
			{ clip_id: f[0]!.clips[2]!.id, format: 'bank' as const, wrong: ['z'] },
		];
		const items = drawMixed(f, own, new Set(), Math.random, script);
		assert.deepEqual(items.slice(0, 3).map((it) => [it.clip_id, it.lesson_id, it.format]), [
			[script[0]!.clip_id, 'b', 'choice'], [own[0]!.id, undefined, 'choice'], [script[2]!.clip_id, 'a', 'bank'],
		]);
		assert.deepEqual(items[0]!.wrong, ['x one', 'x two']);
		assert.equal(items.length, 4);
		assert.equal(items.at(-1)!.phase, 'challenge');
		const has = () => true;
		assert.ok(fitsMixed(items, has, script));
		assert.ok(!fitsMixed(items, has, script.slice(1)), 'the steps changed since');
		assert.ok(!fitsMixed(drawMixed(f, own), has, script), 'drawn before the steps were set');
	});

	test('wrong answers made from the words heard one for another', () => {
		assert.deepEqual(mixUps('asked her'), ['asked him', 'asked a', 'asked his']);
		assert.deepEqual(mixUps("What's his name"), ["What's is name", "What's this name", "What's he's name"]);
		assert.ok(!mixUps('tell him').includes("tell 'em"), "him and 'em sound the same");
		assert.deepEqual(mixUps('take a seat'), ['take her seat', 'take the seat', 'take an seat']);
		assert.deepEqual(mixUps('right now'), []);
	});

	test('review_of read whatever the column holds', () => {
		assert.deepEqual(reviewOfValue('["a","b","a"]'), ['a', 'b']);
		assert.deepEqual(reviewOfValue(['a', 1, null]), ['a']);
		assert.deepEqual(reviewOfValue(null), []);
	});
});

describe('reviews', () => {
	test('one new clip per form due, in order, up to the limit', () => {
		const forms = ['a', 'b', 'c'].map((id) => ({ lessonId: id, clips: [clip('pool'), clip('pool'), clip('trap')] }));
		const met = new Set([forms[0]!.clips[0]!.id, forms[0]!.clips[1]!.id]);
		const items = drawReview(forms, 2, met);
		assert.deepEqual(items.map((it) => it.lesson_id), ['a', 'b']);
		assert.equal(items[0]!.clip_id, forms[0]!.clips[2]!.id, 'the clip not met yet');
		assert.ok(items.every((it) => it.phase === 'review'));
	});

	test('grades: miss Again, slow Hard, 2nd listen Good, 1st listen Easy', () => {
		const g = (o: Partial<{ correct: boolean; listens: number; slow: boolean; hint: boolean }>) =>
			gradeOf({ correct: true, listens: 1, slow: false, hint: false, ...o });
		assert.equal(g({ correct: false }), Rating.Again);
		assert.equal(g({ hint: true }), Rating.Again);
		assert.equal(g({ slow: true }), Rating.Hard);
		assert.equal(g({ listens: 3 }), Rating.Hard);
		assert.equal(g({ listens: 2 }), Rating.Good);
		assert.equal(g({}), Rating.Easy);
	});

	test('a miss brings the form back sooner than an easy answer', () => {
		const now = new Date('2026-03-04T05:00:00Z');
		const first = schedule(null, Rating.Good, now);
		const later = new Date(first.due.getTime() + 60_000);
		const missed = schedule({ ...first, due: first.due, last_review: now }, Rating.Again, later);
		const easy = schedule({ ...first, due: first.due, last_review: now }, Rating.Easy, later);
		assert.ok(missed.due < easy.due);
		assert.ok(easy.due.getTime() - later.getTime() >= 86_400_000, 'whole days only');
	});

	test('mastery fades without review', () => {
		const now = new Date('2026-03-04T05:00:00Z');
		const card = { ...schedule(null, Rating.Good, now), last_review: now };
		const soon = masteryOf([card], new Date(now.getTime() + 86_400_000));
		const late = masteryOf([card], new Date(now.getTime() + 60 * 86_400_000));
		assert.ok(soon > late);
		assert.equal(masteryOf([]), 0);
	});
});

// ── Xu, against the database ──────────────────────────────────────────
let db: any;
let trx: any;
let user: string;
const D = '2026-03-04'; // a Wednesday
const purse = async () => trx('user_xp').where('user_id', user).first();
const makeLesson = async () => {
	const k = randomUUID().slice(0, 8);
	const [g] = await trx('listening_groups').insert({ name: `T ${k}`, slug: `t-${k}` }).returning('id');
	const [sk] = await trx('listening_skills').insert({ group_id: g.id, name: `T ${k}`, slug: `t-${k}` }).returning('id');
	const [l] = await trx('listening_lessons').insert({ skill_id: sk.id, short_id: `t${k}`, text: `phrase ${k}`, is_premium: true }).returning('id');
	return { id: l.id as string, kind: 'pattern' };
};
const give = (amount: number) => earnCoins(trx, user, { reason: 'admin', amount, dedupe: `give:${randomUUID()}` }, D);

describe('Xu', () => {
	before(async () => { db = knex({ client: 'pg', connection: process.env.DB_CONNECTION_STRING, pool: { min: 1, max: 4 } }); });
	after(async () => db.destroy());
	beforeEach(async () => {
		trx = await db.transaction();
		user = randomUUID();
		await trx('directus_users').insert({ id: user, email: `xu-${user}@example.com`, status: 'active', is_internal: true });
	});
	afterEach(async () => trx.rollback());

	test('a rule pays once per key', async () => {
		const rule = { reason: 'lesson' as const, amount: 10, dedupe: 'lesson:x' };
		assert.equal((await earnCoins(trx, user, rule, D)).added, 10);
		assert.equal((await earnCoins(trx, user, rule, D)).added, 0);
		assert.equal((await purse()).coins, 10);
	});

	test(`the purse stops at ${COIN.cap}: the rest is written as missed`, async () => {
		await give(COIN.cap - 4);
		const r = await earnCoins(trx, user, { reason: 'lesson', amount: 10, dedupe: 'lesson:y' }, D);
		assert.deepEqual({ added: r.added, wanted: r.wanted }, { added: 4, wanted: 10 });
		const full = await earnCoins(trx, user, { reason: 'lesson', amount: 10, dedupe: 'lesson:z' }, D);
		assert.equal(full.added, 0);
		assert.equal((await purse()).coins, COIN.cap);
		const row = await trx('coin_events').where({ user_id: user, dedupe_key: 'lesson:z' }).first();
		assert.deepEqual({ amount: row.amount, wanted: row.wanted }, { amount: 0, wanted: 10 }, 'the full purse still uses the key');
	});

	test('unlocking takes the price and keeps the lesson', async () => {
		await give(200);
		const lesson = await makeLesson();
		const paid = await unlockLesson(trx, user, lesson, D);
		assert.equal(paid.price, COIN.unlock.pattern);
		assert.equal((await purse()).coins, 200 - COIN.unlock.pattern!);
		assert.ok(await trx('listening_unlocks').where({ user_id: user, lesson_id: lesson.id }).first());
		await assert.rejects(unlockLesson(trx, user, lesson, D), (e: any) => e instanceof CoinError && e.code === 'ALREADY');
	});

	test('not enough Xu: nothing changes', async () => {
		await give(COIN.unlock.pattern! - 1);
		const lesson = await makeLesson();
		await assert.rejects(unlockLesson(trx, user, lesson, D), (e: any) => e.code === 'NOT_ENOUGH');
		assert.equal((await purse()).coins, COIN.unlock.pattern! - 1);
		assert.equal((await trx('listening_unlocks').where('user_id', user)).length, 0);
	});

	test(`${COIN.weeklyUnlocks} lessons a week at most`, async () => {
		await give(COIN.cap);
		for (let i = 0; i < COIN.weeklyUnlocks; i++) await unlockLesson(trx, user, await makeLesson(), D);
		await assert.rejects(unlockLesson(trx, user, await makeLesson(), D), (e: any) => e.code === 'WEEKLY_LIMIT');
		assert.equal((await walletOf(trx, user, 2, D)).unlocks_left, 0);
	});

	test('a freeze costs Xu, 2 held at most', async () => {
		await give(3 * COIN.freeze);
		assert.equal((await buyFreeze(trx, user, 2, D)).freezes, 1);
		assert.equal((await buyFreeze(trx, user, 2, D)).freezes, 2);
		await assert.rejects(buyFreeze(trx, user, 2, D), (e: any) => e.code === 'MAX_FREEZES');
		assert.equal((await purse()).coins, COIN.freeze);
	});
});

describe('Xu under concurrent clicks', () => {
	// Real parallel transactions: committed, then cleaned up
	let user2: string;
	const lessons: string[] = [];
	let live: any;
	before(async () => {
		live = knex({ client: 'pg', connection: process.env.DB_CONNECTION_STRING, pool: { min: 1, max: 6 } });
	});
	after(async () => {
		await live('listening_unlocks').where('user_id', user2).del();
		await live('coin_events').where('user_id', user2).del();
		await live('user_xp').where('user_id', user2).del();
		await live('directus_users').where('id', user2).del();
		for (const id of lessons) {
			const l = await live('listening_lessons').where('id', id).first('skill_id');
			const s = await live('listening_skills').where('id', l.skill_id).first('group_id');
			await live('listening_lessons').where('id', id).del();
			await live('listening_skills').where('id', l.skill_id).del();
			await live('listening_groups').where('id', s.group_id).del();
		}
		await live.destroy();
	});

	test('two unlock clicks at once pay once', async () => {
		user2 = randomUUID();
		await live('directus_users').insert({ id: user2, email: `xu2-${user2}@example.com`, status: 'active', is_internal: true });
		await earnCoins(live, user2, { reason: 'admin', amount: COIN.cap, dedupe: 'give' }, D);
		const k = randomUUID().slice(0, 8);
		const [g] = await live('listening_groups').insert({ name: `T ${k}`, slug: `t-${k}` }).returning('id');
		const [sk] = await live('listening_skills').insert({ group_id: g.id, name: `T ${k}`, slug: `t-${k}` }).returning('id');
		const [l] = await live('listening_lessons').insert({ skill_id: sk.id, short_id: `t${k}`, text: 'x', is_premium: true }).returning('id');
		lessons.push(l.id);
		const results = await Promise.allSettled([1, 2, 3].map(() => unlockLesson(live, user2, { id: l.id, kind: 'pattern' }, D)));
		assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
		assert.equal((await live('user_xp').where('user_id', user2).first()).coins, COIN.cap - COIN.unlock.pattern!);
	});
});

describe('rules of a group open in order', () => {
	// One group: A (2 lessons), B, C, and D with no lesson yet
	let rdb: any;
	let rt: any;
	let learner: string;
	let ids: Record<string, string>;
	const lessonsOf: Record<string, string[]> = {};
	before(async () => { rdb = knex({ client: 'pg', connection: process.env.DB_CONNECTION_STRING, pool: { min: 1, max: 2 } }); });
	after(async () => rdb.destroy());
	beforeEach(async () => {
		rt = await rdb.transaction();
		learner = randomUUID();
		await rt('directus_users').insert({ id: learner, email: `order-${learner}@example.com`, status: 'active', is_internal: true });
		const k = randomUUID().slice(0, 8);
		const [g] = await rt('listening_groups').insert({ name: `G ${k}`, slug: `g-${k}`, sort: 900 }).returning('id');
		ids = {};
		for (const [i, name] of ['A', 'B', 'C', 'D'].entries()) {
			const [sk] = await rt('listening_skills').insert({ group_id: g.id, name: `${name} ${k}`, slug: `${name.toLowerCase()}-${k}`, sort: i + 1 }).returning('id');
			ids[name] = sk.id;
			lessonsOf[name] = [];
			const count = { A: 2, B: 1, C: 1, D: 0 }[name]!;
			for (let j = 0; j < count; j++) {
				const [l] = await rt('listening_lessons').insert({ skill_id: sk.id, short_id: `${name}${j}${k}`.slice(0, 20), text: `${name} ${j} ${k}`, status: 'published' }).returning('id');
				await rt('listening_clips').insert({ id: randomUUID(), lesson_id: l.id, role: 'core', status: 'published' });
				lessonsOf[name].push(l.id);
			}
		}
	});
	afterEach(async () => rt.rollback());

	const graph = (user: string | null = learner) => loadLessonGraph({ accountability: { user } }, { database: rt, logger: null });
	const lockOf = async (user: string | null = learner) => {
		const g = await graph(user);
		const out: Record<string, string | null> = {};
		for (const name of ['A', 'B', 'C', 'D']) {
			const by = g.ruleLockedBy(g.skillById.get(ids[name]!)!);
			out[name] = by ? Object.keys(ids).find((x) => ids[x] === by.id)! : null;
		}
		return { g, out };
	};
	const progress = (lesson: string, status = 'completed') => rt('listening_progress').insert({ user_id: learner, lesson_id: lesson, status });

	test('a new learner starts on the first rule, the others wait for it', async () => {
		const { g, out } = await lockOf();
		assert.deepEqual(out, { A: null, B: 'A', C: 'A', D: 'A' });
		const first = g.lessonById.get(lessonsOf.B![0]!)!;
		assert.equal(g.lessonCard(first).rule_locked, true);
		assert.equal(g.lessonCard(first).order_locked, true, 'even the first lesson of a waiting rule');
	});

	test('the next rule opens once every lesson is done or skipped by a test', async () => {
		await progress(lessonsOf.A![0]!);
		assert.equal((await lockOf()).out.B, 'A', 'half of A is not enough');
		await progress(lessonsOf.A![1]!, 'tested_out');
		const { g, out } = await lockOf();
		assert.deepEqual(out, { A: null, B: null, C: 'B', D: 'B' });
		assert.equal(g.skillSummary(g.skillById.get(ids.A!)!).passed, true);
	});

	test('a rule already started stays open', async () => {
		await progress(lessonsOf.C![0]!, 'in_progress');
		assert.deepEqual((await lockOf()).out, { A: null, B: 'A', C: null, D: 'A' });
	});

	test('a rule all in Premium does not hold a free learner back', async () => {
		await rt('listening_skills').where('id', ids.A).update({ is_premium: true });
		assert.deepEqual((await lockOf()).out, { A: null, B: null, C: 'B', D: 'B' });
	});

	test('inside a rule, a Premium lesson a free learner cannot open does not block the next', async () => {
		await rt('listening_lessons').where('id', lessonsOf.A![0]!).update({ is_premium: true });
		const g = await graph();
		assert.equal(g.lessonCard(g.lessonById.get(lessonsOf.A![1]!)!).order_locked, false);
	});

	test('guests keep no progress: nothing waits', async () => {
		assert.deepEqual((await lockOf(null)).out, { A: null, B: null, C: null, D: null });
	});
});
