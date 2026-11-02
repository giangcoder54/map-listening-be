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
import { RUN, drawLesson, drawReview, drawTest, formatFor, isRight, passed, summaryOf, weakestForms, withRetry, type PoolClip, type RunItem } from '../src/lib/runs';
import { gradeOf, masteryOf, schedule } from '../src/lib/review';
import { Rating } from 'ts-fsrs';
import { COIN, CoinError, buyFreeze, earnCoins, unlockLesson, walletOf } from '../src/lib/coins';

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
		assert.equal(count('practice'), RUN.practice, '5 pool + the trap');
		assert.equal(count('challenge'), 1);
		assert.equal(count('post'), RUN.post);
		const order = ['pre', 'voice', 'practice', 'challenge', 'post'];
		const seen = [...new Set(phases(items))];
		assert.deepEqual(seen, order);
	});

	test('the core clip opens the lesson', () => {
		const pool = fullPool();
		assert.equal(drawLesson(pool)[0]!.clip_id, pool[0]!.id);
	});

	test('the retest never repeats a phrase of the first test', () => {
		for (let k = 0; k < 50; k++) {
			const pool = fullPool();
			// Two pool clips say the core phrase again: they may not come back in post
			pool[3]!.answer = pool[0]!.answer;
			pool[4]!.answer = pool[0]!.answer;
			const items = drawLesson(pool);
			const answer = (id: string) => pool.find((c) => c.id === id)!.answer;
			const pre = new Set(items.filter((it) => it.phase === 'pre').map((it) => answer(it.clip_id)));
			for (const it of items.filter((it) => it.phase === 'post')) assert.ok(!pre.has(answer(it.clip_id)));
		}
	});

	test('no clip twice among pre, post and the pool part of practice', () => {
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

describe('formats', () => {
	const sentence = (over: Partial<PoolClip> = {}) => clip('pool', { answer: 'I will tell him about it tomorrow', focus: 'tell him', ...over });

	test('practice climbs from choosing to typing', () => {
		const c = sentence();
		assert.equal(formatFor(c, 'practice', 0), 'choice');
		assert.equal(formatFor(c, 'practice', 2), 'tap');
		assert.equal(formatFor(c, 'practice', 4), 'gap');
		assert.equal(formatFor(c, 'practice', 6), 'type');
	});

	test('a format the clip cannot do is skipped', () => {
		assert.equal(formatFor(clip('pool', { hasChoices: false }), 'practice', 0), 'type', 'no choices, no focus');
		assert.equal(formatFor(sentence({ hasChoices: false }), 'practice', 0), 'tap');
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
});

describe('checking an answer', () => {
	const c = clip('pool', { answer: "I'll tell him tomorrow", focus: 'tell him' });
	test('typing: the whole phrase, case and punctuation aside', () => {
		assert.ok(isRight(c, 'type', "i'll TELL him tomorrow!"));
		assert.ok(!isRight(c, 'type', 'tell him'));
	});
	test('gap and tap: only the part with the rule', () => {
		assert.ok(isRight(c, 'gap', 'Tell him'));
		assert.ok(isRight(c, 'tap', 'tell him'));
		assert.ok(!isRight(c, 'gap', 'tell them'));
	});
	test('an empty answer is wrong', () => assert.ok(!isRight(c, 'type', '  ')));
});

describe('retry and summary', () => {
	const items = (): RunItem[] => [
		{ clip_id: 'a', phase: 'pre', format: 'type' },
		{ clip_id: 'b', phase: 'practice', format: 'choice' },
		{ clip_id: 'c', phase: 'practice', format: 'type' },
		{ clip_id: 'd', phase: 'post', format: 'type' },
	];
	test('a practice item missed comes back once, after practice', () => {
		const once = withRetry(items(), 1);
		assert.deepEqual(phases(once), ['pre', 'practice', 'practice', 'retry', 'post']);
		assert.equal(once[3]!.clip_id, 'b');
		assert.equal(withRetry(once, 1).length, once.length, 'not twice');
	});
	test('a first-test or retest miss does not come back', () => {
		assert.equal(withRetry(items(), 0).length, 4);
		assert.equal(withRetry(items(), 3).length, 4);
	});
	test('summary: first miss, perfect retest, hint', () => {
		const list = items();
		const r = (correct: boolean, hint = false) => ({ correct, answer: 'x', listens: 1, slow: false, hint });
		list[0]!.result = r(true);
		list[1]!.result = r(false);
		list[2]!.result = r(true, true);
		list[3]!.result = r(true);
		const s = summaryOf(list);
		assert.equal(s.first_wrong, 1);
		assert.equal(s.perfect, true);
		assert.equal(s.hinted, true);
		assert.equal(s.finished, true);
		assert.equal(s.right, 3);
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
