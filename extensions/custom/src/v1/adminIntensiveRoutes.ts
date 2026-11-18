/**
 * Intensive Listening passages for the team (/admin/library?tab=intensive).
 *
 *   GET    /admin/intensive              passages (status, level, q, page) with how learners did
 *   GET    /admin/intensive/:id          one passage with its sentences, traps, and which labels learners got per sentence
 *   PUT    /admin/intensive/:id/status   { status } publish / hide / back to draft (publishing is checked)
 *   PUT    /admin/intensive/:id/sentences/:sid   { text?, start_ms?, end_ms? } fix one sentence
 *   DELETE /admin/intensive/:id          admins only
 *
 * Passages are written by Claude (docs/giao-trinh/tools/il_write.py) as drafts and reviewed here.
 */
import { tokens } from '../lib/intensive';
import { thumbOf } from '../lib/extensive';
import { UUID_RE } from '../lib/lessons';
import { isStaff } from '../lib/staff';

const STATUSES = ['draft', 'published', 'hidden'];
const KINDS = ['linking', 'confusable', 'imagine'];

export function registerAdminIntensiveRoutes(router: any, context: any) {
	const { database, logger } = context;
	const staff = (handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Admins and editors only' });
		try {
			return await handler(req, res);
		} catch (error: any) {
			logger?.error?.(`[admin-intensive] ${req.method} ${req.path} failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};

	/** What stops a passage being published (empty = fine) */
	const problems = async (l: any, sentences: any[]) => {
		const out: string[] = [];
		const opts = Array.isArray(l.gist_options) ? l.gist_options : [];
		if (opts.length !== 3 || opts.some((o: any) => !String(o || '').trim())) out.push('Câu hỏi nghe ý chính cần đúng 3 đáp án');
		if (!(l.gist_answer >= 0 && l.gist_answer < opts.length)) out.push('Chưa chọn đáp án đúng cho câu hỏi nghe ý chính');
		if (sentences.length < 10 || sentences.length > 16) out.push('Cần 10–16 câu');
		sentences.forEach((s, i) => {
			if (!tokens(s.text).length) out.push(`Câu ${s.n} chưa có chữ`);
			if (s.end_ms - s.start_ms < 600) out.push(`Câu ${s.n} quá ngắn`);
				if (i && s.start_ms < sentences[i - 1].end_ms) out.push(`Câu ${s.n} chồng lên câu ${sentences[i - 1].n}`);
			(s.traps || []).forEach((t: any) => {
				if (!KINDS.includes(t.kind)) out.push(`Câu ${s.n}: loại bẫy "${t.kind}" không hợp lệ`);
				const T = tokens(t.text).join(' ');
				if (!T || !` ${tokens(s.text).join(' ')} `.includes(` ${T} `)) out.push(`Câu ${s.n}: bẫy "${t.text}" không nằm trong câu`);
			});
		});
		return out;
	};

	router.get('/admin/intensive', staff(async (req, res) => {
		const page = Math.max(1, Number(req.query?.page) || 1);
		const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 25));
		const where: string[] = ['true'];
		const params: any[] = [];
		if (STATUSES.includes(String(req.query?.status))) { where.push('l.status = ?'); params.push(String(req.query.status)); }
		const level = Number(req.query?.level) || 0;
		if (level) { where.push('l.level = ?'); params.push(level); }
		if (req.query?.q) { where.push('(l.title ILIKE ? OR sv.title ILIKE ?)'); const q = `%${String(req.query.q).trim()}%`; params.push(q, q); }
		const { rows } = await database.raw(`
			SELECT l.id, l.short_id, l.title, l.level, l.focus, l.status, l.is_premium, l.start_ms, l.end_ms, l.date_updated,
				sv.title AS video_title, sv.channel_name, sv.youtube_video_id, sv.thumbnail_url,
				(SELECT count(*)::int FROM il_sentences s WHERE s.lesson_id = l.id) AS sentences,
				st.plays, st.ratio, count(*) OVER()::int AS full_count
			FROM il_lessons l
			JOIN source_videos sv ON sv.id = l.source_video_id
			LEFT JOIN LATERAL (
				SELECT count(DISTINCT a.id)::int AS plays,
					round(avg(CASE WHEN r.words_total > 0 THEN r.words_right::numeric / r.words_total END) FILTER (WHERE r.round = 1), 2) AS ratio
				FROM il_attempts a LEFT JOIN il_results r ON r.attempt_id = a.id
				WHERE a.lesson_id = l.id AND a.finished_at IS NOT NULL
			) st ON true
			WHERE ${where.join(' AND ')}
			ORDER BY l.level, l.sort, l.date_created
			LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);
		return res.json({ success: true, data: { items: rows.map((r: any) => ({ ...r, thumbnail: thumbOf(r), full_count: undefined })), total: rows[0]?.full_count || 0, page, limit } });
	}));

	router.get('/admin/intensive/:id', staff(async (req, res) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad id' });
		const l = await database('il_lessons as l').join('source_videos as sv', 'sv.id', 'l.source_video_id')
			.select('l.*', 'sv.youtube_video_id', 'sv.title as video_title', 'sv.channel_name').where('l.id', id).first();
		if (!l) return res.status(404).json({ success: false, message: 'Not found' });
		const sentences = await database('il_sentences').where('lesson_id', id).orderBy('n');
		const stats = await database.raw(`
			SELECT r.sentence_id, count(*)::int AS n, round(avg(r.words_right::numeric / NULLIF(r.words_total, 0)), 2) AS ratio
			FROM il_results r JOIN il_attempts a ON a.id = r.attempt_id
			WHERE a.lesson_id = ? AND r.round = 1 GROUP BY 1`, [id]);
		const labels = await database.raw(`
			SELECT r.sentence_id, m->>'label' AS label, count(*)::int AS n
			FROM il_results r JOIN il_attempts a ON a.id = r.attempt_id, jsonb_array_elements(r.labels) m
			WHERE a.lesson_id = ? AND r.round = 1 GROUP BY 1, 2`, [id]);
		return res.json({ success: true, data: {
			...l, problems: await problems(l, sentences),
			sentences: sentences.map((s: any) => ({
				...s,
				plays: stats.rows.find((x: any) => x.sentence_id === s.id)?.n || 0,
				ratio: stats.rows.find((x: any) => x.sentence_id === s.id)?.ratio ?? null,
				labels: Object.fromEntries(labels.rows.filter((x: any) => x.sentence_id === s.id).map((x: any) => [x.label, x.n])),
			})),
		} });
	}));

	router.put('/admin/intensive/:id/status', staff(async (req, res) => {
		const id = String(req.params.id);
		const status = String(req.body?.status || '');
		if (!UUID_RE.test(id) || !STATUSES.includes(status)) return res.status(400).json({ success: false, message: 'Bad request' });
		const l = await database('il_lessons').where('id', id).first();
		if (!l) return res.status(404).json({ success: false, message: 'Not found' });
		if (status === 'published') {
			const list = await problems(l, await database('il_sentences').where('lesson_id', id).orderBy('n'));
			if (list.length) return res.status(422).json({ success: false, message: 'Chưa xuất bản được', problems: list });
		}
		await database('il_lessons').where('id', id).update({ status, date_updated: database.fn.now() });
		return res.json({ success: true, data: { status } });
	}));

	/** Fix one sentence: its text and/or its time range in ms (the team listens with the player and corrects it) */
	router.put('/admin/intensive/:id/sentences/:sid', staff(async (req, res) => {
		const id = String(req.params.id);
		const sid = String(req.params.sid);
		if (!UUID_RE.test(id) || !UUID_RE.test(sid)) return res.status(400).json({ success: false, message: 'Bad id' });
		const body = req.body || {};
		const patch: Record<string, any> = {};
		if (body.text !== undefined) {
			const text = String(body.text).replace(/\s+/g, ' ').trim();
			if (!tokens(text).length) return res.status(422).json({ success: false, message: 'Câu cần có chữ' });
			patch.text = text;
		}
		for (const k of ['start_ms', 'end_ms'] as const) {
			if (body[k] === undefined) continue;
			const v = Math.round(Number(body[k]));
			if (!Number.isFinite(v) || v < 0) return res.status(422).json({ success: false, message: 'Thời gian không hợp lệ' });
			patch[k] = v;
		}
		if (!Object.keys(patch).length) return res.status(400).json({ success: false, message: 'Nothing to change' });
		const s = await database('il_sentences').where({ id: sid, lesson_id: id }).first();
		if (!s) return res.status(404).json({ success: false, message: 'Not found' });
		const start = patch.start_ms ?? s.start_ms;
		const end = patch.end_ms ?? s.end_ms;
		if (end - start < 600) return res.status(422).json({ success: false, message: 'Câu quá ngắn (tối thiểu 0,6 giây)' });
		await database('il_sentences').where('id', sid).update(patch);
		await database('il_lessons').where('id', id).update({ date_updated: database.fn.now() });
		return res.json({ success: true, data: await database('il_sentences').where('id', sid).first() });
	}));

	router.delete('/admin/intensive/:id', staff(async (req, res) => {
		if (!req.accountability?.admin) return res.status(403).json({ success: false, message: 'Admins only' });
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad id' });
		await database('il_lessons').where('id', id).delete();
		return res.json({ success: true, data: null });
	}));
}
