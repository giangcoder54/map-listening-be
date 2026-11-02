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
import { RUN, drawLesson, formatFor, isRight, summaryOf, withRetry, type PoolClip, type RunItem } from '../src/lib/runs';
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
