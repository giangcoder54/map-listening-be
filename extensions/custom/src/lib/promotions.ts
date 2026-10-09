/**
 * Coupons (table `promotions`).
 *
 *   type 'Percent'  value = % off
 *   type 'Fixed'    value = VND off (bank transfer only; card needs a Polar discount)
 *
 * A coupon can be limited in time (valid_from / valid_until), in uses (max_redemptions:
 * paid orders that used it) and to a buyer's first order. `affiliate_user_id` links it to
 * an affiliate: a buyer who uses it is counted as theirs. `polar_discount_id` is the same
 * discount created on Polar, used for card checkouts.
 */
import Decimal from 'decimal.js';
import { sameMailbox } from './fraud';
import { growthConfig } from './growthConfig';
import { findReferrer, hasPaidOrder, referrerDisplayName } from './referrals';

export type PromotionRow = {
	id: string;
	code: string;
	title: string | null;
	description: string | null;
	type: 'Percent' | 'Fixed';
	value: string | number;
	status: string;
	valid_from: string | null;
	valid_until: string | null;
	max_redemptions: number | null;
	first_purchase_only: boolean;
	affiliate_user_id: string | null;
	polar_discount_id: string | null;
};

export const PROMO_CODE_RE = /^[A-Za-z0-9_-]{3,40}$/;

export type PromoCheck =
	| { ok: true; promo: PromotionRow }
	| { ok: false; reason: 'invalid' | 'expired' | 'not-started' | 'used-up' | 'first-order-only' | 'own-code' };

/** Times a coupon was used: published orders, free ones (100% coupons) included */
export async function redemptionsOf(database: any, promotionId: string): Promise<number> {
	const row = await database('purchase_histories')
		.where({ promotion_id: promotionId, status: 'published' })
		.count('* as n')
		.first();
	return Number(row?.n) || 0;
}

export async function checkPromotion(database: any, code: string, userId: string | null): Promise<PromoCheck> {
	const clean = String(code || '').trim();
	if (!PROMO_CODE_RE.test(clean)) return { ok: false, reason: 'invalid' };
	const promo: PromotionRow | undefined = await database('promotions')
		.whereRaw('lower(code) = lower(?)', [clean])
		.where('status', 'published')
		.first();
	if (!promo) return { ok: false, reason: 'invalid' };

	const now = Date.now();
	if (promo.valid_from && new Date(promo.valid_from).getTime() > now) return { ok: false, reason: 'not-started' };
	if (promo.valid_until && new Date(promo.valid_until).getTime() < now) return { ok: false, reason: 'expired' };
	if (promo.max_redemptions && (await redemptionsOf(database, promo.id)) >= promo.max_redemptions) {
		return { ok: false, reason: 'used-up' };
	}
	if (userId && promo.affiliate_user_id === userId) return { ok: false, reason: 'own-code' };
	if (userId && promo.first_purchase_only) {
		const used = await database('purchase_histories').where({ user: userId, status: 'published' }).first('id');
		if (used) return { ok: false, reason: 'first-order-only' };
	}
	return { ok: true, promo };
}

/** Price after a coupon (VND or any currency for a percent coupon) */
export function applyPromotion(price: number, promo: Pick<PromotionRow, 'type' | 'value'>): number {
	if (promo.type === 'Percent') {
		return new Decimal(price).mul(new Decimal(1).minus(new Decimal(promo.value).div(100))).toNumber();
	}
	if (promo.type === 'Fixed') {
		return Decimal.max(new Decimal(0), new Decimal(price).minus(new Decimal(promo.value))).toNumber();
	}
	return price;
}

/**
 * The one code box at checkout takes a coupon or a friend's invite code.
 *   coupon       its discount; the buyer counts for its affiliate, if it has one
 *   invite code  REFERRAL_DISCOUNT_PERCENT % off the buyer's first paid order; the buyer
 *                counts for the owner of the code
 * Whoever the code points to (`referrerId`) is saved on the order and becomes the buyer's
 * referrer when the order is paid (see recordConversion).
 */
export type ResolvedCode =
	| {
		ok: true;
		kind: 'promotion' | 'referral';
		/** Code as the buyer should see it */
		code: string;
		type: 'Percent' | 'Fixed';
		value: number;
		promo: PromotionRow | null;
		referrerId: string | null;
		referrerName: string | null;
		/** Polar discount for card payments, null = bank transfer only */
		polarDiscountId: string | null;
	}
	| { ok: false; reason: 'invalid' | 'expired' | 'not-started' | 'used-up' | 'first-order-only' | 'own-code' };

/** Is the buyer the owner of the code, under another address of the same mailbox? */
async function sameOwner(database: any, buyerId: string | null, ownerId: string | null) {
	if (!buyerId || !ownerId) return false;
	if (buyerId === ownerId) return true;
	const rows = await database('directus_users').select('id', 'email').whereIn('id', [buyerId, ownerId]);
	const email = (id: string) => rows.find((r: any) => r.id === id)?.email || '';
	return sameMailbox(email(buyerId), email(ownerId));
}

export async function resolveCode(database: any, code: string, userId: string | null): Promise<ResolvedCode> {
	const coupon = await checkPromotion(database, code, userId);
	if (coupon.ok) {
		const promo = coupon.promo;
		if (await sameOwner(database, userId, promo.affiliate_user_id)) return { ok: false, reason: 'own-code' };
		return {
			ok: true,
			kind: 'promotion',
			code: promo.code,
			type: promo.type,
			value: Number(promo.value),
			promo,
			referrerId: promo.affiliate_user_id,
			referrerName: null,
			polarDiscountId: promo.type === 'Percent' ? promo.polar_discount_id : null,
		};
	}
	if (coupon.reason !== 'invalid') return coupon;

	const referrer = await findReferrer(database, code);
	const { referralDiscountPercent, polarReferralDiscountId } = growthConfig();
	if (!referrer || !referralDiscountPercent) return { ok: false, reason: 'invalid' };
	if (await sameOwner(database, userId, referrer.id)) return { ok: false, reason: 'own-code' };
	if (userId && (await hasPaidOrder(database, userId))) return { ok: false, reason: 'first-order-only' };
	return {
		ok: true,
		kind: 'referral',
		code: referrer.referral_code,
		type: 'Percent',
		value: referralDiscountPercent,
		promo: null,
		referrerId: referrer.id,
		referrerName: referrerDisplayName(referrer),
		polarDiscountId: polarReferralDiscountId || null,
	};
}

/** Price after a resolved code */
export const applyCode = (price: number, code: Extract<ResolvedCode, { ok: true }>) =>
	applyPromotion(price, { type: code.type, value: code.value });

/** What the client may see of a resolved code */
export const publicCode = (code: Extract<ResolvedCode, { ok: true }>) => ({
	kind: code.kind,
	code: code.code,
	title: code.promo?.title ?? null,
	description: code.promo?.description ?? null,
	type: code.type,
	value: code.value,
	referrer_name: code.referrerName,
	/** Card payment gets the discount only through a matching Polar discount */
	card: !!code.polarDiscountId,
});
