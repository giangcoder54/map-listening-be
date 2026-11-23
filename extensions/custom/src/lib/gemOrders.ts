/**
 * Nạp Kim cương: packs and the order that pays them (web repo docs/xu-v2-backend.md mục 7).
 *
 * An order is a purchase_histories row with product_type = 'coins', so the QR, the SePay webhook, the
 * admin list and the VAT invoice stay as they are. The Kim cương are paid by creditCoinOrder: once per
 * order (the ledger's dedupe key purchase:<order id>), whoever calls it first (the SePay settle, or the
 * hook when an admin publishes the order by hand).
 */
import { CoinError, earnCoins, lockPurse, takeBack } from './coins';

export type Pack = { code: string; price_vnd: number; coins: number; bonus_pct: number; first_mult: number; active: boolean; sort: number };

/** Kim cương of a pack before the first-top-up bonus: its coins plus bonus_pct % */
export const packCoins = (p: Pick<Pack, 'coins' | 'bonus_pct'>) => Math.round(p.coins * (1 + Number(p.bonus_pct || 0) / 100));
/** What the very first top-up of an account gets: first_mult times the pack's coins */
export const firstCoins = (p: Pick<Pack, 'coins' | 'bonus_pct' | 'first_mult'>) => Math.round(packCoins(p) * Math.max(1, Number(p.first_mult) || 1));

/** Packs on sale, for the pricing page. A lesson costs 100 Kim cương: `per_lesson_vnd` is what one is worth in money. */
export async function listPacks(db: any, userId: string | null) {
	const rows = await db('xu_packs').where('active', true).orderBy('sort');
	const first = userId ? !(await db('coin_events').where({ user_id: userId, reason: 'purchase' }).first('id')) : true;
	return rows.map((p: any) => {
		const total = packCoins(p);
		return {
			code: p.code, price_vnd: Number(p.price_vnd), coins: Number(p.coins), bonus_pct: Number(p.bonus_pct), first_mult: Number(p.first_mult),
			total, first_total: first && Number(p.first_mult) > 1 ? firstCoins(p) : null,
			per_lesson_vnd: Math.round((Number(p.price_vnd) / total) * 100),
		};
	});
}

/**
 * Pay the Kim cương of a paid order, once. The first top-up of an account gets the pack's first_mult
 * (decided here, in the transaction that holds the purse: two orders paid together cannot both be the first).
 */
export async function creditCoinOrder(db: any, orderId: string) {
	return db.transaction(async (trx: any) => {
		const order = await trx('purchase_histories').where('id', orderId).first();
		if (!order || order.product_type !== 'coins' || order.status !== 'published' || !order.user) return { added: 0, reason: 'not-a-paid-coin-order' as const };
		const userId = order.user as string;
		await lockPurse(trx, userId);
		let amount = Number(order.coins) || 0;
		const pack = order.pack_code ? await trx('xu_packs').where('code', order.pack_code).first() : null;
		const earlier = await trx('coin_events').where({ user_id: userId, reason: 'purchase' }).first('id');
		if (!earlier && pack && Number(pack.first_mult) > 1) amount = Math.round(amount * Number(pack.first_mult));
		const r = await earnCoins(trx, userId, { reason: 'purchase', amount, dedupe: `purchase:${orderId}`, meta: { order_id: orderId, pack: order.pack_code || null, first: !earlier } });
		return { added: r.added, reason: r.added ? ('credited' as const) : ('already' as const), balance: r.coins };
	});
}

/**
 * Take back an order's Kim cương (refund or chargeback): what the purse cannot cover becomes debt, paid by
 * what the learner earns next. The order becomes 'refunded'.
 */
export async function chargebackCoinOrder(db: any, orderId: string) {
	const order = await db('purchase_histories').where('id', orderId).first();
	if (!order || order.product_type !== 'coins' || !order.user) throw new CoinError('NOT_LOCKED');
	const paid = await db('coin_events').where({ user_id: order.user, dedupe_key: `purchase:${orderId}` }).first('amount');
	if (!paid) throw new CoinError('NOT_LOCKED');
	const r = await takeBack(db, order.user, Number(paid.amount), 'chargeback', `chargeback:${orderId}`, { order_id: orderId });
	await db('purchase_histories').where('id', orderId).update({ status: 'refunded' });
	await db('directus_users').where('id', order.user).update({ gems_flagged: true }).catch(() => {});
	return r;
}
