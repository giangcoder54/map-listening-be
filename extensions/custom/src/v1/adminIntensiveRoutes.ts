/**
 * Intensive Listening passages for the team (/admin/library?tab=intensive).
 *
 *   GET    /admin/intensive              passages (status, level, q, page) with how learners did
 *   GET    /admin/intensive/:id          one passage with its sentences, traps, and which labels learners got per sentence
 *   PUT    /admin/intensive/:id/status   { status } publish / hide / back to draft (publishing is checked)
 *   PUT    /admin/intensive/:id/level    { level } 1 Dễ, 2 Vừa, 3 Khó
 *   GET    /admin/intensive/:id/stats        finishing, where learners stop, the ladder, practice, feedback, thumbs on diagnoses, key words missed again
 *   PUT    /admin/intensive/:id/gist         { prompt, options[3], answer, explain?, sentences[] } the gist question and the sentences (n) that hold its answer
 *   PUT    /admin/intensive/:id/sentences/:sid   { text?, start_ms?, end_ms?, traps?, key_words? } fix one sentence (traps = the words to watch: [{ text, kind, real?, note?, skill? }])
 *   PUT    /admin/intensive/:id/info     { title, intro?, explore?, focus?, topic?, note?, is_premium? (admins) } the passage's own text
 *   POST   /admin/intensive/:id/sentences    { after, text, start_ms, end_ms, part? } a sentence after sentence `after` (0 = first)
 *   GET    /admin/intensive/:id/translations?lang=   every learner text of the passage with its base text and `lang`'s
 *   PUT    /admin/intensive/:id/translations  { lang, items: { key: text } } empty text = back to the base
 *   DELETE /admin/intensive/:id          admins only; a passage learners have done is hidden instead
 *   GET    /admin/intensive/chunks       the shared chunks (il_chunks: "sort of" → "sorta"), traps in every passage
 *   POST   /admin/intensive/chunks       { text, kind?, real?, note?, skill?, active? } add one
 *   PUT    /admin/intensive/chunks/:id   same fields, any of them
 *   DELETE /admin/intensive/chunks/:id   remove one
 *
 * Passages are written by Claude (docs/giao-trinh/tools/il_write.py) as drafts and reviewed here.
 */
import { tokens } from '../lib/intensive';
import { IL_PART, sameAs, sentencesOf, withParts } from '../lib/ilParts';
import { thumbOf } from '../lib/extensive';
import { UUID_RE } from '../lib/lessons';
import { isStaff } from '../lib/staff';
import { otherLangs, readTr, writeTr, type TrRow } from '../lib/adminTr';

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
		// The gist question is optional (a music video has nothing to ask)
		const hasGist = !!String(l.gist_prompt || '').trim() || opts.length > 0;
		if (hasGist && (opts.length !== 3 || opts.some((o: any) => !String(o || '').trim()))) out.push('Câu hỏi nghe ý chính cần đúng 3 đáp án');
		if (hasGist && !(l.gist_answer >= 0 && l.gist_answer < opts.length)) out.push('Chưa chọn đáp án đúng cho câu hỏi nghe ý chính');
		const parts = [...new Set(sentences.map((s) => Number(s.part)))];
		if (parts.length <= 1) {
			if (sentences.length < 10 || sentences.length > 16) out.push('Cần 10–16 câu (bài dài hơn thì chia chặng)');
		} else {
			if (parts.some((p, i) => p !== i + 1)) out.push('Số chặng phải đi từ 1, liền nhau theo thứ tự câu');
			const same = sameAs(sentences);
			for (const p of parts) {
				const asked = sentences.filter((s, i) => Number(s.part) === p && same[i] === null).length;
				if (asked > IL_PART.max) out.push(`Chặng ${p} có ${asked} câu phải gõ (tối đa ${IL_PART.max})`);
			}
		}
		sentences.forEach((s, i) => {
			if (!tokens(s.text).length) out.push(`Câu ${s.n} chưa có chữ`);
			if (s.end_ms - s.start_ms < 600) out.push(`Câu ${s.n} quá ngắn`);
			if (tokens(s.text).length > 18) out.push(`Câu ${s.n} dài ${tokens(s.text).length} từ (tối đa 18): tách thành hai câu`);
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
			ORDER BY ${req.query?.sort === 'level' ? 'l.level, l.sort, l.date_created' : 'l.date_created DESC, l.title'}
			LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);
		return res.json({ success: true, data: { items: rows.map((r: any) => ({ ...r, thumbnail: thumbOf(r), full_count: undefined })), total: rows[0]?.full_count || 0, page, limit } });
	}));

	// ── Shared chunks. Registered before /:id so "chunks" is not read as a passage id ──
	const chunkFields = (body: any, partial: boolean) => {
		const out: Record<string, any> = {};
		if (!partial || body.text !== undefined) {
			const text = tokens(String(body.text || '')).join(' ');
			if (!text) return { error: 'Cụm từ cần có chữ' };
			if (text.split(' ').length > 5) return { error: 'Cụm dài tối đa 5 từ' };
			out.text = text;
		}
		if (body.kind !== undefined) {
			if (!KINDS.includes(String(body.kind))) return { error: 'Loại không hợp lệ' };
			out.kind = String(body.kind);
		}
		for (const k of ['real', 'note'] as const) if (body[k] !== undefined) out[k] = String(body[k] || '').trim().slice(0, 300) || null;
		if (body.skill !== undefined) out.skill = String(body.skill || '').trim().slice(0, 80) || null;
		if (body.active !== undefined) out.active = !!body.active;
		return { out };
	};
	/** What learners reported (il_issues), newest first; PUT marks one as done / new again */
	router.get('/admin/intensive/issues', staff(async (req, res) => {
		const status = req.query?.status === 'done' ? 'done' : 'new';
		const items = await database('il_issues as i').join('il_lessons as l', 'l.id', 'i.lesson_id')
			.leftJoin('il_sentences as s', function (this: any) { this.on('s.lesson_id', 'i.lesson_id').andOn('s.n', 'i.sentence_n'); })
			.leftJoin('directus_users as u', 'u.id', 'i.user_id')
			.select('i.id', 'i.issue', 'i.comment', 'i.typed', 'i.status', 'i.sentence_n', 'i.date_created', 'l.id as lesson_id', 'l.title', 's.text as sentence', 'u.email')
			.where('i.status', status).orderBy('i.date_created', 'desc').limit(200);
		return res.json({ success: true, data: { items } });
	}));
	router.put('/admin/intensive/issues/:id', staff(async (req, res) => {
		if (!UUID_RE.test(String(req.params.id))) return res.status(404).json({ success: false, message: 'Not found' });
		const status = req.body?.status === 'done' ? 'done' : 'new';
		await database('il_issues').where({ id: req.params.id }).update({ status });
		return res.json({ success: true });
	}));
	router.get('/admin/intensive/chunks', staff(async (_req, res) => {
		const items = await database('il_chunks').orderBy('text');
		const skills = await database('listening_skills').select('slug', 'name').where('status', 'published').orderBy('name');
		return res.json({ success: true, data: { items, skills } });
	}));
	router.post('/admin/intensive/chunks', staff(async (req, res) => {
		const { out, error } = chunkFields(req.body || {}, false);
		if (error || !out) return res.status(422).json({ success: false, message: error });
		if (await database('il_chunks').whereRaw('lower(text) = ?', [out.text]).first()) return res.status(409).json({ success: false, message: 'Cụm này đã có' });
		const [row] = await database('il_chunks').insert(out).returning('*');
		return res.json({ success: true, data: row });
	}));
	router.put('/admin/intensive/chunks/:id', staff(async (req, res) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad id' });
		const { out, error } = chunkFields(req.body || {}, true);
		if (error || !out) return res.status(422).json({ success: false, message: error });
		if (!Object.keys(out).length) return res.status(400).json({ success: false, message: 'Nothing to change' });
		if (out.text && await database('il_chunks').whereRaw('lower(text) = ?', [out.text]).whereNot('id', id).first()) return res.status(409).json({ success: false, message: 'Cụm này đã có' });
		const n = await database('il_chunks').where('id', id).update({ ...out, date_updated: database.fn.now() });
		if (!n) return res.status(404).json({ success: false, message: 'Not found' });
		return res.json({ success: true, data: await database('il_chunks').where('id', id).first() });
	}));
	router.delete('/admin/intensive/chunks/:id', staff(async (req, res) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad id' });
		await database('il_chunks').where('id', id).delete();
		return res.json({ success: true, data: null });
	}));

	/** A draft passage from a whole video of the library: its transcript cut into sentences and parts. { video: link or YouTube id } */
	router.post('/admin/intensive/from-video', staff(async (req, res) => {
		const input = String(req.body?.video || '').trim();
		const yt = /^[\w-]{11}$/.test(input) ? input : input.match(/(?:v=|youtu\.be\/|\/(?:shorts|embed|live)\/)([\w-]{11})/)?.[1];
		if (!yt) return res.status(422).json({ success: false, message: 'Link YouTube không đúng' });
		const v = await database('source_videos').select('id', 'title', 'transcript').where('youtube_video_id', yt).first();
		if (!v) return res.status(404).json({ success: false, message: 'Video chưa có trong thư viện' });
		const cut = withParts(sentencesOf(Array.isArray(v.transcript) ? v.transcript : []));
		if (cut.length < 10) return res.status(422).json({ success: false, message: 'Video cần ít nhất 10 câu có phụ đề' });
		if (cut.length > 300) return res.status(422).json({ success: false, message: 'Video quá dài (tối đa 300 câu)' });
		const id = await database.transaction(async (trx: any) => {
			const [row] = await trx('il_lessons').insert({
				source_video_id: v.id, title: String(v.title || yt).slice(0, 200), level: 2, focus: 'mixed', status: 'draft',
				start_ms: cut[0]!.start_ms, end_ms: cut[cut.length - 1]!.end_ms, gist_prompt: '', gist_options: '[]', gist_answer: 0,
			}).returning('id');
			await trx('il_sentences').insert(cut.map((s, i) => ({ lesson_id: row.id, n: i + 1, ...s })));
			return row.id as string;
		});
		return res.json({ success: true, data: { id } });
	}));

	/** Take a sentence out of a passage that is not published and has no learner data yet; the rest are renumbered */
	router.delete('/admin/intensive/:id/sentences/:sid', staff(async (req, res) => {
		const id = String(req.params.id);
		const sid = String(req.params.sid);
		if (!UUID_RE.test(id) || !UUID_RE.test(sid)) return res.status(400).json({ success: false, message: 'Bad id' });
		const l = await database('il_lessons').where('id', id).first('status');
		const s = await database('il_sentences').where({ id: sid, lesson_id: id }).first('n');
		if (!l || !s) return res.status(404).json({ success: false, message: 'Not found' });
		if (await renumberBlocked(id, l.status)) return res.status(409).json({ success: false, message: 'Chỉ xóa được câu khi bài chưa xuất bản và chưa có lượt học, từ vựng hay bản dịch' });
		await database.transaction(async (trx: any) => {
			await trx('il_sentences').where('id', sid).delete();
			for (const r of await trx('il_sentences').where('lesson_id', id).where('n', '>', s.n).orderBy('n').select('id', 'n')) await trx('il_sentences').where('id', r.id).update({ n: r.n - 1 });
			await trx.raw('UPDATE il_lessons SET gist_sentences = ARRAY(SELECT CASE WHEN x > ? THEN x - 1 ELSE x END FROM unnest(gist_sentences) x WHERE x <> ?)::smallint[], date_updated = now() WHERE id = ?', [s.n, s.n, id]);
		});
		return res.json({ success: true, data: null });
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

	/** How learners get on with one passage: finishing, where they stop, the ladder, the feedback card, the thumbs on
	 *  diagnoses, and whether the same key words are missed again on a later go (the real test that the flow works). */
	router.get('/admin/intensive/:id/stats', staff(async (req, res) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad id' });
		const one = async (sql: string, args: any[] = [id]) => (await database.raw(sql, args)).rows;
		const [att] = await one(`SELECT count(*)::int AS starts, count(finished_at)::int AS finished,
			round(avg(extract(epoch FROM finished_at - date_created) / 60) FILTER (WHERE finished_at IS NOT NULL)::numeric, 1) AS minutes
			FROM il_attempts WHERE lesson_id = ?`);
		const stopped = await one(`SELECT coalesce(m.n, 0)::int AS n, count(*)::int AS c FROM il_attempts a
			LEFT JOIN LATERAL (SELECT max(s.n) AS n FROM il_results r JOIN il_sentences s ON s.id = r.sentence_id WHERE r.attempt_id = a.id) m ON true
			WHERE a.lesson_id = ? AND a.finished_at IS NULL GROUP BY 1 ORDER BY 1`);
		const ladder = await one(`SELECT r.ladder->>'outcome' AS outcome, count(*)::int AS c FROM il_results r JOIN il_attempts a ON a.id = r.attempt_id
			WHERE a.lesson_id = ? AND r.ladder IS NOT NULL GROUP BY 1`);
		const [fb] = await one(`SELECT count(*)::int AS n, round(avg(rating)::numeric, 2) AS avg FROM il_feedback WHERE lesson_id = ?`);
		const tags = await one(`SELECT t AS tag, count(*)::int AS c FROM il_feedback, unnest(tags) t WHERE lesson_id = ? GROUP BY 1 ORDER BY 2 DESC`);
		const comments = await one(`SELECT rating, tags, comment, locale, date_created FROM il_feedback WHERE lesson_id = ? ORDER BY date_created DESC LIMIT 30`);
		const votes = await one(`SELECT sentence_n AS n, word, outcome, count(*) FILTER (WHERE vote = 1)::int AS up, count(*) FILTER (WHERE vote = -1)::int AS down
			FROM il_diag_votes WHERE lesson_id = ? GROUP BY 1, 2, 3 ORDER BY down DESC, up DESC, 1`);
		// Learners with two or more finished goes: key words missed on their first go against their latest go
		const [again] = await one(`WITH att AS (
				SELECT id, user_id, row_number() OVER (PARTITION BY user_id ORDER BY seq) AS first_go, row_number() OVER (PARTITION BY user_id ORDER BY seq DESC) AS last_go, count(*) OVER (PARTITION BY user_id) AS goes
				FROM il_attempts WHERE lesson_id = ? AND finished_at IS NOT NULL AND user_id IS NOT NULL),
			miss AS (
				SELECT a.user_id, a.first_go, a.last_go FROM att a JOIN il_results r ON r.attempt_id = a.id AND r.round = 1 JOIN il_sentences s ON s.id = r.sentence_id, jsonb_array_elements(r.labels) m
				WHERE a.goes >= 2 AND (a.first_go = 1 OR a.last_go = 1) AND replace(lower(m->>'word'), chr(39), '') = ANY(s.key_words))
			SELECT (SELECT count(DISTINCT user_id) FROM att WHERE goes >= 2)::int AS users,
				count(*) FILTER (WHERE first_go = 1)::int AS first_missed, count(*) FILTER (WHERE last_go = 1)::int AS last_missed FROM miss`);
		return res.json({ success: true, data: { attempts: att, stopped, ladder, feedback: { ...fb, tags, comments }, votes, again } });
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

	/** How hard the passage is (1-3): first set by whoever wrote it, the team can change it */
	router.put('/admin/intensive/:id/level', staff(async (req, res) => {
		const id = String(req.params.id);
		const level = Number(req.body?.level);
		if (!UUID_RE.test(id) || ![1, 2, 3].includes(level)) return res.status(400).json({ success: false, message: 'Bad request' });
		const n = await database('il_lessons').where('id', id).update({ level, date_updated: database.fn.now() });
		if (!n) return res.status(404).json({ success: false, message: 'Not found' });
		return res.json({ success: true, data: { level } });
	}));

	/** The gist question (base text) and the sentences that hold its answer */
	router.put('/admin/intensive/:id/gist', staff(async (req, res) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad id' });
		const l = await database('il_lessons').where('id', id).first();
		if (!l) return res.status(404).json({ success: false, message: 'Not found' });
		const b = req.body || {};
		const prompt = String(b.prompt || '').trim();
		const options = Array.isArray(b.options) ? b.options.map((o: any) => String(o || '').trim()) : [];
		const answer = Number(b.answer);
		if (!prompt) return res.status(422).json({ success: false, message: 'Cần câu hỏi' });
		if (options.length !== 3 || options.some((o: string) => !o)) return res.status(422).json({ success: false, message: 'Cần đúng 3 đáp án' });
		if (!Number.isInteger(answer) || answer < 0 || answer > 2) return res.status(422).json({ success: false, message: 'Chọn đáp án đúng' });
		const ns = new Set((await database('il_sentences').where('lesson_id', id).pluck('n')).map(Number));
		const lines = [...new Set((Array.isArray(b.sentences) ? b.sentences : []).map(Number))].filter((n) => ns.has(n)).sort((x, y) => x - y);
		await database('il_lessons').where('id', id).update({
			gist_prompt: prompt.slice(0, 400), gist_options: JSON.stringify(options.map((o: string) => o.slice(0, 300))), gist_answer: answer,
			gist_explain: String(b.explain || '').trim().slice(0, 600) || null, gist_sentences: lines, date_updated: database.fn.now(),
		});
		return res.json({ success: true });
	}));

	/** Fix one sentence: its text and/or its time range in ms (the team listens with the player and corrects it) */
	/** Sentences are numbered (n) and translations, vocabulary and attempts point at those numbers: they move only while nothing does */
	const renumberBlocked = async (id: string, status: string) => status === 'published'
		|| !!(await database('il_attempts').where('lesson_id', id).first('id'))
		|| !!(await database('il_vocab').where('lesson_id', id).first('id'))
		|| !!(await database('il_translations').where('lesson_id', id).where('key', 'like', 's%').first('key'));

	router.put('/admin/intensive/:id/info', staff(async (req, res) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad id' });
		const l = await database('il_lessons').where('id', id).first();
		if (!l) return res.status(404).json({ success: false, message: 'Not found' });
		const b = req.body || {};
		const title = String(b.title ?? l.title).replace(/\s+/g, ' ').trim();
		if (!title) return res.status(422).json({ success: false, message: 'Cần tên bài' });
		const focus = b.focus === undefined ? l.focus : b.focus || null;
		if (focus && !['linking', 'confusable', 'imagine', 'speed', 'mixed'].includes(focus)) return res.status(422).json({ success: false, message: 'Kiểu luyện không hợp lệ' });
		if (b.is_premium !== undefined && !!b.is_premium !== !!l.is_premium && !req.accountability?.admin) return res.status(403).json({ success: false, message: 'Chỉ admin đổi được Premium' });
		const text = (v: any, old: any, n: number) => (v === undefined ? old : String(v || '').trim().slice(0, n) || null);
		await database('il_lessons').where('id', id).update({
			title: title.slice(0, 200), intro: text(b.intro, l.intro, 1000), explore: text(b.explore, l.explore, 6000), focus,
			topic: text(b.topic, l.topic, 60), note: text(b.note, l.note, 1000), is_premium: b.is_premium === undefined ? l.is_premium : !!b.is_premium,
			date_updated: database.fn.now(),
		});
		return res.json({ success: true });
	}));

	router.post('/admin/intensive/:id/sentences', staff(async (req, res) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad id' });
		const l = await database('il_lessons').where('id', id).first('status');
		if (!l) return res.status(404).json({ success: false, message: 'Not found' });
		if (await renumberBlocked(id, l.status)) return res.status(409).json({ success: false, message: 'Chỉ thêm được câu khi bài chưa xuất bản và chưa có lượt học, từ vựng hay bản dịch' });
		const b = req.body || {};
		const text = String(b.text || '').replace(/\s+/g, ' ').trim();
		const start = Math.round(Number(b.start_ms));
		const end = Math.round(Number(b.end_ms));
		if (!tokens(text).length) return res.status(422).json({ success: false, message: 'Câu cần có chữ' });
		if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < 600) return res.status(422).json({ success: false, message: 'Câu dài tối thiểu 0,6 giây' });
		const after = Math.max(0, Math.floor(Number(b.after) || 0));
		const prev = after ? await database('il_sentences').where({ lesson_id: id, n: after }).first('part') : null;
		const part = Number.isInteger(Number(b.part)) && Number(b.part) >= 1 ? Number(b.part) : prev?.part || 1;
		await database.transaction(async (trx: any) => {
			// From the end, so no two rows share a number on the way
			for (const r of await trx('il_sentences').where('lesson_id', id).where('n', '>', after).orderBy('n', 'desc').select('id', 'n')) await trx('il_sentences').where('id', r.id).update({ n: r.n + 1 });
			await trx('il_sentences').insert({ lesson_id: id, n: after + 1, text, start_ms: start, end_ms: end, part, traps: '[]', key_words: [] });
			await trx.raw('UPDATE il_lessons SET gist_sentences = ARRAY(SELECT CASE WHEN x > ? THEN x + 1 ELSE x END FROM unnest(gist_sentences) x)::smallint[], date_updated = now() WHERE id = ?', [after, id]);
		});
		return res.json({ success: true, data: null });
	}));

	/** Every learner text of a passage (keys as intensiveRoutes reads them), its base text beside it; vocabulary is in its own block */
	const trRows = async (id: string) => {
		const l = await database('il_lessons').where('id', id).first();
		if (!l) return null;
		const rows: TrRow[] = [
			{ key: 'title', label: 'Tên bài', base: l.title || '' },
			{ key: 'intro', label: 'Giới thiệu', base: l.intro || '' },
			{ key: 'explore', label: 'Tìm hiểu thêm', base: l.explore || '' },
			{ key: 'gist_prompt', label: 'Câu hỏi ý chính', base: l.gist_prompt || '' },
			...(Array.isArray(l.gist_options) ? l.gist_options : []).map((o: string, i: number) => ({ key: `gist_o${i}`, label: `Ý chính · đáp án ${i + 1}`, base: o || '' })),
			{ key: 'gist_explain', label: 'Ý chính · giải thích', base: l.gist_explain || '' },
		];
		for (const s of await database('il_sentences').where('lesson_id', id).orderBy('n')) {
			rows.push({ key: `s${s.n}:sub`, label: `Câu ${s.n} · phụ đề`, base: s.sub || '' });
			(Array.isArray(s.traps) ? s.traps : []).forEach((t: any, j: number) => {
				if (t.note) rows.push({ key: `s${s.n}:t${j}:note`, label: `Câu ${s.n} · bẫy “${t.text}” · giải thích`, base: t.note });
				if (t.real) rows.push({ key: `s${s.n}:t${j}:real`, label: `Câu ${s.n} · bẫy “${t.text}” · nghe như`, base: t.real });
			});
		}
		return rows.filter((r) => r.base.trim());
	};
	router.get('/admin/intensive/:id/translations', staff(async (req, res) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad id' });
		const langs = await otherLangs(database, 'vi-VN');
		const lang = langs.includes(String(req.query?.lang)) ? String(req.query.lang) : langs[0];
		const rows = await trRows(id);
		if (!rows) return res.status(404).json({ success: false, message: 'Not found' });
		return res.json({ success: true, data: { langs, lang, rows: lang ? await readTr(database, 'il_translations', id, lang, rows) : [] } });
	}));
	router.put('/admin/intensive/:id/translations', staff(async (req, res) => {
		const id = String(req.params.id);
		const lang = String(req.body?.lang || '');
		if (!UUID_RE.test(id) || !(await otherLangs(database, 'vi-VN')).includes(lang)) return res.status(400).json({ success: false, message: 'Bad request' });
		const rows = await trRows(id);
		if (!rows) return res.status(404).json({ success: false, message: 'Not found' });
		await writeTr(database, 'il_translations', id, lang, req.body?.items, rows);
		return res.json({ success: true });
	}));

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
		if (body.sub !== undefined) patch.sub = String(body.sub || '').replace(/\s+/g, ' ').trim().slice(0, 600) || null;
		if (!Object.keys(body).some((k) => ['text', 'start_ms', 'end_ms', 'traps', 'key_words', 'part', 'sub'].includes(k))) return res.status(400).json({ success: false, message: 'Nothing to change' });
		const s = await database('il_sentences').where({ id: sid, lesson_id: id }).first();
		if (!s) return res.status(404).json({ success: false, message: 'Not found' });
		if (body.part !== undefined) {
			const part = Number(body.part);
			if (!Number.isInteger(part) || part < 1 || part > 99) return res.status(422).json({ success: false, message: 'Chặng từ 1 đến 99' });
			patch.part = part;
		}
		if (body.traps !== undefined) {
			if (!Array.isArray(body.traps) || body.traps.length > 12) return res.status(422).json({ success: false, message: 'Tối đa 12 bẫy mỗi câu' });
			const sentence = ` ${tokens(patch.text ?? s.text).join(' ')} `;
			const traps: any[] = [];
			for (const t of body.traps) {
				const text = tokens(String(t?.text || '')).join(' ');
				if (!text) continue;
				if (!KINDS.includes(String(t?.kind))) return res.status(422).json({ success: false, message: `Loại bẫy "${text}" không hợp lệ` });
				if (!sentence.includes(` ${text} `)) return res.status(422).json({ success: false, message: `Bẫy "${text}" không nằm trong câu` });
				const clip = (v: any, n: number) => String(v || '').trim().slice(0, n) || undefined;
				traps.push({ text: String(t.text).trim(), kind: t.kind, real: clip(t.real, 300), note: clip(t.note, 400), skill: clip(t.skill, 80) });
			}
			patch.traps = JSON.stringify(traps);
		}
		// Key words: words of the sentence that change its meaning when missed (can't, not, the main nouns). Stored lower case
		// without apostrophes; a word no longer in the sentence (after a text fix) is dropped
		const inSentence = new Set(tokens(patch.text ?? s.text).map((w) => w.replace(/'/g, '')));
		if (body.key_words !== undefined || patch.text) {
			const want: string[] = Array.isArray(body.key_words) ? body.key_words : s.key_words || [];
			const keys = [...new Set(want.map((w) => String(w || '').toLowerCase().replace(/[‘’']/g, '').trim()).filter(Boolean))];
			const out = keys.filter((w) => inSentence.has(w));
			if (body.key_words !== undefined && out.length < keys.length) return res.status(422).json({ success: false, message: `Từ "${keys.find((w) => !inSentence.has(w))}" không nằm trong câu` });
			if (out.length > 6) return res.status(422).json({ success: false, message: 'Tối đa 6 từ quan trọng mỗi câu' });
			patch.key_words = out;
		}
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
		if (await database('il_attempts').where('lesson_id', id).first('id')) return res.status(409).json({ success: false, message: 'Đã có người học làm bài này: dùng trạng thái Ẩn thay vì xoá' });
		await database('il_lessons').where('id', id).delete();
		return res.json({ success: true, data: null });
	}));
}
