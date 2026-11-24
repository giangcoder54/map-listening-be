/**
 * Đấu & Luyện cùng: presence (src/lib/coop.ts pingCoop, sweepPresence). A member silent for PRESENCE_MS leaves the room.
 *
 *   npm run test:presence    (needs the local stack: docker compose up)
 *
 * Each test runs in a transaction that is rolled back. The sweep looks at the whole table, so a test only asserts on its own room.
 */
import { afterEach, after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { COIN, applyCoinSettings, earnCoins } from '../src/lib/coins';
import { PRESENCE_MS, createCoop, getState, joinCoop, pingCoop, startCoop, sweepPresence } from '../src/lib/coop';
import { drop, subscribe, touchWatchers } from '../src/lib/coopHub';

const PNPM = '/directus/node_modules/.pnpm';
const knexDir = readdirSync(PNPM).find((d) => d.startsWith('knex@'));
if (!knexDir) throw new Error(`knex not found in ${PNPM}: run this inside the API container (npm run test:presence)`);
const knex = createRequire(`${PNPM}/${knexDir}/node_modules/knex/package.json`)('knex');

const DAY = '2026-03-02';
let db: any; let trx: any; let user: string; let other: string;
const mkUser = async (name: string) => { const id = randomUUID(); await trx('directus_users').insert({ id, email: `${name}-${id}@example.com`, status: 'active', is_internal: true, first_name: name }); return id; };
const fund = (id: string, n: number) => earnCoins(trx, id, { reason: 'admin', amount: n, dedupe: `fund:${randomUUID()}` }, DAY);
const purse = async (id: string) => Number((await trx('user_xp').where('user_id', id).first())?.coins) || 0;
const ledger = async (id: string) => Number((await trx('coin_events').where('user_id', id).sum('amount as s').first())?.s) || 0;
const ago = (ms: number) => new Date(Date.now() - ms);
const seen = (room: string, u: string, at: Date | null) => trx('coop_members').where({ room_id: room, user_id: u }).update({ last_seen: at });
const lastSeen = async (room: string, u: string) => (await trx('coop_members').where({ room_id: room, user_id: u }).first('last_seen')).last_seen as Date | null;
const status = async (room: string) => (await trx('coop_rooms').where('id', room).first('status')).status as string;
const members = async (room: string) => (await trx('coop_members').where('room_id', room).pluck('user_id')) as string[];
const STALE = PRESENCE_MS + 5_000;

before(async () => { db = knex({ client: 'pg', connection: process.env.DB_CONNECTION_STRING, pool: { min: 1, max: 2 } }); });
after(async () => db.destroy());
beforeEach(async () => { trx = await db.transaction(); user = await mkUser('Ann'); other = await mkUser('Ben'); });
afterEach(async () => { await trx.rollback(); applyCoinSettings(null); });

/** A practice room in play (both paid the deposit) */
const practice = async () => { await fund(user, 100); await fund(other, 100); const id = await createCoop(trx, user); await joinCoop(trx, other, id); await startCoop(trx, user, id); return id as string; };
/** A duel in play, fee 20 each */
const duel = async () => { await fund(user, 500); await fund(other, 500); const id = await createCoop(trx, user, { mode: 'duel', fee: 20, today: DAY }); await joinCoop(trx, other, id, DAY); await startCoop(trx, user, id); return id as string; };

describe('ping', () => {
	test('a ping stamps the time; "bye" leaves only ~10 s before the member counts as gone', async () => {
		const id = await practice();
		await pingCoop(trx, user, id);
		let t = (await lastSeen(id, user))!;
		assert.ok(Math.abs(Date.now() - t.getTime()) < 5_000, 'stamped now');
		await pingCoop(trx, user, id, true);
		t = (await lastSeen(id, user))!;
		const left = PRESENCE_MS - (Date.now() - t.getTime());
		assert.ok(left > 5_000 && left <= 10_500, `bye leaves about 10 s, left ${left} ms`);
	});
	test('pinging for another player does not move them; a stranger or a bad id changes nothing and does not throw', async () => {
		const id = await practice();
		await seen(id, other, ago(STALE));
		await pingCoop(trx, user, id);
		assert.ok(Date.now() - (await lastSeen(id, other))!.getTime() > PRESENCE_MS, 'the other member is not refreshed by my ping');
		const stranger = await mkUser('Cy');
		assert.deepEqual(await pingCoop(trx, stranger, id), { ok: true });
		assert.equal((await trx('coop_members').where('room_id', id).count('* as n').first()).n, '2', 'no row was made for the stranger');
		assert.deepEqual(await pingCoop(trx, user, 'not-a-uuid'), { ok: false });
		assert.deepEqual(await pingCoop(trx, user, randomUUID()), { ok: true }, 'an unknown room is a no-op');
	});
	test('a ping rescues a member who was about to be swept', async () => {
		const id = await practice();
		await seen(id, user, ago(STALE)); await seen(id, other, new Date());
		await pingCoop(trx, user, id);
		await sweepPresence(trx, DAY);
		assert.equal(await status(id), 'playing');
	});
});

describe('a silent member leaves', () => {
	test('both here: nothing happens; just under the limit: nothing happens', async () => {
		const id = await practice();
		await seen(id, user, new Date()); await seen(id, other, ago(PRESENCE_MS - 5_000));
		assert.equal((await sweepPresence(trx, DAY)).includes(id), false);
		assert.equal(await status(id), 'playing');
		assert.equal((await members(id)).length, 2);
	});
	test('practice: the silent one loses the deposit, the one who stays gets theirs back, the room closes', async () => {
		const id = await practice();
		assert.equal(await purse(user), 100 - COIN.coop.deposit);
		await seen(id, user, ago(STALE)); await seen(id, other, new Date());
		assert.ok((await sweepPresence(trx, DAY)).includes(id));
		assert.equal(await status(id), 'cancelled');
		assert.equal(await purse(user), 100 - COIN.coop.deposit, 'no refund for the one who left');
		assert.equal(await purse(other), 100, 'the one who stayed has it back, no reward');
		assert.equal(await purse(other), await ledger(other));
		assert.equal((await getState(trx, other, id)).status, 'cancelled');
	});
	test('duel: the silent one forfeits, the other takes the pot, money adds up', async () => {
		const id = await duel();
		await seen(id, user, ago(STALE)); await seen(id, other, new Date());
		assert.ok((await sweepPresence(trx, DAY)).includes(id));
		assert.equal(await status(id), 'done');
		assert.equal(await purse(user), 480, 'the fee is lost');
		assert.ok(await purse(other) > 480, 'the winner is paid');
		assert.equal(await purse(user), await ledger(user)); assert.equal(await purse(other), await ledger(other));
		const s = await getState(trx, other, id);
		assert.equal(s.results.find((r: any) => r.you).prize > 0, true); assert.equal(s.results.find((r: any) => !r.you).prize, 0);
	});
	test('duel: both silent at once: the room closes once and nobody is paid twice', async () => {
		const id = await duel();
		await seen(id, user, ago(STALE)); await seen(id, other, ago(STALE));
		await sweepPresence(trx, DAY);
		assert.equal(await status(id), 'done');
		const total = (await purse(user)) + (await purse(other));
		assert.ok(total <= 1000, `no money was made out of nothing, total ${total}`);
		assert.equal(await purse(user), await ledger(user)); assert.equal(await purse(other), await ledger(other));
		const again = await sweepPresence(trx, DAY);
		assert.equal(again.includes(id), false, 'the second scan finds nothing in a finished room');
		assert.equal((await purse(user)) + (await purse(other)), total, 'a second scan pays nothing');
	});
	test('practice: both silent at once: the room closes and nobody is paid twice', async () => {
		const id = await practice();
		await seen(id, user, ago(STALE)); await seen(id, other, ago(STALE));
		await sweepPresence(trx, DAY);
		assert.equal(await status(id), 'cancelled');
		assert.ok((await purse(user)) + (await purse(other)) <= 200, 'at most the two deposits come back to one side');
		assert.equal(await purse(user), await ledger(user)); assert.equal(await purse(other), await ledger(other));
	});
	test('scanning twice does the same as once', async () => {
		const id = await practice();
		await seen(id, user, ago(STALE)); await seen(id, other, new Date());
		await sweepPresence(trx, DAY);
		const a = [await purse(user), await purse(other)];
		await sweepPresence(trx, DAY);
		assert.deepEqual([await purse(user), await purse(other)], a);
	});
});

describe('rooms that are still waiting', () => {
	const waiting = async (mode: 'practice' | 'duel' = 'practice') => { await fund(user, 500); await fund(other, 500); const id = await createCoop(trx, user, mode === 'duel' ? { mode, fee: 20, today: DAY } : {}); await joinCoop(trx, other, id, DAY); return id as string; };
	test('a silent guest of a friend\'s room is taken out with the fee back; the room keeps waiting for someone else', async () => {
		const id = await waiting();
		await seen(id, other, ago(STALE)); await seen(id, user, new Date());
		await sweepPresence(trx, DAY);
		assert.equal(await status(id), 'waiting');
		assert.deepEqual(await members(id), [user]);
		assert.equal(await purse(other), 500, 'the guest has the fee back');
	});
	test('a silent host closes the room and everyone gets the fee back', async () => {
		const id = await waiting();
		await seen(id, user, ago(STALE)); await seen(id, other, new Date());
		await sweepPresence(trx, DAY);
		assert.equal(await status(id), 'cancelled');
		assert.equal(await purse(user), 500); assert.equal(await purse(other), 500);
	});
	test('a queue (auto) room: a silent member closes it, fees go back, and the leaver cannot search for a moment', async () => {
		const id = await waiting('duel');
		await trx('coop_rooms').where('id', id).update({ auto: true });
		await seen(id, other, ago(STALE)); await seen(id, user, new Date());
		await sweepPresence(trx, DAY);
		assert.equal(await status(id), 'cancelled');
		assert.equal(await purse(user), 500); assert.equal(await purse(other), 500);
		assert.ok(await trx('match_bans').where('user_id', other).first(), 'the silent one is banned from the queue for a short time');
	});
});

describe('who is counted', () => {
	test('never pinged (an old row): joined_at counts, so a fresh join is safe and an old one is swept', async () => {
		const id = await practice();
		await seen(id, user, null); await seen(id, other, null);
		await sweepPresence(trx, DAY);
		assert.equal(await status(id), 'playing', 'just joined, never pinged: still here');
		await trx('coop_members').where({ room_id: id, user_id: user }).update({ joined_at: ago(STALE) });
		await sweepPresence(trx, DAY);
		assert.equal(await status(id), 'cancelled', 'joined long ago and never heard from');
	});
	test('finished and cancelled rooms are left alone', async () => {
		const id = await practice();
		await seen(id, user, ago(STALE)); await seen(id, other, ago(STALE));
		await trx('coop_rooms').where('id', id).update({ status: 'done' });
		assert.equal((await sweepPresence(trx, DAY)).includes(id), false);
		await trx('coop_rooms').where('id', id).update({ status: 'cancelled' });
		assert.equal((await sweepPresence(trx, DAY)).includes(id), false);
		assert.equal((await members(id)).length, 2, 'the rows stay for the history');
	});
	test('a player in a room is not touched by the silence of someone in another room', async () => {
		const a = await practice();
		const c = await mkUser('Cy'); const d = await mkUser('Dee');
		await fund(c, 100); await fund(d, 100);
		const b = await createCoop(trx, c); await joinCoop(trx, d, b); await startCoop(trx, c, b);
		await seen(a, user, ago(STALE)); await seen(a, other, new Date());
		await seen(b, c, new Date()); await seen(b, d, new Date());
		await sweepPresence(trx, DAY);
		assert.equal(await status(a), 'cancelled'); assert.equal(await status(b), 'playing');
	});
});

/** A socket as Directus gives it: the session signs it in (accountability.user), readyState 1 = open */
const socket = (user: string) => ({ accountability: { user }, readyState: 1, sent: [] as any[], send(m: string) { this.sent.push(JSON.parse(m)); } });
const openSockets: any[] = [];
const watch = async (client: any, room: string) => { openSockets.push(client); await subscribe(trx, client, room, 0); };

describe('the WebSocket keeps a seat (coopHub touchWatchers)', () => {
	afterEach(() => { for (const c of openSockets.splice(0)) drop(c); });

	test('a player with an open socket is not swept, even when the page has not pinged for minutes', async () => {
		const id = await practice();
		await seen(id, user, ago(STALE)); await seen(id, other, new Date());
		await watch(socket(user), id);
		await touchWatchers(trx);
		assert.ok(Date.now() - (await lastSeen(id, user))!.getTime() < 5_000, 'the socket stamped the player');
		await sweepPresence(trx, DAY);
		assert.equal(await status(id), 'playing');
	});

	test('a socket that has closed no longer keeps the seat: the player is swept', async () => {
		const id = await practice();
		await seen(id, user, ago(STALE)); await seen(id, other, new Date());
		const c = socket(user);
		await watch(c, id);
		c.readyState = 3; // CLOSED
		await touchWatchers(trx);
		await sweepPresence(trx, DAY);
		assert.equal(await status(id), 'cancelled');
	});

	test('after drop (the socket closed on the server) the seat is not kept', async () => {
		const id = await practice();
		await seen(id, user, ago(STALE)); await seen(id, other, new Date());
		const c = socket(user);
		await watch(c, id);
		drop(c); openSockets.length = 0;
		await touchWatchers(trx);
		await sweepPresence(trx, DAY);
		assert.equal(await status(id), 'cancelled');
	});

	test('one player\'s socket does not keep the other player\'s seat', async () => {
		const id = await practice();
		await seen(id, user, new Date()); await seen(id, other, ago(STALE));
		await watch(socket(user), id);
		await touchWatchers(trx);
		assert.ok(Date.now() - (await lastSeen(id, other))!.getTime() > PRESENCE_MS, 'the silent player is not refreshed');
		await sweepPresence(trx, DAY);
		assert.equal(await status(id), 'cancelled');
	});

	test('a socket with no signed-in user is refused and keeps nothing', async () => {
		const id = await practice();
		await seen(id, user, ago(STALE)); await seen(id, other, new Date());
		const anon = { accountability: undefined, readyState: 1, sent: [] as any[], send(m: string) { this.sent.push(JSON.parse(m)); } };
		await watch(anon, id);
		assert.deepEqual(anon.sent.map((m) => m.code), ['UNAUTHORIZED']);
		await touchWatchers(trx);
		await sweepPresence(trx, DAY);
		assert.equal(await status(id), 'cancelled');
	});

	test('a socket that joins a room it is not in keeps no seat there', async () => {
		const id = await practice();
		await seen(id, user, ago(STALE)); await seen(id, other, new Date());
		const stranger = await mkUser('Cy');
		await watch(socket(stranger), id);
		await touchWatchers(trx);
		await sweepPresence(trx, DAY);
		assert.equal(await status(id), 'cancelled', 'a watcher is not a member');
		assert.equal((await members(id)).includes(stranger), false);
	});
});

describe('reload and close', () => {
	test('a reload (bye, then a ping a moment later) keeps the seat', async () => {
		const id = await practice();
		await seen(id, other, new Date());
		await pingCoop(trx, user, id, true);
		await sweepPresence(trx, DAY);
		assert.equal(await status(id), 'playing', 'bye alone leaves ~10 s: not gone yet');
		await pingCoop(trx, user, id);
		await sweepPresence(trx, DAY);
		assert.equal(await status(id), 'playing');
	});
	test('closing the tab: after bye and 10 s of silence the member is gone', async () => {
		const id = await practice();
		await seen(id, other, new Date());
		await pingCoop(trx, user, id, true);
		// 11 s later: what bye left (35 s ago) is now 46 s ago
		await seen(id, user, new Date((await lastSeen(id, user))!.getTime() - 11_000));
		await sweepPresence(trx, DAY);
		assert.equal(await status(id), 'cancelled');
	});
});
