/**
 * Admin (Directus admins only) for the growth features.
 *
 *   GET    /admin/growth                  numbers for the admin home
 *   GET    /admin/attribution             ?days=30: sign-ups and sales per channel (UTM)
 *   GET    /admin/promotions              coupons (+ uses)
 *   POST   /admin/promotions
 *   PATCH  /admin/promotions/:id
 *   DELETE /admin/promotions/:id          unused coupon: deleted; used: archived
 *   GET    /admin/affiliates              applications + their numbers
 *   PATCH  /admin/affiliates/:id          { status, commission_rate, admin_note, legal_name, country,
 *                                           tax_id, business_registered }
 *   GET    /admin/conversions             ?referrer=&status=&kind=&q=&page=&limit= -> { data, total }
 *   PATCH  /admin/conversions/:id         { status: 'void' | 'approved' }
 *   GET    /admin/payouts                 ?q=&page=&limit= -> { data, total }
 *   POST   /admin/payouts                 { user_id, currency, method, reference, note, tax_withheld?, force? }:
 *                                         pays every payable commission of that currency, minus the
 *                                         PIT kept back (default: suggestedWithholding)
 *   GET    /admin/payouts/report          ?year=2026: payouts per person for the tax return
 *   PATCH  /admin/payout-requests/:id     { status: 'rejected', admin_note }: turn a request down
 *                                         (paying it = POST /admin/payouts, which closes it)
 *   GET    /admin/support                 contact messages
 *   PATCH  /admin/support/:id             { status }
 */
import { UUID_RE } from '../lib/lessons';
import { PROMO_CODE_RE } from '../lib/promotions';
import { codeTaken, ensureReferralCode } from '../lib/referrals';
import { growthConfig, minPayout, suggestedWithholding } from '../lib/growthConfig';

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function registerAdminGrowthRoutes(router: any, context: any) {
	const { database, logger } = context;
	const fail = (res: any, what: string, error: any) => {
		logger?.error?.(`[admin-growth] ${what} failed: ${String(error)}`);
		return res.status(500).json({ success: false, message: 'Server error' });
	};
	/** Every route here: admins only */
	const admin = (handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
		if (!req.accountability?.admin) return res.status(403).json({ success: false, message: 'Admins only' });
		try {
			return await handler(req, res);
		} catch (error: any) {
			if (error?.status) return res.status(error.status).json({ success: false, message: error.message });
			if (error?.code === '23505') return res.status(409).json({ success: false, message: 'Already exists' });
			return fail(res, `${req.method} ${req.path}`, error);
		}
	};
	const bad = (message: string) => Object.assign(new Error(message), { status: 400 });
	/** ?page=&limit= -> page (from 1), limit (default 25, at most 100), offset */
	const paging = (req: any) => {
		const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
		const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
		return { page, limit, offset: (page - 1) * limit };
	};
	/** ?q= as an ILIKE pattern (wildcards in the text are taken literally), or '' */
	const search = (req: any) => {
		const q = str(req.query.q, 100);
		return q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : '';
	};
	const idParam = (req: any) => {
		const id = String(req.params.id || '');
		if (!UUID_RE.test(id)) throw Object.assign(new Error('Not found'), { status: 404 });
		return id;
	};

	// ── Overview ──────────────────────────────────────────────────────────
	router.get('/admin/growth', admin(async (_req, res) => {
		const r = (await database.raw(`
			SELECT
				(SELECT COUNT(*) FROM directus_users WHERE status = 'active')::int AS users,
				(SELECT COUNT(*) FROM directus_users WHERE gl_created_at >= now() - interval '7 days')::int AS signups_7d,
				(SELECT COUNT(*) FROM directus_users WHERE gl_created_at >= now() - interval '30 days')::int AS signups_30d,
				(SELECT COUNT(*) FROM directus_users WHERE is_premium AND (premium_until IS NULL OR premium_until > now()))::int AS premium_users,
				(SELECT COUNT(*) FROM purchase_histories WHERE status = 'published' AND amount > 0 AND coalesce(date_transfer, date_created) >= now() - interval '30 days')::int AS orders_30d,
				(SELECT COUNT(*) FROM directus_users WHERE referred_by IS NOT NULL)::int AS referred_users,
				(SELECT COUNT(*) FROM affiliates WHERE status = 'pending')::int AS affiliates_pending,
				(SELECT COUNT(*) FROM affiliates WHERE status = 'approved')::int AS affiliates_active,
				(SELECT COUNT(*) FROM support_messages WHERE status = 'new')::int AS support_new,
				(SELECT COUNT(*) FROM placement_results WHERE date_created >= now() - interval '30 days')::int AS placement_30d,
				(SELECT COUNT(DISTINCT user_id) FROM listening_attempts WHERE date_created >= now() - interval '7 days')::int AS active_learners_7d
		`)).rows?.[0] || {};
		const revenue = (await database.raw(`
			SELECT lower(currency) AS currency, SUM(amount)::bigint AS amount
			FROM purchase_histories
			WHERE status = 'published' AND amount > 0 AND coalesce(date_transfer, date_created) >= now() - interval '30 days'
			GROUP BY 1
		`)).rows || [];
		const owed = (await database.raw(`
			SELECT currency, SUM(amount)::bigint AS amount FROM referral_conversions
			WHERE kind = 'commission' AND status IN ('pending', 'approved') AND available_at <= now()
			GROUP BY 1
		`)).rows || [];
		return res.json({
			success: true,
			data: {
				...r,
				revenue_30d: revenue.map((x: any) => ({ currency: x.currency, amount: Number(x.amount) })),
				commissions_payable: owed.map((x: any) => ({ currency: x.currency, amount: Number(x.amount) })),
				config: growthConfig(),
			},
		});
	}));

	// ── Traffic sources (first touch, lib/attribution.ts) ─────────────────
	router.get('/admin/attribution', admin(async (req, res) => {
		const days = [7, 30, 90, 365].includes(Number(req.query.days)) ? Number(req.query.days) : Number(req.query.days) === 0 ? 0 : 30;
		const since = days ? `u.gl_created_at >= now() - interval '${days} days'` : 'true';
		// Paid orders of each account (any date): what the channel brought in
		const orders = `
			LEFT JOIN LATERAL (
				SELECT
					COUNT(*)::int AS n,
					COALESCE(SUM(amount) FILTER (WHERE lower(currency) = 'vnd'), 0)::bigint AS vnd,
					COALESCE(SUM(amount) FILTER (WHERE lower(currency) = 'usd'), 0)::bigint AS usd
				FROM purchase_histories h
				WHERE h.user = u.id AND h.status = 'published' AND h.amount > 0 AND coalesce(h.payment_method, '') <> 'free'
			) o ON true`;
		const sums = `
			COUNT(*)::int AS signups,
			COUNT(*) FILTER (WHERE o.n > 0)::int AS paying,
			COALESCE(SUM(o.n), 0)::int AS orders,
			COALESCE(SUM(o.vnd), 0)::bigint AS revenue_vnd,
			COALESCE(SUM(o.usd), 0)::bigint AS revenue_usd`;
		const num = (r: any) => ({ ...r, revenue_vnd: Number(r.revenue_vnd), revenue_usd: Number(r.revenue_usd) });
		const sources = (await database.raw(`
			SELECT COALESCE(u.utm_source, '(unknown)') AS source, COALESCE(u.utm_medium, '') AS medium, ${sums}
			FROM directus_users u ${orders}
			WHERE ${since}
			GROUP BY 1, 2 ORDER BY signups DESC, 1 LIMIT 100
		`)).rows || [];
		const campaigns = (await database.raw(`
			SELECT u.utm_source AS source, u.utm_medium AS medium, u.utm_campaign AS campaign, COALESCE(u.utm_content, '') AS content, ${sums}
			FROM directus_users u ${orders}
			WHERE ${since} AND u.utm_campaign IS NOT NULL
			GROUP BY 1, 2, 3, 4 ORDER BY signups DESC, 3 LIMIT 100
		`)).rows || [];
		const recent = (await database.raw(`
			SELECT u.email, u.gl_created_at AS created_at, u.utm_source AS source, u.utm_medium AS medium,
				u.utm_campaign AS campaign, u.utm_content AS content, u.signup_referrer AS referrer, u.signup_landing AS landing,
				(o.n > 0) AS paid
			FROM directus_users u ${orders}
			WHERE ${since}
			ORDER BY u.gl_created_at DESC NULLS LAST LIMIT 50
		`)).rows || [];
		return res.json({ success: true, data: { days, sources: sources.map(num), campaigns: campaigns.map(num), recent } });
	}));

	// ── Coupons ───────────────────────────────────────────────────────────
	const promoBody = (body: any, partial: boolean) => {
		const out: Record<string, any> = {};
		if (!partial || body.code !== undefined) {
			const code = str(body.code, 40).toUpperCase();
			if (!PROMO_CODE_RE.test(code)) throw bad('Code: 3-40 letters, digits, - or _');
			out.code = code;
		}
		if (!partial || body.type !== undefined) {
			if (!['Percent', 'Fixed'].includes(body.type)) throw bad('Type: Percent or Fixed');
			out.type = body.type;
		}
		if (!partial || body.value !== undefined) {
			const value = Number(body.value);
			if (!Number.isFinite(value) || value <= 0) throw bad('Value must be > 0');
			out.value = value;
		}
		if (out.type === 'Percent' && out.value > 100) throw bad('A percent coupon is at most 100');
		if (body.title !== undefined) out.title = str(body.title, 255) || null;
		if (body.description !== undefined) out.description = str(body.description, 500) || null;
		if (body.status !== undefined) out.status = ['published', 'draft', 'archived'].includes(body.status) ? body.status : 'draft';
		for (const f of ['valid_from', 'valid_until'] as const) {
			if (body[f] !== undefined) {
				const d = body[f] ? new Date(body[f]) : null;
				out[f] = d && !Number.isNaN(d.getTime()) ? d : null;
			}
		}
		if (body.max_redemptions !== undefined) {
			const n = body.max_redemptions === null || body.max_redemptions === '' ? null : Math.round(Number(body.max_redemptions));
			if (n !== null && (!Number.isFinite(n) || n < 1)) throw bad('Max uses must be 1 or more');
			out.max_redemptions = n;
		}
		if (body.first_purchase_only !== undefined) out.first_purchase_only = body.first_purchase_only === true;
		if (body.affiliate_user_id !== undefined) {
			const id = body.affiliate_user_id ? String(body.affiliate_user_id) : null;
			if (id && !UUID_RE.test(id)) throw bad('Affiliate: invalid user');
			out.affiliate_user_id = id;
		}
		if (body.polar_discount_id !== undefined) out.polar_discount_id = str(body.polar_discount_id, 64) || null;
		return out;
	};

	router.get('/admin/promotions', admin(async (_req, res) => {
		const rows = await database('promotions as p')
			.leftJoin('directus_users as u', 'u.id', 'p.affiliate_user_id')
			.select('p.*', 'u.email as affiliate_email',
				database.raw(`(SELECT COUNT(*) FROM purchase_histories h WHERE h.promotion_id = p.id AND h.status = 'published')::int AS uses`))
			.orderBy('p.date_created', 'desc');
		return res.json({ success: true, data: rows.map((r: any) => ({ ...r, value: Number(r.value) })) });
	}));

	router.post('/admin/promotions', admin(async (req, res) => {
		const data = promoBody(req.body || {}, false);
		if (await codeTaken(database, data.code)) throw bad('This code is already a coupon or an invite code');
		const [row] = await database('promotions').insert({ status: 'published', ...data }).returning('id');
		return res.status(201).json({ success: true, data: { id: row?.id || row } });
	}));

	router.patch('/admin/promotions/:id', admin(async (req, res) => {
		const id = idParam(req);
		const data = promoBody(req.body || {}, true);
		if (data.code !== undefined) {
			const same = await database('promotions').where('id', id).whereRaw('lower(code) = lower(?)', [data.code]).first('id');
			if (!same && (await codeTaken(database, data.code))) throw bad('This code is already a coupon or an invite code');
		}
		if (data.type === undefined && data.value !== undefined) {
			const current = await database('promotions').select('type').where('id', id).first();
			if (current?.type === 'Percent' && data.value > 100) throw bad('A percent coupon is at most 100');
		}
		const updated = await database('promotions').where('id', id).update(data);
		if (!updated) return res.status(404).json({ success: false, message: 'Not found' });
		return res.json({ success: true });
	}));

	router.delete('/admin/promotions/:id', admin(async (req, res) => {
		const id = idParam(req);
		const used = await database('purchase_histories').where('promotion_id', id).first('id');
		if (used) {
			await database('promotions').where('id', id).update({ status: 'archived' });
			return res.json({ success: true, data: { archived: true } });
		}
		await database('promotions').where('id', id).delete();
		return res.json({ success: true, data: { deleted: true } });
	}));

	// ── Affiliates ────────────────────────────────────────────────────────
	router.get('/admin/affiliates', admin(async (_req, res) => {
		const rows = (await database.raw(`
			SELECT a.*, u.email, u.first_name, u.last_name, u.referral_code,
				(SELECT COUNT(*) FROM referral_clicks c WHERE c.referrer_id = a.user_id)::int AS clicks,
				(SELECT COUNT(*) FROM directus_users x WHERE x.referred_by = a.user_id)::int AS signups,
				(SELECT COUNT(DISTINCT r.referred_user_id) FROM referral_conversions r WHERE r.referrer_id = a.user_id AND r.kind = 'commission' AND r.status <> 'void')::int AS customers,
				(SELECT COUNT(*) FROM referral_conversions r WHERE r.referrer_id = a.user_id AND r.flags IS NOT NULL AND r.status <> 'void')::int AS flagged,
				(SELECT row_to_json(q) FROM (
					SELECT pr.id, pr.currency, pr.amount, pr.date_created FROM affiliate_payout_requests pr
					WHERE pr.user_id = a.user_id AND pr.status = 'pending' ORDER BY pr.date_created LIMIT 1
				) q) AS request,
				(SELECT json_agg(t) FROM (
					SELECT r.currency,
						SUM(r.amount) FILTER (WHERE r.status IN ('pending', 'approved') AND r.available_at > now())::bigint AS pending,
						SUM(r.amount) FILTER (WHERE r.status IN ('pending', 'approved') AND r.available_at <= now())::bigint AS available,
						SUM(r.amount) FILTER (WHERE r.status = 'paid')::bigint AS paid
					FROM referral_conversions r WHERE r.referrer_id = a.user_id AND r.kind = 'commission'
					GROUP BY r.currency
				) t) AS totals
			FROM affiliates a
			JOIN directus_users u ON u.id = a.user_id
			ORDER BY
				EXISTS (SELECT 1 FROM affiliate_payout_requests pr WHERE pr.user_id = a.user_id AND pr.status = 'pending') DESC,
				CASE a.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, a.date_created DESC
		`)).rows || [];
		// What "Pay" would send now, per currency: minimum and suggested tax
		const data = rows.map((a: any) => ({
			...a,
			payable: (a.totals || [])
				.map((t: any) => {
					const available = Number(t.available) || 0;
					const tax = suggestedWithholding(a, available, t.currency);
					return { currency: t.currency, available, min: minPayout(t.currency), below_min: available < minPayout(t.currency), suggested_tax: tax, net: available - tax };
				})
				.filter((p: any) => p.available > 0),
		}));
		return res.json({ success: true, data, default_rate: growthConfig().affiliateDefaultRate });
	}));

	router.patch('/admin/affiliates/:id', admin(async (req, res) => {
		const id = idParam(req);
		const body = req.body || {};
		const patch: Record<string, any> = { date_updated: new Date() };
		if (body.status !== undefined) {
			if (!['pending', 'approved', 'rejected', 'suspended'].includes(body.status)) throw bad('Invalid status');
			patch.status = body.status;
		}
		if (body.commission_rate !== undefined) {
			const rate = body.commission_rate === null || body.commission_rate === '' ? null : Number(body.commission_rate);
			if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 90)) throw bad('Rate: 0-90 %');
			patch.commission_rate = rate;
		}
		if (body.admin_note !== undefined) patch.admin_note = str(body.admin_note, 2000) || null;
		if (body.legal_name !== undefined) patch.legal_name = str(body.legal_name, 255) || null;
		if (body.tax_id !== undefined) patch.tax_id = str(body.tax_id, 30).replace(/\s+/g, '') || null;
		if (body.business_registered !== undefined) patch.business_registered = body.business_registered === true;
		if (body.country !== undefined) {
			const country = str(body.country, 2).toUpperCase();
			if (!/^[A-Z]{2}$/.test(country)) throw bad('Country: 2-letter code');
			patch.country = country;
		}
		const row = await database('affiliates').where('id', id).first();
		if (!row) return res.status(404).json({ success: false, message: 'Not found' });
		if (patch.status === 'approved' && row.status !== 'approved') {
			patch.approved_at = new Date();
			await ensureReferralCode(database, row.user_id);
		}
		await database('affiliates').where('id', id).update(patch);
		return res.json({ success: true });
	}));

	// ── Conversions ───────────────────────────────────────────────────────
	router.get('/admin/conversions', admin(async (req, res) => {
		const { page, limit, offset } = paging(req);
		const like = search(req);
		const base = database('referral_conversions as r')
			.join('directus_users as ref', 'ref.id', 'r.referrer_id')
			.leftJoin('directus_users as buyer', 'buyer.id', 'r.referred_user_id')
			.leftJoin('purchase_histories as h', 'h.id', 'r.purchase_id');
		if (req.query.referrer && UUID_RE.test(String(req.query.referrer))) base.where('r.referrer_id', String(req.query.referrer));
		if (['pending', 'approved', 'paid', 'void'].includes(String(req.query.status))) base.where('r.status', String(req.query.status));
		if (['reward', 'commission'].includes(String(req.query.kind))) base.where('r.kind', String(req.query.kind));
		if (like) {
			base.where((w: any) => w.whereILike('ref.email', like).orWhereILike('buyer.email', like).orWhereILike('h.transfer_code', like)
				.orWhereILike('ref.referral_code', like));
		}
		const [rows, count] = await Promise.all([
			base.clone()
				.select('r.*', 'ref.email as referrer_email', 'buyer.email as buyer_email', 'h.transfer_code', 'h.payment_method')
				.orderBy('r.date_created', 'desc')
				.limit(limit)
				.offset(offset),
			base.clone().count('* as n').first(),
		]);
		return res.json({
			success: true,
			data: rows.map((r: any) => ({ ...r, amount: Number(r.amount) || 0, order_amount: Number(r.order_amount) || 0 })),
			total: Number(count?.n) || 0,
			page,
			limit,
		});
	}));

	router.patch('/admin/conversions/:id', admin(async (req, res) => {
		const id = idParam(req);
		const status = String(req.body?.status || '');
		if (!['void', 'approved', 'pending'].includes(status)) throw bad('Status: void, approved or pending');
		const updated = await database('referral_conversions').where('id', id).whereNot('status', 'paid').update({ status });
		if (!updated) return res.status(409).json({ success: false, message: 'Not found or already paid' });
		return res.json({ success: true });
	}));

	// ── Payouts ───────────────────────────────────────────────────────────
	router.get('/admin/payouts', admin(async (req, res) => {
		const { page, limit, offset } = paging(req);
		const like = search(req);
		const base = database('affiliate_payouts as p').join('directus_users as u', 'u.id', 'p.user_id');
		if (like) base.where((w: any) => w.whereILike('u.email', like).orWhereILike('p.legal_name', like).orWhereILike('p.reference', like));
		const [rows, count] = await Promise.all([
			base.clone().select('p.*', 'u.email').orderBy('p.paid_at', 'desc').limit(limit).offset(offset),
			base.clone().count('* as n').first(),
		]);
		return res.json({
			success: true,
			data: rows.map((r: any) => ({ ...r, amount: Number(r.amount) || 0, gross_amount: Number(r.gross_amount ?? r.amount) || 0, tax_withheld: Number(r.tax_withheld) || 0 })),
			total: Number(count?.n) || 0,
			page,
			limit,
		});
	}));

	// Everything paid in a year, one row per person and currency (for the accountant /
	// the PIT return). Names and tax ids are the ones recorded at payout time.
	router.get('/admin/payouts/report', admin(async (req, res) => {
		const year = Number(req.query.year) || new Date().getFullYear();
		if (year < 2020 || year > 2100) throw bad('Invalid year');
		const rows = (await database.raw(`
			SELECT p.user_id, u.email,
				COALESCE(MAX(p.legal_name), MAX(a.legal_name)) AS legal_name,
				COALESCE(MAX(p.tax_id), MAX(a.tax_id)) AS tax_id,
				COALESCE(MAX(p.country), MAX(a.country)) AS country,
				BOOL_OR(COALESCE(a.business_registered, false)) AS business_registered,
				p.currency,
				COUNT(*)::int AS payouts,
				SUM(COALESCE(p.gross_amount, p.amount))::bigint AS gross,
				SUM(p.tax_withheld)::bigint AS tax_withheld,
				SUM(p.amount)::bigint AS net
			FROM affiliate_payouts p
			JOIN directus_users u ON u.id = p.user_id
			LEFT JOIN affiliates a ON a.user_id = p.user_id
			WHERE (p.paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh') >= make_date(?, 1, 1)
				AND (p.paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh') < make_date(? + 1, 1, 1)
			GROUP BY p.user_id, u.email, p.currency
			ORDER BY p.currency, gross DESC
		`, [year, year])).rows || [];
		return res.json({
			success: true,
			data: {
				year,
				rows: rows.map((r: any) => ({ ...r, gross: Number(r.gross), tax_withheld: Number(r.tax_withheld), net: Number(r.net) })),
			},
		});
	}));

	router.post('/admin/payouts', admin(async (req, res) => {
		const body = req.body || {};
		const userId = String(body.user_id || '');
		const currency = str(body.currency, 10).toLowerCase();
		if (!UUID_RE.test(userId) || !currency) throw bad('user_id and currency are required');
		const result = await database.transaction(async (trx: any) => {
			const payable = await trx('referral_conversions')
				.where({ referrer_id: userId, kind: 'commission', currency })
				.whereIn('status', ['pending', 'approved'])
				.where('available_at', '<=', trx.fn.now())
				.forUpdate()
				.select('id', 'amount');
			const total = payable.reduce((n: number, r: any) => n + (Number(r.amount) || 0), 0);
			if (!payable.length || total <= 0) throw bad('Nothing to pay for this currency');
			if (total < minPayout(currency) && body.force !== true) {
				throw Object.assign(new Error('Below the minimum payout'), { status: 400 });
			}
			const affiliate = await trx('affiliates')
				.select('payout_method', 'legal_name', 'tax_id', 'country', 'business_registered')
				.where('user_id', userId)
				.first();
			// PIT kept back: the admin's number, or the Vietnamese rule
			const asked = body.tax_withheld === undefined || body.tax_withheld === null || body.tax_withheld === '' ? null : Number(body.tax_withheld);
			if (asked !== null && (!Number.isFinite(asked) || asked < 0 || asked > total)) throw bad('Tax withheld: 0 to the commission total');
			const tax = asked !== null ? Math.round(asked) : suggestedWithholding(affiliate, total, currency);
			const [row] = await trx('affiliate_payouts').insert({
				user_id: userId,
				gross_amount: total,
				tax_withheld: tax,
				amount: total - tax,
				legal_name: affiliate?.legal_name || null,
				tax_id: affiliate?.tax_id || null,
				country: affiliate?.country || null,
				currency,
				method: str(body.method, 30) || affiliate?.payout_method || null,
				reference: str(body.reference, 255) || null,
				note: str(body.note, 2000) || null,
			}).returning('id');
			const payoutId = row?.id || row;
			await trx('referral_conversions').whereIn('id', payable.map((r: any) => r.id)).update({ status: 'paid', payout_id: payoutId });
			await trx('affiliate_payout_requests')
				.where({ user_id: userId, currency, status: 'pending' })
				.update({ status: 'paid', payout_id: payoutId, date_updated: new Date() });
			return { id: payoutId, gross_amount: total, tax_withheld: tax, amount: total - tax, conversions: payable.length };
		});
		return res.status(201).json({ success: true, data: result });
	}));

	router.patch('/admin/payout-requests/:id', admin(async (req, res) => {
		const id = idParam(req);
		if (req.body?.status !== 'rejected') throw bad('Status: rejected (to pay, record a payout)');
		const note = str(req.body?.admin_note, 1000);
		if (!note) throw bad('Tell the affiliate why');
		const updated = await database('affiliate_payout_requests').where({ id, status: 'pending' })
			.update({ status: 'rejected', admin_note: note, date_updated: new Date() });
		if (!updated) return res.status(409).json({ success: false, message: 'Not found or already handled' });
		return res.json({ success: true });
	}));

	// ── Support ───────────────────────────────────────────────────────────
	router.get('/admin/support', admin(async (req, res) => {
		const q = database('support_messages').orderBy('date_created', 'desc').limit(300);
		if (['new', 'answered', 'closed'].includes(String(req.query.status))) q.where('status', String(req.query.status));
		return res.json({ success: true, data: await q });
	}));

	router.patch('/admin/support/:id', admin(async (req, res) => {
		const id = idParam(req);
		const status = String(req.body?.status || '');
		if (!['new', 'answered', 'closed'].includes(status)) throw bad('Invalid status');
		await database('support_messages').where('id', id).update({ status });
		return res.json({ success: true });
	}));

	// Users for the coupon form ("link to an affiliate")
	router.get('/admin/affiliate-users', admin(async (_req, res) => {
		const rows = await database('affiliates as a').join('directus_users as u', 'u.id', 'a.user_id')
			.select('a.user_id', 'u.email', 'u.first_name', 'u.last_name').where('a.status', 'approved').orderBy('u.email');
		return res.json({ success: true, data: rows });
	}));
}
