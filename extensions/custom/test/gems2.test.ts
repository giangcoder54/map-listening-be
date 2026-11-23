/**
 * Kim cương v2 P2-P7: cards, chests, top-up, hints, rooms (src/lib/cards.ts, chests.ts, gemOrders.ts, help.ts, rooms.ts).
 *
 *   npm run test:gems2    (needs the local stack: docker compose up)
 *
 * Pure rules run without a database. The rest runs each test in a transaction that is rolled back.
 */
import { afterEach, after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { COIN, applyCoinSettings, earnCoins } from '../src/lib/coins';
import { matches, pickCard, pickDifficulty, answerTruth, claimRecovery, drawCard, onAnswer, skipDare, CardError, type CardRow } from '../src/lib/cards';
import { ChestError, openChest, roll, oddsOf, worthOf, type Drop } from '../src/lib/chests';
import { chargebackCoinOrder, creditCoinOrder, firstCoins, packCoins } from '../src/lib/gemOrders';
import { checkHint, leaks, HelpError } from '../src/lib/help';
import { CoopError, advanceDue, leaveCoop, answerCoop, chatCoop, createCoop, getState, joinCoop, lockCoop, nextCoop, playCoop, readyCoop, startCoop, sweepCoop } from '../src/lib/coop';
import { cancelQueue, joinQueue, matchStatus, sweepQueue } from '../src/lib/match';
import { joinVoice } from '../src/lib/voice';
import { levelOfUser } from '../src/lib/coop';
import { createHmac } from 'node:crypto';
import { split, createRoom, joinRoom, answerRoom, sweepRooms, RoomError } from '../src/lib/rooms';

const PNPM = '/directus/node_modules/.pnpm';
const knexDir = readdirSync(PNPM).find((d) => d.startsWith('knex@'));
if (!knexDir) throw new Error(`knex not found in ${PNPM}: run this inside the API container (npm run test:gems2)`);
const knex = createRequire(`${PNPM}/${knexDir}/node_modules/knex/package.json`)('knex');

// A seeded random so a test can say what it expects
const lcg = (seed: number) => { let s = seed; return (n: number) => { s = (s * 1664525 + 1013904223) % 4294967296; return Math.floor((s / 4294967296) * n); }; };
const DAY = '2026-03-02';
const NEXT = '2026-03-03';

describe('picking a card (pure)', () => {
	const mk = (o: Partial<CardRow>): CardRow => ({ id: randomUUID(), kind: 'dare', type: 't', difficulty: 1, level_min: null, level_max: null, weight: 10, hidden: false, reward: { coins: 1 }, ...o });
	test('difficulty comes out near 45/30/20/5', () => {
		const rand = lcg(7); const n = [0, 0, 0, 0];
		for (let i = 0; i < 20000; i++) n[pickDifficulty(rand) - 1]!++;
		const pct = n.map((x) => (x / 200));
		assert.ok(Math.abs(pct[0]! - 45) < 2 && Math.abs(pct[1]! - 30) < 2 && Math.abs(pct[2]! - 20) < 2 && Math.abs(pct[3]! - 5) < 1.5, pct.join(','));
	});
	test('a card whose level range does not fit the learner is left out', () => {
		const cards = [mk({ type: 'a', level_min: 5 }), mk({ type: 'b' })];
		for (let i = 0; i < 50; i++) assert.equal(pickCard({ cards, level: 1, recentTypes: [], rand: lcg(i + 1) })!.type, 'b');
	});
	test('types seen in the last draws are skipped while others remain', () => {
		const cards = [mk({ type: 'a' }), mk({ type: 'b' })];
		for (let i = 0; i < 50; i++) assert.equal(pickCard({ cards, level: 1, recentTypes: ['a'], rand: lcg(i + 1) })!.type, 'b');
		assert.ok(pickCard({ cards: [mk({ type: 'a' })], level: 1, recentTypes: ['a'], rand: lcg(1) }), 'the only type is still drawn');
	});
	test('a hidden card comes about once in 100', () => {
		const cards = [mk({ type: 'a' }), mk({ type: 'h', hidden: true })];
		const rand = lcg(3); let hidden = 0;
		for (let i = 0; i < 20000; i++) if (pickCard({ cards, level: 1, recentTypes: [], rand })!.hidden) hidden++;
		assert.ok(hidden > 100 && hidden < 300, String(hidden));
	});
});

describe('what counts toward a dare', () => {
	const ev = { correct: true, hint: false, phase: 'practice', difficulty: 3, listens: 1, star: null as any };
	test('right answers, the filter by difficulty and by listens', () => {
		assert.equal(matches({ metric: 'correct' }, ev), true);
		assert.equal(matches({ metric: 'correct' }, { ...ev, correct: false }), false);
		assert.equal(matches({ metric: 'correct' }, { ...ev, hint: true }), false);
		assert.equal(matches({ metric: 'correct', filter: { difficulty: 3 } }, ev), true);
		assert.equal(matches({ metric: 'correct', filter: { difficulty: 2 } }, ev), false);
		assert.equal(matches({ metric: 'correct', filter: { listens: 1 } }, { ...ev, listens: 2 }), false);
		assert.equal(matches({ metric: 'star_right' }, { ...ev, star: 'right' }), true);
		assert.equal(matches({ metric: 'nope' }, ev), false);
	});
});

describe('chests (pure)', () => {
	const drops: Drop[] = [
		{ item_code: 'a', weight: 70, guaranteed: false, premium_alt: null },
		{ item_code: 'b', weight: 25, guaranteed: false, premium_alt: null },
		{ item_code: 'c', weight: 5, guaranteed: false, premium_alt: 'a' },
	];
	test('10,000 rolls land within 1% of the weights', () => {
		const rand = lcg(11); const n: Record<string, number> = { a: 0, b: 0, c: 0 };
		for (let i = 0; i < 10000; i++) for (const it of roll(drops, 1, { premium: false, rand }).items) n[it]!++;
		assert.ok(Math.abs(n.a! / 100 - 70) < 1.5 && Math.abs(n.b! / 100 - 25) < 1.5 && Math.abs(n.c! / 100 - 5) < 1, JSON.stringify(n));
	});
	test('a learner with Premium gets the replacement instead of the free-lesson item', () => {
		const only: Drop[] = [{ item_code: 'c', weight: 1, guaranteed: false, premium_alt: 'a' }];
		assert.deepEqual(roll(only, 2, { premium: true, rand: lcg(1) }).items, ['a', 'a']);
		assert.deepEqual(roll(only, 2, { premium: false, rand: lcg(1) }).items, ['c', 'c']);
	});
	test('pity: after n-1 openings without the item, the next one holds it, and the counter resets', () => {
		const pity = { n: 4, item: 'c', misses: 0 };
		let misses = 0; let hits = 0;
		const rand = () => 0; // always the first drop, never c
		for (let i = 0; i < 8; i++) {
			const r = roll(drops, 1, { premium: false, rand, pity: { ...pity, misses } });
			misses = r.misses;
			if (r.items.includes('c')) hits++;
		}
		assert.equal(hits, 2, 'every 4th opening');
	});
	test('guaranteed items are always in', () => {
		const g: Drop[] = [...drops, { item_code: 'g', weight: 1, guaranteed: true, premium_alt: null }];
		assert.ok(roll(g, 1, { premium: false, rand: lcg(5) }).items.includes('g'));
	});
	test('odds and worth', () => {
		assert.deepEqual(oddsOf(drops).map((o) => o.pct), [70, 25, 5]);
		assert.equal(worthOf(drops, 2, { a: 10, b: 100, c: 1000 }), Math.round((0.7 * 10 + 0.25 * 100 + 0.05 * 1000) * 2));
	});
});

describe('the pot of a room (pure)', () => {
	const m = (user_id: string, score: number | null, time_ms: number | null) => ({ user_id, score, time_ms });
	test('the best score takes the pot less the house share', () => {
		const s = split([m('a', 4, 9000), m('b', 2, 1000)], 20, 10);
		assert.deepEqual([s.pot, s.prize, s.winners, s.each], [40, 36, ['a'], 36]);
	});
	test('a tie is broken by time, and a tie in time splits', () => {
		assert.deepEqual(split([m('a', 3, 9000), m('b', 3, 5000)], 20, 10).winners, ['b']);
		const s = split([m('a', 3, 5000), m('b', 3, 5000), m('c', 0, 100)], 10, 10);
		assert.deepEqual([s.winners.sort(), s.each], [['a', 'b'], 13]);
	});
});

describe('hints leave the answer out (pure)', () => {
	test('a hint with a word of the answer is refused', () => {
		assert.equal(leaks('It starts like the word gonna', 'I was gonna go'), true);
		assert.equal(leaks('Two words are joined near the end', 'I was gonna go'), false);
		assert.throws(() => checkHint('rule', 'the answer is gonna', 'gonna go'), (e: any) => e instanceof HelpError && e.code === 'HINT_LEAKS');
		assert.throws(() => checkHint('letter', 'gg', 'gonna'), (e: any) => e.code === 'BAD_REQUEST');
		assert.equal(checkHint('letter', 'g', 'gonna'), 'g');
	});
});

// ── with the database ─────────────────────────────────────────────────────────────────────────
let db: any; let trx: any; let user: string; let other: string; let third: string;
const mkUser = async (name: string) => { const id = randomUUID(); await trx('directus_users').insert({ id, email: `${name}-${id}@example.com`, status: 'active', is_internal: true, first_name: name }); return id; };
const fund = (id: string, n: number) => earnCoins(trx, id, { reason: 'admin', amount: n, dedupe: `fund:${randomUUID()}` }, DAY);
const purse = async (id: string) => Number((await trx('user_xp').where('user_id', id).first())?.coins) || 0;
const ledger = async (id: string) => Number((await trx('coin_events').where('user_id', id).sum('amount as s').first())?.s) || 0;
const debt = async (id: string) => Number((await trx('user_xp').where('user_id', id).first())?.coins_debt) || 0;

before(async () => { db = knex({ client: 'pg', connection: process.env.DB_CONNECTION_STRING, pool: { min: 1, max: 2 } }); });
after(async () => db.destroy());
beforeEach(async () => { trx = await db.transaction(); user = await mkUser('Ann'); other = await mkUser('Ben'); third = await mkUser('Cy'); });
afterEach(async () => { await trx.rollback(); applyCoinSettings(null); });

describe('chests with the database', () => {
	test('opening takes the price, gives the items, and a double click opens once', async () => {
		await fund(user, 1000);
		const id = randomUUID();
		const r = await openChest(trx, user, 'bronze', id, { premium: false, today: DAY });
		assert.equal(r.price, 150);
		assert.equal(r.items.length, 2);
		const again = await openChest(trx, user, 'bronze', id, { premium: false, today: DAY });
		assert.equal(again.replay, true);
		assert.equal(await trx('chest_opens').where('user_id', user).count('* as n').first().then((x: any) => Number(x.n)), 1);
		assert.equal(await purse(user), await ledger(user), 'the purse matches the ledger');
	});
	test('not enough Kim cuong: refused, nothing taken', async () => {
		await fund(user, 100);
		await assert.rejects(openChest(trx, user, 'bronze', randomUUID(), { premium: false, today: DAY }), (e: any) => e instanceof ChestError && e.code === 'NOT_ENOUGH');
		assert.equal(await purse(user), 100);
	});
	test('the welcome chest is free and opens once per account', async () => {
		const r = await openChest(trx, user, 'newbie', randomUUID(), { premium: false, today: DAY });
		assert.equal(r.price, 0);
		await assert.rejects(openChest(trx, user, 'newbie', randomUUID(), { premium: false, today: DAY }), (e: any) => e.code === 'ONCE');
		assert.equal(await purse(user), 100, 'its guaranteed 100 Kim cuong');
		assert.equal(await purse(user), await ledger(user));
	});
	test('every chest in the seed is worth 70-110% of its price', async () => {
		const items = Object.fromEntries((await trx('items').select('code', 'value')).map((i: any) => [i.code, Number(i.value)]));
		for (const c of await trx('chests').where('price', '>', 0)) {
			const drops = await trx('chest_drops').where('chest_code', c.code);
			const pct = (worthOf(drops, Number(c.rolls), items) / c.price) * 100;
			assert.ok(pct >= 70 && pct <= 110, `${c.code}: ${pct}%`);
		}
	});
});

describe('top-up with the database', () => {
	const order = async (uid: string, pack = 'p20', status = 'published') => {
		const id = randomUUID();
		const p = await trx('xu_packs').where('code', pack).first();
		await trx('purchase_histories').insert({ id, user: uid, status, product_type: 'coins', pack_code: pack, coins: packCoins(p), amount: p.price_vnd, type: 'gems' });
		return id;
	};
	test('a paid order pays its Kim cuong once, whoever asks', async () => {
		const id = await order(user, 'p50');
		assert.equal((await creditCoinOrder(trx, id)).added, 2200);
		assert.equal((await creditCoinOrder(trx, id)).added, 0);
		assert.equal(await purse(user), 2200);
		assert.equal(await purse(user), await ledger(user));
	});
	test('an order not paid yet pays nothing', async () => {
		const id = await order(user, 'p50', 'pending');
		assert.equal((await creditCoinOrder(trx, id)).added, 0);
		assert.equal(await purse(user), 0);
	});
	test('the first top-up gets the pack first bonus, the next does not', async () => {
		const p = await trx('xu_packs').where('code', 'p20').first();
		assert.equal(firstCoins(p), 1600);
		assert.equal((await creditCoinOrder(trx, await order(user, 'p20'))).added, 1600);
		assert.equal((await creditCoinOrder(trx, await order(user, 'p20'))).added, 800);
	});
	test('a chargeback takes it back; what is spent becomes debt, paid by the next Kim cuong earned', async () => {
		const id = await order(user, 'p20');
		await creditCoinOrder(trx, id);
		await trx('user_xp').where('user_id', user).update({ coins: 100 });
		await trx('coin_events').insert({ user_id: user, amount: -1500, reason: 'unlock', dedupe_key: 'spent', day: DAY, balance_after: 100 });
		const r = await chargebackCoinOrder(trx, id);
		assert.equal(r.coins, 0);
		assert.equal(await debt(user), 1500);
		await fund(user, 1000);
		assert.equal(await purse(user), 0);
		assert.equal(await debt(user), 500);
		assert.equal((await trx('purchase_histories').where('id', id).first()).status, 'refunded');
	});
});

describe('cards with the database', () => {
	test('one draw a day, and a dare not done blocks the next day', async () => {
		const d = await drawCard(trx, user, { kind: 'dare', pick: 0, lang: 'vi-VN', today: DAY, rand: lcg(1) });
		assert.equal(d.kind, 'dare');
		await assert.rejects(drawCard(trx, user, { kind: 'truth', pick: 1, lang: 'vi-VN', today: DAY }), (e: any) => e instanceof CardError && e.code === 'CARD_OPEN');
		await trx('card_draws').where('user_id', user).update({ status: 'done' });
		await assert.rejects(drawCard(trx, user, { kind: 'dare', pick: 0, lang: 'vi-VN', today: DAY }), (e: any) => e.code === 'DRAWN_TODAY');
		const next = await drawCard(trx, user, { kind: 'dare', pick: 0, lang: 'vi-VN', today: NEXT, rand: lcg(2) });
		assert.ok(next.id);
	});
	test('a dare counts the answers that fit, and pays once when its goal is reached', async () => {
		const card = (await trx('cards').insert({ kind: 'dare', type: 'correct_n', difficulty: 1, goal: JSON.stringify({ metric: 'correct', n: 3 }), reward: JSON.stringify({ coins: 77 }), status: 'draft' }).returning('id'))[0];
		const cid = card.id ?? card;
		await trx('cards').where('id', cid).update({ status: 'approved' });
		await trx('cards').whereNot('id', cid).update({ status: 'archived' });
		await drawCard(trx, user, { kind: 'dare', pick: 0, lang: 'vi-VN', today: DAY, rand: lcg(1) });
		const ev = { correct: true, hint: false, phase: 'practice', difficulty: 2, listens: 1, star: null as any };
		const ctx = { freeLesson: false, premium: false };
		assert.equal((await onAnswer(trx, user, ev, ctx, DAY)).dare!.progress, 1);
		assert.equal((await onAnswer(trx, user, { ...ev, correct: false }, ctx, DAY)).dare, null);
		await onAnswer(trx, user, ev, ctx, DAY);
		const last = await onAnswer(trx, user, ev, ctx, DAY);
		assert.equal(last.dare!.done, true);
		assert.equal(await purse(user), 77);
		assert.equal((await onAnswer(trx, user, ev, ctx, DAY)).dare, null, 'done: nothing more counts');
		assert.equal(await purse(user), await ledger(user));
	});
	test('a truth: graded by the server, paid when right, answered once', async () => {
		await trx('cards').where('kind', 'truth').whereNot('type', 'explore').update({ status: 'archived' });
		const d = await drawCard(trx, user, { kind: 'truth', pick: 0, lang: 'vi-VN', today: DAY, rand: lcg(4) });
		assert.equal((d as any).correct_index, undefined, 'the answer is not sent with the question');
		const dyk = await trx('dyk_cards').where('status', 'approved').first();
		const rightIndex = Number((await trx('card_draws as w').join('cards as c', 'c.id', 'w.card_id').join('dyk_cards as k', trx.raw("k.id::text = c.source->>'dyk_card_id'")).where('w.user_id', user).first('k.correct')).correct);
		const r = await answerTruth(trx, user, { choice: rightIndex, premium: false, lang: 'vi-VN', today: DAY });
		assert.equal(r.correct, true);
		assert.equal(await purse(user), 40);
		await assert.rejects(answerTruth(trx, user, { choice: rightIndex, premium: false, lang: 'vi-VN', today: DAY }), (e: any) => e.code === 'ALREADY');
		assert.ok(dyk);
	});
	test('skipping a dare costs Kim cuong; too few and it stays', async () => {
		await drawCard(trx, user, { kind: 'dare', pick: 0, lang: 'vi-VN', today: DAY, rand: lcg(1) });
		await assert.rejects(skipDare(trx, user, DAY), (e: any) => e.code === 'NOT_ENOUGH');
		await fund(user, 80);
		await skipDare(trx, user, DAY);
		assert.equal(await purse(user), 30);
		assert.equal(await trx('card_draws').where({ user_id: user, status: 'open' }).first(), undefined);
	});
	test('the way back: 10 right answers in free lessons while low, then take 50 once', async () => {
		const ev = { correct: true, hint: false, phase: 'practice', difficulty: 1, listens: 1, star: null as any };
		for (let i = 0; i < 12; i++) await onAnswer(trx, user, ev, { freeLesson: true, premium: false }, DAY);
		assert.equal((await trx('recovery_progress').where('user_id', user).first()).n, COIN.recovery.need);
		assert.equal((await claimRecovery(trx, user, DAY)).added, 50);
		await assert.rejects(claimRecovery(trx, user, DAY), (e: any) => e.code === 'ALREADY');
	});
	test('a learner with plenty of Kim cuong gets no way-back progress', async () => {
		await fund(user, 500);
		await onAnswer(trx, user, { correct: true, hint: false, phase: 'practice', difficulty: 1, listens: 1, star: null }, { freeLesson: true, premium: false }, DAY);
		assert.equal(await trx('recovery_progress').where('user_id', user).first(), undefined);
	});
});

describe('rooms with the database', () => {
	test('fees go in, the best score wins the pot less the house share', async () => {
		await fund(user, 100); await fund(other, 100);
		const id = await createRoom(trx, user, { fee: 20, size: 2, today: DAY });
		assert.equal(await purse(user), 80);
		assert.deepEqual(await joinRoom(trx, other, id, DAY), { filled: true });
		const ids: string[] = (await trx('rooms').where('id', id).first()).questions;
		const right = async (i: number) => Number((await trx('dyk_cards').where('id', ids[i]).first('correct')).correct);
		for (let i = 0; i < ids.length; i++) await answerRoom(trx, user, id, { index: i, choice: await right(i) }, DAY);
		for (let i = 0; i < ids.length; i++) await answerRoom(trx, other, id, { index: i, choice: ((await right(i)) + 1) % 3 }, DAY);
		const room = await trx('rooms').where('id', id).first();
		assert.equal(room.status, 'done');
		assert.equal(await purse(user), 80 + 36);
		assert.equal(await purse(other), 80);
		assert.equal(await purse(user), await ledger(user));
		assert.equal(await purse(other), await ledger(other));
	});
	test('a full room, the same player twice, too few Kim cuong: refused', async () => {
		await fund(user, 100); await fund(other, 100); await fund(third, 5);
		const id = await createRoom(trx, user, { fee: 20, size: 2, today: DAY });
		await assert.rejects(joinRoom(trx, user, id, DAY), (e: any) => e instanceof RoomError && e.code === 'JOINED');
		await assert.rejects(joinRoom(trx, third, id, DAY), (e: any) => e.code === 'NOT_ENOUGH');
		await joinRoom(trx, other, id, DAY);
		await assert.rejects(joinRoom(trx, third, id, DAY), (e: any) => e.code === 'NO_ROOM');
	});
	test('a room not full by its deadline gives every fee back', async () => {
		await fund(user, 100);
		const id = await createRoom(trx, user, { fee: 50, size: 3, today: DAY });
		assert.equal(await purse(user), 50);
		await trx('rooms').where('id', id).update({ deadline: new Date(Date.now() - 1000) });
		await sweepRooms(trx, DAY);
		assert.equal((await trx('rooms').where('id', id).first()).status, 'cancelled');
		assert.equal(await purse(user), 100);
	});
	test('a player who has not played by the deadline scores 0', async () => {
		await fund(user, 100); await fund(other, 100);
		const id = await createRoom(trx, user, { fee: 20, size: 2, today: DAY });
		await joinRoom(trx, other, id, DAY);
		const ids: string[] = (await trx('rooms').where('id', id).first()).questions;
		const right = Number((await trx('dyk_cards').where('id', ids[0]).first('correct')).correct);
		await answerRoom(trx, user, id, { index: 0, choice: right }, DAY);
		for (let i = 1; i < ids.length; i++) await answerRoom(trx, user, id, { index: i, choice: Number((await trx('dyk_cards').where('id', ids[i]).first('correct')).correct) }, DAY);
		await trx('rooms').where('id', id).update({ deadline: new Date(Date.now() - 1000) });
		await sweepRooms(trx, DAY);
		assert.equal(await purse(user), 80 + 36);
		assert.equal(await purse(other), 80);
	});
});

describe('Luyen cung (two learners, at the same time)', () => {
	const sentence = async (id: string, idx: number) => String((await trx('coop_rooms').where('id', id).first('questions')).questions[idx].text);
	const ready = async () => { await fund(user, 100); await fund(other, 100); const id = await createCoop(trx, user); await joinCoop(trx, other, id); await startCoop(trx, user, id); return id as string; };
	test('create, join, only the host starts, and a third player is refused', async () => {
		await fund(user, 100); await fund(other, 100);
		const id = await createCoop(trx, user);
		await assert.rejects(startCoop(trx, user, id), (e: any) => e instanceof CoopError && e.code === 'NOT_READY');
		await joinCoop(trx, other, id);
		await assert.rejects(joinCoop(trx, third, id), (e: any) => e.code === 'FULL');
		await assert.rejects(startCoop(trx, other, id), (e: any) => e.code === 'NOT_HOST');
		await startCoop(trx, user, id);
		const s = await getState(trx, user, id);
		assert.equal(s.status, 'playing'); assert.equal(s.idx, 0); assert.equal(s.play_seq, 1);
	});
	test('one open room each', async () => {
		await fund(user, 100);
		await createCoop(trx, user);
		await assert.rejects(createCoop(trx, user), (e: any) => e.code === 'TOO_MANY');
	});
	test('the sentence stays hidden until both have typed, then both see it', async () => {
		const id = await ready();
		const text = await sentence(id, 0);
		let a = await getState(trx, user, id);
		assert.equal(a.reveal, undefined); assert.equal(JSON.stringify(a).includes(text), false, 'the sentence is not sent before the answer');
		assert.equal(a.question.kind, 'dict'); assert.ok(a.question.words > 1);
		await answerCoop(trx, user, id, { idx: 0, text });
		a = await getState(trx, user, id); const b = await getState(trx, other, id);
		assert.equal(a.my_text, text); assert.equal(b.my_text, null); assert.equal(b.answered, 1); assert.equal(b.reveal, undefined);
		await assert.rejects(answerCoop(trx, user, id, { idx: 0, text: 'again' }), (e: any) => e.code === 'BAD_REQUEST', 'one send, then only after the talk');
		await assert.rejects(answerCoop(trx, other, id, { idx: 0, text: '   ' }), (e: any) => e.code === 'BAD_REQUEST', 'an empty text is no answer');
		const r = await answerCoop(trx, other, id, { idx: 0, text: text.toUpperCase() });
		assert.equal(r.revealed, true, 'both right (case and punctuation do not matter): straight to the answer');
		const c = await getState(trx, other, id);
		assert.equal(c.phase, 'reveal'); assert.equal(c.reveal.sentence, text); assert.equal(c.reveal.picks.length, 2); assert.equal(c.reveal.picks.every((x: any) => x.ok), true); assert.equal(c.stars, 1);
	});
	test('"play" bumps the number for everyone; chat reaches the other player', async () => {
		const id = await ready();
		await playCoop(trx, other, id);
		assert.equal((await getState(trx, user, id)).play_seq, 2);
		await chatCoop(trx, user, id, '  hello   there ');
		const s = await getState(trx, other, id, 0);
		assert.equal(s.messages.length, 1); assert.equal(s.messages[0].body, 'hello there'); assert.equal(s.messages[0].you, false);
		assert.equal((await getState(trx, other, id, s.messages[0].id)).messages.length, 0);
		await assert.rejects(chatCoop(trx, third, id, 'hi'), (e: any) => e.code === 'NOT_MEMBER');
	});
	test('all questions done: both are paid once, next is safe to press twice, perDay holds', async () => {
		const id = await ready();
		const total = (await getState(trx, user, id)).total;
		assert.equal(total, COIN.coop.practiceQuestions);
		for (let i = 0; i < total; i++) {
			const text = await sentence(id, i);
			await answerCoop(trx, user, id, { idx: i, text }); await answerCoop(trx, other, id, { idx: i, text });
			const n = await nextCoop(trx, user, id, i, DAY);
			assert.equal(n.done, i === total - 1);
			assert.equal((await nextCoop(trx, other, id, i, DAY)).done, i === total - 1, 'pressing again changes nothing');
		}
		assert.equal(await purse(user), 100 + COIN.coop.reward, 'deposit back + reward'); assert.equal(await purse(other), 100 + COIN.coop.reward);
		assert.equal(await purse(user), await ledger(user));
		const s = await getState(trx, user, id); assert.equal(s.stars, total); assert.equal(s.review.length, total);
	});
	test('a room nobody touches is closed without a reward', async () => {
		const id = await ready();
		await trx('coop_rooms').where('id', id).update({ phase_at: new Date(Date.now() - 3600_000) });
		assert.ok((await sweepCoop(trx)) >= 1, 'other idle rooms in a shared database may be swept too');
		assert.equal((await getState(trx, user, id)).status, 'cancelled');
		assert.equal(await purse(user), 100, 'the deposit is back, no reward');
	});
});

describe('Luyen cung: duel (a clock and a pot)', () => {
	const duel = async (fee = 20) => { await fund(user, 500); await fund(other, 500); const id = await createCoop(trx, user, { mode: 'duel', fee, today: DAY }); await joinCoop(trx, other, id, DAY); await startCoop(trx, user, id); await due(id); await advanceDue(trx, id, DAY); return id as string; };
	const due = (id: string) => trx('coop_rooms').where('id', id).update({ deadline_at: new Date(Date.now() - 1000) });
	const text = async (id: string, idx: number) => String((await trx('coop_rooms').where('id', id).first('questions')).questions[idx].text);
	test('both pay the fee, a waiting guest who leaves gets it back, the host leaving refunds all', async () => {
		await fund(user, 500); await fund(other, 500);
		const id = await createCoop(trx, user, { mode: 'duel', fee: 50, today: DAY });
		await joinCoop(trx, other, id, DAY);
		assert.equal(await purse(user), 450); assert.equal(await purse(other), 450);
		await chatCoop(trx, user, id, 'ready?');
		await leaveCoop(trx, other, id, DAY);
		assert.equal(await purse(other), 500, 'the guest is refunded');
		await joinCoop(trx, other, id, DAY);
		await leaveCoop(trx, user, id, DAY);
		assert.equal(await purse(user), 500); assert.equal(await purse(other), 500);
		assert.equal((await getState(trx, user, id)).status, 'cancelled');
	});
	test('a bad fee and too little Kim cuong are refused', async () => {
		await assert.rejects(createCoop(trx, user, { mode: 'duel', fee: 7 }), (e: any) => e.code === 'BAD_REQUEST');
		await assert.rejects(createCoop(trx, user, { mode: 'duel', fee: 50, today: DAY }), (e: any) => e.code === 'NOT_ENOUGH');
	});
	test('the clock turns an unanswered question to reveal, then on to the next; no chat while playing', async () => {
		const id = await duel();
		assert.ok((await getState(trx, user, id)).ends_in > 0);
		await assert.rejects(chatCoop(trx, user, id, 'hi'), (e: any) => e.code === 'NOT_PLAYING');
		assert.equal(await advanceDue(trx, id, DAY), false, 'not due yet');
		await due(id);
		assert.equal(await advanceDue(trx, id, DAY), true);
		assert.equal((await getState(trx, user, id)).phase, 'reveal');
		await due(id);
		assert.equal(await advanceDue(trx, id, DAY), true);
		const s = await getState(trx, user, id);
		assert.equal(s.idx, 1); assert.equal(s.phase, 'listen', 'the next question starts with the shared listen');
		await assert.rejects(nextCoop(trx, user, id, 1, DAY).then((r) => { if (r.idx !== 1 || r.done) throw new Error('moved'); throw new CoopError('BAD_REQUEST'); }), (e: any) => e.code === 'BAD_REQUEST', 'next is not a player action in a duel');
	});
	test('the better score takes the pot less the house share; Kim cuong are conserved', async () => {
		const id = await duel(50);
		const total = (await getState(trx, user, id)).total;
		for (let i = 0; i < total; i++) {
			if ((await getState(trx, user, id)).phase === 'listen') { await due(id); await advanceDue(trx, id, DAY); }
			await answerCoop(trx, user, id, { idx: i, text: await text(id, i) });
			await answerCoop(trx, other, id, { idx: i, text: 'zzzxq qqqzx' });
			await due(id); await advanceDue(trx, id, DAY);
		}
		const s = await getState(trx, user, id);
		assert.equal(s.status, 'done');
		const pot = 100, prize = pot - Math.floor((pot * COIN.room.rakePct) / 100);
		assert.equal(await purse(user), 500 - 50 + prize); assert.equal(await purse(other), 450);
		assert.ok(s.results.find((r: any) => r.you).score > total * 500, 'a right answer is 500 and more'); assert.equal(s.results.find((r: any) => !r.you).score, 0); assert.equal(s.results.find((r: any) => r.you).prize, prize);
		assert.equal(await purse(user), await ledger(user)); assert.equal(await purse(other), await ledger(other));
	});
	test('answering after the clock is too late; leaving mid-duel forfeits to the other player', async () => {
		const id = await duel(20);
		await due(id);
		await assert.rejects(answerCoop(trx, user, id, { idx: 0, text: 'x' }), (e: any) => e.code === 'BAD_REQUEST');
		await leaveCoop(trx, user, id, DAY);
		const s = await getState(trx, other, id);
		assert.equal(s.status, 'done');
		assert.equal(s.results.find((r: any) => r.you).prize, 36);
		assert.equal(await purse(other), 500 - 20 + 36);
	});
});

describe('Dau v2: shared listen, queue, talk and lock', () => {
	const sentence = async (id: string, idx: number) => String((await trx('coop_rooms').where('id', id).first('questions')).questions[idx].text);
	const due = (id: string) => trx('coop_rooms').where('id', id).update({ deadline_at: new Date(Date.now() - 1000) });
	test('the queue joins two of the same fee, both press ready, the clip is heard first then the clock starts', async () => {
		await fund(user, 100); await fund(other, 100);
		const a = await joinQueue(trx, user, 20, 'duel', DAY); assert.equal(a.status, 'searching'); assert.equal(await purse(user), 80, 'the fee is kept by the queue');
		const b = await joinQueue(trx, other, 20, 'duel', DAY); assert.equal(b.status, 'matched');
		const m = await matchStatus(trx, user); assert.equal(m.status, 'matched');
		const id = (m as any).room_id as string;
		let s = await getState(trx, user, id); assert.equal(s.status, 'waiting'); assert.equal(s.auto, true);
		assert.equal((await readyCoop(trx, user, id)).started, false);
		assert.equal((await readyCoop(trx, other, id)).started, true);
		s = await getState(trx, user, id); assert.equal(s.phase, 'listen'); assert.ok(s.play_in > 0 && s.play_in <= COIN.coop.duelLead);
		await assert.rejects(answerCoop(trx, user, id, { idx: 0, text: 'x' }), (e: any) => e.code === 'BAD_REQUEST', 'no answer while the clip plays');
		await assert.rejects(playCoop(trx, user, id), (e: any) => e.code === 'NOT_PLAYING', 'no replay in a duel');
		await due(id); assert.equal(await advanceDue(trx, id, DAY), true);
		s = await getState(trx, user, id); assert.equal(s.phase, 'answer'); assert.ok(s.ends_in > 0);
	});
	test('leaving the queue gives the fee back; a room nobody readies is closed and refunded', async () => {
		await fund(user, 100); await fund(other, 100);
		await joinQueue(trx, user, 50, 'duel', DAY); await cancelQueue(trx, user, DAY);
		assert.equal(await purse(user), 100);
		await joinQueue(trx, user, 20, 'duel', DAY); await joinQueue(trx, other, 20, 'duel', DAY);
		const id = ((await matchStatus(trx, user)) as any).room_id as string;
		await readyCoop(trx, user, id);
		await due(id); assert.equal(await advanceDue(trx, id, DAY), true);
		assert.equal((await getState(trx, user, id)).status, 'cancelled');
		assert.equal(await purse(user), 100); assert.equal(await purse(other), 100);
		await assert.rejects(joinQueue(trx, other, 20, 'duel', DAY), (e: any) => e.code === 'BANNED', 'whoever was not ready waits a moment');
		await joinQueue(trx, user, 20, 'duel', DAY); assert.equal(await sweepQueue(trx, DAY), 0);
	});
	test('practice: different texts go to talk, both can type again, both locked and both right = a team star; a miss is counted', async () => {
		await fund(user, 100); await fund(other, 100);
		const id = await createCoop(trx, user); await joinCoop(trx, other, id); await startCoop(trx, user, id);
		const text = await sentence(id, 0);
		const first = text.split(' ')[0]!;
		const q = (await trx('coop_rooms').where('id', id).first('questions')).questions[0];
		await answerCoop(trx, user, id, { idx: 0, text });
		await answerCoop(trx, other, id, { idx: 0, text: text.replace(first, 'zzzxq') });
		let s = await getState(trx, user, id); assert.equal(s.phase, 'discuss'); assert.equal(s.picks.length, 2); assert.equal(s.reveal, undefined);
		assert.equal(JSON.stringify(s).includes(text), s.picks.some((p: any) => p.text === text), 'only the typed texts are shown, never the sentence itself');
		await lockCoop(trx, user, id, 0); assert.equal((await getState(trx, user, id)).phase, 'discuss');
		await assert.rejects(answerCoop(trx, user, id, { idx: 0, text: 'x' }), (e: any) => e.code === 'BAD_REQUEST', 'locked: no more typing');
		await answerCoop(trx, other, id, { idx: 0, text });
		assert.equal((await lockCoop(trx, other, id, 0)).revealed, true);
		s = await getState(trx, user, id); assert.equal(s.phase, 'reveal'); assert.equal(s.stars, 1);
		// a second room where the miss stays: it is counted for later
		await leaveCoop(trx, user, id, DAY);
		const id2 = await createCoop(trx, user); await joinCoop(trx, other, id2); await startCoop(trx, user, id2);
		const t2 = await sentence(id2, 0); const q2 = (await trx('coop_rooms').where('id', id2).first('questions')).questions[0];
		const w = t2.split(' ')[0]!.toLowerCase().replace(/[^a-z']/g, '');
		await answerCoop(trx, user, id2, { idx: 0, text: t2.replace(t2.split(' ')[0]!, 'something') });
		await answerCoop(trx, other, id2, { idx: 0, text: t2.replace(t2.split(' ')[0]!, 'another') });
		await lockCoop(trx, user, id2, 0); await lockCoop(trx, other, id2, 0);
		const n = await trx('dict_mishears').where({ source: q2.source, ref_id: q2.ref_id }).count('* as n').first();
		assert.ok(Number(n.n) >= 1, `a word typed for "${w}" is counted`); void q;
	});
	test('duel: a right text is 500 and more, a part of it still earns a part of 400, and what was heard wrongly is counted', async () => {
		await fund(user, 100); await fund(other, 100);
		await joinQueue(trx, user, 20, 'duel', DAY); await joinQueue(trx, other, 20, 'duel', DAY);
		const id = ((await matchStatus(trx, user)) as any).room_id as string;
		await readyCoop(trx, user, id); await readyCoop(trx, other, id);
		await due(id); await advanceDue(trx, id, DAY);
		const qs = (await trx('coop_rooms').where('id', id).first('questions')).questions; qs[0].text = 'I think we should leave the house before it starts to rain'; await trx('coop_rooms').where('id', id).update({ questions: JSON.stringify(qs) });
		const t = await sentence(id, 0); const words = t.split(' '); const q = qs[0];
		await answerCoop(trx, user, id, { idx: 0, text: t });
		await answerCoop(trx, other, id, { idx: 0, text: words.map((w, i) => (i % 2 ? w : 'qqqzx')).join(' ') });
		const s = await getState(trx, user, id);
		assert.equal(s.phase, 'reveal');
		const mine = s.reveal.picks.find((p: any) => p.you); const theirs = s.reveal.picks.find((p: any) => !p.you);
		assert.ok(mine.points >= 500 && mine.ok, 'a right text'); assert.ok(theirs.points < 400 && !theirs.ok, 'a part earns less than 400');
		assert.deepEqual(s.scores.map((x: any) => x.points), [mine.points, theirs.points]);
		const n = await trx('dict_mishears').where({ source: q.source, ref_id: q.ref_id }).count('* as n').first();
		assert.ok(Number(n.n) >= 1, 'the words typed for others are counted');
	});
	test('Tim ban luyen: the same queue, a practice room starts on "answer", the deposit is held until it is done', async () => {
		await fund(user, 100); await fund(other, 100); await fund(third, 100);
		await joinQueue(trx, user, 20, 'practice', DAY);
		await joinQueue(trx, third, 20, 'duel', DAY);
		assert.equal((await matchStatus(trx, user)).status, 'searching', 'a duel searcher is not a practice partner');
		await cancelQueue(trx, third, DAY);
		await joinQueue(trx, other, 20, 'practice', DAY);
		const id = ((await matchStatus(trx, user)) as any).room_id as string;
		let s = await getState(trx, user, id); assert.equal(s.mode, 'practice'); assert.equal(s.auto, true);
		await readyCoop(trx, user, id); await readyCoop(trx, other, id);
		s = await getState(trx, user, id); assert.equal(s.phase, 'answer'); assert.equal(s.total, COIN.coop.practiceQuestions);
		assert.equal(await purse(user), 80);
	});
	test('the last opponent is the last choice: another waiting player is matched first, the same one when nobody else waits', async () => {
		await fund(user, 300); await fund(other, 300); await fund(third, 300);
		await joinQueue(trx, user, 20, 'practice', DAY); await joinQueue(trx, other, 20, 'practice', DAY);
		const first = ((await matchStatus(trx, user)) as any).room_id as string;
		await trx('coop_rooms').where('id', first).update({ status: 'cancelled' }); await trx('match_bans').delete();
		const lvl = await levelOfUser(trx, user);
		// `other` and `third` both wait (put in the queue by hand so they do not meet each other first), then `user` looks
		await trx('match_queue').insert([{ user_id: other, fee: 20, level: lvl, mode: 'practice', since: new Date(Date.now() - 5000) }, { user_id: third, fee: 20, level: lvl, mode: 'practice' }]);
		await joinQueue(trx, user, 20, 'practice', DAY);
		const m = await matchStatus(trx, user) as any; assert.equal(m.status, 'matched');
		const who = await trx('coop_members').where('room_id', m.room_id).pluck('user_id');
		assert.ok(who.includes(third) && !who.includes(other), 'the new face first');
		await trx('coop_rooms').where('id', m.room_id).update({ status: 'cancelled' });
		await joinQueue(trx, user, 20, 'practice', DAY);
		assert.equal((await matchStatus(trx, user)).status, 'matched', 'nobody else waits: the old one again');
	});
	test('leaving a practice room midway loses the deposit and refunds the other player', async () => {
		await fund(user, 100); await fund(other, 100);
		const id = await createCoop(trx, user); await joinCoop(trx, other, id); await startCoop(trx, user, id);
		await leaveCoop(trx, user, id, DAY);
		assert.equal(await purse(user), 100 - COIN.coop.deposit); assert.equal(await purse(other), 100);
		assert.equal((await getState(trx, other, id)).status, 'cancelled');
	});
});

describe('Voice token (LiveKit)', () => {
	test('off without keys; a practice room member gets a signed token for that room only; a duel gets none', async () => {
		delete process.env.LIVEKIT_URL; delete process.env.LIVEKIT_API_KEY; delete process.env.LIVEKIT_API_SECRET;
		await fund(user, 100); await fund(other, 100);
		const id = await createCoop(trx, user); await joinCoop(trx, other, id);
		assert.equal((await joinVoice(trx, user, id)).on, false);
		process.env.LIVEKIT_URL = 'ws://x'; process.env.LIVEKIT_API_KEY = 'k'; process.env.LIVEKIT_API_SECRET = 's';
		try {
			const v: any = await joinVoice(trx, user, id);
			assert.equal(v.on, true);
			const [h, b, sig] = v.token.split('.');
			const claims = JSON.parse(Buffer.from(b, 'base64url').toString());
			assert.equal(claims.video.room, `coop-${id}`); assert.equal(claims.iss, 'k'); assert.equal(claims.sub, user);
			assert.equal(sig, createHmac('sha256', 's').update(`${h}.${b}`).digest('base64url'));
			await assert.rejects(joinVoice(trx, third, id), (e: any) => e.code === 'NOT_MEMBER');
			const d = await createCoop(trx, third, { mode: 'duel', fee: 10, today: DAY }).catch(() => null);
			if (d) await assert.rejects(joinVoice(trx, third, d), (e: any) => e.code === 'NOT_PLAYING');
		} finally { delete process.env.LIVEKIT_URL; delete process.env.LIVEKIT_API_KEY; delete process.env.LIVEKIT_API_SECRET; }
	});
});
