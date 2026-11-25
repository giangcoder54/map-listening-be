/**
 * Quotes of the daily review popup, for the team (/admin/library?tab=quotes). Loaded in bulk from the team's
 * quote collection by docs/giao-trinh/tools/quotes_load.py; added, edited, approved and deleted here.
 *
 *   GET /admin/quotes            quotes (status, topic, q, page) + topics for the filter
 *   GET /admin/quotes/:id        one quote with all its translations (for the edit form)
 *   POST /admin/quotes           add a quote (draft unless status given)
 *   PUT /admin/quotes/:id        edit a quote and its translations
 *   DELETE /admin/quotes/:id     delete a quote (nothing keeps history of a quote)
 *   PUT /admin/quotes/:id/status { status } approve / draft / retire (only approved quotes are shown)
 */
import { UUID_RE } from '../lib/lessons';
import { isStaff } from '../lib/staff';

const STATUSES = ['draft', 'approved', 'retired'];
const TR_KEYS = ['meaning', 'author'];

export function registerAdminQuoteRoutes(router: any, context: any) {
	const { database, logger } = context;
	const staff = (handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Admins and editors only' });
		try {
			return await handler(req, res);
		} catch (error: any) {
			if (String(error?.code) === '23505') return res.status(409).json({ success: false, message: 'Câu này đã có trong kho' });
			logger?.error?.(`[admin-quotes] ${req.method} ${req.path} failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};

	router.get('/admin/quotes', staff(async (req: any, res: any) => {
		const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
		const page = Math.max(1, Number(req.query.page) || 1);
		const where: string[] = ['true'];
		const args: any[] = [];
		if (STATUSES.includes(String(req.query.status))) { where.push('q.status = ?'); args.push(req.query.status); }
		const topic = String(req.query.topic || '').trim().slice(0, 60);
		if (topic) { where.push('q.topic = ?'); args.push(topic); }
		const s = String(req.query.q || '').trim().slice(0, 80);
		if (s) { where.push('(q.quote ILIKE ? OR q.meaning ILIKE ? OR q.author ILIKE ?)'); args.push(`%${s}%`, `%${s}%`, `%${s}%`); }
		const total = (await database.raw(`SELECT count(*)::int AS n FROM review_quotes q WHERE ${where.join(' AND ')}`, args)).rows[0].n;
		const items = (await database.raw(
			`SELECT q.id, q.quote, q.meaning, q.author, q.topic, q.status,
				COALESCE((SELECT array_agg(DISTINCT t.lang) FROM review_quote_translations t WHERE t.quote_id = q.id), '{}') AS langs
			 FROM review_quotes q WHERE ${where.join(' AND ')}
			 ORDER BY q.status = 'approved' DESC, q.date_created DESC, q.id LIMIT ? OFFSET ?`,
			[...args, limit, (page - 1) * limit],
		)).rows;
		const topics = (await database.raw(`SELECT topic, count(*)::int AS n FROM review_quotes WHERE topic IS NOT NULL GROUP BY topic ORDER BY topic`)).rows;
		const approved = (await database.raw(`SELECT count(*)::int AS n FROM review_quotes WHERE status = 'approved'`)).rows[0].n;
		return res.json({ success: true, data: { items, total, page, limit, topics, approved } });
	}));

	/** Checks and shapes a quote from the form. Returns { error } or { row, tr }. */
	const readQuote = (body: any): { error: string } | { row: any; tr: Record<string, Record<string, string>> } => {
		const text = (v: any, max: number) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
		const row = { quote: text(body?.quote, 400), meaning: text(body?.meaning, 600) || null, author: text(body?.author, 200) || null, topic: text(body?.topic, 60) || null };
		if (!row.quote) return { error: 'Câu tiếng Anh không được để trống' };
		if (!row.meaning) return { error: 'Nhập nghĩa tiếng Việt' };
		const tr: Record<string, Record<string, string>> = {};
		for (const [lang, t] of Object.entries<any>(body?.tr || {})) {
			if (!/^[a-z]{2}-[A-Z]{2}$/.test(lang) || !t) continue;
			const put: Record<string, string> = {};
			for (const k of TR_KEYS) if (text(t[k], 600)) put[k] = text(t[k], 600);
			if (Object.keys(put).length) tr[lang] = put;
		}
		return { row, tr };
	};

	const saveTranslations = async (trx: any, id: string, tr: Record<string, Record<string, string>>, langs: string[]) => {
		if (langs.length) await trx('review_quote_translations').where({ quote_id: id }).whereIn('lang', langs).del();
		const rows = Object.entries(tr).flatMap(([lang, t]) => Object.entries(t).map(([key, txt]) => ({ quote_id: id, lang, key, text: txt })));
		if (rows.length) await trx('review_quote_translations').insert(rows);
	};

	router.get('/admin/quotes/:id', staff(async (req: any, res: any) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad request' });
		const q = await database('review_quotes').where({ id }).first();
		if (!q) return res.status(404).json({ success: false, message: 'Quote not found' });
		const tr: Record<string, Record<string, string>> = {};
		for (const r of await database('review_quote_translations').where({ quote_id: id })) (tr[r.lang] ||= {})[r.key] = r.text;
		return res.json({ success: true, data: { ...q, tr } });
	}));

	router.post('/admin/quotes', staff(async (req: any, res: any) => {
		const read = readQuote(req.body);
		if ('error' in read) return res.status(400).json({ success: false, message: read.error });
		const status = STATUSES.includes(String(req.body?.status)) ? String(req.body.status) : 'draft';
		const id = await database.transaction(async (trx: any) => {
			const [created] = await trx('review_quotes').insert({ ...read.row, status }).returning('id');
			const qid = created?.id ?? created;
			await saveTranslations(trx, qid, read.tr, []);
			return qid;
		});
		return res.json({ success: true, data: { id } });
	}));

	router.put('/admin/quotes/:id', staff(async (req: any, res: any) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad request' });
		if (!(await database('review_quotes').where({ id }).first())) return res.status(404).json({ success: false, message: 'Quote not found' });
		const read = readQuote(req.body);
		if ('error' in read) return res.status(400).json({ success: false, message: read.error });
		const status = STATUSES.includes(String(req.body?.status)) ? String(req.body.status) : undefined;
		await database.transaction(async (trx: any) => {
			await trx('review_quotes').where({ id }).update({ ...read.row, ...(status ? { status } : {}) });
			// every language the form shows is replaced; one it sends empty is removed
			const shown = Array.isArray(req.body?.tr_langs) ? req.body.tr_langs.map(String).filter((l: string) => /^[a-z]{2}-[A-Z]{2}$/.test(l)) : Object.keys(read.tr);
			await saveTranslations(trx, id, read.tr, shown);
		});
		return res.json({ success: true, data: { id } });
	}));

	router.delete('/admin/quotes/:id', staff(async (req: any, res: any) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad request' });
		const n = await database('review_quotes').where({ id }).del(); // translations go with it (ON DELETE CASCADE)
		if (!n) return res.status(404).json({ success: false, message: 'Quote not found' });
		return res.json({ success: true, data: { id } });
	}));

	router.put('/admin/quotes/:id/status', staff(async (req: any, res: any) => {
		const id = String(req.params.id);
		const status = String(req.body?.status || '');
		if (!UUID_RE.test(id) || !STATUSES.includes(status)) return res.status(400).json({ success: false, message: 'Bad request' });
		const n = await database('review_quotes').where({ id }).update({ status });
		if (!n) return res.status(404).json({ success: false, message: 'Quote not found' });
		return res.json({ success: true, data: { id, status } });
	}));
}
