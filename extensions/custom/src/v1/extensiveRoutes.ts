/**
 * Extensive Listening for learners (lib/extensive.ts says how a lesson goes and how the Level moves).
 *
 *   GET  /extensive/home?topic=               my Level, minutes this week, lessons around my Level
 *   GET  /extensive/lessons?level&topic&page  every published lesson, paged
 *   GET  /extensive/lessons/:key              one lesson to play (answers stay on the server)
 *   POST /extensive/lessons/:key/start        { mode?: 'resume' | 'restart' } -> { attempt_id, part } (signed in; guests play without one).
 *                                             A lesson already finished starts a 'redo': minutes only, no XP, no Level move
 *   POST /extensive/attempts/:id/progress     { part } the part reached, to resume
 *   GET  /extensive/lessons/:key/after        summary, vocabulary, notes, bilingual lines, "did you know" (?lang=vi-VN)
 *   POST /extensive/vocab/:id/save            { saved } keep a word for review
 *   POST /extensive/answer                    { question_id, choice, attempt_id? } -> right, answer, the line
 *   POST /extensive/attempts/:id/event        { type: 'replay' | 'subs' }
 *   POST /extensive/attempts/:id/finish       { self_rating, listened_s } -> score, Level move, XP, next
 *   POST /extensive/intro-seen                the intro cards were read
 *
 * Guests can play free lessons; nothing is saved for them. Premium lessons need Premium.
 */
import { BASE_LANG, EL, RESUME_DAYS, SELF_RATINGS, langOf, levelRowOf, linesIn, moveAfter, thumbOf, type SelfRating } from '../lib/extensive';
import { UUID_RE } from '../lib/lessons';
import { wordKey } from '../lib/dict';
import { isPremiumUser } from '../lib/premium';
import { isStaff } from '../lib/staff';
import { grantRewards, recordPractice, vnDay } from '../lib/xp';

const KEY_RE = /^[a-z0-9]{8}$/;

export function registerExtensiveRoutes(router: any, context: any) {
	const { database, logger } = context;
	const wrap = (what: string, handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
		try {
			return await handler(req, res);
		} catch (error: any) {
			logger?.error?.(`[extensive] ${what} failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};
	const userOf = (req: any) => (req.accountability?.user as string | undefined) || null;
	/** Learner text in another language (Vietnamese is in the base columns) */
	const trOf = async (lessonId: string, lang: string) => {
		if (lang === BASE_LANG) return null;
		const rows = await database('el_translations').select('key', 'text').where({ lesson_id: lessonId, lang });
		return new Map<string, string>(rows.map((r: any) => [r.key, r.text]));
	};
	const pick = (tr: Map<string, string> | null, key: string, base: string | null) => (tr ? tr.get(key) ?? null : base);

	const CARD_SQL = `
		SELECT l.id, l.short_id, COALESCE(tt.text, l.title) AS title, l.level, l.topic, COALESCE(tn.name, t.name) AS topic_name, l.is_premium, l.start_ms, l.end_ms,
			sv.youtube_video_id, sv.thumbnail_url, sv.channel_name,
			(SELECT count(*)::int FROM el_segments s WHERE s.lesson_id = l.id) AS parts,
			(SELECT count(*)::int FROM el_attempts a WHERE a.lesson_id = l.id AND a.finished_at IS NOT NULL) AS plays
			%DONE%
		FROM el_lessons l
		JOIN source_videos sv ON sv.id = l.source_video_id
		LEFT JOIN video_topics t ON t.code = l.topic
		LEFT JOIN video_topic_translations tn ON tn.code = l.topic AND tn.lang = '%LANG%'
		LEFT JOIN el_translations tt ON tt.lesson_id = l.id AND tt.lang = '%LANG%' AND tt.key = 'title'
		WHERE l.status = 'published'`;
	// Title and topic name in the learner's language, the base (Vietnamese) text where a translation is missing.
	// `lang` is already checked by langOf (xx-XX), so it is safe in the SQL text.
	const cardSql = (userId: string | null, lang: string) => CARD_SQL.replace(/%LANG%/g, lang).replace('%DONE%', userId
		? `, EXISTS (SELECT 1 FROM el_attempts a WHERE a.lesson_id = l.id AND a.user_id = '${userId}' AND a.finished_at IS NOT NULL) AS done`
		: ', false AS done');
	/** The learner's language: ?lang= on a GET, `lang` in the body of a POST */
	const reqLang = (req: any) => langOf(req.query?.lang ?? req.body?.lang);
	/** Like pick, but a missing translation falls back to the base text (for text that must always show) */
	const pickOr = (tr: Map<string, string> | null, key: string, base: string | null) => tr?.get(key) ?? base;
	const card = (r: any, premium: boolean) => ({
		id: r.id, short_id: r.short_id, title: r.title, level: r.level, topic: r.topic, topic_name: r.topic_name,
		channel: r.channel_name, minutes: Math.max(1, Math.round((r.end_ms - r.start_ms) / 60000)), parts: r.parts, plays: r.plays,
		thumbnail: thumbOf(r), is_premium: !!r.is_premium, locked: !!r.is_premium && !premium, done: !!r.done,
	});

	const weekSeconds = async (userId: string) => {
		const r = await database.raw(`SELECT coalesce(sum(listened_s), 0)::int AS s, count(*)::int AS n FROM el_attempts
			WHERE user_id = ? AND finished_at IS NOT NULL AND finished_at >= date_trunc('week', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'`, [userId]);
		return r.rows[0];
	};
	const meOf = async (userId: string | null) => {
		if (!userId) return null;
		const [row, week, all, premium] = await Promise.all([
			levelRowOf(database, userId),
			weekSeconds(userId),
			database.raw(`SELECT coalesce(sum(listened_s), 0)::int AS s, count(*)::int AS n FROM el_attempts WHERE user_id = ? AND finished_at IS NOT NULL`, [userId]),
			isPremiumUser(database, userId, logger),
		]);
		return { level: row.level, source: row.source, intro_seen: !!row.intro_seen, week_s: week.s, week_n: week.n, total_s: all.rows[0].s, total_n: all.rows[0].n, premium };
	};

	router.get('/extensive/home', wrap('home', async (req, res) => {
		const userId = userOf(req);
		const me = await meOf(userId);
		const level = me?.level ?? EL.defaultLevel;
		const topic = String(req.query?.topic || '');
		const params: any[] = [level - 1, level + 1];
		let where = ' AND l.level BETWEEN ? AND ?';
		if (topic) { where += ' AND l.topic = ?'; params.push(topic); }
		const lang = reqLang(req);
		const { rows } = await database.raw(`SELECT * FROM (${cardSql(userId, lang)}${where}) x
			ORDER BY x.done, abs(x.level - ${Number(level)}), x.is_premium, random() LIMIT ${EL.suggest}`, params);
		const topics = await database.raw(`SELECT t.code, COALESCE(tn.name, t.name) AS name, count(*)::int AS n FROM el_lessons l JOIN video_topics t ON t.code = l.topic
			LEFT JOIN video_topic_translations tn ON tn.code = t.code AND tn.lang = ?
			WHERE l.status = 'published' GROUP BY t.code, tn.name, t.name, t.sort ORDER BY t.sort`, [lang]);
		const total = await database('el_lessons').where('status', 'published').count('* as n').first();
		return res.json({ success: true, data: { me, level, topics: topics.rows, total: Number(total?.n || 0), suggested: rows.map((r: any) => card(r, !!me?.premium)) } });
	}));

	router.get('/extensive/lessons', wrap('list', async (req, res) => {
		const userId = userOf(req);
		const premium = await isPremiumUser(database, userId, logger);
		const page = Math.max(1, Number(req.query?.page) || 1);
		const limit = Math.min(48, Math.max(1, Number(req.query?.limit) || 24));
		const params: any[] = [];
		let where = '';
		const level = Number(req.query?.level) || 0;
		if (level >= 1 && level <= 10) { where += ' AND l.level = ?'; params.push(level); }
		if (req.query?.topic) { where += ' AND l.topic = ?'; params.push(String(req.query.topic)); }
		// Filters on the finished card (done is computed inside the subquery): not heard / heard, free only
		const status = String(req.query?.status || '');
		const outer: string[] = [];
		if (userId && status === 'todo') outer.push('NOT x.done');
		if (userId && status === 'done') outer.push('x.done');
		if (req.query?.premium === 'free') outer.push('NOT x.is_premium');
		// Order: fit (not heard first, nearest my Level, least listened first so late lessons are not buried: the default), popular (most finished), level
		const sort = String(req.query?.sort || 'fit');
		const myLevel = userId ? (await levelRowOf(database, userId)).level : EL.defaultLevel;
		const order = sort === 'popular' ? 'x.plays DESC, x.title'
			: sort === 'level' ? 'x.level, x.title'
				: `x.done, abs(x.level - ${Number(myLevel)}), x.plays, x.title`;
		const { rows } = await database.raw(`SELECT *, count(*) OVER()::int AS full_count FROM (${cardSql(userId, reqLang(req))}${where}) x
			${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
			ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);
		return res.json({ success: true, data: { items: rows.map((r: any) => card(r, premium)), total: rows[0]?.full_count || 0, page, limit } });
	}));

	const findLesson = (key: string) => {
		if (!KEY_RE.test(key) && !UUID_RE.test(key)) return null;
		return database('el_lessons as l').join('source_videos as sv', 'sv.id', 'l.source_video_id')
			.select('l.*', 'sv.youtube_video_id', 'sv.transcript', 'sv.channel_name', 'sv.title as video_title')
			.where(UUID_RE.test(key) ? 'l.id' : 'l.short_id', key).first();
	};

	router.get('/extensive/lessons/:key', wrap('lesson', async (req, res) => {
		const userId = userOf(req);
		const l = await findLesson(String(req.params.key));
		// Editors can open drafts (the admin preview)
		const staff = isStaff(req.accountability);
		if (!l || (l.status !== 'published' && !(staff && req.query?.preview))) return res.status(404).json({ success: false, message: 'Not found' });
		const premium = await isPremiumUser(database, userId, logger);
		const locked = !!l.is_premium && !premium && !req.accountability?.admin;
		const lang = langOf(req.query?.lang);
		const [segments, questions, me, vocab, notes, tr, open, finished] = await Promise.all([
			database('el_segments').where('lesson_id', l.id).orderBy('n'),
			database('el_questions').select('id', 'segment_id', 'n', 'prompt', 'options', 'kind').where('lesson_id', l.id).orderBy('n'),
			meOf(userId),
			database('el_vocab').select('id', 'term', 'forms').where('lesson_id', l.id),
			database('el_notes').select('id', 'n', 'term', 'forms', 'kind', 'explain', 'before').where('lesson_id', l.id).orderBy('n'),
			trOf(l.id, lang),
			userId ? database('el_attempts').select('id', 'part').where({ user_id: userId, lesson_id: l.id }).whereNull('finished_at')
				.where('date_created', '>', database.raw(`now() - interval '${RESUME_DAYS} days'`)).orderBy('date_created', 'desc').first() : null,
			userId ? database('el_attempts').select('id').where({ user_id: userId, lesson_id: l.id }).whereNotNull('finished_at').first() : null,
		]);
		// Question text in the learner's language (keys q:<id>:prompt, q:<id>:o<i>), base text when missing
		const q = (x: any) => ({
			id: x.id, prompt: pickOr(tr, `q:${x.id}:prompt`, x.prompt),
			options: (x.options as string[]).map((o, i) => pickOr(tr, `q:${x.id}:o${i}`, o)), kind: x.kind,
		});
		const final = questions.find((x: any) => !x.segment_id);
		return res.json({ success: true, data: {
			id: l.id, short_id: l.short_id, title: pickOr(tr, 'title', l.title), level: l.level, topic: l.topic, intro: pickOr(tr, 'intro', l.intro), listen_for: pickOr(tr, 'listen_for', l.listen_for),
			channel: l.channel_name, video_title: l.video_title, video_id: l.youtube_video_id, start: l.start_ms, end: l.end_ms,
			is_premium: !!l.is_premium, locked, status: l.status,
			segments: segments.map((s: any) => ({ n: s.n, start: s.start_ms, end: s.end_ms, questions: questions.filter((x: any) => x.segment_id === s.id).map(q) })),
			final: final ? q(final) : null,
			lines: locked ? [] : linesIn(l.transcript, l.start_ms, l.end_ms),
			// What to colour in the subtitles (the meanings come with /after)
			marks: [...vocab.map((v: any) => ({ k: 'v', id: v.id, forms: [v.term, ...(v.forms || [])] })), ...notes.map((n: any) => ({ k: 'n', id: n.id, forms: [n.term, ...(n.forms || [])] }))],
			// Shown before listening: only what the learner needs to follow the talk
			notes_before: locked ? [] : notes.filter((n: any) => n.before).map((n: any) => ({ id: n.id, term: n.term, kind: n.kind, explain: pickOr(tr, `note:${n.n}`, n.explain) })).filter((n: any) => n.explain),
			progress: { unfinished: open ? { attempt_id: open.id, part: open.part } : null, finished: !!finished },
			me,
		} });
	}));

	router.post('/extensive/lessons/:key/start', wrap('start', async (req, res) => {
		const userId = userOf(req);
		if (!userId) return res.json({ success: true, data: { attempt_id: null, part: 0 } });
		const l = await findLesson(String(req.params.key));
		if (!l || l.status !== 'published') return res.status(404).json({ success: false, message: 'Not found' });
		if (l.is_premium && !(await isPremiumUser(database, userId, logger))) return res.status(403).json({ success: false, code: 'PREMIUM', message: 'Premium only' });
		const where = { user_id: userId, lesson_id: l.id };
		const open = await database('el_attempts').select('id', 'part').where(where).whereNull('finished_at')
			.where('date_created', '>', database.raw(`now() - interval '${RESUME_DAYS} days'`)).orderBy('date_created', 'desc').first();
		if (open && req.body?.mode === 'resume') return res.json({ success: true, data: { attempt_id: open.id, part: open.part } });
		// A fresh start drops the unfinished tries. Already finished once: this one is a redo
		await database('el_attempts').where(where).whereNull('finished_at').delete();
		const finished = await database('el_attempts').select('id').where(where).whereNotNull('finished_at').first();
		const total = await database('el_questions').where('lesson_id', l.id).count('* as n').first();
		const [row] = await database('el_attempts').insert({ ...where, level: l.level, total: Number(total?.n || 0), kind: finished ? 'redo' : 'first' }).returning('id');
		return res.json({ success: true, data: { attempt_id: row.id ?? row, part: 0 } });
	}));

	const ownAttempt = async (req: any) => {
		const userId = userOf(req);
		const id = String(req.params?.id || req.body?.attempt_id || '');
		if (!userId || !UUID_RE.test(id)) return null;
		return database('el_attempts').where({ id, user_id: userId }).first();
	};

	router.post('/extensive/answer', wrap('answer', async (req, res) => {
		const id = String(req.body?.question_id || '');
		const choice = Number(req.body?.choice);
		if (!UUID_RE.test(id) || !Number.isInteger(choice)) return res.status(400).json({ success: false, message: 'Bad answer' });
		const q = await database('el_questions as q').join('el_lessons as l', 'l.id', 'q.lesson_id').join('source_videos as sv', 'sv.id', 'l.source_video_id')
			.select('q.*', 'l.is_premium', 'l.status', 'sv.transcript').where('q.id', id).first();
		if (!q) return res.status(404).json({ success: false, message: 'Not found' });
		const right = choice === q.answer;
		const attempt = await ownAttempt(req);
		if (attempt && attempt.lesson_id === q.lesson_id && !attempt.finished_at) {
			// The first answer counts
			await database.raw(`UPDATE el_attempts SET answers = answers || jsonb_build_object(?::text, jsonb_build_object('choice', ?::int, 'right', ?::boolean))
				WHERE id = ? AND NOT jsonb_exists(answers, ?)`, [id, choice, right, attempt.id, id]);
		}
		const lines = q.answer_start != null ? linesIn(q.transcript, q.answer_start, q.answer_end ?? q.answer_start + 1) : [];
		return res.json({ success: true, data: {
			right, answer: q.answer, explain: pickOr(await trOf(q.lesson_id, reqLang(req)), `q:${id}:explain`, q.explain),
			line: lines.length ? { start: Math.min(...lines.map((c) => c.start)), end: Math.max(...lines.map((c) => c.end)), text: lines.map((c) => c.text).join(' ') } : null,
		} });
	}));

	router.post('/extensive/attempts/:id/event', wrap('event', async (req, res) => {
		const a = await ownAttempt(req);
		if (!a || a.finished_at) return res.json({ success: true, data: null });
		if (req.body?.type === 'replay') await database('el_attempts').where('id', a.id).increment('replays', 1);
		if (req.body?.type === 'subs') await database('el_attempts').where('id', a.id).update({ subs_used: true });
		return res.json({ success: true, data: null });
	}));

	router.post('/extensive/attempts/:id/progress', wrap('progress', async (req, res) => {
		const a = await ownAttempt(req);
		const part = Math.max(0, Math.min(50, Math.round(Number(req.body?.part) || 0)));
		if (a && !a.finished_at) await database('el_attempts').where('id', a.id).update({ part });
		return res.json({ success: true, data: null });
	}));

	router.post('/extensive/attempts/:id/finish', wrap('finish', async (req, res) => {
		const userId = userOf(req)!;
		const a = await ownAttempt(req);
		if (!a) return res.status(404).json({ success: false, message: 'Not found' });
		const rating = (SELF_RATINGS as readonly string[]).includes(req.body?.self_rating) ? (req.body.self_rating as SelfRating) : null;
		const lesson = await database('el_lessons').select('id', 'end_ms', 'start_ms', 'level', 'topic').where('id', a.lesson_id).first();
		const maxS = Math.round((lesson.end_ms - lesson.start_ms) / 1000) * 3;
		const listened = Math.max(0, Math.min(maxS, Math.round(Number(req.body?.listened_s) || 0)));
		const answers = a.answers || {};
		const right = Object.values(answers).filter((x: any) => x?.right).length;
		const total = a.total || Object.keys(answers).length;

		// A redo counts the minutes only: no XP, no Level move
		if (a.kind === 'redo' && !a.finished_at) {
			await database('el_attempts').where('id', a.id).update({ right_count: right, total, self_rating: rating, listened_s: listened, finished_at: database.fn.now(), move: 0 });
			await recordPractice(database, userId, { attempts: total });
			const w = await weekSeconds(userId);
			return res.json({ success: true, data: { right, total, self_rating: rating, move: 0, level_before: null, level_after: null, xp: 0, week_s: w.s, next: [], redo: true } });
		}
		const result = await database.transaction(async (trx: any) => {
			if (a.finished_at) return { move: a.move || 0, before: null, after: null, again: true };
			await trx('el_attempts').where('id', a.id).update({ right_count: right, total, self_rating: rating, listened_s: listened, finished_at: trx.fn.now() });
			await levelRowOf(trx, userId);
			const row = await trx('el_levels').where('user_id', userId).forUpdate().first();
			const move = await moveAfter(trx, userId, row.level, { id: a.id, level: a.level, ratio: total ? right / total : 0, rating });
			const after = Math.min(10, Math.max(1, row.level + move));
			await trx('el_attempts').where('id', a.id).update({ move });
			if (move) {
				const history = [...(row.history || []), { at: new Date().toISOString(), from: row.level, to: after, attempt: a.id }].slice(-50);
				await trx('el_levels').where('user_id', userId).update({ level: after, source: 'moved', history: JSON.stringify(history), date_updated: trx.fn.now() });
			}
			return { move, before: row.level, after, again: false };
		});

		let xp = 0;
		if (!result.again) {
			const first = !(await database('el_attempts').where({ user_id: userId, lesson_id: a.lesson_id }).whereNotNull('finished_at').whereNot('id', a.id).first());
			const won = await recordPractice(database, userId, {
				attempts: total,
				xp: first
					? { reason: 'extensive', dedupe: `extensive:${a.lesson_id}`, lessonId: null }
					: { reason: 'extensive', dedupe: `extensive:${a.lesson_id}:${vnDay()}`, lessonId: null, amount: EL.xpAgain },
			});
			xp = won.xp;
			await grantRewards(context, req.schema, userId, won.rewards);
		}

		// Next: a lesson at the new Level not heard yet, same topic first
		const level = result.after ?? a.level;
		const { rows } = await database.raw(`SELECT * FROM (${cardSql(userId, reqLang(req))} AND l.id <> ? AND l.level BETWEEN ? AND ?) x
			ORDER BY x.done, (x.topic IS NOT DISTINCT FROM ?) DESC, abs(x.level - ?), random() LIMIT 3`, [a.lesson_id, level - 1, level + 1, lesson.topic, level]);
		const premium = await isPremiumUser(database, userId, logger);
		const week = await weekSeconds(userId);
		return res.json({ success: true, data: { right, total, self_rating: rating, move: result.move, level_before: result.before, level_after: result.after, xp, week_s: week.s, next: rows.map((r: any) => card(r, premium)) } });
	}));

	router.get('/extensive/lessons/:key/after', wrap('after', async (req, res) => {
		const userId = userOf(req);
		const l = await findLesson(String(req.params.key));
		const staff = isStaff(req.accountability);
		if (!l || (l.status !== 'published' && !(staff && req.query?.preview))) return res.status(404).json({ success: false, message: 'Not found' });
		if (l.is_premium && !(await isPremiumUser(database, userId, logger)) && !req.accountability?.admin) return res.status(403).json({ success: false, code: 'PREMIUM', message: 'Premium only' });
		const lang = langOf(req.query?.lang);
		const [vocab, notes, subs, tr, saved] = await Promise.all([
			database('el_vocab').where('lesson_id', l.id).orderBy('n'),
			database('el_notes').where('lesson_id', l.id).orderBy('n'),
			database('el_line_subs').select('start_ms', 'text').where({ lesson_id: l.id, lang }),
			trOf(l.id, lang),
			userId ? database('user_words').select('word').where('user_id', userId) : [],
		]);
		const savedSet = new Set(saved.map((r: any) => r.word));
		const subOf = new Map<number, string>(subs.map((r: any) => [r.start_ms, r.text]));
		const exploreList: string[] = (l.explore || []).map((t: string, i: number) => pick(tr, `explore:${i}`, t)).filter(Boolean);
		return res.json({ success: true, data: {
			lang, summary: pick(tr, 'summary', l.summary), explore: exploreList,
			vocab: vocab.map((v: any) => {
				const eg = v.at_start != null ? linesIn(l.transcript, v.at_start, v.at_end ?? v.at_start + 1) : [];
				return { id: v.id, term: v.term, forms: v.forms || [], kind: v.kind, meaning: pick(tr, `vocab:${v.n}`, v.meaning),
					example: eg.map((c) => c.text).join(' ') || null, at: eg.length ? { start: Math.min(...eg.map((c) => c.start)), end: Math.max(...eg.map((c) => c.end)) } : null, saved: savedSet.has(wordKey(v.term)) };
			}).filter((v: any) => v.meaning),
			notes: notes.map((n: any) => ({ id: n.id, term: n.term, forms: n.forms || [], kind: n.kind, explain: pick(tr, `note:${n.n}`, n.explain), extra: pick(tr, `note_extra:${n.n}`, n.extra) })).filter((n: any) => n.explain),
			// The transcript with its translation; `tr` is null when this language has none yet
			lines: linesIn(l.transcript, l.start_ms, l.end_ms).map((c) => ({ ...c, tr: subOf.get(c.start) ?? null })),
		} });
	}));

	router.post('/extensive/vocab/:id/save', wrap('save', async (req, res) => {
		const userId = userOf(req);
		const id = String(req.params.id);
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad id' });
		// Saved into "Từ của tôi" (user_words, v1/wordsRoutes.ts), the one store every feature shares
		const v = await database('el_vocab as v').join('el_lessons as l', 'l.id', 'v.lesson_id').join('source_videos as sv', 'sv.id', 'l.source_video_id')
			.select('v.*', 'sv.youtube_video_id', 'sv.transcript').where('v.id', id).first();
		const word = v ? wordKey(v.term) : null;
		if (!v || !word) return res.status(404).json({ success: false, message: 'Not found' });
		if (req.body?.saved === false) await database('user_words').where({ user_id: userId, word }).delete();
		else {
			const eg = v.at_start != null ? linesIn(v.transcript, v.at_start, v.at_end ?? v.at_start + 1) : [];
			await database('user_words').insert({
				user_id: userId, word, shown: v.term, forms: v.forms || [], meaning: v.meaning, source: 'extensive', source_id: v.id,
				video_id: v.youtube_video_id, start_ms: eg.length ? Math.min(...eg.map((c) => c.start)) : v.at_start, end_ms: eg.length ? Math.max(...eg.map((c) => c.end)) : v.at_end,
				example: eg.map((c) => c.text).join(' ') || null,
			}).onConflict(['user_id', 'word']).ignore();
		}
		return res.json({ success: true, data: null });
	}));

	router.post('/extensive/intro-seen', wrap('intro', async (req, res) => {
		const userId = userOf(req);
		if (!userId) return res.json({ success: true, data: null });
		await levelRowOf(database, userId);
		await database('el_levels').where('user_id', userId).update({ intro_seen: true });
		return res.json({ success: true, data: null });
	}));
}
