/**
 * Referral and affiliate program.
 *
 * Every user has an invite code (referral_code). A buyer types a friend's invite code, or
 * an affiliate's coupon, in the code box at checkout (a ?ref=CODE link only fills the box
 * in). The order keeps who the code points to (purchase_histories.referrer_id).
 *
 * When an order is paid (purchase_histories -> published, see hook/index.ts),
 * recordConversion() fixes the buyer's referrer on their first such order
 * (directus_users.referred_by) and writes one referral_conversions row:
 *   - the referrer is an approved affiliate -> a commission (% of the order), for the
 *     buyer's orders in the next AFFILIATE_COMMISSION_MONTHS months, renewals included
 *   - else, first paid order of that friend -> the referrer gets Premium days
 */
import { customAlphabet } from 'nanoid';
import { earnCoins } from './coins';
import { growthConfig } from './growthConfig';
import { notifyAdmin } from './telegram';
import { fraudFlags } from './fraud';

export const REF_CODE_RE = /^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$/;
const randomPart = customAlphabet('abcdefghjkmnpqrstuvwxyz23456789', 5);

const slugName = (name: string) =>
	String(name || '')
		.toLowerCase()
		.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
		.replace(/[^a-z0-9]+/g, '')
		.slice(0, 10);

/** The user's referral code, created on first use (first name + 5 random characters). */
export async function ensureReferralCode(database: any, userId: string): Promise<string> {
	const row = await database('directus_users').select('referral_code', 'first_name', 'email').where('id', userId).first();
	if (!row) throw new Error('User not found');
	if (row.referral_code) return row.referral_code;
	const base = slugName(row.first_name) || slugName(String(row.email || '').split('@')[0] || '') || 'friend';
	for (let i = 0; i < 6; i++) {
		const code = `${base}${randomPart()}`;
		if (await database('referral_code_aliases').where('code', code).first('code')) continue; // someone's old code
		try {
			const updated = await database('directus_users').where('id', userId).whereNull('referral_code').update({ referral_code: code });
			if (updated) return code;
			const again = await database('directus_users').select('referral_code').where('id', userId).first();
			if (again?.referral_code) return again.referral_code;
		} catch (error: any) {
			if (error?.code !== '23505') throw error; // taken: try another one
		}
	}
	throw new Error('Could not create a referral code');
}

/** Owner of a code: the current code, or one the user had before (referral_code_aliases) */
export async function findReferrer(database: any, code: string) {
	const clean = String(code || '').trim().toLowerCase();
	if (!REF_CODE_RE.test(clean)) return null;
	const columns = ['u.id', 'u.first_name', 'u.last_name', 'u.email', 'u.avatar', 'u.referral_code'];
	const current = await database('directus_users as u')
		.select(columns)
		.whereRaw('lower(u.referral_code) = ?', [clean])
		.where('u.status', 'active')
		.first();
	if (current) return current;
	return database('referral_code_aliases as a')
		.join('directus_users as u', 'u.id', 'a.user_id')
		.select(columns)
		.where('a.code', clean)
		.where('u.status', 'active')
		.first();
}

/**
 * Is a code used by someone else, now or before, or is it a coupon? Coupons and invite codes
 * share the checkout box (coupons win there), so they must never collide.
 */
export async function codeTaken(database: any, code: string, exceptUserId?: string) {
	const clean = code.toLowerCase();
	const current = database('directus_users').whereRaw('lower(referral_code) = ?', [clean]);
	const alias = database('referral_code_aliases').where('code', clean);
	const coupon = database('promotions').whereRaw('lower(code) = ?', [clean]);
	if (exceptUserId) {
		current.whereNot('id', exceptUserId);
		alias.whereNot('user_id', exceptUserId);
	}
	return !!((await current.first('id')) || (await alias.first('code')) || (await coupon.first('id')));
}

/**
 * Change a user's code. The old one becomes an alias, so links already shared keep
 * working. Taking back one of your own old codes is allowed.
 */
export async function changeReferralCode(database: any, userId: string, code: string) {
	const clean = code.toLowerCase();
	await database.transaction(async (trx: any) => {
		const row = await trx('directus_users').select('referral_code').where('id', userId).forUpdate().first();
		const old = String(row?.referral_code || '').toLowerCase();
		if (old === clean) return;
		if (old) await trx.raw('INSERT INTO referral_code_aliases (code, user_id) VALUES (?, ?) ON CONFLICT (code) DO NOTHING', [old, userId]);
		await trx('referral_code_aliases').where({ code: clean, user_id: userId }).delete();
		await trx('directus_users').where('id', userId).update({ referral_code: clean });
	});
}

/** "hai***@gmail.com": enough to recognise a friend, without giving the address away */
export const maskEmail = (email: string) => {
	const [local = '', domain = ''] = String(email || '').split('@');
	if (!local || !domain) return '';
	return `${local.slice(0, local.length > 3 ? 3 : 1)}***@${domain}`;
};

/**
 * Name of the inviter shown to anyone who opens their link (the link is public):
 * first + last name, else a masked email, never the full address.
 */
export const referrerDisplayName = (referrer: { first_name?: string | null; last_name?: string | null; email?: string | null }) => {
	const name = [referrer.first_name, referrer.last_name].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
	return name || maskEmail(referrer.email || '') || null;
};

/** Paid orders only: free (100% coupon) orders do not count */
export const paidOrders = (database: any, userId: string) =>
	database('purchase_histories')
		.where({ user: userId, status: 'published' })
		.where('amount', '>', 0)
		.whereRaw("coalesce(payment_method, '') <> 'free'");

export async function hasPaidOrder(database: any, userId: string): Promise<boolean> {
	return !!(await paidOrders(database, userId).first('id'));
}

/** Approved affiliate row of a user, or null */
export async function approvedAffiliate(database: any, userId: string) {
	return database('affiliates').where({ user_id: userId, status: 'approved' }).first();
}

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86400000);

/**
 * A paid order of a referred user -> reward or commission. Idempotent: one row per order
 * (UNIQUE purchase_id), so a second "published" update of the same order does nothing.
 */
export async function recordConversion(purchaseId: string, context: any) {
	const { database, logger } = context;
	const purchase = await database('purchase_histories').where('id', purchaseId).first();
	if (!purchase || purchase.status !== 'published' || !purchase.user) return;
	const amount = Number(purchase.amount) || 0;
	if (amount <= 0 || purchase.payment_method === 'free') return; // free (100% coupon) orders earn nothing

	const buyer = await database('directus_users').select('id', 'email', 'referred_by', 'referred_at').where('id', purchase.user).first();
	if (!buyer) return;
	// First paid order with a code: its owner becomes the buyer's referrer, for good
	if (!buyer.referred_by && purchase.referrer_id && purchase.referrer_id !== buyer.id) {
		const referredAt = new Date();
		const locked = await database('directus_users')
			.where('id', buyer.id)
			.whereNull('referred_by')
			.update({ referred_by: purchase.referrer_id, referred_at: referredAt });
		if (locked) {
			buyer.referred_by = purchase.referrer_id;
			buyer.referred_at = referredAt;
		}
	}
	if (!buyer.referred_by || buyer.referred_by === buyer.id) return;
	if (await database('referral_conversions').where('purchase_id', purchaseId).first('id')) return;

	const cfg = growthConfig();
	const affiliate = await approvedAffiliate(database, buyer.referred_by);
	// Commission is on the price before tax: VAT (bank transfer, VAT_RATE) or the sales tax
	// Polar collects for the buyer's country is not our money
	const tax = Math.max(0, Number(purchase.vat_amount) || 0);
	const net = Math.max(0, amount - tax);
	// Self-referral signs (same mailbox, same public IP, same name): shown to the admin
	const flags = await fraudFlags(database, buyer.id, buyer.referred_by).catch(() => []);
	const base = {
		purchase_id: purchaseId,
		referrer_id: buyer.referred_by,
		referred_user_id: buyer.id,
		order_amount: net,
		currency: String(purchase.currency || 'vnd').toLowerCase(),
		flags: flags.length ? flags : null,
	};

	if (affiliate) {
		const since = buyer.referred_at ? new Date(buyer.referred_at) : new Date();
		const windowEnd = new Date(since);
		windowEnd.setMonth(windowEnd.getMonth() + cfg.affiliateCommissionMonths);
		if (Date.now() > windowEnd.getTime()) return;
		const rate = affiliate.commission_rate != null ? Number(affiliate.commission_rate) : cfg.affiliateDefaultRate;
		const commission = Math.round((net * rate) / 100);
		await database('referral_conversions').insert({
			...base,
			kind: 'commission',
			amount: commission,
			rate,
			status: 'pending',
			available_at: addDays(new Date(), cfg.affiliateHoldDays),
		}).onConflict('purchase_id').ignore();
		const money = base.currency === 'usd' ? `$${(commission / 100).toFixed(2)}` : `${commission.toLocaleString('vi-VN')}đ`;
		logger?.info?.(`[affiliate] Commission ${money} for ${buyer.referred_by} (order ${purchaseId})`);
		notifyAdmin(`🤝 Affiliate: hoa hồng ${money} (${rate}%) cho đơn ${purchase.transfer_code || purchaseId}${flags.length ? `\n⚠️ Nghi tự giới thiệu: ${flags.join(', ')}` : ''}`);
		return;
	}

	// Suspended affiliate (e.g. for fraud): earns nothing, no reward either
	if (await database('affiliates').where({ user_id: buyer.referred_by, status: 'suspended' }).first('id')) return;

	// Normal inviter: Kim cương, only for the friend's first paid order
	const earlier = await paidOrders(database, buyer.id).whereNot('id', purchaseId).first('id');
	const coins = Math.round((Number(purchase.coins) || 0) * cfg.referralRewardPct / 100);
	if (earlier || coins <= 0) return;

	await database.transaction(async (trx: any) => {
		const added = await trx('referral_conversions').insert({
			...base,
			kind: 'reward',
			amount: 0,
			reward_coins: coins,
			status: 'approved',
		}).onConflict('purchase_id').ignore().returning('id');
		if (!added.length) return;
		await earnCoins(trx, buyer.referred_by, { reason: 'referral', amount: coins, dedupe: `referral:${purchaseId}`, meta: { order_id: purchaseId } });
		logger?.info?.(`[referral] ${buyer.referred_by} earned ${coins} Kim cương (order ${purchaseId})`);
	});
}

/** Refunded order: its commission no longer counts (unless already paid out) */
export async function voidConversion(database: any, purchaseIds: string[]) {
	if (!purchaseIds.length) return 0;
	return database('referral_conversions')
		.whereIn('purchase_id', purchaseIds)
		.whereIn('status', ['pending', 'approved'])
		.where('kind', 'commission')
		.update({ status: 'void' });
}
