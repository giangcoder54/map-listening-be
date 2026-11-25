/**
 * What happens when a Kim cương order is paid or refunded (lib/gemOrders.ts), against the real database,
 * with no webhook, so nothing is sent to Telegram. Web repo docs/test-cases/payment-gems.md, group P.
 *
 *   npm run test:payment    (needs the local stack: docker compose up)
 *
 * Same set-up as test/gems.test.ts: every test makes its own learner in a transaction rolled back at the end.
 */
import { after, before, beforeEach, afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { earnCoins, spend } from '../src/lib/coins';
import { ORDER_LIMIT, ORDER_MINUTES, chargebackCoinOrder, creditCoinOrder, firstCoins, orderWait, packCoins } from '../src/lib/gemOrders';

const PNPM = '/directus/node_modules/.pnpm';
const knexDir = readdirSync(PNPM).find((d) => d.startsWith('knex@'));
if (!knexDir) throw new Error(`knex not found in ${PNPM}: run this inside the API container (npm run test:payment)`);
const knex = createRequire(`${PNPM}/${knexDir}/node_modules/knex/package.json`)('knex');

let db: any;
let trx: any;
let user: string;
let pack: any;
const DAY = '2026-03-02';
const purse = () => trx('user_xp').where('user_id', user).first();
const ledger = async () => Number((await trx('coin_events').where('user_id', user).sum('amount as s').first())?.s) || 0;
const order = async (o: Record<string, unknown> = {}) => {
	const id = randomUUID();
	await trx('purchase_histories').insert({
		id, user, status: 'published', date_created: new Date(), amount: pack.price_vnd, currency: 'vnd', payment_method: 'bank_transfer',
		type: 'gems', product_type: 'coins', pack_code: pack.code, coins: packCoins(pack), transfer_code: `QAUNIT${id.slice(0, 12)}`, ...o,
	});
	return id;
};

before(async () => {
	db = knex({ client: 'pg', connection: process.env.DB_CONNECTION_STRING, pool: { min: 1, max: 2 } });
	pack = await db('xu_packs').where('active', true).orderBy('sort').first();
});
after(async () => db.destroy());
beforeEach(async () => {
	trx = await db.transaction();
	user = randomUUID();
	await trx('directus_users').insert({ id: user, email: `pay-${user}@example.com`, status: 'active', is_internal: true });
});
afterEach(async () => { await trx.rollback(); });

describe('paying an order', () => {
	test('P1 a pending order pays nothing', async () => {
		const r = await creditCoinOrder(trx, await order({ status: 'pending' }));
		assert.equal(r.added, 0);
	});

	test('P2 the first top-up gets the first-time multiplier', async () => {
		const r = await creditCoinOrder(trx, await order());
		assert.equal(r.added, firstCoins(pack));
		assert.equal(Number((await purse()).coins), firstCoins(pack));
	});

	test('P3 the same order paid again (webhook retry, hook after webhook) adds nothing', async () => {
		const id = await order();
		await creditCoinOrder(trx, id);
		const again = await creditCoinOrder(trx, id);
		assert.equal(again.added, 0);
		assert.equal(await ledger(), firstCoins(pack));
	});

	test('P4 the second order has no first-time multiplier', async () => {
		await creditCoinOrder(trx, await order());
		const r = await creditCoinOrder(trx, await order());
		assert.equal(r.added, packCoins(pack));
	});

	test('P5 an order that is not a Kim cương order pays nothing', async () => {
		const r = await creditCoinOrder(trx, await order({ product_type: 'plan' }));
		assert.equal(r.added, 0);
	});
});

describe('refunding an order', () => {
	test('P6 unspent Kim cương are taken back, the order is refunded, the account flagged', async () => {
		const id = await order();
		await creditCoinOrder(trx, id);
		const r = await chargebackCoinOrder(trx, id);
		assert.equal(r.taken, firstCoins(pack));
		assert.equal(Number((await purse()).coins), 0);
		assert.equal((await trx('purchase_histories').where('id', id).first()).status, 'refunded');
		assert.equal((await trx('directus_users').where('id', user).first()).gems_flagged, true);
	});

	test('P7 spent Kim cương become debt, paid by the next earnings; the purse never goes below 0', async () => {
		const id = await order();
		await creditCoinOrder(trx, id);
		await spend(trx, user, 100, 'unlock', 'qa:spend', null, DAY);
		const r = await chargebackCoinOrder(trx, id);
		assert.equal(r.debt, 100);
		assert.equal(Number((await purse()).coins), 0);
		await earnCoins(trx, user, { reason: 'lesson', amount: 130, dedupe: 'qa:earn' }, DAY);
		assert.equal(Number((await purse()).coins), 30);
		assert.equal(Number((await purse()).coins_debt), 0);
	});

	test('P8 refunding twice takes the Kim cương once', async () => {
		const id = await order();
		await creditCoinOrder(trx, id);
		await chargebackCoinOrder(trx, id);
		await assert.rejects(() => chargebackCoinOrder(trx, id));
		assert.equal(await ledger(), 0);
	});

	test('P9 an order never paid cannot be refunded', async () => {
		const id = await order({ status: 'pending' });
		await assert.rejects(() => chargebackCoinOrder(trx, id));
	});
});

describe('limit of unpaid orders', () => {
	const alive = (n: number, o: Record<string, unknown> = {}) =>
		Promise.all(Array.from({ length: n }, () => order({ status: 'pending', expire_time: new Date(Date.now() + ORDER_MINUTES * 60_000), ...o })));

	test('P10 below the limit: may order now', async () => {
		await alive(ORDER_LIMIT - 1);
		assert.equal(await orderWait(trx, user), 0);
	});

	test('P11 at the limit: told how many minutes to wait', async () => {
		await alive(ORDER_LIMIT);
		const wait = await orderWait(trx, user);
		assert.ok(wait >= 1 && wait <= ORDER_MINUTES, `wait ${wait}`);
	});

	test('P12 expired orders do not count', async () => {
		await alive(ORDER_LIMIT, { expire_time: new Date(Date.now() - 60_000) });
		assert.equal(await orderWait(trx, user), 0);
	});
});
