/**
 * Numbers of the referral and affiliate programs. Each one is read from the growth_settings
 * row (Directus admin, a singleton), else the env var, else the default below, so the
 * admin can change them without restarting anything. See docs/growth-roadmap.md in the web repo.
 */
import { applyCoinSettings } from './coins';
import { isStaff } from './staff';

type Settings = Record<string, any>;
let settings: Settings = {};

/** Re-read growth_settings (on start, every minute and after an admin edit, see hook/index.ts) */
export async function refreshGrowthConfig(database: any, logger?: any) {
	try {
		settings = (await database('growth_settings').first()) || {};
		applyCoinSettings(settings.coin_settings);
	} catch (error) {
		logger?.warn?.(`[growth] growth_settings not loaded, using env: ${String(error)}`);
	}
}

/** Column in growth_settings, else env var */
const raw = (column: string, env: string) => {
	const value = settings[column];
	return value === null || value === undefined || value === '' ? process.env[env] : String(value);
};

const num = (column: string, env: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) => {
	const value = raw(column, env);
	const n = value === undefined || value === '' ? fallback : Number(value);
	return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export const growthConfig = () => ({
	/** % off the first order of a user who types someone's invite code */
	referralDiscountPercent: num('referral_discount_percent', 'REFERRAL_DISCOUNT_PERCENT', 10, 0, 90),
	/** Kim cương a normal user earns for an invited friend's first order, as a % of the Kim cương the friend bought */
	referralRewardPct: num('referral_reward_pct', 'REFERRAL_REWARD_PCT', 30, 0, 100),
	/** Commission % of an approved affiliate without their own rate */
	affiliateDefaultRate: num('affiliate_default_rate', 'AFFILIATE_DEFAULT_RATE', 30, 0, 90),
	/** Orders of a referred user earn commission for this many months after they came */
	affiliateCommissionMonths: num('affiliate_commission_months', 'AFFILIATE_COMMISSION_MONTHS', 12, 1, 120),
	/** A commission becomes payable this many days after the order (time for cancelled / disputed payments) */
	affiliateHoldDays: num('affiliate_hold_days', 'AFFILIATE_HOLD_DAYS', 14, 0, 120),
	/** Countries (ISO codes, comma separated) that can join the affiliate program; * = all */
	affiliateCountries: (raw('affiliate_countries', 'AFFILIATE_COUNTRIES') || 'VN').toUpperCase().split(',').map((c) => c.trim()).filter(Boolean),
	/** Smallest payout, VND */
	affiliateMinPayoutVnd: num('affiliate_min_payout_vnd', 'AFFILIATE_MIN_PAYOUT_VND', 200000, 0),
	/** Smallest payout, US cents ($50) */
	affiliateMinPayoutUsd: num('affiliate_min_payout_usd', 'AFFILIATE_MIN_PAYOUT_USD', 5000, 0),
	/** Vietnam: PIT kept back on one payment to an unregistered individual from this amount (VND) */
	affiliateWithholdThresholdVnd: num('affiliate_withhold_threshold_vnd', 'AFFILIATE_WITHHOLD_THRESHOLD_VND', 5000000, 0),
	/** ...at this rate (%) */
	affiliateWithholdRate: num('affiliate_withhold_rate', 'AFFILIATE_WITHHOLD_RATE', 10, 0, 50),
	/** Polar discount applied to card checkouts with an invite code (empty = invite codes are bank transfer only) */
	polarReferralDiscountId: (raw('polar_referral_discount_id', 'POLAR_REFERRAL_DISCOUNT_ID') || '').trim(),
	/** Phrase Lab, free learners: new phrases a day, open phrases per type, film clips per phrase */
	phraseFreeNewPerDay: num('phrase_free_new_per_day', 'PHRASE_FREE_NEW_PER_DAY', 3, 0, 100),
	phraseFreePerType: num('phrase_free_per_type', 'PHRASE_FREE_PER_TYPE', 3, 0, 1000),
	phraseFreeClips: num('phrase_free_clips', 'PHRASE_FREE_CLIPS', 2, 1, 50),
	/** Phrase Lab role-play: AI checks a day (free / Premium); only a guard against abuse (~4 VND a check) */
	phraseAiChecksFree: num('phrase_ai_checks_free', 'PHRASE_AI_CHECKS_FREE', 200, 0, 10000),
	phraseAiChecksPremium: num('phrase_ai_checks_premium', 'PHRASE_AI_CHECKS_PREMIUM', 200, 0, 10000),
});

/** The parts of Kim cương v2 that can be switched on one by one (web repo docs/xu-v2-tasks.md) */
export const GEMS_FEATURES = ['stars', 'cards', 'chests', 'purchase', 'share', 'help', 'rooms'] as const;
export type GemsFeature = (typeof GEMS_FEATURES)[number];
export type GemsFlag = 'off' | 'staff' | 'all';

/** growth_settings.gems_flags, an object or its JSON text; a feature not set is off */
export function gemsFlags(): Record<GemsFeature, GemsFlag> {
	let o: any = settings.gems_flags;
	if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = null; } }
	const out = {} as Record<GemsFeature, GemsFlag>;
	for (const f of GEMS_FEATURES) {
		const v = o && typeof o === 'object' ? o[f] : null;
		out[f] = v === 'all' || v === 'staff' ? v : 'off';
	}
	return out;
}

/** Is this Kim cương v2 feature on for this request? "staff" = admins and content editors only */
export const gemsOn = (feature: GemsFeature, accountability: any) => {
	const flag = gemsFlags()[feature];
	return flag === 'all' || (flag === 'staff' && isStaff(accountability));
};

/** Site origin for links shown to users (invite link...) */
export const siteOrigin = () =>
	(process.env.SITE_URL || process.env.POLAR_SITE_URL || 'https://guidelingo.com').replace(/\/+$/, '');

export const affiliateCountryAllowed = (country: string) => {
	const list = growthConfig().affiliateCountries;
	return list.includes('*') || list.includes(country.toUpperCase());
};

/** Smallest payout for a currency (minor unit: VND, or US cents) */
export const minPayout = (currency: string) => {
	const cfg = growthConfig();
	return currency.toLowerCase() === 'usd' ? cfg.affiliateMinPayoutUsd : cfg.affiliateMinPayoutVnd;
};

/**
 * Personal income tax to keep back on a payout (suggestion, the admin can change it).
 * Vietnam rule (Decree 253/2026, from 2026-07-01): a resident individual without business
 * registration, paid >= 5,000,000 VND at once -> 10 %. Below that, or a registered
 * business (they declare their own tax): nothing. Payments abroad: 0 here, ask an
 * accountant (see docs/growth-roadmap.md).
 */
export const suggestedWithholding = (
	affiliate: { country?: string | null; business_registered?: boolean | null } | null | undefined,
	gross: number,
	currency: string,
) => {
	const cfg = growthConfig();
	if (!affiliate || currency.toLowerCase() !== 'vnd') return 0;
	if ((affiliate.country || 'VN').toUpperCase() !== 'VN' || affiliate.business_registered) return 0;
	if (gross < cfg.affiliateWithholdThresholdVnd) return 0;
	return Math.round((gross * cfg.affiliateWithholdRate) / 100);
};
