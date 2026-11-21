/**
 * "Bạn có biết?" cards for the team (/admin/library?tab=dyk). Cards are written by Claude
 * (docs/giao-trinh/tools/dyk_write.py) as drafts; the team listens to the clip, then approves.
 *
 *   GET /admin/dyk/cards          cards (status, kind, q, page) with how often each was shown and what visitors did
 *   GET /admin/dyk/cards/:id      one card with all its translations (for the edit form)
 *   POST /admin/dyk/cards         add a card (draft unless status given); same checks as dyk_write.py
 *   PUT /admin/dyk/cards/:id      edit a card and its translations
 *   DELETE /admin/dyk/cards/:id   delete a card never shown; a shown one must be retired instead
 *   PUT /admin/dyk/cards/:id/status   { status } approve / draft / retire (only approved cards are picked for a day)
 *
 * Visitor numbers are people (not events) from learning_events, event 'dyk', path = card id.
 */
import { UUID_RE } from '../lib/lessons';
import { isStaff } from '../lib/staff';
import { vnDay } from '../lib/xp';

const STATUSES = ['draft', 'approved', 'retired'];
const KINDS = ['il', 'el', 'cs'];

export function registerAdminDykRoutes(router: any, context: any) {
	const { database, logger } = context;
	const staff = (handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Admins and editors only' });
		try {
			return await handler(req, res);
		} catch (error: any) {
			logger?.error?.(`[admin-dyk] ${req.method} ${req.path} failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};

	router.get('/admin/dyk/cards', staff(async (req: any, res: any) => {
		const today = vnDay();
		const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
		const page = Math.max(1, Number(req.query.page) || 1);
		const where: string[] = ['true'];
		const args: any[] = [];
		if (STATUSES.includes(String(req.query.status))) { where.push('c.status = ?'); args.push(req.query.status); }
		if (KINDS.includes(String(req.query.kind))) { where.push('c.kind = ?'); args.push(req.query.kind); }
		const q = String(req.query.q || '').trim().slice(0, 80);
		if (q) { where.push('(c.hook ILIKE ? OR c.lesson_key ILIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
		const total = (await database.raw(`SELECT count(*)::int AS n FROM dyk_cards c WHERE ${where.join(' AND ')}`, args)).rows[0].n;
		const rows = (await database.raw(
			`SELECT c.id, c.kind, c.lesson_key, c.youtube_video_id, c.clip_start::float AS clip_start, c.clip_end::float AS clip_end,
				c.hook, c.question, c.options, c.correct, c.answer, c.line, c.tease, c.status, c.topic,
				CASE c.kind
					WHEN 'el' THEN (SELECT l.title FROM el_lessons l WHERE l.short_id = c.lesson_key)
					WHEN 'il' THEN (SELECT l.title FROM il_lessons l WHERE l.short_id = c.lesson_key)
					ELSE (SELECT s.name FROM listening_skills s WHERE s.slug = c.lesson_key) END AS lesson_title,
				(c.kind = 'cs'
					OR (c.kind = 'el' AND EXISTS (SELECT 1 FROM el_lessons l WHERE l.short_id = c.lesson_key AND l.status = 'published' AND NOT l.is_premium))
					OR (c.kind = 'il' AND EXISTS (SELECT 1 FROM il_lessons l WHERE l.short_id = c.lesson_key AND l.status = 'published' AND NOT l.is_premium))) AS lesson_ok,
				(SELECT count(*)::int FROM dyk_schedule s WHERE s.card_id = c.id AND s.day <= ?::date) AS shown,
				(SELECT max(s.day)::text FROM dyk_schedule s WHERE s.card_id = c.id) AS last_day,
				COALESCE((SELECT array_agg(DISTINCT t.lang) FROM dyk_translations t WHERE t.card_id = c.id), '{}') AS langs,
				(SELECT count(DISTINCT e.actor_key)::int FROM learning_events e WHERE e.event = 'dyk' AND e.step = 'view' AND e.path = c.id::text) AS views,
				(SELECT count(DISTINCT e.actor_key)::int FROM learning_events e WHERE e.event = 'dyk' AND e.step = 'play' AND e.path = c.id::text) AS plays,
				(SELECT count(DISTINCT e.actor_key)::int FROM learning_events e WHERE e.event = 'dyk' AND e.step = 'answer' AND e.path = c.id::text) AS answers,
				(SELECT count(DISTINCT e.actor_key)::int FROM learning_events e WHERE e.event = 'dyk' AND e.step = 'right' AND e.path = c.id::text) AS rights,
				(SELECT count(DISTINCT e.actor_key)::int FROM learning_events e WHERE e.event = 'dyk' AND e.step = 'cta_lesson' AND e.path = c.id::text) AS clicks
			 FROM dyk_cards c WHERE ${where.join(' AND ')}
			 ORDER BY c.status = 'approved' DESC, c.date_created DESC, c.id
			 LIMIT ? OFFSET ?`,
			[today, ...args, limit, (page - 1) * limit],
		)).rows;
		const todayCard = await database('dyk_schedule').select('card_id').where('day', today).first();
		const free = (await database.raw(`SELECT count(*)::int AS n FROM dyk_cards c WHERE c.status = 'approved' AND c.id NOT IN (SELECT card_id FROM dyk_schedule WHERE day >= ?::date - 60)`, [today])).rows[0].n;
		return res.json({ success: true, data: { items: rows, total, page, limit, today_id: todayCard?.card_id || null, ready: free } });
	}));

	/** Checks and shapes a card from the form. Returns { error } or { row, tr }. Same rules as tools/dyk_write.py. */
	const readCard = async (body: any): Promise<{ error: string } | { row: any; tr: Record<string, Record<string, string>> }> => {
		const text = (v: any, max: number) => String(v ?? '').trim().slice(0, max);
		const kind = String(body?.kind || '');
		const lessonKey = text(body?.lesson_key, 80);
		const start = Number(body?.clip_start);
		const end = Number(body?.clip_end);
		const options = Array.isArray(body?.options) ? body.options.map((o: any) => text(o, 200)) : [];
		const correct = Number(body?.correct);
		const row: any = {
			kind, lesson_key: lessonKey, clip_start: start, clip_end: end, options, correct,
			hook: text(body?.hook, 140), question: text(body?.question, 300), answer: text(body?.answer, 600),
			line: text(body?.line, 400) || null, tease: text(body?.tease, 300) || null, topic: text(body?.topic, 60) || null,
			youtube_video_id: text(body?.youtube_video_id, 20),
		};
		if (!KINDS.includes(kind) || !lessonKey) return { error: 'Chọn loại bài và nhập mã bài' };
		if (!row.hook || !row.question || !row.answer) return { error: 'Hook, câu hỏi và đáp án không được để trống' };
		if (options.length !== 3 || options.some((o: string) => !o)) return { error: 'Cần đúng 3 lựa chọn, không để trống' };
		if (![0, 1, 2].includes(correct)) return { error: 'Chọn lựa chọn đúng' };
		if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 5 || end - start > 15) return { error: 'Clip phải dài 5–15 giây' };
		if (kind === 'cs') {
			if (!(await database('listening_skills').where({ slug: lessonKey }).first())) return { error: `Không có kỹ năng “${lessonKey}”` };
			if (!row.youtube_video_id) return { error: 'Nhập mã video YouTube' };
		} else {
			const table = kind === 'il' ? 'il_lessons' : 'el_lessons';
			const lesson = await database(`${table} as l`).join('source_videos as sv', 'sv.id', 'l.source_video_id')
				.select('l.start_ms', 'l.end_ms', 'sv.youtube_video_id').where('l.short_id', lessonKey).first();
			if (!lesson) return { error: `Không có bài “${lessonKey}”` };
			if (start < lesson.start_ms / 1000 || end > lesson.end_ms / 1000) return { error: `Clip nằm ngoài đoạn của bài (${lesson.start_ms / 1000}–${lesson.end_ms / 1000}s)` };
			row.youtube_video_id = lesson.youtube_video_id; // the lesson's own video, never typed by hand
		}
		// Other languages: option i is the translation of the option shown at place i
		const tr: Record<string, Record<string, string>> = {};
		for (const [lang, t] of Object.entries<any>(body?.tr || {})) {
			if (!/^[a-z]{2}-[A-Z]{2}$/.test(lang) || !t) continue;
			const put: Record<string, string> = {};
			for (const k of ['hook', 'question', 'answer', 'tease']) if (text(t[k], 600)) put[k] = text(t[k], 600);
			[0, 1, 2].forEach((i) => { if (text(t.options?.[i], 200)) put[`option${i}`] = text(t.options[i], 200); });
			if (Object.keys(put).length) tr[lang] = put;
		}
		return { row, tr };
	};

	const saveTranslations = async (trx: any, id: string, tr: Record<string, Record<string, string>>, langs: string[]) => {
		if (langs.length) await trx('dyk_translations').where({ card_id: id }).whereIn('lang', langs).del();
		const rows = Object.entries(tr).flatMap(([lang, t]) => Object.entries(t).map(([key, txt]) => ({ card_id: id, lang, key, text: txt })));
		if (rows.length) await trx('dyk_translations').insert(rows);
	};

	router.get('/admin/dyk/cards/:id', staff(async (req: any, res: any) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad request' });
		const card = await database('dyk_cards').where({ id }).first();
		if (!card) return res.status(404).json({ success: false, message: 'Card not found' });
		const tr: Record<string, any> = {};
		for (const r of await database('dyk_translations').where({ card_id: id })) {
			const t = (tr[r.lang] ||= { options: ['', '', ''] });
			const m = /^option([012])$/.exec(r.key);
			if (m) t.options[Number(m[1])] = r.text; else t[r.key] = r.text;
		}
		return res.json({ success: true, data: { ...card, clip_start: Number(card.clip_start), clip_end: Number(card.clip_end), tr } });
	}));

	router.post('/admin/dyk/cards', staff(async (req: any, res: any) => {
		const read = await readCard(req.body);
		if ('error' in read) return res.status(400).json({ success: false, message: read.error });
		const status = STATUSES.includes(String(req.body?.status)) ? String(req.body.status) : 'draft';
		const id = await database.transaction(async (trx: any) => {
			const [created] = await trx('dyk_cards').insert({ ...read.row, status }).returning('id');
			const cid = created?.id ?? created;
			await saveTranslations(trx, cid, read.tr, []);
			return cid;
		});
		return res.json({ success: true, data: { id } });
	}));

	router.put('/admin/dyk/cards/:id', staff(async (req: any, res: any) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad request' });
		if (!(await database('dyk_cards').where({ id }).first())) return res.status(404).json({ success: false, message: 'Card not found' });
		const read = await readCard(req.body);
		if ('error' in read) return res.status(400).json({ success: false, message: read.error });
		const status = STATUSES.includes(String(req.body?.status)) ? String(req.body.status) : undefined;
		await database.transaction(async (trx: any) => {
			await trx('dyk_cards').where({ id }).update({ ...read.row, ...(status ? { status } : {}) });
			// every language the form shows is replaced; one it sends empty is removed
			const shown = Array.isArray(req.body?.tr_langs) ? req.body.tr_langs.map(String).filter((l: string) => /^[a-z]{2}-[A-Z]{2}$/.test(l)) : Object.keys(read.tr);
			await saveTranslations(trx, id, read.tr, shown);
		});
		return res.json({ success: true, data: { id } });
	}));

	router.delete('/admin/dyk/cards/:id', staff(async (req: any, res: any) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad request' });
		// A card already shown to visitors keeps its history: retire it instead of deleting
		const shown = await database('dyk_schedule').where({ card_id: id }).andWhere('day', '<=', vnDay()).first();
		if (shown) return res.status(409).json({ success: false, message: 'Thẻ đã từng lên landing. Chuyển sang “Ngừng dùng” thay vì xoá.' });
		await database.transaction(async (trx: any) => {
			await trx('dyk_schedule').where({ card_id: id }).del(); // future days only: the pick is redone
			await trx('dyk_cards').where({ id }).del(); // translations go with it (ON DELETE CASCADE)
		});
		return res.json({ success: true, data: { id } });
	}));

	router.put('/admin/dyk/cards/:id/status', staff(async (req: any, res: any) => {
		const id = String(req.params.id);
		const status = String(req.body?.status || '');
		if (!UUID_RE.test(id) || !STATUSES.includes(status)) return res.status(400).json({ success: false, message: 'Bad request' });
		const n = await database('dyk_cards').where({ id }).update({ status });
		if (!n) return res.status(404).json({ success: false, message: 'Card not found' });
		return res.json({ success: true, data: { id, status } });
	}));
}
