/**
 * Referral, affiliate and coupon endpoints for learners (see lib/referrals.ts).
 *
 *   POST  /referral/click          a visit through ?ref=CODE (public): is the code valid?
 *   GET   /referral/me             my link, code and invite stats
 *   PATCH /referral/me             choose my own code
 *   GET   /affiliate/me            my application / affiliate dashboard
 *   POST  /affiliate/apply         apply (or update a pending application)
 *   PATCH /affiliate/me            payout and tax details
 *   GET   /affiliate/sales         ?status=&page=&limit=: my sales, paged (+ counts per status)
 *   GET   /affiliate/payouts       ?page=&limit=: money sent to me, paged
 *   GET   /referral/friends        ?page=&limit=: friends who upgraded with my code, paged
 *   POST  /promotions/validate     can I use this code? (a coupon or a friend's invite code)
 *   POST  /attribution/attach      where the signed-in user came from (UTM, first visit)
 */
import { affiliateCountryAllowed, growthConfig, minPayout, siteOrigin } from '../lib/growthConfig';
import { REF_CODE_RE, approvedAffiliate, maskEmail, ensureReferralCode, findReferrer, referrerDisplayName, codeTaken, changeReferralCode } from '../lib/referrals';
import { publicCode, resolveCode } from '../lib/promotions';
import { notifyAdmin } from '../lib/sepay';
import { attachAttribution } from '../lib/attribution';

const ANON_ID_RE = /^[A-Za-z0-9-]{16,64}$/;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Money owed / paid to a referrer, per currency */
async function commissionTotals(database: any, userId: string) {
	const rows = await database('referral_conversions')
		.select(
			'currency',
			database.raw(`COALESCE(SUM(amount) FILTER (WHERE status IN ('pending', 'approved') AND available_at > now()), 0)::bigint AS pending`),
			database.raw(`COALESCE(SUM(amount) FILTER (WHERE status IN ('pending', 'approved') AND available_at <= now()), 0)::bigint AS available`),
			database.raw(`COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)::bigint AS paid`),
		)
		.where({ referrer_id: userId, kind: 'commission' })
		.groupBy('currency');
	return rows.map((r: any) => ({ currency: r.currency, pending: Number(r.pending), available: Number(r.available), paid: Number(r.paid) }));
}

async function inviteStats(database: any, userId: string) {
	const [clicks, paying, rewards] = await Promise.all([
		database('referral_clicks').where('referrer_id', userId).count('* as n').first(),
		database('referral_conversions').where('referrer_id', userId).countDistinct('referred_user_id as n').first(),
		database('referral_conversions').where({ referrer_id: userId, kind: 'reward', status: 'approved' }).sum('reward_days as n').first(),
	]);
	return {
		clicks: Number(clicks?.n) || 0,
		paying: Number(paying?.n) || 0,
		reward_days: Number(rewards?.n) || 0,
	};
}

/**
 * Affiliate numbers: only what earned a commission (friends who paid before the user was
 * an affiliate gave Premium days, they show on /invite instead)
 */
async function affiliateStats(database: any, userId: string) {
	const [clicks, sales] = await Promise.all([
		database('referral_clicks').where('referrer_id', userId).count('* as n').first(),
		database('referral_conversions')
			.where({ referrer_id: userId, kind: 'commission' })
			.whereNot('status', 'void')
			.select(database.raw('COUNT(DISTINCT referred_user_id)::int AS customers, COUNT(*)::int AS orders'))
			.first(),
	]);
	const rewards = await database('referral_conversions')
		.where({ referrer_id: userId, kind: 'reward', status: 'approved' })
		.select(database.raw('COUNT(DISTINCT referred_user_id)::int AS friends, COALESCE(SUM(reward_days), 0)::int AS days'))
		.first();
	return {
		clicks: Number(clicks?.n) || 0,
		customers: Number(sales?.customers) || 0,
		orders: Number(sales?.orders) || 0,
		/** Friends who paid before the user became an affiliate (Premium days, not money) */
		reward_friends: Number(rewards?.friends) || 0,
		reward_days: Number(rewards?.days) || 0,
	};
}

const COUNTRY_RE = /^[A-Z]{2}$/;
/** Vietnam: CCCD (12 digits, also the personal tax code) or MST (10 digits, -xxx branch) */
const VN_TAX_ID_RE = /^(\d{12}|\d{10}(-\d{3})?)$/;
const PAYOUT_METHODS = ['bank', 'paypal', 'other'];

type TaxFields = { legal_name: string; country: string; tax_id: string | null; business_registered: boolean };
/** Tax details of an affiliate from a form -> clean fields, or an error code */
function taxFields(body: any): TaxFields | { error: string; message: string } {
	const country = str(body.country, 2).toUpperCase() || 'VN';
	const legalName = str(body.legal_name, 255);
	const taxId = str(body.tax_id, 30).replace(/\s+/g, '');
	if (!COUNTRY_RE.test(country)) return { error: 'INVALID_COUNTRY', message: 'Choose your country.' };
	if (!affiliateCountryAllowed(country)) return { error: 'COUNTRY_NOT_SUPPORTED', message: 'The affiliate program is only open to residents of Vietnam for now.' };
	if (legalName.length < 3) return { error: 'MISSING_LEGAL_NAME', message: 'Enter your full legal name.' };
	if (country === 'VN' && !VN_TAX_ID_RE.test(taxId)) return { error: 'INVALID_TAX_ID', message: 'Enter your 12-digit citizen ID (CCCD) or your tax code.' };
	return { legal_name: legalName, country, tax_id: taxId || null, business_registered: body.business_registered === true };
}

type PayoutFields = {
	payout_method: string;
	payout_bank: string | null;
	payout_account_number: string | null;
	payout_account_name: string | null;
	payout_details: string | null;
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/**
 * Where an affiliate gets paid -> clean fields, or an error code. Bank transfer needs the
 * bank, the account number and the holder's name; PayPal an email; "other" a description.
 */
function payoutFields(body: any): PayoutFields | { error: string; message: string } {
	const method = PAYOUT_METHODS.includes(body.payout_method) ? body.payout_method : 'bank';
	const none = { payout_bank: null, payout_account_number: null, payout_account_name: null };
	if (method === 'bank') {
		const bank = str(body.payout_bank, 100);
		const number = str(body.payout_account_number, 30).replace(/[\s.-]/g, '');
		const name = str(body.payout_account_name, 255).toUpperCase();
		if (bank.length < 2) return { error: 'PAYOUT_BANK_REQUIRED', message: 'Choose your bank.' };
		if (!/^\d{6,20}$/.test(number)) return { error: 'PAYOUT_ACCOUNT_INVALID', message: 'Enter your account number (6-20 digits).' };
		if (name.length < 3) return { error: 'PAYOUT_NAME_REQUIRED', message: 'Enter the account holder name.' };
		return { payout_method: method, payout_bank: bank, payout_account_number: number, payout_account_name: name, payout_details: null };
	}
	const details = str(body.payout_details, 1000);
	if (method === 'paypal' && !EMAIL_RE.test(details)) return { error: 'PAYOUT_EMAIL_INVALID', message: 'Enter your PayPal email.' };
	if (method === 'other' && details.length < 5) return { error: 'PAYOUT_DETAILS_REQUIRED', message: 'Tell us how to pay you.' };
	return { payout_method: method, ...none, payout_details: details };
}

export function registerGrowthRoutes(router: any, context: any) {
	const { database, logger } = context;
	const fail = (res: any, what: string, error: any) => {
		logger?.error?.(`[growth] ${what} failed: ${String(error)}`);
		return res.status(500).json({ success: false, message: 'Server error' });
	};
	const needUser = (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		if (!userId) res.status(401).json({ success: false, message: 'Unauthorized' });
		return userId as string | null;
	};

	// ── Referral ──────────────────────────────────────────────────────────
	// body: { code, anonymous_id?, landing? } -> { valid, referrer_name, discount_percent }
	router.post('/referral/click', async (req: any, res: any) => {
		const body = req.body || {};
		try {
			const referrer = await findReferrer(database, body.code);
			if (!referrer) return res.json({ success: true, data: { valid: false } });
			const userId = req.accountability?.user ?? null;
			const anonymousId = typeof body.anonymous_id === 'string' && ANON_ID_RE.test(body.anonymous_id) ? body.anonymous_id : null;
			if (userId !== referrer.id) {
				// One click per visitor per day (unique index), others are ignored
				await database
					.raw('INSERT INTO referral_clicks (referrer_id, anonymous_id, landing) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [
						referrer.id, anonymousId, str(body.landing, 500) || null,
					])
					.catch((e: any) => logger?.warn?.(`[referral] click not saved: ${String(e)}`));
			}
			return res.json({
				success: true,
				data: {
					valid: true,
					code: referrer.referral_code,
					referrer_name: referrerDisplayName(referrer),
					discount_percent: growthConfig().referralDiscountPercent,
				},
			});
		} catch (error) {
			return fail(res, 'Referral click', error);
		}
	});

	// body: { source, medium?, campaign?, content?, term?, referrer?, landing?, first_seen? }
	router.post('/attribution/attach', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		try {
			const result = await attachAttribution(database, userId, req.body || {}, logger);
			return res.json({ success: true, data: { result } });
		} catch (error) {
			return fail(res, 'Attribution attach', error);
		}
	});

	router.get('/referral/me', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		try {
			const code = await ensureReferralCode(database, userId);
			const cfg = growthConfig();
			const [stats, affiliate] = await Promise.all([
				inviteStats(database, userId),
				database('affiliates').select('status').where('user_id', userId).first(),
			]);
			return res.json({
				success: true,
				data: {
					code,
					link: `${siteOrigin()}/?ref=${code}`,
					discount_percent: cfg.referralDiscountPercent,
					reward_days: cfg.referralRewardDays,
					stats,
					affiliate_status: affiliate?.status || null,
				},
			});
		} catch (error) {
			return fail(res, 'Load referral', error);
		}
	});

	// body: { code } -> my own code (4-32 chars: a-z 0-9 -)
	router.patch('/referral/me', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		const code = str(req.body?.code, 32).toLowerCase();
		if (!REF_CODE_RE.test(code)) return res.status(400).json({ success: false, code: 'INVALID_CODE', message: 'Use 4-32 letters, digits or dashes.' });
		try {
			// Taken by someone else, now or as an old code (old links must keep reaching their owner)
			if (await codeTaken(database, code, userId)) return res.status(409).json({ success: false, code: 'CODE_TAKEN', message: 'This code is already taken.' });
			await changeReferralCode(database, userId, code);
			return res.json({ success: true, data: { code, link: `${siteOrigin()}/?ref=${code}` } });
		} catch (error: any) {
			if (error?.code === '23505') return res.status(409).json({ success: false, code: 'CODE_TAKEN', message: 'This code is already taken.' });
			return fail(res, 'Change referral code', error);
		}
	});

	// ── Affiliate ─────────────────────────────────────────────────────────
	router.get('/affiliate/me', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		try {
			const cfg = growthConfig();
			const row = await database('affiliates').where('user_id', userId).first();
			const base = {
				default_rate: cfg.affiliateDefaultRate,
				commission_months: cfg.affiliateCommissionMonths,
				hold_days: cfg.affiliateHoldDays,
				discount_percent: cfg.referralDiscountPercent,
				countries: cfg.affiliateCountries,
				min_payout: { vnd: minPayout('vnd'), usd: minPayout('usd') },
				withholding: { threshold_vnd: cfg.affiliateWithholdThresholdVnd, rate: cfg.affiliateWithholdRate },
			};
			if (!row) return res.json({ success: true, data: { ...base, application: null } });

			const application = {
				status: row.status,
				commission_rate: row.commission_rate != null ? Number(row.commission_rate) : cfg.affiliateDefaultRate,
				channel_url: row.channel_url,
				audience: row.audience,
				payout_method: row.payout_method,
				payout_bank: row.payout_bank,
				payout_account_number: row.payout_account_number,
				payout_account_name: row.payout_account_name,
				payout_details: row.payout_details,
				legal_name: row.legal_name,
				country: row.country,
				tax_id: row.tax_id,
				business_registered: !!row.business_registered,
				date_created: row.date_created,
				approved_at: row.approved_at,
			};
			if (row.status !== 'approved') return res.json({ success: true, data: { ...base, application } });

			const code = await ensureReferralCode(database, userId);
			const [stats, totals, coupons, daily] = await Promise.all([
				affiliateStats(database, userId),
				commissionTotals(database, userId),
				database('promotions').select('code', 'type', 'value', 'valid_until').where({ affiliate_user_id: userId, status: 'published' }),
				database.raw(`
					SELECT to_char(d, 'YYYY-MM-DD') AS day,
						(SELECT COUNT(*) FROM referral_clicks c WHERE c.referrer_id = ? AND (c.date_created AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = d)::int AS clicks,
						(SELECT COUNT(*) FROM referral_conversions r WHERE r.referrer_id = ? AND r.kind = 'commission' AND r.status <> 'void' AND (r.date_created AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = d)::int AS sales
					FROM generate_series((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 29, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, interval '1 day') AS d
				`, [userId, userId]),
			]);
			return res.json({
				success: true,
				data: {
					...base,
					application,
					code,
					link: `${siteOrigin()}/?ref=${code}`,
					stats,
					totals,
					coupons: coupons.map((c: any) => ({ ...c, value: Number(c.value) })),
					daily: daily.rows || [],
					payout_requests: (await database('affiliate_payout_requests')
						.select('id', 'currency', 'amount', 'status', 'admin_note', 'date_created', 'date_updated')
						.where('user_id', userId)
						.orderBy('date_created', 'desc')
						.limit(10)).map((r: any) => ({ ...r, amount: Number(r.amount) || 0 })),
				},
			});
		} catch (error) {
			return fail(res, 'Load affiliate', error);
		}
	});

	// ── My lists (paged) ──────────────────────────────────────────────────
	/** ?page=&limit= -> page (from 1), limit (default 10, at most 50), offset */
	const paging = (req: any) => {
		const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
		const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
		return { page, limit, offset: (page - 1) * limit };
	};
	/** A buyer as the affiliate may see them: "Lan N." or "lan***@gmail.com" */
	const customerLabel = (u: { first_name?: string | null; last_name?: string | null; email?: string | null }) => {
		const first = String(u.first_name || '').trim();
		const last = String(u.last_name || '').trim();
		if (first) return last ? `${first} ${last[0]!.toUpperCase()}.` : first;
		return maskEmail(u.email || '') || null;
	};
	/** What the affiliate reads: on hold, ready, paid, cancelled, or a Premium-days reward */
	const SALE_STATUS = ['on_hold', 'ready', 'paid', 'void', 'reward'] as const;
	const saleFilter = (q: any, status: string) => {
		if (status === 'reward') return q.where('r.kind', 'reward').whereNot('r.status', 'void');
		if (status === 'void') return q.where('r.status', 'void');
		if (status === 'paid') return q.where('r.kind', 'commission').where('r.status', 'paid');
		if (status === 'on_hold' || status === 'ready') {
			return q.where('r.kind', 'commission').whereIn('r.status', ['pending', 'approved'])
				.where('r.available_at', status === 'on_hold' ? '>' : '<=', database.fn.now());
		}
		return q;
	};

	router.get('/affiliate/sales', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		const { page, limit, offset } = paging(req);
		const status = SALE_STATUS.includes(req.query.status) ? String(req.query.status) : '';
		try {
			const base = () => database('referral_conversions as r')
				.leftJoin('purchase_histories as h', 'h.id', 'r.purchase_id')
				.leftJoin('directus_users as b', 'b.id', 'r.referred_user_id')
				.where('r.referrer_id', userId);
			const [rows, count, counts] = await Promise.all([
				saleFilter(base(), status)
					.select('r.kind', 'r.order_amount', 'r.amount', 'r.currency', 'r.rate', 'r.status', 'r.available_at', 'r.reward_days', 'r.date_created',
						'h.billing_cycle', 'b.first_name', 'b.last_name', 'b.email')
					.orderBy('r.date_created', 'desc')
					.limit(limit)
					.offset(offset),
				saleFilter(base(), status).count('* as n').first(),
				base().select(database.raw(`
					COUNT(*)::int AS all,
					COUNT(*) FILTER (WHERE r.kind = 'commission' AND r.status IN ('pending', 'approved') AND r.available_at > now())::int AS on_hold,
					COUNT(*) FILTER (WHERE r.kind = 'commission' AND r.status IN ('pending', 'approved') AND r.available_at <= now())::int AS ready,
					COUNT(*) FILTER (WHERE r.kind = 'commission' AND r.status = 'paid')::int AS paid,
					COUNT(*) FILTER (WHERE r.status = 'void')::int AS void,
					COUNT(*) FILTER (WHERE r.kind = 'reward' AND r.status <> 'void')::int AS reward`)).first(),
			]);
			const now = Date.now();
			return res.json({
				success: true,
				data: rows.map((r: any) => ({
					date: r.date_created,
					kind: r.kind,
					customer: customerLabel(r),
					billing_cycle: r.billing_cycle != null ? Number(r.billing_cycle) : null,
					order_amount: Number(r.order_amount) || 0,
					amount: Number(r.amount) || 0,
					currency: r.currency,
					rate: r.rate != null ? Number(r.rate) : null,
					reward_days: r.reward_days,
					available_at: r.available_at,
					status: r.status === 'void' ? 'void'
						: r.kind === 'reward' ? 'reward'
						: r.status === 'paid' ? 'paid'
						: r.available_at && new Date(r.available_at).getTime() <= now ? 'ready' : 'on_hold',
				})),
				total: Number(count?.n) || 0,
				page,
				limit,
				counts,
			});
		} catch (error) {
			return fail(res, 'Affiliate sales', error);
		}
	});

	router.get('/affiliate/payouts', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		const { page, limit, offset } = paging(req);
		try {
			const [rows, count] = await Promise.all([
				database('affiliate_payouts').select('amount', 'gross_amount', 'tax_withheld', 'currency', 'method', 'reference', 'paid_at')
					.where('user_id', userId).orderBy('paid_at', 'desc').limit(limit).offset(offset),
				database('affiliate_payouts').where('user_id', userId).count('* as n').first(),
			]);
			return res.json({
				success: true,
				data: rows.map((p: any) => ({ ...p, amount: Number(p.amount) || 0, gross_amount: Number(p.gross_amount ?? p.amount) || 0, tax_withheld: Number(p.tax_withheld) || 0 })),
				total: Number(count?.n) || 0,
				page,
				limit,
			});
		} catch (error) {
			return fail(res, 'Affiliate payouts', error);
		}
	});

	// Friends: first name only, never their email
	router.get('/referral/friends', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		const { page, limit, offset } = paging(req);
		try {
			const [rows, count] = await Promise.all([
				database('directus_users as u')
					.leftJoin('referral_conversions as c', function (this: any) {
						this.on('c.referred_user_id', 'u.id').andOn('c.referrer_id', 'u.referred_by');
					})
					.select('u.first_name', 'u.referred_at', database.raw('COUNT(c.id)::int AS orders'))
					.where('u.referred_by', userId)
					.groupBy('u.id', 'u.first_name', 'u.referred_at')
					.orderBy('u.referred_at', 'desc')
					.limit(limit)
					.offset(offset),
				database('directus_users').where('referred_by', userId).count('* as n').first(),
			]);
			return res.json({
				success: true,
				data: rows.map((f: any) => ({ name: f.first_name || null, joined_at: f.referred_at, paid: f.orders > 0 })),
				total: Number(count?.n) || 0,
				page,
				limit,
			});
		} catch (error) {
			return fail(res, 'Referral friends', error);
		}
	});

	// An approved affiliate asks to be paid what is payable (at least the minimum). One
	// open request per currency; the admin pays it (POST /admin/payouts) or turns it down.
	router.post('/affiliate/payout-request', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		const currency = str(req.body?.currency, 3).toLowerCase() || 'vnd';
		try {
			const affiliate = await approvedAffiliate(database, userId);
			if (!affiliate) return res.status(403).json({ success: false, code: 'NOT_AFFILIATE', message: 'Only approved affiliates can ask for a payout.' });
			const total = (await commissionTotals(database, userId)).find((t: any) => t.currency === currency);
			const available = total?.available || 0;
			if (available < minPayout(currency)) {
				return res.status(400).json({ success: false, code: 'BELOW_MIN', message: 'Your payable balance is below the minimum payout.' });
			}
			const open = await database('affiliate_payout_requests').where({ user_id: userId, currency, status: 'pending' }).first('id');
			if (open) return res.status(409).json({ success: false, code: 'ALREADY_REQUESTED', message: 'You already have a payout request waiting.' });
			await database('affiliate_payout_requests').insert({ user_id: userId, currency, amount: available, status: 'pending' });
			const user = await database('directus_users').select('email').where('id', userId).first();
			const money = currency === 'usd' ? `$${(available / 100).toFixed(2)}` : `${available.toLocaleString('vi-VN')}đ`;
			notifyAdmin(`💸 Yêu cầu rút tiền affiliate: ${user?.email} · ${money}\nXử lý tại /admin/affiliates`);
			return res.status(201).json({ success: true, data: { amount: available, currency } });
		} catch (error: any) {
			if (error?.code === '23505') return res.status(409).json({ success: false, code: 'ALREADY_REQUESTED', message: 'You already have a payout request waiting.' });
			return fail(res, 'Payout request', error);
		}
	});

	// body: { channel_url, audience, payout_method, payout_bank, payout_account_number,
	//         payout_account_name, payout_details, legal_name, country, tax_id,
	//         business_registered, accept_terms }
	router.post('/affiliate/apply', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		const body = req.body || {};
		const tax = taxFields(body);
		if ('error' in tax) return res.status(400).json({ success: false, code: tax.error, message: tax.message });
		const payout = payoutFields(body);
		if ('error' in payout) return res.status(400).json({ success: false, code: payout.error, message: payout.message });
		if (body.accept_terms !== true) {
			return res.status(400).json({ success: false, code: 'TERMS_REQUIRED', message: 'Please accept the affiliate terms.' });
		}
		const data = {
			channel_url: str(body.channel_url, 500),
			audience: str(body.audience, 2000),
			...payout,
			...tax,
			terms_accepted_at: new Date(),
		};
		if (!data.channel_url || !data.audience) {
			return res.status(400).json({ success: false, code: 'MISSING_FIELDS', message: 'Tell us where and to whom you will share GuideLingo.' });
		}
		try {
			const existing = await database('affiliates').where('user_id', userId).first();
			if (existing && ['approved', 'suspended'].includes(existing.status)) {
				return res.status(409).json({ success: false, code: 'ALREADY_AFFILIATE', message: 'You are already in the program.' });
			}
			if (existing) {
				await database('affiliates').where('id', existing.id).update({ ...data, status: 'pending', date_updated: new Date() });
			} else {
				await database('affiliates').insert({ ...data, user_id: userId, status: 'pending' });
			}
			await ensureReferralCode(database, userId);
			const user = await database('directus_users').select('email').where('id', userId).first();
			notifyAdmin(`🤝 Đơn đăng ký affiliate mới: ${user?.email}\nKênh: ${data.channel_url}\nDuyệt tại /admin/affiliates`);
			return res.status(201).json({ success: true });
		} catch (error) {
			return fail(res, 'Affiliate apply', error);
		}
	});

	router.patch('/affiliate/me', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		const body = req.body || {};
		const tax = taxFields(body);
		if ('error' in tax) return res.status(400).json({ success: false, code: tax.error, message: tax.message });
		const payout = payoutFields(body);
		if ('error' in payout) return res.status(400).json({ success: false, code: payout.error, message: payout.message });
		try {
			const before = await database('affiliates')
				.select('payout_method', 'payout_bank', 'payout_account_number', 'payout_account_name', 'payout_details')
				.where('user_id', userId)
				.first();
			if (!before) return res.status(404).json({ success: false, message: 'Not an affiliate' });
			// Where the money goes changed: the admin sees it (account takeover, typo)
			const moved = (['payout_method', 'payout_bank', 'payout_account_number', 'payout_account_name', 'payout_details'] as const)
				.some((k) => (before[k] || null) !== (payout[k] || null));
			const updated = await database('affiliates').where('user_id', userId).update({
				...payout,
				...(moved ? { payout_updated_at: new Date() } : {}),
				...tax,
				date_updated: new Date(),
			});
			if (!updated) return res.status(404).json({ success: false, message: 'Not an affiliate' });
			return res.json({ success: true });
		} catch (error) {
			return fail(res, 'Affiliate payout details', error);
		}
	});

	// ── Coupons ───────────────────────────────────────────────────────────
	// body: { code } -> { valid, promotion? } (promotion.kind: 'promotion' | 'referral')
	router.post('/promotions/validate', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		try {
			const code = str(req.body?.code, 40);
			if (!code) return res.json({ success: true, data: { valid: false } });
			const check = await resolveCode(database, code, userId);
			// Why a code is refused (expired, used up, own code...) is not told: no probing of codes
			if (!check.ok) return res.json({ success: true, data: { valid: false } });
			return res.json({ success: true, data: { valid: true, promotion: publicCode(check) } });
		} catch (error) {
			return fail(res, 'Validate coupon', error);
		}
	});

	// Is this user an approved affiliate? (header menu)
	router.get('/affiliate/status', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		const row = await approvedAffiliate(database, userId).catch(() => null);
		return res.json({ success: true, data: { approved: !!row } });
	});
}
