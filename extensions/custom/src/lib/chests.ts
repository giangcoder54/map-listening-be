/**
 * Rương (chests) and the items in them (web repo docs/xu-v2-backend.md mục 6).
 *
 * roll() is pure: weights in, items out, the random function passed in (crypto.randomInt in
 * production, so a test can fix it). openChest() does the money and the items in one transaction:
 * spend, pity, roll, give, record. chest_opens.id is the client's request_id, so a double click
 * opens once and the second call gets the first result back.
 */
import { randomInt } from 'node:crypto';
import { COIN, CoinError, earnCoins, lockPurse, spend } from './coins';
import { vnDay } from './days';

export type Drop = { item_code: string; weight: number; guaranteed: boolean; premium_alt: string | null };
export type Rand = (n: number) => number;
/** Whole number in [0, n) from the system's secure random */
export const secureRand: Rand = (n) => randomInt(n);

/** Weighted pick among drops */
export function pickWeighted<T extends { weight: number }>(list: T[], rand: Rand): T | null {
	const total = list.reduce((n, d) => n + d.weight, 0);
	if (!total) return null;
	let at = rand(total);
	for (const d of list) {
		if (at < d.weight) return d;
		at -= d.weight;
	}
	return list[list.length - 1] || null;
}

/**
 * What one opening gives: the guaranteed items, then `rolls` weighted rolls. A learner with Premium gets the
 * drop's premium_alt where it has one. Pity: when the opens without `pity.item` reach pity.n - 1, this one
 * holds it (the last roll turns into it). Returns the items and the pity counter after this opening.
 */
export function roll(drops: Drop[], rolls: number, o: { premium: boolean; rand: Rand; pity?: { n: number | null; item: string | null; misses: number } | null }) {
	const swap = (d: Drop) => (o.premium && d.premium_alt ? d.premium_alt : d.item_code);
	const items: string[] = drops.filter((d) => d.guaranteed).map(swap);
	const pool = drops.filter((d) => !d.guaranteed);
	for (let i = 0; i < rolls; i++) {
		const d = pickWeighted(pool, o.rand);
		if (d) items.push(swap(d));
	}
	let pityHit = false;
	const p = o.pity;
	if (p && p.n && p.item) {
		if (!items.includes(p.item) && p.misses + 1 >= p.n) {
			// The last rolled item becomes the pity item (never a guaranteed one)
			const rolled = items.length - drops.filter((d) => d.guaranteed).length;
			if (rolled > 0) items[items.length - 1] = p.item;
			else items.push(p.item);
			pityHit = true;
		}
		const has = items.includes(p.item);
		return { items, pityHit, misses: has ? 0 : p.misses + 1 };
	}
	return { items, pityHit, misses: 0 };
}

/** Public odds: each drop's share of the rolls, in % with one decimal, for GET /chests/:code/odds */
export function oddsOf(drops: Drop[]) {
	const pool = drops.filter((d) => !d.guaranteed);
	const total = pool.reduce((n, d) => n + d.weight, 0) || 1;
	return pool.map((d) => ({ item_code: d.item_code, pct: Math.round((d.weight / total) * 1000) / 10 }));
}

/** Average worth of one opening, in Kim cương, against its price: the admin's calculator */
export function worthOf(drops: Drop[], rolls: number, values: Record<string, number>) {
	const pool = drops.filter((d) => !d.guaranteed);
	const total = pool.reduce((n, d) => n + d.weight, 0) || 1;
	const perRoll = pool.reduce((n, d) => n + (d.weight / total) * (values[d.item_code] || 0), 0);
	const fixed = drops.filter((d) => d.guaranteed).reduce((n, d) => n + (values[d.item_code] || 0), 0);
	return Math.round(perRoll * rolls + fixed);
}

export type ChestResult = {
	open_id: string;
	chest: string;
	price: number;
	items: { code: string; kind: string; amount?: number; days?: number; badge?: string; serial_no?: number | null; also?: string }[];
	pity: boolean;
	balance: number;
	premium_days: number;
	replay?: boolean;
};

export class ChestError extends Error {
	constructor(public code: 'NO_CHEST' | 'ONCE' | 'NOT_ENOUGH' | 'BAD_REQUEST') { super(code); }
}

/**
 * Open a chest. `free` = a prize (the price is not charged: a dare's chest reward). The item stays in the
 * learner's bag (shield, gold_star, extra_star) or is paid at once (gems, badge). A Premium day is only
 * counted here: the route gives it after the commit (grantRewards), as the other Premium days.
 */
export async function openChest(db: any, userId: string, code: string, openId: string, o: { free?: boolean; premium: boolean; rand?: Rand; today?: string }): Promise<ChestResult> {
	const rand = o.rand || secureRand;
	const today = o.today || vnDay();
	return db.transaction(async (trx: any) => {
		await lockPurse(trx, userId);
		const before = await trx('chest_opens').where('id', openId).first();
		if (before) {
			if (before.user_id !== userId) throw new ChestError('BAD_REQUEST');
			return { ...(before.result as ChestResult), replay: true };
		}
		const chest = await trx('chests').where({ code, active: true }).first();
		const now = Date.now();
		if (!chest || (chest.starts_at && new Date(chest.starts_at).getTime() > now) || (chest.ends_at && new Date(chest.ends_at).getTime() < now)) throw new ChestError('NO_CHEST');
		if (chest.once && (await trx('chest_opens').where({ user_id: userId, chest_code: code }).first('id'))) throw new ChestError('ONCE');
		const price = o.free ? 0 : Number(chest.price);
		let eventId: number | null = null;
		if (price > 0) {
			try {
				eventId = (await spend(trx, userId, price, 'chest', `chest:${openId}`, null, today, { chest_open_id: openId, chest: code })).eventId;
			} catch (e) {
				if (e instanceof CoinError && e.code === 'NOT_ENOUGH') throw new ChestError('NOT_ENOUGH');
				throw e;
			}
		}
		await trx('chest_pity').insert({ user_id: userId, chest_code: code }).onConflict(['user_id', 'chest_code']).ignore();
		const pityRow = await trx('chest_pity').where({ user_id: userId, chest_code: code }).forUpdate().first();
		const drops: Drop[] = await trx('chest_drops').select('item_code', 'weight', 'guaranteed', 'premium_alt').where('chest_code', code);
		const out = roll(drops, Number(chest.rolls) || 1, { premium: o.premium, rand, pity: { n: chest.pity_n, item: chest.pity_item, misses: Number(pityRow.misses) || 0 } });
		await trx('chest_pity').where({ user_id: userId, chest_code: code }).update({ misses: out.misses });

		const items: ChestResult['items'] = [];
		let premiumDays = 0;
		let n = 0;
		for (const itemCode of out.items) {
			const it = await trx('items').where('code', itemCode).first();
			if (!it) continue;
			n += 1;
			const given = await giveItem(trx, userId, it, { source: 'chest', sourceId: openId, key: `${openId}:${n}`, today });
			if (given.premiumDays) premiumDays += given.premiumDays;
			items.push({ code: it.code, kind: it.kind, ...given.view });
		}
		const result: ChestResult = { open_id: openId, chest: code, price, items, pity: out.pityHit, balance: (await lockPurse(trx, userId)).coins, premium_days: premiumDays };
		await trx('chest_opens').insert({ id: openId, user_id: userId, chest_code: code, price, coin_event_id: eventId, result: JSON.stringify(result) });
		return result;
	});
}

/**
 * Hand one item to a learner. Gems are paid into the purse (reason chest), a badge goes to the shelf
 * (numbered when it has a serial_max; one already owned or all numbers taken pays its worth in Kim
 * cương instead), a Premium day is only counted (the caller gives it after the commit); the rest go to
 * the bag with an expiry.
 */
export async function giveItem(trx: any, userId: string, it: any, o: { source: string; sourceId: string; key: string; today: string }) {
	const params = (typeof it.params === 'string' ? JSON.parse(it.params) : it.params) || {};
	if (it.kind === 'gems') {
		const amount = Number(params.amount) || 0;
		await earnCoins(trx, userId, { reason: 'chest', amount, dedupe: `chest_item:${o.key}`, meta: { source: o.source, item: it.code } }, o.today);
		return { view: { amount }, premiumDays: 0 };
	}
	if (it.kind === 'premium_day') {
		return { view: { days: Number(params.days) || 1 }, premiumDays: Number(params.days) || 1 };
	}
	if (it.kind === 'badge') {
		const badge = await trx('badges').where('code', params.badge).first();
		const owned = badge && (await trx('user_badges').where({ user_id: userId, badge_code: badge.code }).first('badge_code'));
		let serial: number | null = null;
		let full = false;
		if (badge && !owned) {
			if (badge.serial_max) {
				const top = await trx('user_badges').where('badge_code', badge.code).max('serial_no as m').first();
				serial = (Number(top?.m) || 0) + 1;
				full = serial > Number(badge.serial_max);
			}
			if (!full) {
				await trx('user_badges').insert({ user_id: userId, badge_code: badge.code, serial_no: serial });
				return { view: { badge: badge.code, serial_no: serial }, premiumDays: 0 };
			}
		}
		// Already on the shelf, or every number is taken: what it is worth, in Kim cương
		const amount = Number(it.value) || 0;
		if (amount) await earnCoins(trx, userId, { reason: 'chest', amount, dedupe: `chest_item:${o.key}`, meta: { source: o.source, item: it.code, also: 'badge' } }, o.today);
		return { view: { amount, also: 'badge_owned' }, premiumDays: 0 };
	}
	// shield, gold_star, extra_star: into the bag
	const expires = it.expires_days ? new Date(Date.now() + Number(it.expires_days) * 86400_000) : null;
	await trx('user_items').insert({ user_id: userId, item_code: it.code, expires_at: expires, source: o.source, source_id: o.sourceId });
	return { view: {}, premiumDays: 0 };
}

/** A live (not used, not expired) item of a learner, locked for this transaction; null when none */
export async function takeItem(trx: any, userId: string, code: string) {
	return (await trx('user_items')
		.where({ user_id: userId, item_code: code }).whereNull('used_at')
		.where((q: any) => q.whereNull('expires_at').orWhere('expires_at', '>', trx.fn.now()))
		.orderByRaw('expires_at NULLS LAST, id')
		.forUpdate().first()) || null;
}
export const useItem = (trx: any, id: number | string) => trx('user_items').where('id', id).update({ used_at: trx.fn.now() });
export { COIN };
