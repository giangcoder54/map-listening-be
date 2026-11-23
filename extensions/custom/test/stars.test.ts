/**
 * Ngôi sao (src/lib/stars.ts): the pure rules, and the ledger through a real transaction.
 *
 *   npm run test:stars    (needs the local stack: docker compose up)
 *
 * Same set-up as test/gems.test.ts: every test makes its own learner, lesson, clip and run inside a
 * transaction that is rolled back at the end.
 */
import { after, before, beforeEach, afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { COIN, applyCoinSettings, earnCoins } from '../src/lib/coins';
import { canAfford, playStar, starCheck, starSummary, starValue, starsUsed } from '../src/lib/stars';

const PNPM = '/directus/node_modules/.pnpm';
const knexDir = readdirSync(PNPM).find((d) => d.startsWith('knex@'));
if (!knexDir) throw new Error(`knex not found in ${PNPM}: run this inside the API container (npm run test:stars)`);
const knex = createRequire(`${PNPM}/${knexDir}/node_modules/knex/package.json`)('knex');

let db: any;
let trx: any;
let user: string;
let lessonId: string;
let runId: string;
const DAY = '2026-03-02';
const purse = async () => Number((await trx('user_xp').where('user_id', user).first())?.coins) || 0;
const ledger = async () => Number((await trx('coin_events').where('user_id', user).sum('amount as s').first())?.s) || 0;
const newClip = async () => {
	const id = randomUUID();
	await trx('listening_clips').insert({ id, lesson_id: lessonId, role: 'pool', status: 'published' });
	return id;
};
const fund = (n: number) => earnCoins(trx, user, { reason: 'admin', amount: n, dedupe: `fund:${randomUUID()}` }, DAY);
const star = async (o: { clip?: string; value?: number; correct?: boolean; hint?: boolean } = {}) =>
	playStar(trx, user, { runId, clipId: o.clip || (await newClip()), lessonId, value: o.value ?? 10, correct: o.correct ?? true, hint: o.hint ?? false, today: DAY });

before(async () => {
	db = knex({ client: 'pg', connection: process.env.DB_CONNECTION_STRING, pool: { min: 1, max: 2 } });
});
after(async () => db.destroy());
beforeEach(async () => {
	trx = await db.transaction();
	user = randomUUID();
	await trx('directus_users').insert({ id: user, email: `stars-${user}@example.com`, status: 'active', is_internal: true });
	const k = randomUUID().slice(0, 8);
	const [g] = await trx('listening_groups').insert({ name: `T ${k}`, slug: `t-${k}` }).returning('id');
	const [sk] = await trx('listening_skills').insert({ group_id: g.id, name: `T ${k}`, slug: `t-${k}` }).returning('id');
	const [l] = await trx('listening_lessons').insert({ skill_id: sk.id, short_id: `t${k}`, text: `phrase ${k}` }).returning('id');
	lessonId = l.id;
	const [r] = await trx('listening_runs').insert({ user_id: user, learner_key: `u:${user}`, mode: 'learn', lesson_id: lessonId }).returning('id');
	runId = r.id;
});
afterEach(async () => { await trx.rollback(); applyCoinSettings(null); });

describe('what a question is worth', () => {
	test('by difficulty: easy, medium, hard; none is medium', () => {
		assert.deepEqual([1, 2, 3, null].map((d) => starValue(d, 'type')), [5, 10, 15, 10]);
	});
	test('a choice or a word bank is worth half', () => {
		assert.deepEqual(['choice', 'bank', 'gap'].map((f) => starValue(3, f)), [8, 8, 15]);
		assert.equal(starValue(1, 'choice'), 3);
	});
	test('the numbers come from growth_settings', () => {
		applyCoinSettings({ star: { medium: 20, pickPct: 25 } });
		assert.equal(starValue(2, 'type'), 20);
		assert.equal(starValue(2, 'choice'), 5);
	});
});

describe('may an item take a star', () => {
	const base = { on: true, userId: 'u', mode: 'learn', phase: 'practice', tries: 0, used: 0 };
	test('a normal item can', () => assert.deepEqual(starCheck(base), { ok: true }));
	test('feature off, a guest', () => {
		assert.deepEqual(starCheck({ ...base, on: false }), { ok: false, code: 'STARS_OFF' });
		assert.deepEqual(starCheck({ ...base, userId: null }), { ok: false, code: 'STAR_GUEST' });
	});
	test('a challenge or bank run says nothing until its end: no star', () => {
		for (const mode of ['challenge', 'bank']) assert.deepEqual(starCheck({ ...base, mode }), { ok: false, code: 'STAR_MODE' });
	});
	test('not on the first listen before the explanation, not on a retry', () => {
		for (const phase of ['pre', 'retry']) assert.deepEqual(starCheck({ ...base, phase }), { ok: false, code: 'STAR_PHASE' });
	});
	test('not after a first try at a typed item', () => assert.deepEqual(starCheck({ ...base, tries: 1 }), { ok: false, code: 'STAR_LATE' }));
	test('a run has COIN.star.perRun stars', () => {
		assert.equal(starCheck({ ...base, used: COIN.star.perRun - 1 }).ok, true);
		assert.deepEqual(starCheck({ ...base, used: COIN.star.perRun }), { ok: false, code: 'STAR_NONE_LEFT' });
	});
});

describe('a star in the ledger', () => {
	test('right: win the value, one row of reason star with its meta', async () => {
		await fund(100);
		const r = await star({ value: 10, correct: true });
		assert.deepEqual([r!.outcome, r!.delta, r!.balance, r!.stars_left], ['right', 10, 110, 1]);
		const row = await trx('coin_events').where({ user_id: user, reason: 'star' }).first();
		assert.equal(row.amount, 10);
		assert.equal(row.meta.run_id, runId);
		assert.equal(await purse(), await ledger());
	});
	test('wrong: lose the value', async () => {
		await fund(100);
		const r = await star({ value: 15, correct: false });
		assert.deepEqual([r!.outcome, r!.delta, r!.balance], ['wrong', -15, 85]);
		assert.equal(await purse(), await ledger());
	});
	test('a gold star pays three times when right', async () => {
		await fund(100);
		const r = await playStar(trx, user, { runId, clipId: await newClip(), lessonId, value: 10, correct: true, hint: false, today: DAY, kind: 'gold' });
		assert.deepEqual([r!.outcome, r!.delta, r!.balance], ['right', 30, 130]);
		assert.equal(await purse(), await ledger());
	});
	test('a shield turns a miss into nothing, and is only used when it saved a loss', async () => {
		await fund(100);
		const miss = await playStar(trx, user, { runId, clipId: await newClip(), lessonId, value: 15, correct: false, hint: false, today: DAY, shielded: true });
		assert.deepEqual([miss!.outcome, miss!.delta, miss!.shield_used, miss!.balance], ['void', 0, true, 100]);
		const hit = await playStar(trx, user, { runId, clipId: await newClip(), lessonId, value: 10, correct: true, hint: false, today: DAY, shielded: true });
		assert.deepEqual([hit!.outcome, hit!.delta, hit!.shield_used], ['right', 10, false]);
	});
	test('a hint voids the star: nothing won or lost, still one star used', async () => {
		await fund(100);
		const r = await star({ hint: true, correct: false });
		assert.deepEqual([r!.outcome, r!.delta, r!.balance, r!.stars_left], ['void', 0, 100, 1]);
		assert.equal(await trx('coin_events').where({ user_id: user, reason: 'star' }).first(), undefined);
		assert.equal(await starsUsed(trx, runId), 1);
	});
	test('a question takes a star once, ever: the second is refused and pays nothing', async () => {
		await fund(100);
		const clip = await newClip();
		assert.ok(await star({ clip, correct: true }));
		assert.equal(await star({ clip, correct: true }), null);
		assert.equal(await purse(), 110);
	});
	test('the same clip in another run is still refused', async () => {
		await fund(100);
		const clip = await newClip();
		await star({ clip });
		const [r2] = await trx('listening_runs').insert({ user_id: user, learner_key: `u:${user}`, mode: 'learn', lesson_id: lessonId }).returning('id');
		assert.equal(await playStar(trx, user, { runId: r2.id, clipId: clip, lessonId, value: 10, correct: true, hint: false, today: DAY }), null);
	});
	test('the purse must cover what a star can lose', async () => {
		await fund(8);
		assert.equal(await canAfford(trx, user, 10), false);
		assert.equal(await canAfford(trx, user, 8), true);
	});
	test('the summary counts stars, the delta and the wrong ones', async () => {
		await fund(100);
		const wrongClip = await newClip();
		await star({ correct: true, value: 10 });
		await star({ clip: wrongClip, correct: false, value: 15 });
		const s = await starSummary(trx, runId);
		assert.deepEqual([s.used, s.right, s.wrong, s.void, s.delta], [2, 1, 1, 0, -5]);
		assert.deepEqual(s.missed, [{ clip_id: wrongClip, lesson_id: lessonId, value: 15 }]);
	});
});
