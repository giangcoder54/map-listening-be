/**
 * XP, streak, streak freezes, levels and rewards (src/lib/xp.ts), against the real database.
 *
 *   npm run test:xp      (needs the local stack: docker compose up)
 *
 * Runs inside the API container (it has knex, pg and the database), bundled by esbuild.
 * Every test makes its own learner inside a transaction that is rolled back at the end:
 * nothing is left in the database, and no test depends on another or on today's date
 * (each one plays its own days through recordPractice's `today`).
 */
import { after, before, beforeEach, afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
	FREEZE_EVERY_XP, GOAL_DAYS_FOR_REWARD, LEVELS, MAX_FREEZES, XP,
	engagementOf, grantRewards, lessonXp, levelOf, recordPractice, type NewReward,
} from '../src/lib/xp';

// knex as Directus has it: pnpm keeps it (and pg next to it) in /directus/node_modules/.pnpm
const PNPM = '/directus/node_modules/.pnpm';
const knexDir = readdirSync(PNPM).find((d) => d.startsWith('knex@'));
if (!knexDir) throw new Error(`knex not found in ${PNPM}: run this inside the API container (npm run test:xp)`);
const knex = createRequire(`${PNPM}/${knexDir}/node_modules/knex/package.json`)('knex');

let db: any;
let trx: any;
let user: string;

const D0 = '2026-03-02'; // a Monday: day 0 of every test
const day = (n: number) => {
	const d = new Date(`${D0}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
};
let seq = 0;
/** A practice on day n that wins 10 XP (for the streak, freeze and reward tests) */
const gain = (n: number, amount = 10) =>
	recordPractice(trx, user, { attempts: 1, xp: { reason: 'review', dedupe: `test:${++seq}`, amount } }, day(n));
/** An answer that wins nothing: still a practice day */
const miss = (n: number) => recordPractice(trx, user, { attempts: 1 }, day(n));
/** Reach a goal of `goal` XP on day n, 10 XP at a time: the Premium days it gave */
const reachGoal = async (n: number, goal = 30) => {
	const rewards: NewReward[] = [];
	for (let xp = 0; xp < goal; xp += 10) rewards.push(...(await gain(n)).rewards);
	return rewards.filter((r) => r.kind === 'premium_day');
};

/** A lesson with `clips` step-1 clips (and a step-2 one): group, skill, lesson, clips */
const makeLesson = async (clips = 5) => {
	const k = randomUUID().slice(0, 8);
	const [g] = await trx('listening_groups').insert({ name: `T ${k}`, slug: `t-${k}` }).returning('id');
	const [sk] = await trx('listening_skills').insert({ group_id: g.id, name: `T ${k}`, slug: `t-${k}` }).returning('id');
	const [l] = await trx('listening_lessons').insert({ skill_id: sk.id, short_id: `t${k}`, text: `phrase ${k}` }).returning('id');
	const ids = Array.from({ length: clips }, () => randomUUID());
	await trx('listening_clips').insert([
		...ids.map((id) => ({ id, lesson_id: l.id, step: 'type' })),
		{ id: randomUUID(), lesson_id: l.id, step: 'voice' },
	]);
	return { id: l.id as string, clips: ids };
};
/** An answer on day n, at noon in Vietnam: right, wrong, or "show answer" */
const answer = (n: number, clipId: string, kind: 'right' | 'wrong' | 'reveal' = 'right') =>
	trx('listening_attempts').insert({
		id: randomUUID(), user_id: user, clip_id: clipId, is_correct: kind === 'right',
		answer: kind === 'reveal' ? '[REVEALED]' : 'x', date_created: `${day(n)}T05:00:00Z`,
	});
const answerAll = async (n: number, lesson: { clips: string[] }) => { for (const c of lesson.clips) await answer(n, c); };
const finish = (n: number, lesson: { id: string }) => lessonXp(trx, user, lesson.id, day(n));
const account = () => trx('user_xp').where('user_id', user).first();
const eng = (n: number) => engagementOf(trx, user, day(n));

before(async () => {
	db = knex({ client: 'pg', connection: process.env.DB_CONNECTION_STRING, pool: { min: 1, max: 2 } });
});
after(async () => db.destroy());

beforeEach(async () => {
	trx = await db.transaction();
	user = randomUUID();
	await trx('directus_users').insert({ id: user, email: `xp-${user}@example.com`, status: 'active', daily_goal: 30, is_internal: true });
});
afterEach(async () => trx.rollback());

describe('XP rules (by lesson)', () => {
	test('a lesson gives 20 XP the first time, whatever its number of clips', async () => {
		const five = await makeLesson(5);
		await answerAll(0, five);
		assert.deepEqual(await finish(0, five).then(({ xp, kind }) => ({ xp, kind })), { xp: XP.lesson, kind: 'new' });
		const one = await makeLesson(1);
		await answerAll(0, one);
		assert.equal((await finish(0, one)).xp, XP.lesson, 'one clip or five: the same');
		assert.equal((await account()).xp_total, 2 * XP.lesson);
	});

	test('an answer of step 1 looked at: 10 XP instead of 20', async () => {
		const lesson = await makeLesson(3);
		await answer(0, lesson.clips[1]!, 'reveal');
		await answerAll(0, lesson);
		const won = await finish(0, lesson);
		assert.equal(won.xp, XP.lessonRevealed);
		assert.equal(won.kind, 'revealed');
	});

	test('wrong tries before the right one cost nothing', async () => {
		const lesson = await makeLesson(2);
		await answer(0, lesson.clips[0]!, 'wrong');
		await answer(0, lesson.clips[0]!, 'wrong');
		await answerAll(0, lesson);
		assert.equal((await finish(0, lesson)).xp, XP.lesson);
	});

	test('done again: 5 XP, once a day, only when step 1 was answered right again that day', async () => {
		const lesson = await makeLesson(3);
		await answerAll(0, lesson);
		assert.equal((await finish(0, lesson)).xp, XP.lesson);
		assert.deepEqual(await finish(0, lesson).then(({ xp, kind }) => ({ xp, kind })), { xp: 0, kind: null }, 'the same day');
		assert.equal((await finish(1, lesson)).xp, 0, 'next day, without answering: nothing');
		await answer(1, lesson.clips[0]!);
		assert.equal((await finish(1, lesson)).xp, 0, 'only part of step 1 done again');
		await answerAll(1, lesson);
		assert.deepEqual(await finish(1, lesson).then(({ xp, kind }) => ({ xp, kind })), { xp: XP.replay, kind: 'replay' });
		assert.equal((await finish(1, lesson)).xp, 0, 'twice the same day');
		await answerAll(2, lesson);
		assert.equal((await finish(2, lesson)).xp, XP.replay, 'and again the next day');
	});

	test('each review answered right gives 5 XP', async () => {
		const review = (id: string) => recordPractice(trx, user, { attempts: 1, xp: { reason: 'review', dedupe: `review:${id}` } }, day(0));
		assert.equal((await review('r1')).xp, XP.review);
		assert.equal((await review('r2')).xp, XP.review);
		assert.equal((await review('r1')).xp, 0, 'the same attempt twice');
	});

	test('XP today and this week (weeks start on Monday)', async () => {
		await gain(0); await gain(1); await gain(1); // Mon, Tue
		await gain(7); // next Monday
		const e = await eng(7);
		assert.equal(e.xp_today, 10);
		assert.equal(e.xp_week, 10, 'last week does not count');
		assert.equal((await eng(1)).xp_week, 30);
	});
});

describe('Streak', () => {
	test('days in a row with any answer, wrong ones too', async () => {
		await gain(0); await miss(1); await gain(2);
		const e = await eng(2);
		assert.equal(e.streak, 3);
		assert.equal(e.practiced_today, true);
	});

	test('today not practised yet: the streak still counts up to yesterday', async () => {
		await gain(0); await gain(1);
		const e = await eng(2);
		assert.equal(e.streak, 2);
		assert.equal(e.practiced_today, false);
	});

	test('a missed day without a freeze breaks it', async () => {
		await gain(0); await gain(1); await gain(3);
		assert.equal((await eng(3)).streak, 1);
	});
});

describe('Streak freezes', () => {
	const giveFreezes = (n: number) => trx('user_xp').insert({ user_id: user, freezes: n }).onConflict('user_id').merge();

	test('one missed day, one freeze: covered, the freeze is spent', async () => {
		await gain(0); await gain(1);
		await giveFreezes(1);
		await gain(3);
		const e = await eng(3);
		assert.equal(e.streak, 4, 'day 2 is frozen');
		assert.equal(e.freezes, 0);
		const frozen = await trx('user_daily_stats').where({ user_id: user, frozen: true }).pluck('day');
		assert.deepEqual(frozen.map((d: any) => new Date(d).toISOString().slice(0, 10)), [day(2)]);
	});

	test('covered on the first look at the site, before any answer', async () => {
		await gain(0);
		await giveFreezes(1);
		const e = await eng(2);
		assert.equal(e.streak, 2);
		assert.equal(e.practiced_today, false);
		assert.equal(e.freezes, 0);
	});

	test('two missed days, one freeze: broken, nothing spent', async () => {
		await gain(0);
		await giveFreezes(1);
		await gain(3);
		const e = await eng(3);
		assert.equal(e.streak, 1);
		assert.equal(e.freezes, 1);
	});

	test('two missed days, two freezes: both spent', async () => {
		await gain(0);
		await giveFreezes(2);
		await gain(3);
		const e = await eng(3);
		assert.equal(e.streak, 4);
		assert.equal(e.freezes, 0);
	});

	test('no missed day: nothing spent', async () => {
		await gain(0);
		await giveFreezes(1);
		await gain(1);
		assert.equal((await eng(1)).freezes, 1);
	});

	test('a freeze every 500 XP, as a reward', async () => {
		await trx('user_xp').insert({ user_id: user, xp_total: FREEZE_EVERY_XP - 10 });
		const { rewards } = await gain(0);
		assert.deepEqual(rewards, [{ kind: 'freeze', days: 0, key: 'freeze:1' }]);
		const acc = await account();
		assert.equal(acc.freezes, 1);
		assert.equal(acc.freezes_awarded, 1);
		assert.equal((await gain(0)).rewards.length, 0, 'not again before the next 500');
	});

	test(`never more than ${MAX_FREEZES} held`, async () => {
		await trx('user_xp').insert({ user_id: user, xp_total: 2 * FREEZE_EVERY_XP - 10, freezes: MAX_FREEZES, freezes_awarded: 1 });
		const { rewards } = await gain(0);
		assert.equal(rewards.length, 0, 'full: no reward to show');
		const acc = await account();
		assert.equal(acc.freezes, MAX_FREEZES);
		assert.equal(acc.freezes_awarded, 2, 'the 1000 is used up all the same');
	});
});

describe(`${GOAL_DAYS_FOR_REWARD}-day reward`, () => {
	test(`the ${GOAL_DAYS_FOR_REWARD}th goal day in a row gives a Premium day, once`, async () => {
		for (let n = 0; n < GOAL_DAYS_FOR_REWARD - 1; n++) assert.deepEqual(await reachGoal(n), [], `day ${n}`);
		const won = await reachGoal(GOAL_DAYS_FOR_REWARD - 1);
		assert.deepEqual(won, [{ kind: 'premium_day', days: 1, key: `premium:${day(GOAL_DAYS_FOR_REWARD - 1)}` }]);
		assert.deepEqual((await gain(GOAL_DAYS_FOR_REWARD - 1)).rewards, [], 'more XP the same day');
		const e = await eng(GOAL_DAYS_FOR_REWARD - 1);
		assert.equal(e.goal_days, GOAL_DAYS_FOR_REWARD);
		assert.equal(e.rewards_new.filter((r: any) => r.kind === 'premium_day').length, 1);
	});

	test('the 14th day gives another one', async () => {
		let count = 0;
		for (let n = 0; n < 2 * GOAL_DAYS_FOR_REWARD; n++) count += (await reachGoal(n)).length;
		assert.equal(count, 2);
	});

	test('a day under the goal starts the count again', async () => {
		for (let n = 0; n < 3; n++) await reachGoal(n);
		await gain(3); // 10 of 30 XP
		let count = 0;
		for (let n = 4; n < 4 + GOAL_DAYS_FOR_REWARD - 1; n++) count += (await reachGoal(n)).length;
		assert.equal(count, 0, 'only 6 in a row since day 3');
		assert.equal((await reachGoal(4 + GOAL_DAYS_FOR_REWARD - 1)).length, 1);
	});

	test('a day kept by a freeze keeps the streak, not the goal count', async () => {
		for (let n = 0; n < 6; n++) await reachGoal(n);
		await trx('user_xp').where('user_id', user).update({ freezes: 1 });
		const won = await reachGoal(7); // day 6 missed, frozen
		assert.equal(won.length, 0);
		const e = await eng(7);
		assert.equal(e.streak, 8);
		assert.equal(e.goal_days, 1);
	});

	test('a goal changed today counts at once; past days keep theirs', async () => {
		await reachGoal(0); // goal 30
		await trx('directus_users').where('id', user).update({ daily_goal: 50 });
		await reachGoal(1, 30);
		let e = await eng(1);
		assert.equal(e.goal_met_today, false);
		assert.equal(e.goal_days, 1, 'day 0 met its own goal; today is not done');
		await reachGoal(1, 20);
		e = await eng(1);
		assert.equal(e.goal_met_today, true);
		assert.equal(e.goal_days, 2);
	});
});

describe('Levels', () => {
	test('boundaries', () => {
		assert.deepEqual(levelOf(0), { level: 1, from: 0, to: LEVELS[1] });
		assert.equal(levelOf(LEVELS[1]! - 1).level, 1);
		assert.equal(levelOf(LEVELS[1]!).level, 2);
		assert.deepEqual(levelOf(LEVELS.at(-1)! + 5000), { level: LEVELS.length, from: LEVELS.at(-1), to: null });
	});

	test('the level follows lifetime XP', async () => {
		await trx('user_xp').insert({ user_id: user, xp_total: LEVELS[2]! - 10 });
		await gain(0);
		const e = await eng(0);
		assert.equal(e.level, 3);
		assert.equal(e.xp_total, LEVELS[2]);
	});
});

describe('Premium day given', () => {
	/** Directus' users service, recording what it is asked to write */
	const servicesSpy = () => {
		const calls: any[] = [];
		class UsersService { async updateOne(id: string, data: any) { calls.push({ id, data }); } }
		return { calls, services: { UsersService } };
	};
	const reward: NewReward = { kind: 'premium_day', days: 1, key: `premium:${day(0)}` };
	const logger = { info() {}, warn() {}, error() {} };
	const DAY_MS = 86400_000;

	test('a free learner: Premium from now for a day', async () => {
		const { calls, services } = servicesSpy();
		await grantRewards({ database: trx, services, logger }, null, user, [reward]);
		const end = new Date(calls.at(-1).data.premium_until).getTime();
		assert.ok(Math.abs(end - (Date.now() + DAY_MS)) < 60_000);
		assert.equal(calls.at(-1).data.is_premium, true);
	});

	test('Premium already running: a day added at its end', async () => {
		const until = new Date(Date.now() + 10 * DAY_MS);
		await trx('directus_users').where('id', user).update({ is_premium: true, premium_until: until, subscription_type: 'pro' });
		const { calls, services } = servicesSpy();
		await grantRewards({ database: trx, services, logger }, null, user, [reward]);
		assert.equal(new Date(calls.at(-1).data.premium_until).getTime(), until.getTime() + DAY_MS);
		assert.equal(calls.at(-1).data.subscription_type, 'pro', 'the plan stays');
	});

	test('a lifetime member: nothing to add, the reward is kept at 0 days', async () => {
		await trx('directus_users').where('id', user).update({ is_premium: true, premium_until: null, subscription_type: 'lifetime' });
		await trx('user_rewards').insert({ user_id: user, kind: 'premium_day', dedupe_key: reward.key, days: 1 });
		const { calls, services } = servicesSpy();
		await grantRewards({ database: trx, services, logger }, null, user, [reward]);
		assert.equal(calls.length, 0);
		assert.equal((await trx('user_rewards').where('user_id', user).first()).days, 0);
	});

	test('a freeze alone gives no Premium', async () => {
		const { calls, services } = servicesSpy();
		await grantRewards({ database: trx, services, logger }, null, user, [{ kind: 'freeze', days: 0, key: 'freeze:1' }]);
		assert.equal(calls.length, 0);
	});
});
