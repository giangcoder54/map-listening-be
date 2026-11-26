/**
 * Extensive Listening lessons for the team (/admin/library?tab=extensive).
 *
 *   GET    /admin/extensive                 lessons (status, level, topic, q, page) with how learners did
 *   GET    /admin/extensive/coverage        published / draft lessons by topic x Level
 *   GET    /admin/extensive/candidates      library videos that would make a lesson (level, topic, q, page)
 *   GET    /admin/extensive/:id             one lesson with answers, the transcript of its range, stats per question
 *   POST   /admin/extensive                 { source_video_id } a draft (one part, the whole video)
 *   PUT    /admin/extensive/:id             the whole lesson: fields, parts and their questions, the closing one, summary,
 *                                           explore lines, vocabulary, notes and the Vietnamese subtitle of each line
 *   GET    /admin/extensive/:id/translations?lang=   every learner text with its base (Vietnamese) text and `lang`'s
 *   PUT    /admin/extensive/:id/translations  { lang, items: { key: text } } empty text = back to the base
 *   DELETE /admin/extensive/:id             admins only; a lesson learners have done is hidden instead
 *
 * Lessons are written by Claude (docs/giao-trinh/tools/el_write.py) and reviewed here. Publishing
 * checks every part has a question, every question 3 options and an answer, and a closing question.
 */
import { wordKey } from '../lib/dict';
import { EFFECTIVE } from '../lib/videoTags';
import { BASE_LANG, linesIn, thumbOf } from '../lib/extensive';
import { UUID_RE } from '../lib/lessons';
import { isStaff } from '../lib/staff';
import { otherLangs, readTr, writeTr, type TrRow } from '../lib/adminTr';

const STATUSES = ['draft', 'published', 'hidden'];
const KINDS = ['gist', 'detail', 'why', 'attitude'];

type QIn = { id?: string; prompt: string; options: string[]; answer: number; explain?: string | null; answer_start?: number | null; answer_end?: number | null; kind?: string };
type SegIn = { id?: string; start_ms: number; end_ms: number; questions: QIn[] };

export function registerAdminExtensiveRoutes(router: any, context: any) {
	const { database, logger } = context;
	const staff = (handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Admins and editors only' });
		try {
			return await handler(req, res);
		} catch (error: any) {
			logger?.error?.(`[admin-extensive] ${req.method} ${req.path} failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};
	const bad = (res: any, message: string) => res.status(400).json({ success: false, message });

	router.get('/admin/extensive', staff(async (req, res) => {
		const page = Math.max(1, Number(req.query?.page) || 1);
		const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 25));
		const where: string[] = ['true'];
		const params: any[] = [];
		if (STATUSES.includes(String(req.query?.status))) { where.push('l.status = ?'); params.push(String(req.query.status)); }
		const level = Number(req.query?.level) || 0;
		if (level) { where.push('l.level = ?'); params.push(level); }
		if (req.query?.topic) { where.push('l.topic = ?'); params.push(String(req.query.topic)); }
		if (req.query?.q) { where.push('(l.title ILIKE ? OR sv.title ILIKE ? OR sv.channel_name ILIKE ?)'); const q = `%${String(req.query.q).trim()}%`; params.push(q, q, q); }
		const { rows } = await database.raw(`
			SELECT l.id, l.short_id, l.title, l.level, l.topic, l.status, l.is_premium, l.start_ms, l.end_ms, l.date_updated,
				sv.title AS video_title, sv.channel_name, sv.youtube_video_id, sv.thumbnail_url,
				(SELECT count(*)::int FROM el_segments s WHERE s.lesson_id = l.id) AS parts,
				(SELECT count(*)::int FROM el_questions q WHERE q.lesson_id = l.id) AS questions,
				st.plays, st.ratio, st.subs, st.little,
				count(*) OVER()::int AS full_count
			FROM el_lessons l
			JOIN source_videos sv ON sv.id = l.source_video_id
			LEFT JOIN LATERAL (
				SELECT count(*)::int AS plays,
					round(avg(CASE WHEN a.total > 0 THEN a.right_count::numeric / a.total END), 2) AS ratio,
					count(*) FILTER (WHERE a.subs_used)::int AS subs,
					count(*) FILTER (WHERE a.self_rating = 'little')::int AS little
				FROM el_attempts a WHERE a.lesson_id = l.id AND a.finished_at IS NOT NULL
			) st ON true
			WHERE ${where.join(' AND ')}
			ORDER BY ${req.query?.sort === 'level' ? 'l.level, l.sort, l.date_created' : 'l.date_created DESC, l.title'}
			LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);
		return res.json({ success: true, data: { items: rows.map((r: any) => ({ ...r, thumbnail: thumbOf(r), full_count: undefined })), total: rows[0]?.full_count || 0, page, limit } });
	}));

	router.get('/admin/extensive/coverage', staff(async (_req, res) => {
		const { rows } = await database.raw(`SELECT topic, level, count(*) FILTER (WHERE status = 'published')::int AS published, count(*) FILTER (WHERE status = 'draft')::int AS draft
			FROM el_lessons GROUP BY topic, level`);
		return res.json({ success: true, data: { cells: rows } });
	}));

	router.get('/admin/extensive/candidates', staff(async (req, res) => {
		const page = Math.max(1, Number(req.query?.page) || 1);
		const limit = 25;
		const where = [`coalesce(t.broken, false) = false`, `sv.transcript_kind IN ('manual', 'asr')`, `t.duration_s BETWEEN 90 AND 900`,
			`NOT EXISTS (SELECT 1 FROM el_lessons l WHERE l.source_video_id = sv.id)`];
		const params: any[] = [];
		const level = Number(req.query?.level) || 0;
		if (level) { where.push(`${EFFECTIVE.level} = ?`); params.push(level); }
		if (req.query?.topic) { where.push(`${EFFECTIVE.topic} = ?`); params.push(String(req.query.topic)); }
		const search = String(req.query?.q || '').trim();
		if (search) { where.push('(sv.title ILIKE ? OR sv.channel_name ILIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
		const { rows } = await database.raw(`
			SELECT sv.id, sv.title, sv.channel_name, sv.youtube_video_id, sv.thumbnail_url, sv.transcript_kind, t.duration_s, t.wpm,
				${EFFECTIVE.topic} AS topic, ${EFFECTIVE.level} AS level, count(*) OVER()::int AS full_count
			FROM source_videos sv
			JOIN video_tags t ON t.source_video_id = sv.id
			LEFT JOIN channel_tags ct ON ct.channel_name = sv.channel_name
			WHERE ${where.join(' AND ')}
			ORDER BY (sv.transcript_kind = 'manual') DESC, t.duration_s
			LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);
		return res.json({ success: true, data: { items: rows.map((r: any) => ({ ...r, thumbnail: thumbOf(r), full_count: undefined })), total: rows[0]?.full_count || 0, page, limit } });
	}));

	router.get('/admin/extensive/:id', staff(async (req, res) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return bad(res, 'Bad id');
		const l = await database('el_lessons as l').join('source_videos as sv', 'sv.id', 'l.source_video_id')
			.select('l.*', 'sv.youtube_video_id', 'sv.title as video_title', 'sv.channel_name', 'sv.transcript', 'sv.transcript_kind')
			.where('l.id', id).first();
		if (!l) return res.status(404).json({ success: false, message: 'Not found' });
		const [segments, questions, stats, vocab, notes, subs, spares] = await Promise.all([
			database('el_segments').where('lesson_id', id).orderBy('n'),
			database('el_questions').where('lesson_id', id).orderBy('n'),
			database.raw(`SELECT k AS question_id, count(*)::int AS n, count(*) FILTER (WHERE (v->>'right')::boolean)::int AS right
				FROM el_attempts a, jsonb_each(a.answers) e(k, v) WHERE a.lesson_id = ? GROUP BY k`, [id]),
			database('el_vocab').where('lesson_id', id).orderBy('n'),
			database('el_notes').where('lesson_id', id).orderBy('n'),
			database('el_line_subs').select('start_ms', 'text').where({ lesson_id: id, lang: BASE_LANG }),
			database('el_spare_questions').where('lesson_id', id).orderBy('n'),
		]);
		const statOf = new Map(stats.rows.map((s: any) => [s.question_id, { n: s.n, right: s.right }]));
		const q = (x: any) => ({ ...x, stats: statOf.get(x.id) || { n: 0, right: 0 } });
		const { transcript, ...rest } = l;
		return res.json({ success: true, data: {
			...rest,
			segments: segments.map((s: any) => ({ ...s, questions: questions.filter((x: any) => x.segment_id === s.id).map(q) })),
			final: (() => { const f = questions.find((x: any) => !x.segment_id); return f ? q(f) : null; })(),
			// Spare questions: kept for later, read-only here (not played by learners yet)
			spares: spares.map((x: any) => ({ id: x.id, n: x.n, prompt: x.prompt, options: x.options, answer: x.answer, explain: x.explain, answer_start: x.answer_start, answer_end: x.answer_end, kind: x.kind, published: !!x.published })),
			vocab: vocab.map((v: any) => ({ id: v.id, term: v.term, forms: v.forms || [], kind: v.kind, meaning: v.meaning, at_start: v.at_start, at_end: v.at_end })),
			notes: notes.map((n: any) => ({ id: n.id, term: n.term, forms: n.forms || [], kind: n.kind, explain: n.explain, extra: n.extra, before: !!n.before })),
			// The whole video, so the range can be moved; `tr` is the Vietnamese subtitle
			lines: (() => { const m = new Map<number, string>(subs.map((r: any) => [r.start_ms, r.text])); return linesIn(transcript, 0, Number.MAX_SAFE_INTEGER).map((c) => ({ ...c, tr: m.get(c.start) ?? '' })); })(),
		} });
	}));

	router.post('/admin/extensive', staff(async (req, res) => {
		const id = String(req.body?.source_video_id || '');
		if (!UUID_RE.test(id)) return bad(res, 'Bad video');
		const v = await database('source_videos as sv').leftJoin('video_tags as t', 't.source_video_id', 'sv.id').leftJoin('channel_tags as ct', 'ct.channel_name', 'sv.channel_name')
			.select('sv.id', 'sv.title', 't.duration_s', database.raw(`${EFFECTIVE.topic} AS topic`), database.raw(`${EFFECTIVE.level} AS level`))
			.where('sv.id', id).first();
		if (!v) return res.status(404).json({ success: false, message: 'Video not found' });
		const end = Math.max(1000, (Number(v.duration_s) || 60) * 1000);
		const created = await database.transaction(async (trx: any) => {
			const [l] = await trx('el_lessons').insert({ source_video_id: id, title: String(v.title || 'Video').slice(0, 200), level: v.level || 5, topic: v.topic, start_ms: 0, end_ms: end, listen_for: '' }).returning('id');
			await trx('el_segments').insert({ lesson_id: l.id, n: 1, start_ms: 0, end_ms: end });
			return l.id;
		});
		return res.json({ success: true, data: { id: created } });
	}));

	const cleanQ = (x: any): QIn | string => {
		const prompt = String(x?.prompt || '').trim();
		const options = Array.isArray(x?.options) ? x.options.map((o: any) => String(o ?? '').trim()) : [];
		const answer = Number(x?.answer);
		if (!prompt) return 'A question has no text';
		if (options.length < 2 || options.length > 4 || options.some((o: string) => !o)) return `“${prompt.slice(0, 40)}”: 2–4 options, none empty`;
		if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) return `“${prompt.slice(0, 40)}”: pick the right option`;
		const ms = (v: any) => (v === null || v === undefined || v === '' ? null : Math.max(0, Math.round(Number(v))));
		return { id: UUID_RE.test(String(x?.id || '')) ? x.id : undefined, prompt: prompt.slice(0, 500), options: options.map((o: string) => o.slice(0, 300)), answer,
			explain: x?.explain ? String(x.explain).slice(0, 500) : null, answer_start: ms(x?.answer_start), answer_end: ms(x?.answer_end), kind: KINDS.includes(x?.kind) ? x.kind : 'gist' };
	};

	router.put('/admin/extensive/:id', staff(async (req, res) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return bad(res, 'Bad id');
		const old = await database('el_lessons').where('id', id).first();
		if (!old) return res.status(404).json({ success: false, message: 'Not found' });
		const b = req.body || {};
		const level = Number(b.level);
		if (!Number.isInteger(level) || level < 1 || level > 10) return bad(res, 'Level 1–10');
		const status = STATUSES.includes(b.status) ? b.status : old.status;
		if (b.is_premium !== undefined && !!b.is_premium !== !!old.is_premium && !req.accountability?.admin) return res.status(403).json({ success: false, message: 'Only admins change Premium' });

		const segs: SegIn[] = [];
		for (const s of Array.isArray(b.segments) ? b.segments : []) {
			const start = Math.round(Number(s?.start_ms)), end = Math.round(Number(s?.end_ms));
			if (!(end > start)) return bad(res, 'A part ends before it starts');
			const qs: QIn[] = [];
			for (const x of Array.isArray(s?.questions) ? s.questions : []) { const c = cleanQ(x); if (typeof c === 'string') return bad(res, c); qs.push(c); }
			segs.push({ id: UUID_RE.test(String(s?.id || '')) ? s.id : undefined, start_ms: start, end_ms: end, questions: qs });
		}
		if (!segs.length) return bad(res, 'At least one part');
		segs.sort((a, z) => a.start_ms - z.start_ms);
		const final = b.final ? cleanQ(b.final) : null;
		if (typeof final === 'string') return bad(res, final);
		const listenFor = String(b.listen_for || '').trim();
		if (status === 'published') {
			if (!listenFor) return bad(res, 'Publishing needs the “listen for” question');
			if (!final) return bad(res, 'Publishing needs the closing question');
			if (segs.some((s) => !s.questions.length)) return bad(res, 'Publishing needs a question after every part');
		}

		const KIND_V = ['word', 'phrase', 'grammar'], KIND_N = ['person', 'org', 'place', 'culture', 'idiom'];
		const strs = (v: any) => (Array.isArray(v) ? v.map((x: any) => String(x ?? '').trim()).filter(Boolean).slice(0, 12) : []);
		const vocab = (Array.isArray(b.vocab) ? b.vocab : []).map((v: any) => ({ term: String(v?.term || '').trim().slice(0, 120), forms: strs(v?.forms), kind: KIND_V.includes(v?.kind) ? v.kind : 'word',
			meaning: String(v?.meaning || '').trim().slice(0, 300), at_start: v?.at_start ?? null, at_end: v?.at_end ?? null })).filter((v: any) => v.term);
		if (vocab.some((v: any) => !v.meaning)) return bad(res, 'Every vocabulary item needs a meaning');
		// A saved item is kept by its word key (letters, spaces, ' and - only, up to 60): a structure that cannot be keyed could not be saved for review
		const unkeyed = vocab.find((v: any) => v.kind === 'grammar' && !wordKey(v.term));
		if (unkeyed) return bad(res, `Structure “${unkeyed.term}” can only have letters, spaces, ' and -, up to 60 characters (write the pattern, e.g. “I reckon”)`);
		const notes = (Array.isArray(b.notes) ? b.notes : []).map((n: any) => ({ term: String(n?.term || '').trim().slice(0, 120), forms: strs(n?.forms), kind: KIND_N.includes(n?.kind) ? n.kind : 'culture',
			explain: String(n?.explain || '').trim().slice(0, 600), extra: n?.extra ? String(n.extra).trim().slice(0, 600) : null, before: !!n?.before })).filter((n: any) => n.term);
		if (notes.some((n: any) => !n.explain)) return bad(res, 'Every note needs an explanation');
		const explore = strs(b.explore).map((t: string) => t.slice(0, 600));
		const subs: [number, string][] = Object.entries(b.subs && typeof b.subs === 'object' ? b.subs : {}).map(([k, v]) => [Math.round(Number(k)), String(v ?? '').trim().slice(0, 600)] as [number, string]).filter(([k, v]) => Number.isFinite(k) && v);

		await database.transaction(async (trx: any) => {
			await trx('el_lessons').where('id', id).update({ summary: b.summary ? String(b.summary).trim().slice(0, 1500) : null, explore: explore.length ? explore : null });
			await trx('el_vocab').where('lesson_id', id).delete();
			if (vocab.length) await trx('el_vocab').insert(vocab.map((v: any, i: number) => ({ ...v, lesson_id: id, n: i + 1 })));
			await trx('el_notes').where('lesson_id', id).delete();
			if (notes.length) await trx('el_notes').insert(notes.map((n: any, i: number) => ({ ...n, lesson_id: id, n: i + 1 })));
			await trx('el_line_subs').where({ lesson_id: id, lang: BASE_LANG }).delete();
			if (subs.length) await trx('el_line_subs').insert(subs.map(([start_ms, text]) => ({ lesson_id: id, lang: BASE_LANG, start_ms, text })));
			await trx('el_lessons').where('id', id).update({
				title: String(b.title || old.title).trim().slice(0, 200), level, topic: b.topic || null,
				start_ms: segs[0]!.start_ms, end_ms: segs[segs.length - 1]!.end_ms, listen_for: listenFor, intro: b.intro ? String(b.intro).slice(0, 500) : null,
				status, is_premium: b.is_premium === undefined ? old.is_premium : !!b.is_premium, note: b.note ? String(b.note).slice(0, 1000) : null, date_updated: trx.fn.now(),
			});
			// Keep the ids that come back (answers and stats are keyed by question id), drop the rest
			const keepSeg = segs.map((s) => s.id).filter(Boolean);
			const keepQ = [...segs.flatMap((s) => s.questions.map((q) => q.id)), final?.id].filter(Boolean);
			await trx('el_questions').where('lesson_id', id).modify((q: any) => keepQ.length && q.whereNotIn('id', keepQ)).delete();
			// Kept questions may move to another part: free them before dropping parts (cascade)
			if (keepQ.length) await trx('el_questions').whereIn('id', keepQ).where('lesson_id', id).update({ segment_id: null });
			await trx('el_segments').where('lesson_id', id).modify((q: any) => keepSeg.length && q.whereNotIn('id', keepSeg)).delete();
			// n is unique per lesson: move the kept parts out of the way first
			await trx('el_segments').where('lesson_id', id).update({ n: trx.raw('n + 1000') });
			let qn = 0;
			const putQ = async (x: QIn, segmentId: string | null) => {
				const row = { lesson_id: id, segment_id: segmentId, n: ++qn, prompt: x.prompt, options: JSON.stringify(x.options), answer: x.answer, explain: x.explain, answer_start: x.answer_start, answer_end: x.answer_end, kind: x.kind };
				if (x.id) await trx('el_questions').where({ id: x.id, lesson_id: id }).update(row);
				else await trx('el_questions').insert(row);
			};
			for (const [i, s] of segs.entries()) {
				let segId = s.id;
				if (segId) await trx('el_segments').where({ id: segId, lesson_id: id }).update({ n: i + 1, start_ms: s.start_ms, end_ms: s.end_ms });
				else segId = (await trx('el_segments').insert({ lesson_id: id, n: i + 1, start_ms: s.start_ms, end_ms: s.end_ms }).returning('id'))[0].id;
				for (const x of s.questions) await putQ(x, segId!);
			}
			if (final) await putQ(final, null);
		});
		return res.json({ success: true, data: { id } });
	}));

	// Spare questions: edit the text; publish = a copy in el_questions (learners see it), unpublish = remove the copy
	const MAX_QUESTIONS = 6;
	const spareQ = (x: any) => {
		const c = cleanQ(x);
		return typeof c === 'string' ? c : { prompt: c.prompt, options: c.options, answer: c.answer, explain: c.explain, answer_start: c.answer_start, answer_end: c.answer_end, kind: c.kind };
	};

	router.put('/admin/extensive/spares/:id', staff(async (req, res) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return bad(res, 'Bad id');
		const sp = await database('el_spare_questions').where('id', id).first();
		if (!sp) return res.status(404).json({ success: false, message: 'Not found' });
		const c = spareQ(req.body);
		if (typeof c === 'string') return bad(res, c);
		await database.transaction(async (trx: any) => {
			await trx('el_spare_questions').where('id', id).update({ ...c, options: JSON.stringify(c.options) });
			// Keep the published copy in step with the spare
			if (sp.question_id) await trx('el_questions').where('id', sp.question_id).update({ ...c, options: JSON.stringify(c.options) });
		});
		return res.json({ success: true, data: { id } });
	}));

	router.post('/admin/extensive/spares/:id/publish', staff(async (req, res) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return bad(res, 'Bad id');
		const on = !!req.body?.published;
		const sp = await database('el_spare_questions').where('id', id).first();
		if (!sp) return res.status(404).json({ success: false, message: 'Not found' });
		if (on === !!sp.published) return res.json({ success: true, data: { id, published: on } });
		if (!on) {
			await database.transaction(async (trx: any) => {
				if (sp.question_id) await trx('el_questions').where('id', sp.question_id).delete();
				await trx('el_spare_questions').where('id', id).update({ published: false, question_id: null });
			});
			return res.json({ success: true, data: { id, published: false } });
		}
		const lesson = await database('el_lessons').where('id', sp.lesson_id).first();
		const [{ count }] = await database('el_questions').where('lesson_id', sp.lesson_id).count('* as count');
		if (Number(count) >= MAX_QUESTIONS) return bad(res, `Bài đã có ${MAX_QUESTIONS} câu, không thể xuất bản thêm câu đề phòng`);
		const segs = await database('el_segments').where('lesson_id', sp.lesson_id).orderBy('n');
		// The part that holds the answer, else the nearest one in time
		const at = sp.answer_start ?? lesson?.start_ms ?? 0;
		const seg = segs.find((s: any) => at >= s.start_ms && at <= s.end_ms)
			|| segs.reduce((best: any, s: any) => (best == null || Math.abs(at - s.start_ms) < Math.abs(at - best.start_ms) ? s : best), null);
		if (!seg) return bad(res, 'Bài chưa có đoạn nào để đặt câu này');
		const [{ max }] = await database('el_questions').where('lesson_id', sp.lesson_id).max('n as max');
		await database.transaction(async (trx: any) => {
			const [row] = await trx('el_questions').insert({
				lesson_id: sp.lesson_id, segment_id: seg.id, n: Number(max || 0) + 1, prompt: sp.prompt, options: JSON.stringify(sp.options),
				answer: sp.answer, explain: sp.explain, answer_start: sp.answer_start, answer_end: sp.answer_end, kind: sp.kind || 'gist',
			}).returning('id');
			const qid = typeof row === 'object' ? row.id : row;
			await trx('el_spare_questions').where('id', id).update({ published: true, question_id: qid });
		});
		return res.json({ success: true, data: { id, published: true } });
	}));

	/** Every learner text of a lesson, keys as extensiveRoutes reads them, its base text beside it */
	const trRows = async (id: string) => {
		const l = await database('el_lessons').where('id', id).first();
		if (!l) return null;
		const [questions, notes, vocab] = await Promise.all([
			database('el_questions as q').leftJoin('el_segments as s', 's.id', 'q.segment_id').select('q.*', 's.n as part').where('q.lesson_id', id).orderByRaw('s.n NULLS LAST, q.n'),
			database('el_notes').where('lesson_id', id).orderBy('n'),
			database('el_vocab').where('lesson_id', id).orderBy('n'),
		]);
		const rows: TrRow[] = [
			{ key: 'title', label: 'Tên bài', base: l.title || '' },
			{ key: 'intro', label: 'Giới thiệu', base: l.intro || '' },
			{ key: 'listen_for', label: 'Nghe để tìm', base: l.listen_for || '' },
			{ key: 'summary', label: 'Tóm tắt', base: l.summary || '' },
			...(l.explore || []).map((t: string, i: number) => ({ key: `explore:${i}`, label: `Tìm hiểu thêm ${i + 1}`, base: t || '' })),
		];
		for (const q of questions) {
			const where = q.part ? `Đoạn ${q.part} · câu hỏi ${q.n}` : 'Câu hỏi cuối';
			rows.push({ key: `q:${q.id}:prompt`, label: where, base: q.prompt || '' });
			(q.options || []).forEach((o: string, i: number) => rows.push({ key: `q:${q.id}:o${i}`, label: `${where} · đáp án ${i + 1}`, base: o || '' }));
		}
		for (const v of vocab) rows.push({ key: `vocab:${v.n}`, label: `Từ vựng “${v.term}”`, base: v.meaning || '' });
		for (const n of notes) {
			rows.push({ key: `note:${n.n}`, label: `Ghi chú “${n.term}”`, base: n.explain || '' });
			rows.push({ key: `note_extra:${n.n}`, label: `Ghi chú “${n.term}” · thêm`, base: n.extra || '' });
		}
		return rows.filter((r) => r.base.trim());
	};
	router.get('/admin/extensive/:id/translations', staff(async (req, res) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return bad(res, 'Bad id');
		const langs = await otherLangs(database, BASE_LANG);
		const lang = langs.includes(String(req.query?.lang)) ? String(req.query.lang) : langs[0];
		const rows = await trRows(id);
		if (!rows) return res.status(404).json({ success: false, message: 'Not found' });
		return res.json({ success: true, data: { langs, lang, rows: lang ? await readTr(database, 'el_translations', id, lang, rows) : [] } });
	}));
	router.put('/admin/extensive/:id/translations', staff(async (req, res) => {
		const id = String(req.params.id);
		const lang = String(req.body?.lang || '');
		if (!UUID_RE.test(id) || !(await otherLangs(database, BASE_LANG)).includes(lang)) return bad(res, 'Bad request');
		const rows = await trRows(id);
		if (!rows) return res.status(404).json({ success: false, message: 'Not found' });
		await writeTr(database, 'el_translations', id, lang, req.body?.items, rows);
		return res.json({ success: true });
	}));

	router.delete('/admin/extensive/:id', staff(async (req, res) => {
		if (!req.accountability?.admin) return res.status(403).json({ success: false, message: 'Admins only' });
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return bad(res, 'Bad id');
		if (await database('el_attempts').where('lesson_id', id).first('id')) return res.status(409).json({ success: false, message: 'Đã có người học làm bài này: dùng trạng thái Ẩn thay vì xoá' });
		await database('el_lessons').where('id', id).delete();
		return res.json({ success: true, data: null });
	}));
}
