/**
 * Admin: what the team edits in Kim cương v2 (Directus admins only). Web repo docs/xu-v2-tasks.md T2.8, T3.6, T4.4, T4.6.
 *
 *   /admin/gems/cards    Sự thật hay Thử thách: list (with how often drawn and done), create, edit, delete
 *   /admin/gems/chests   chests with their drops and what one opening is worth against its price; edit, create
 *   /admin/gems/items    items: worth, expiry, switch, names
 *   /admin/gems/packs    top-up packs
 *   /admin/gems/orders   top-ups paid or waiting; POST .../chargeback takes the Kim cương back
 *   /admin/gems/premium  who still has Premium (the plans no longer sold), for T4.6
 */
import { worthOf, type Drop } from '../lib/chests';
import { chargebackCoinOrder, packCoins } from '../lib/gemOrders';
import { CoinError } from '../lib/coins';

const int = (v: any, min: number, max: number) => {
	const n = Number(v);
	return Number.isInteger(n) && n >= min && n <= max ? n : null;
};
const CARD_KINDS = ['truth', 'dare'];
const CARD_STATUS = ['draft', 'approved', 'archived'];
// BCP-47, the same codes as locales[].language in nuxt.config.ts; a new language is added here and in the admin page
const ITEM_LANGS = ['vi-VN', 'en-US'];

export function registerAdminGemsContentRoutes(router: any, context: any) {
	const { database, logger } = context;
	const admin = (handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
		if (!req.accountability?.admin) return res.status(403).json({ success: false, message: 'Admins only' });
		try {
			return await handler(req, res);
		} catch (error: any) {
			logger?.error?.(`[admin-gems] ${req.method} ${req.path} failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};
	const bad = (res: any, message: string) => res.status(400).json({ success: false, message });

	// ── cards ──────────────────────────────────────────────────────────────────────────────────
	const cardOut = (c: any, tr: any[], stats: any) => ({
		...c,
		translations: Object.fromEntries(tr.filter((t) => t.card_id === c.id).map((t) => [t.lang, { title: t.title || '', body: t.body || '' }])),
		draws: Number(stats?.draws) || 0, done: Number(stats?.done) || 0,
	});

	router.get('/admin/gems/cards', admin(async (_req, res) => {
		const cards = await database('cards').orderBy([{ column: 'kind' }, { column: 'difficulty' }, { column: 'created_at' }]);
		const tr = await database('card_translations').select('card_id', 'lang', 'title', 'body');
		const stats = await database('card_draws').select('card_id').count('* as draws').select(database.raw("count(*) FILTER (WHERE status = 'done') AS done")).groupBy('card_id');
		const byId = new Map(stats.map((s: any) => [s.card_id, s]));
		const byType = await database('card_draws as d').join('cards as c', 'c.id', 'd.card_id').groupBy('c.kind', 'c.type').select('c.kind', 'c.type').count('* as draws')
			.select(database.raw("count(*) FILTER (WHERE d.status = 'done') AS done"));
		return res.json({ success: true, data: { cards: cards.map((c: any) => cardOut(c, tr, byId.get(c.id))), by_type: byType.map((r: any) => ({ kind: r.kind, type: r.type, draws: Number(r.draws), done: Number(r.done) })) } });
	}));

	const cardFields = async (b: any) => {
		const out: any = {};
		if (!CARD_KINDS.includes(b.kind)) return { error: 'kind must be truth or dare' };
		out.kind = b.kind;
		out.type = String(b.type || '').trim().slice(0, 30);
		if (!out.type) return { error: 'type is required' };
		const d = int(b.difficulty, 1, 4); if (d === null) return { error: 'difficulty 1-4' }; out.difficulty = d;
		out.level_min = b.level_min === '' || b.level_min == null ? null : int(b.level_min, 1, 20);
		out.level_max = b.level_max === '' || b.level_max == null ? null : int(b.level_max, 1, 20);
		const w = int(b.weight ?? 10, 1, 1000); if (w === null) return { error: 'weight 1-1000' }; out.weight = w;
		out.hidden = !!b.hidden;
		if (!CARD_STATUS.includes(b.status)) return { error: 'status' }; out.status = b.status;
		const reward = typeof b.reward === 'string' ? JSON.parse(b.reward || '{}') : b.reward;
		if (!reward || (!reward.coins && !reward.item && !reward.chest)) return { error: 'reward needs coins, item or chest' };
		if (reward.coins != null && int(reward.coins, 1, 100000) === null) return { error: 'reward.coins' };
		if (reward.item && !(await database('items').where('code', reward.item).first('code'))) return { error: 'unknown item' };
		if (reward.chest && !(await database('chests').where('code', reward.chest).first('code'))) return { error: 'unknown chest' };
		out.reward = JSON.stringify(reward);
		if (b.kind === 'dare') {
			const goal = typeof b.goal === 'string' ? JSON.parse(b.goal || '{}') : b.goal;
			if (!goal || !['correct', 'star_right'].includes(goal.metric) || int(goal.n, 1, 100000) === null) return { error: 'goal needs a metric (correct, star_right) and n' };
			out.goal = JSON.stringify(goal);
		} else out.goal = null;
		const source = typeof b.source === 'string' ? (b.source ? JSON.parse(b.source) : null) : b.source;
		out.source = source ? JSON.stringify(source) : null;
		return { out };
	};
	const saveTranslations = async (trx: any, id: string, t: any) => {
		for (const lang of ITEM_LANGS) {
			const x = t?.[lang];
			if (!x) continue;
			await trx('card_translations').insert({ card_id: id, lang, title: String(x.title || '').slice(0, 300), body: String(x.body || '').slice(0, 2000) }).onConflict(['card_id', 'lang']).merge();
		}
	};
	router.post('/admin/gems/cards', admin(async (req, res) => {
		let f: any;
		try { f = await cardFields(req.body || {}); } catch { return bad(res, 'JSON of reward, goal or source is not valid'); }
		if (f.error) return bad(res, f.error);
		const id = await database.transaction(async (trx: any) => {
			const [row] = await trx('cards').insert(f.out).returning('id');
			const id = row.id ?? row;
			await saveTranslations(trx, id, req.body?.translations);
			return id;
		});
		return res.json({ success: true, data: { id } });
	}));
	router.put('/admin/gems/cards/:id', admin(async (req, res) => {
		let f: any;
		try { f = await cardFields(req.body || {}); } catch { return bad(res, 'JSON of reward, goal or source is not valid'); }
		if (f.error) return bad(res, f.error);
		await database.transaction(async (trx: any) => {
			await trx('cards').where('id', req.params.id).update(f.out);
			await saveTranslations(trx, req.params.id, req.body?.translations);
		});
		return res.json({ success: true });
	}));
	router.delete('/admin/gems/cards/:id', admin(async (req, res) => {
		const used = await database('card_draws').where('card_id', req.params.id).first('id');
		// A card learners already drew is archived, not deleted: their history keeps pointing at it
		if (used) { await database('cards').where('id', req.params.id).update({ status: 'archived' }); return res.json({ success: true, archived: true }); }
		await database('cards').where('id', req.params.id).delete();
		return res.json({ success: true, archived: false });
	}));

	// ── items and chests ───────────────────────────────────────────────────────────────────────
	router.get('/admin/gems/items', admin(async (_req, res) => {
		const [items, tr] = await Promise.all([database('items').orderBy('rarity'), database('item_translations').select('code', 'lang', 'name', 'body')]);
		return res.json({ success: true, data: items.map((i: any) => ({ ...i, names: Object.fromEntries(tr.filter((t: any) => t.code === i.code).map((t: any) => [t.lang, t.name || ''])) })) });
	}));
	router.put('/admin/gems/items/:code', admin(async (req, res) => {
		const b = req.body || {};
		const value = int(b.value, 0, 1_000_000); if (value === null) return bad(res, 'value');
		const exp = b.expires_days === '' || b.expires_days == null ? null : int(b.expires_days, 1, 3650);
		await database('items').where('code', req.params.code).update({ value, expires_days: exp, active: !!b.active });
		for (const lang of ITEM_LANGS) if (b.names?.[lang] != null) await database('item_translations').insert({ code: req.params.code, lang, name: String(b.names[lang]).slice(0, 100) }).onConflict(['code', 'lang']).merge(['name']);
		return res.json({ success: true });
	}));

	const chestsOut = async () => {
		const [chests, drops, items, tr] = await Promise.all([
			database('chests').orderBy('tier'), database('chest_drops').orderBy('id'), database('items').select('code', 'value'), database('chest_translations').select('code', 'lang', 'name'),
		]);
		const values = Object.fromEntries(items.map((i: any) => [i.code, Number(i.value)]));
		return chests.map((c: any) => {
			const own = drops.filter((d: any) => d.chest_code === c.code).map((d: any) => ({ id: d.id, item_code: d.item_code, weight: Number(d.weight), guaranteed: d.guaranteed, premium_alt: d.premium_alt }));
			const worth = worthOf(own as Drop[], Number(c.rolls), values);
			return { ...c, drops: own, worth, worth_pct: c.price > 0 ? Math.round((worth / c.price) * 100) : null, names: Object.fromEntries(tr.filter((t: any) => t.code === c.code).map((t: any) => [t.lang, t.name || ''])) };
		});
	};
	router.get('/admin/gems/chests', admin(async (_req, res) => res.json({ success: true, data: await chestsOut() })));

	const saveChest = async (code: string, b: any, create: boolean) => {
		const price = int(b.price, 0, 1_000_000), rolls = int(b.rolls, 1, 20), tier = int(b.tier ?? 1, 0, 20);
		if (price === null || rolls === null || tier === null) return { error: 'price, rolls, tier' };
		const drops: any[] = Array.isArray(b.drops) ? b.drops : [];
		const clean: any[] = [];
		for (const d of drops) {
			const w = int(d.weight, 1, 1_000_000);
			if (w === null || !(await database('items').where('code', d.item_code).first('code'))) return { error: `drop ${d.item_code}: weight or item` };
			if (d.premium_alt && !(await database('items').where('code', d.premium_alt).first('code'))) return { error: `drop ${d.item_code}: unknown premium_alt` };
			clean.push({ chest_code: code, item_code: d.item_code, weight: w, guaranteed: !!d.guaranteed, premium_alt: d.premium_alt || null });
		}
		if (!clean.some((d) => !d.guaranteed)) return { error: 'a chest needs at least one rolled drop' };
		await database.transaction(async (trx: any) => {
			const row = { price, rolls, tier, once: !!b.once, active: b.active !== false };
			if (create) await trx('chests').insert({ code, ...row }); else await trx('chests').where('code', code).update(row);
			await trx('chest_drops').where('chest_code', code).delete();
			if (clean.length) await trx('chest_drops').insert(clean);
			for (const lang of ITEM_LANGS) if (b.names?.[lang] != null) await trx('chest_translations').insert({ code, lang, name: String(b.names[lang]).slice(0, 100) }).onConflict(['code', 'lang']).merge(['name']);
		});
		return {};
	};
	router.put('/admin/gems/chests/:code', admin(async (req, res) => {
		const r: any = await saveChest(String(req.params.code), req.body || {}, false);
		if (r.error) return bad(res, r.error);
		const c = (await chestsOut()).find((x: any) => x.code === req.params.code);
		return res.json({ success: true, data: c, warn: c && c.worth_pct != null && c.worth_pct > 110 ? 'This chest is worth more than 110% of its price' : null });
	}));
	router.post('/admin/gems/chests', admin(async (req, res) => {
		const code = String(req.body?.code || '').toLowerCase();
		if (!/^[a-z0-9_]{2,30}$/.test(code)) return bad(res, 'code: 2-30 letters, digits or _');
		if (await database('chests').where('code', code).first('code')) return bad(res, 'code already used');
		const r: any = await saveChest(code, req.body || {}, true);
		if (r.error) return bad(res, r.error);
		return res.json({ success: true });
	}));

	// ── packs ──────────────────────────────────────────────────────────────────────────────────
	router.get('/admin/gems/packs', admin(async (_req, res) => {
		const rows = await database('xu_packs').orderBy('sort');
		return res.json({ success: true, data: rows.map((p: any) => ({ ...p, total: packCoins(p) })) });
	}));
	router.put('/admin/gems/packs/:code', admin(async (req, res) => {
		const code = String(req.params.code).toLowerCase();
		if (!/^[a-z0-9_]{1,30}$/.test(code)) return bad(res, 'code');
		const b = req.body || {};
		const price = int(b.price_vnd, 1000, 100_000_000), coins = int(b.coins, 1, 10_000_000), bonus = int(b.bonus_pct ?? 0, 0, 500), sort = int(b.sort ?? 0, 0, 1000);
		const first = Number(b.first_mult ?? 1);
		if (price === null || coins === null || bonus === null || sort === null || !(first >= 1 && first <= 5)) return bad(res, 'price_vnd, coins, bonus_pct, first_mult (1-5), sort');
		await database('xu_packs').insert({ code, price_vnd: price, coins, bonus_pct: bonus, first_mult: first, active: b.active !== false, sort }).onConflict('code').merge();
		return res.json({ success: true });
	}));
	router.delete('/admin/gems/packs/:code', admin(async (req, res) => {
		// Orders keep their pack_code: a pack is switched off, never deleted
		await database('xu_packs').where('code', req.params.code).update({ active: false });
		return res.json({ success: true, archived: true });
	}));

	// ── orders ─────────────────────────────────────────────────────────────────────────────────
	router.get('/admin/gems/orders', admin(async (_req, res) => {
		const rows = await database('purchase_histories as p').join('directus_users as u', 'u.id', 'p.user').where('p.product_type', 'coins').orderBy('p.date_created', 'desc').limit(100)
			.select('p.id', 'p.status', 'p.amount', 'p.coins', 'p.pack_code', 'p.transfer_code', 'p.date_created', 'p.date_transfer', 'u.email', 'u.gems_flagged');
		return res.json({ success: true, data: rows });
	}));
	router.post('/admin/gems/orders/:id/chargeback', admin(async (req, res) => {
		try {
			return res.json({ success: true, data: await chargebackCoinOrder(database, String(req.params.id)) });
		} catch (e) {
			if (e instanceof CoinError) return res.status(409).json({ success: false, code: e.code === 'NOT_LOCKED' ? 'NOT_PAID' : e.code });
			throw e;
		}
	}));

	// ── Premium that is still running (T4.6) ──────────────────────────────────────────────────
	router.get('/admin/gems/premium', admin(async (_req, res) => {
		const row = await database('directus_users').where('is_premium', true).whereRaw('is_internal IS NOT TRUE')
			.select(database.raw("count(*) FILTER (WHERE subscription_type = 'lifetime') AS lifetime"),
				database.raw("count(*) FILTER (WHERE coalesce(subscription_type, '') <> 'lifetime' AND premium_until > now()) AS running"),
				database.raw("min(premium_until) FILTER (WHERE coalesce(subscription_type, '') <> 'lifetime' AND premium_until > now()) AS next_end"),
				database.raw("max(premium_until) FILTER (WHERE coalesce(subscription_type, '') <> 'lifetime' AND premium_until > now()) AS last_end")).first();
		return res.json({ success: true, data: { lifetime: Number(row.lifetime), running: Number(row.running), next_end: row.next_end, last_end: row.last_end } });
	}));
}
