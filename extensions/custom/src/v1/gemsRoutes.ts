/**
 * Kim cương v2 for learners (web repo docs/xu-v2-tasks.md P2-P7). Each part sits behind its own switch
 * (growth_settings.gems_flags: off | staff | all), see lib/growthConfig.ts gemsOn.
 *
 *   cards     GET /cards/today   POST /cards/draw   POST /cards/answer   POST /cards/skip   POST /cards/recovery/claim
 *   chests    GET /chests   GET /chests/:code/odds   POST /chests/:code/open   GET /gems/bag   POST /items/use
 *   purchase  GET /xu/packs   POST /coins/orders        (the order is paid and polled like a plan: /checkout/:id/status)
 *   share     POST /share   GET /share/:id.png   GET /share/:id   GET /gems/leaderboard   PUT /badges/shown   GET /u/:id
 *   help      GET /help/hints?clip_id=   POST /help/hints   POST /help/hints/:id/use
 *   rooms     GET /rooms   POST /rooms   POST /rooms/:id/join   GET /rooms/:id   POST /rooms/:id/answer
 */
import { COIN, CoinError, walletOf } from '../lib/coins';
import { gemsOn, siteOrigin, type GemsFeature } from '../lib/growthConfig';
import { BASE_LANG, langOf } from '../lib/extensive';
import { vnDay } from '../lib/days';
import { levelOf, grantRewards } from '../lib/xp';
import { CardError, answerTruth, cardsState, claimRecovery, drawCard, skipDare } from '../lib/cards';
import { ChestError, oddsOf, openChest, takeItem, useItem, type Drop } from '../lib/chests';
import { listPacks, packCoins } from '../lib/gemOrders';
import { HelpError, hintsFor, leaveHint, useHint } from '../lib/help';
import { notify as coopNotify } from '../lib/coopHub';
import { CoopError, answerCoop, chatCoop, createCoop, getState, joinCoop, leaveCoop, listCoop, lockCoop, nextCoop, playCoop, readyCoop, startCoop } from '../lib/coop';
import { cancelQueue, joinQueue, matchStatus, sweepQueue } from '../lib/match';
import { joinVoice } from '../lib/voice';
import { RoomError, answerRoom, createRoom, joinRoom, listRooms, roomView, sweepRooms } from '../lib/rooms';
import { SHARE_KINDS, newShareId, ogPage, shareFacts, shareSvg, shareText, sharePng, type ShareKind } from '../lib/share';
import { STAR_MODES } from '../lib/stars';
import { getReceivingAccount } from '../lib/sepayBankAccount';
import { addVat, breakdownFromPreTax } from '../lib/vat';
import { newPaymentCode } from './paymentCode';

const STATUS: Record<string, number> = { BAD_REQUEST: 400, NO_ROOM: 404, NO_CHEST: 404, NO_HINT: 404, NO_OPEN: 404 };

/** Kim cương earned by learning: what the weekly ranking counts (not bought, not given, not luck) */
const NOT_LEARNING = ['purchase', 'admin', 'refund', 'chargeback', 'chest', 'room_prize', 'premium_day', 'card_skip'];

export function registerGemsRoutes(router: any, context: any) {
	const { database, logger } = context;

	/** A signed-in learner and, for a part of v2, its switch; errors of the parts become a code and a status */
	const learner = (feature: GemsFeature | null, handler: (req: any, res: any, userId: string) => Promise<any>, whenOff?: any) => async (req: any, res: any) => {
		const userId = req.accountability?.user as string | undefined;
		if (!userId) return res.status(401).json({ success: false, code: 'UNAUTHORIZED' });
		if (feature && !gemsOn(feature, req.accountability)) {
			if (whenOff !== undefined) return res.json({ success: true, data: whenOff });
			return res.status(403).json({ success: false, code: `${feature.toUpperCase()}_OFF` });
		}
		try {
			return await handler(req, res, userId);
		} catch (e: any) {
			if (e instanceof CardError || e instanceof ChestError || e instanceof RoomError || e instanceof CoopError || e instanceof HelpError || e instanceof CoinError) {
				return res.status(STATUS[e.code] || 409).json({ success: false, code: e.code });
			}
			logger?.error?.(`[gems] ${req.method} ${req.path} failed: ${String(e)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};

	const isPremium = async (userId: string) => {
		const u = await database('directus_users').select('is_premium', 'premium_until', 'subscription_type').where('id', userId).first();
		return !!u?.is_premium && (u.subscription_type === 'lifetime' || !u.premium_until || new Date(u.premium_until).getTime() > Date.now());
	};
	const firstName = (u: any) => [u?.first_name, String(u?.last_name || '').slice(0, 1)].filter(Boolean).join(' ') || 'Learner';
	/** Names of items / chests in the learner's language, falling back to Vietnamese */
	const names = async (table: 'item_translations' | 'chest_translations', lang: string) => {
		const short = lang.slice(0, 2);
		const rows = await database(table).select('code', 'lang', 'name', 'body').whereIn('lang', [short, 'vi']);
		const out = new Map<string, { name: string; body: string | null }>();
		for (const r of rows.filter((x: any) => x.lang === 'vi')) out.set(r.code, { name: r.name, body: r.body });
		for (const r of rows.filter((x: any) => x.lang === short && x.lang !== 'vi')) out.set(r.code, { name: r.name || out.get(r.code)?.name || r.code, body: r.body || out.get(r.code)?.body || null });
		return out;
	};
	/** 'vi-VN' (what the translation tables of Bạn có biết use) and 'vi' (what cards, items and chests use) */
	const fullLang = (req: any) => langOf(req.query?.lang ?? req.body?.lang);
	const langOfReq = (req: any) => fullLang(req).slice(0, 2);
	const afterCommit = async (req: any, userId: string, premiumDays: number, key: string) => {
		if (premiumDays > 0) await grantRewards(context, req.schema, userId, [{ kind: 'premium_day', days: premiumDays, key }]);
	};

	// ── P2: cards ──────────────────────────────────────────────────────────────────────────────
	router.get('/cards/today', learner('cards', async (req, res, userId) => {
		return res.json({ success: true, data: { on: true, ...(await cardsState(database, userId, fullLang(req))) } });
	}, { on: false }));

	router.post('/cards/draw', learner('cards', async (req, res, userId) => {
		const draw = await drawCard(database, userId, { kind: req.body?.kind, pick: Number(req.body?.pick), lang: fullLang(req) });
		return res.json({ success: true, data: draw });
	}));

	router.post('/cards/answer', learner('cards', async (req, res, userId) => {
		const r = await answerTruth(database, userId, { choice: Number(req.body?.choice), premium: await isPremium(userId), lang: fullLang(req) });
		await afterCommit(req, userId, r.paid?.premium_days || 0, `card:${r.id}`);
		return res.json({ success: true, data: { correct: r.correct, reward: r.paid, draw: r.view } });
	}));

	router.post('/cards/skip', learner('cards', async (_req, res, userId) => {
		return res.json({ success: true, data: await skipDare(database, userId) });
	}));

	router.post('/cards/recovery/claim', learner('cards', async (_req, res, userId) => {
		return res.json({ success: true, data: await claimRecovery(database, userId) });
	}));

	// ── P3: chests, items, badges ─────────────────────────────────────────────────────────────
	const dropsOf = (code: string): Promise<Drop[]> => database('chest_drops').select('item_code', 'weight', 'guaranteed', 'premium_alt').where('chest_code', code);

	router.get('/chests', learner('chests', async (req, res, userId) => {
		const lang = langOfReq(req);
		const [chests, nm, item, bal] = await Promise.all([
			database('chests').where('active', true).orderBy('tier'), names('chest_translations', lang), names('item_translations', lang),
			walletOf(database, userId, 0),
		]);
		const opened = new Set<string>(await database('chest_opens').where('user_id', userId).distinct('chest_code').pluck('chest_code'));
		const data = [];
		for (const c of chests) {
			if (c.once && opened.has(c.code)) continue;
			const drops = await dropsOf(c.code);
			data.push({
				code: c.code, tier: c.tier, price: c.price, rolls: c.rolls, pity_n: c.pity_n, pity_item: c.pity_item ? item.get(c.pity_item)?.name || c.pity_item : null, once: c.once,
				name: nm.get(c.code)?.name || c.code, body: nm.get(c.code)?.body || null,
				odds: oddsOf(drops).map((o) => ({ ...o, name: item.get(o.item_code)?.name || o.item_code })).sort((a, b) => b.pct - a.pct),
				guaranteed: drops.filter((d) => d.guaranteed).map((d) => item.get(d.item_code)?.name || d.item_code),
			});
		}
		return res.json({ success: true, data: { chests: data, balance: bal.coins } });
	}, { chests: [], balance: 0 }));

	router.post('/chests/:code/open', learner('chests', async (req, res, userId) => {
		const requestId = String(req.body?.request_id || '');
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) return res.status(400).json({ success: false, code: 'BAD_REQUEST' });
		const r = await openChest(database, userId, String(req.params.code), requestId, { premium: await isPremium(userId) });
		if (!r.replay) await afterCommit(req, userId, r.premium_days, `chest:${requestId}`);
		const item = await names('item_translations', langOfReq(req));
		return res.json({ success: true, data: { ...r, items: r.items.map((i) => ({ ...i, name: item.get(i.code)?.name || i.code })) } });
	}));

	router.get('/gems/bag', learner('chests', async (req, res, userId) => {
		const lang = langOfReq(req);
		const [rows, item, badges, wallet] = await Promise.all([
			database('user_items').select('item_code').min('expires_at as expires_at').count('* as n').where('user_id', userId).whereNull('used_at')
				.where((q: any) => q.whereNull('expires_at').orWhere('expires_at', '>', database.fn.now())).groupBy('item_code'),
			names('item_translations', lang),
			database('user_badges as ub').join('badges as b', 'b.code', 'ub.badge_code').where('ub.user_id', userId).orderBy('b.rarity', 'desc')
				.select('b.code', 'b.name_vi', 'b.name_en', 'b.rarity', 'ub.serial_no', 'b.serial_max', 'ub.shown', 'ub.created_at'),
			walletOf(database, userId, 0),
		]);
		return res.json({
			success: true, data: {
				balance: wallet.coins,
				items: rows.map((r: any) => ({ code: r.item_code, name: item.get(r.item_code)?.name || r.item_code, body: item.get(r.item_code)?.body || null, n: Number(r.n), expires_at: r.expires_at })),
				badges: badges.map((b: any) => ({ code: b.code, name: lang === 'vi' ? b.name_vi : b.name_en || b.name_vi, rarity: b.rarity, serial_no: b.serial_no, serial_max: b.serial_max, shown: b.shown })),
			},
		});
	}, { balance: 0, items: [], badges: [] }));

	/** "Thêm 1 Ngôi sao": used before a run; that run has more stars */
	router.post('/items/use', learner('chests', async (req, res, userId) => {
		const code = String(req.body?.item_code || '');
		if (code !== 'extra_star') return res.status(400).json({ success: false, code: 'BAD_REQUEST' });
		const out = await database.transaction(async (trx: any) => {
			const run = await trx('listening_runs').where({ id: String(req.body?.run_id || ''), user_id: userId, status: 'active' }).forUpdate().first();
			if (!run || !STAR_MODES.includes(run.mode)) return null;
			const row = await takeItem(trx, userId, 'extra_star');
			if (!row) return 'none' as const;
			const def = await trx('items').where('code', 'extra_star').first('params');
			const n = Number((typeof def?.params === 'string' ? JSON.parse(def.params) : def?.params)?.n) || 1;
			await useItem(trx, row.id);
			await trx('listening_runs').where('id', run.id).update({ extra_stars: (Number(run.extra_stars) || 0) + n });
			return { extra_stars: (Number(run.extra_stars) || 0) + n, stars_left: Math.max(0, COIN.star.perRun + (Number(run.extra_stars) || 0) + n - Number((await trx('star_uses').where('run_id', run.id).count('* as c').first())?.c || 0)) };
		});
		if (out === null) return res.status(400).json({ success: false, code: 'BAD_REQUEST' });
		if (out === 'none') return res.status(409).json({ success: false, code: 'NO_ITEM' });
		return res.json({ success: true, data: out });
	}));

	// ── P4: top-up ────────────────────────────────────────────────────────────────────────────
	router.get('/xu/packs', async (req: any, res: any) => {
		try {
			if (!gemsOn('purchase', req.accountability)) return res.json({ success: true, data: { on: false, packs: [] } });
			return res.json({ success: true, data: { on: true, packs: await listPacks(database, req.accountability?.user || null), lesson_price: COIN.unlock.pattern } });
		} catch (e) {
			logger?.error?.(`[gems] packs failed: ${String(e)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	});

	router.post('/coins/orders', learner('purchase', async (req, res, userId) => {
		const pack = await database('xu_packs').where({ code: String(req.body?.pack_code || ''), active: true }).first();
		if (!pack) return res.status(404).json({ success: false, code: 'NO_PACK' });
		// The very first top-up of an account gets the pack's first_mult (lib/gemOrders.ts decides again when it is paid)
		const isFirst = !(await database('coin_events').where({ user_id: userId, reason: 'purchase' }).first('id'));
		const pending = Number((await database('purchase_histories').where({ user: userId, product_type: 'coins', status: 'pending' }).where('date_created', '>', new Date(Date.now() - 3600_000)).count('* as n').first())?.n) || 0;
		if (pending >= 5) return res.status(429).json({ success: false, code: 'TOO_MANY_ORDERS' });
		const account = await getReceivingAccount(context);
		if (!account) return res.status(503).json({ success: false, error: 'Payment is not available right now, please try again in a few minutes.' });
		// The price is read from the database, now; the order keeps the Kim cuong it was sold for
		const total = addVat(Number(pack.price_vnd));
		const paid = breakdownFromPreTax(total);
		const code = newPaymentCode();
		const expire = new Date(Date.now() + 15 * 60_000);
		expire.setSeconds(0, 0);
		const [row] = await database('purchase_histories').insert({
			id: database.raw('gen_random_uuid()'), user: userId, status: 'pending', date_created: database.fn.now(), amount: Math.round(paid.total), price_original: Math.round(paid.total),
			price_subtotal: Math.round(paid.subtotal), vat_rate: paid.vatRate, vat_amount: Math.round(paid.vatAmount), transfer_code: code, expire_time: expire,
			payment_method: 'bank_transfer', currency: 'vnd', type: 'gems', product_type: 'coins', pack_code: pack.code, coins: packCoins(pack),
		}).returning('id');
		const qs = new URLSearchParams({ bank: account.bankBin || account.bankShortName, acc: account.accountNumber, amount: String(Math.round(paid.total)), des: code });
		return res.json({
			success: true, data: {
				purchaseHistoryId: row.id ?? row, code, pack_code: pack.code, coins: packCoins(pack), first_coins: isFirst && Number(pack.first_mult) > 1 ? Math.round(packCoins(pack) * Number(pack.first_mult)) : null,
				price_paid: paid.total, expire_time: expire.toISOString(),
				beneficiaryAccountNumber: account.accountNumber, beneficiaryAccountName: account.accountHolderName, beneficiaryBankName: account.bankShortName, beneficiaryBankCode: account.bankBin,
				qrCode: `https://vietqr.app/img?${qs.toString()}&template=&showinfo=0`,
			},
		});
	}));

	// ── P5: share, ranking, public profile ────────────────────────────────────────────────────
	router.post('/share', learner('share', async (req, res, userId) => {
		const kind = String(req.body?.kind || '') as ShareKind;
		if (!SHARE_KINDS.includes(kind)) return res.status(400).json({ success: false, code: 'BAD_REQUEST' });
		const facts = await shareFacts(database, userId, kind, req.body?.ref ? String(req.body.ref) : null);
		if (!facts) return res.status(404).json({ success: false, code: 'NOTHING_TO_SHARE' });
		const user = await database('directus_users').select('first_name', 'last_name').where('id', userId).first();
		const id = newShareId();
		const lang = langOfReq(req);
		await database('shares').insert({ id, user_id: userId, kind, data: JSON.stringify({ facts, lang, name: firstName(user) }) });
		const base = `${(process.env.PUBLIC_URL || siteOrigin()).replace(/\/+$/, '')}/v1/share/${id}`;
		const ref = await database('directus_users').select('referral_code').where('id', userId).first().catch(() => null);
		return res.json({ success: true, data: { id, url: base, image: `${base}.png`, referral_code: ref?.referral_code || null } });
	}));

	const shareOf = async (id: string) => {
		const row = /^[A-Za-z0-9]{6,12}$/.test(id) ? await database('shares').where('id', id).first() : null;
		if (!row) return null;
		const d = row.data as any;
		return { row, text: shareText(row.kind, d.facts, d.lang || 'vi', d.name || 'Learner') };
	};
	router.get('/share/:id.png', async (req: any, res: any) => {
		try {
			const s = await shareOf(String(req.params.id));
			if (!s) return res.status(404).end();
			const svg = shareSvg(s.text);
			const png = await sharePng(svg);
			res.set('Cache-Control', 'public, max-age=86400');
			if (png) return res.type('image/png').send(png);
			return res.type('image/svg+xml').send(svg);
		} catch { return res.status(500).end(); }
	});
	router.get('/share/:id', async (req: any, res: any) => {
		try {
			const s = await shareOf(String(req.params.id));
			if (!s) return res.status(404).end();
			const api = `${(process.env.PUBLIC_URL || siteOrigin()).replace(/\/+$/, '')}/v1/share/${s.row.id}`;
			res.set('Cache-Control', 'public, max-age=3600');
			return res.type('html').send(ogPage({ ...s.text, image: `${api}.png`, url: api, to: `${siteOrigin()}/?ref=share` }));
		} catch { return res.status(500).end(); }
	});

	router.get('/gems/leaderboard', async (req: any, res: any) => {
		try {
			if (!gemsOn('share', req.accountability)) return res.json({ success: true, data: { on: false, rows: [] } });
			const today = vnDay();
			const d = new Date(`${today}T00:00:00Z`);
			d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
			const monday = d.toISOString().slice(0, 10);
			const rows = await database('coin_events as e').join('directus_users as u', 'u.id', 'e.user_id')
				.where('e.day', '>=', monday).where('e.amount', '>', 0).whereNotIn('e.reason', NOT_LEARNING).whereRaw('u.is_internal IS NOT TRUE')
				.groupBy('u.id', 'u.first_name', 'u.last_name').select('u.id', 'u.first_name', 'u.last_name').sum('e.amount as total').orderBy('total', 'desc').limit(20);
			const me = req.accountability?.user as string | undefined;
			return res.json({ success: true, data: { on: true, week: monday, rows: rows.map((r: any, i: number) => ({ rank: i + 1, name: firstName(r), total: Number(r.total), you: r.id === me, id: r.id })) } });
		} catch (e) {
			logger?.error?.(`[gems] leaderboard failed: ${String(e)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	});

	router.put('/badges/shown', learner('share', async (req, res, userId) => {
		const codes: string[] = Array.isArray(req.body?.codes) ? req.body.codes.map(String).slice(0, 3) : [];
		await database.transaction(async (trx: any) => {
			await trx('user_badges').where('user_id', userId).update({ shown: null });
			for (let i = 0; i < codes.length; i++) await trx('user_badges').where({ user_id: userId, badge_code: codes[i] }).update({ shown: i + 1 });
		});
		return res.json({ success: true, data: { shown: codes } });
	}));

	router.get('/u/:id', async (req: any, res: any) => {
		try {
			if (!gemsOn('share', req.accountability)) return res.status(404).json({ success: false });
			const id = String(req.params.id);
			if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).json({ success: false });
			const u = await database('directus_users').select('id', 'first_name', 'last_name', 'avatar').where('id', id).first();
			if (!u) return res.status(404).json({ success: false });
			const [xp, badges] = await Promise.all([
				database('user_xp').select('xp_total').where('user_id', id).first(),
				database('user_badges as ub').join('badges as b', 'b.code', 'ub.badge_code').where('ub.user_id', id).whereNotNull('ub.shown').orderBy('ub.shown')
					.select('b.code', 'b.name_vi', 'b.name_en', 'b.rarity', 'ub.serial_no', 'b.serial_max'),
			]);
			const lang = langOfReq(req);
			return res.json({ success: true, data: { name: firstName(u), level: levelOf(Number(xp?.xp_total) || 0).level, badges: badges.map((b: any) => ({ code: b.code, name: lang === 'vi' ? b.name_vi : b.name_en || b.name_vi, rarity: b.rarity, serial_no: b.serial_no, serial_max: b.serial_max })) } });
		} catch (e) {
			logger?.error?.(`[gems] profile failed: ${String(e)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	});

	// ── P6: hints from other learners ─────────────────────────────────────────────────────────
	router.get('/help/hints', learner('help', async (req, res, userId) => {
		const clip = String(req.query.clip_id || '');
		if (!/^[0-9a-f-]{36}$/i.test(clip)) return res.status(400).json({ success: false, code: 'BAD_REQUEST' });
		const mine = await database('listening_attempts').where({ user_id: userId, clip_id: clip, is_correct: true }).first('id');
		return res.json({ success: true, data: { hints: await hintsFor(database, userId, clip), can_leave: !!mine } });
	}, { hints: [], can_leave: false }));
	router.post('/help/hints', learner('help', async (req, res, userId) => {
		const r = await leaveHint(database, userId, { clipId: String(req.body?.clip_id || ''), kind: String(req.body?.kind || ''), body: String(req.body?.body || '') });
		return res.json({ success: true, data: r });
	}));
	router.post('/help/hints/:id/use', learner('help', async (req, res, userId) => {
		return res.json({ success: true, data: await useHint(database, userId, String(req.params.id)) });
	}));

	// ── P7: rooms ─────────────────────────────────────────────────────────────────────────────
	router.get('/rooms', learner('rooms', async (_req, res, userId) => {
		await sweepRooms(database);
		const wallet = await walletOf(database, userId, 0);
		return res.json({ success: true, data: { ...(await listRooms(database, userId)), balance: wallet.coins } });
	}, { on: false }));
	router.post('/rooms', learner('rooms', async (req, res, userId) => {
		const id = await createRoom(database, userId, { fee: Number(req.body?.fee), size: Number(req.body?.size) });
		return res.json({ success: true, data: { id } });
	}));
	router.post('/rooms/:id/join', learner('rooms', async (req, res, userId) => {
		return res.json({ success: true, data: await joinRoom(database, userId, String(req.params.id)) });
	}));
	router.get('/rooms/:id', learner('rooms', async (req, res, userId) => {
		return res.json({ success: true, data: await roomView(database, userId, String(req.params.id), fullLang(req)) });
	}));
	router.post('/rooms/:id/answer', learner('rooms', async (req, res, userId) => {
		return res.json({ success: true, data: await answerRoom(database, userId, String(req.params.id), { index: Number(req.body?.index), choice: Number(req.body?.choice) }) });
	}));

	// ── Đấu & Luyện cùng: realtime rooms for two (pushed over the WebSocket, polled as a fallback) ─────
	router.get('/coop', learner('rooms', async (_req, res, userId) => {
		// the old rooms played at different times (lib/rooms.ts) are no longer made, but the ones still open must close and refund
		sweepRooms(database).catch(() => null);
		sweepQueue(database).catch(() => null);
		return res.json({ success: true, data: { ...(await listCoop(database, userId)), balance: (await walletOf(database, userId, 0)).coins } });
	}, { on: false }));
	// Tìm trận: join the queue of a fee, poll the status, leave
	router.post('/match', learner('rooms', async (req, res, userId) => res.json({ success: true, data: await joinQueue(database, userId, Number(req.body?.fee), req.body?.mode === 'practice' ? 'practice' : 'duel') })));
	router.get('/match', learner('rooms', async (_req, res, userId) => res.json({ success: true, data: await matchStatus(database, userId) })));
	router.delete('/match', learner('rooms', async (_req, res, userId) => res.json({ success: true, data: await cancelQueue(database, userId) })));
	router.post('/coop', learner('rooms', async (req, res, userId) => res.json({ success: true, data: { id: await createCoop(database, userId, { mode: req.body?.mode === 'duel' ? 'duel' : 'practice', fee: Number(req.body?.fee) }) } })));
	router.get('/coop/:id', learner('rooms', async (req, res, userId) => res.json({ success: true, data: await getState(database, userId, String(req.params.id), Number(req.query.since) || 0) })));
	// every change tells the others in the room over the WebSocket
	const act = (path: string, run: (req: any, userId: string, id: string) => Promise<any>) => router.post(`/coop/:id/${path}`, learner('rooms', async (req, res, userId) => {
		const id = String(req.params.id);
		const data = await run(req, userId, id);
		coopNotify(database, id).catch(() => null);
		return res.json({ success: true, data });
	}));
	act('join', (_r, u, id) => joinCoop(database, u, id));
	act('start', (_r, u, id) => startCoop(database, u, id));
	act('ready', (_r, u, id) => readyCoop(database, u, id));
	act('lock', (r, u, id) => lockCoop(database, u, id, Number(r.body?.idx)));
	act('play', (_r, u, id) => playCoop(database, u, id));
	act('answer', (r, u, id) => answerCoop(database, u, id, { idx: Number(r.body?.idx), text: String(r.body?.text ?? '') }));
	act('next', (r, u, id) => nextCoop(database, u, id, Number(r.body?.idx)));
	act('chat', (r, u, id) => chatCoop(database, u, id, String(r.body?.body || '')));
	act('leave', (_r, u, id) => leaveCoop(database, u, id));
	act('voice', (_r, u, id) => joinVoice(database, u, id));

	void BASE_LANG;
}
