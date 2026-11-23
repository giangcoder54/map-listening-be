/**
 * Kim cương P0 (web repo docs/xu-v2-tasks.md): the numbers from growth_settings (lib/coins.ts
 * applyCoinSettings), the ledger with debt (earnCoins / spend / takeBack), the nightly check
 * (lib/coinLedger.ts) and the admin weeks (v1/adminGemsRoutes.ts), against the real database.
 *
 *   npm run test:gems    (needs the local stack: docker compose up)
 *
 * Same set-up as test/xp.test.ts: every test makes its own learner in a transaction rolled back at the end.
 */
import { after, before, beforeEach, afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { COIN, CoinError, applyCoinSettings, earnCoins, spend, takeBack } from '../src/lib/coins';
import { findMismatches, vnHour, dayBefore } from '../src/lib/coinLedger';
import { weekOf, weeksOf } from '../src/v1/adminGemsRoutes';

const PNPM = '/directus/node_modules/.pnpm';
const knexDir = readdirSync(PNPM).find((d) => d.startsWith('knex@'));
if (!knexDir) throw new Error(`knex not found in ${PNPM}: run this inside the API container (npm run test:gems)`);
const knex = createRequire(`${PNPM}/${knexDir}/node_modules/knex/package.json`)('knex');

let db: any;
let trx: any;
let user: string;
const DAY = '2026-03-02';
const purse = () => trx('user_xp').where('user_id', user).first();
const ledger = async () => Number((await trx('coin_events').where('user_id', user).sum('amount as s').first())?.s) || 0;

before(async () => {
	db = knex({ client: 'pg', connection: process.env.DB_CONNECTION_STRING, pool: { min: 1, max: 2 } });
});
after(async () => db.destroy());
beforeEach(async () => {
	trx = await db.transaction();
	user = randomUUID();
	await trx('directus_users').insert({ id: user, email: `gems-${user}@example.com`, status: 'active', is_internal: true });
});
afterEach(async () => { await trx.rollback(); applyCoinSettings(null); });

describe('numbers from growth_settings', () => {
	test('empty settings keep the defaults', () => {
		applyCoinSettings(null);
		assert.equal(COIN.unlock.pattern, 100);
		assert.equal(COIN.freeze, 50);
	});
	test('known keys are taken, bad values and unknown keys are not', () => {
		applyCoinSettings(JSON.stringify({ freeze: 60, unlock: { pattern: 120, nope: 5 }, earn: { lesson: -3, review: 12 }, typo: 9, retest: 'x' }));
		assert.equal(COIN.freeze, 60);
		assert.equal(COIN.unlock.pattern, 120);
		assert.equal((COIN.unlock as any).nope, undefined);
		assert.equal(COIN.earn.lesson, 70);
		assert.equal(COIN.earn.review, 12);
		assert.equal(COIN.retest, 30);
		assert.equal((COIN as any).typo, undefined);
	});
	test('a new edit starts again from the defaults', () => {
		applyCoinSettings({ freeze: 60 });
		applyCoinSettings({ retest: 40 });
		assert.equal(COIN.freeze, 50);
		assert.equal(COIN.retest, 40);
	});
	test('streak days are sorted longest first', () => {
		applyCoinSettings({ streakDay: [{ from: 1, xu: 5 }, { from: 10, xu: 9 }] });
		assert.deepEqual(COIN.streakDay, [{ from: 10, xu: 9 }, { from: 1, xu: 5 }]);
	});
	test('broken JSON keeps the defaults', () => {
		applyCoinSettings('{oops');
		assert.equal(COIN.freeze, 50);
	});
});

describe('ledger', () => {
	test('earn and spend write the balance after each row and meta', async () => {
		await earnCoins(trx, user, { reason: 'admin', amount: 100, dedupe: 't:1', meta: { why: 'test' } }, DAY);
		await spend(trx, user, 30, 'freeze', 't:2', null, DAY, { item: 'x' });
		const rows = await trx('coin_events').where('user_id', user).orderBy('id');
		assert.deepEqual(rows.map((r: any) => r.balance_after), [100, 70]);
		assert.equal(rows[0].meta.why, 'test');
		assert.equal((await purse()).coins, 70);
		assert.equal(await ledger(), 70);
	});
	test('spending more than the purse is refused', async () => {
		await earnCoins(trx, user, { reason: 'admin', amount: 10, dedupe: 't:1' }, DAY);
		await assert.rejects(spend(trx, user, 20, 'freeze', 't:2', null, DAY), (e: any) => e instanceof CoinError && e.code === 'NOT_ENOUGH');
	});
	test('a chargeback bigger than the purse leaves a debt, paid first by the next earnings', async () => {
		await earnCoins(trx, user, { reason: 'admin', amount: 100, dedupe: 't:1' }, DAY);
		await spend(trx, user, 80, 'freeze', 't:2', null, DAY);
		const back = await takeBack(trx, user, 100, 'chargeback', 't:3', { order_id: 'o1' }, DAY);
		assert.deepEqual([back.coins, back.debt], [0, 80]);
		let p = await purse();
		assert.equal(Number(p.coins) - Number(p.coins_debt), await ledger());
		await earnCoins(trx, user, { reason: 'admin', amount: 50, dedupe: 't:4' }, DAY);
		p = await purse();
		assert.deepEqual([p.coins, p.coins_debt], [0, 30]);
		await earnCoins(trx, user, { reason: 'admin', amount: 50, dedupe: 't:5' }, DAY);
		p = await purse();
		assert.deepEqual([p.coins, p.coins_debt], [20, 0]);
		assert.equal(Number(p.coins) - Number(p.coins_debt), await ledger());
	});
	test('the same chargeback twice is refused', async () => {
		await earnCoins(trx, user, { reason: 'admin', amount: 100, dedupe: 't:1' }, DAY);
		await takeBack(trx, user, 40, 'chargeback', 't:2', null, DAY);
		await assert.rejects(takeBack(trx, user, 40, 'chargeback', 't:2', null, DAY), (e: any) => e instanceof CoinError && e.code === 'ALREADY');
	});
	test('the nightly check finds a purse changed outside the ledger', async () => {
		await earnCoins(trx, user, { reason: 'admin', amount: 100, dedupe: 't:1' }, DAY);
		assert.equal((await findMismatches(trx)).some((m) => m.user_id === user), false);
		await trx('user_xp').where('user_id', user).update({ coins: 150 });
		const m = (await findMismatches(trx)).find((x) => x.user_id === user);
		assert.deepEqual(m && [m.ledger, m.purse, m.debt], [100, 150, 0]);
	});
});

describe('days and weeks', () => {
	test('Vietnam hour', () => assert.equal(vnHour(new Date('2026-03-02T20:30:00Z')), 3));
	test('day before / after', () => {
		assert.equal(dayBefore('2026-03-01'), '2026-02-28');
		assert.equal(dayBefore('2026-03-02', -7), '2026-03-09');
	});
	test('a week starts on Monday', () => {
		assert.equal(weekOf('2026-03-08'), '2026-03-02');
		assert.equal(weekOf('2026-03-02'), '2026-03-02');
	});
	test('weeks add up their days and reasons, newest first', () => {
		const out = weeksOf([
			{ day: '2026-03-02', reason: 'lesson', earned: 100, spent: 0, events: 2 },
			{ day: '2026-03-04', reason: 'unlock', earned: 0, spent: 50, events: 1 },
			{ day: '2026-03-09', reason: 'lesson', earned: 30, spent: 0, events: 1 },
		], '2026-03-02');
		const first = out.find((w) => w.week === '2026-03-02')!;
		assert.deepEqual([first.earned, first.spent, first.ratio], [100, 50, 2]);
		assert.equal(first.reasons[0]!.reason, 'lesson');
		assert.ok(out[0]!.week > out[out.length - 1]!.week);
	});
});
