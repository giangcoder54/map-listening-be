/**
 * Intensive Listening for learners (lib/intensive.ts says how a sentence is checked and labelled).
 *
 *   GET  /intensive/home                        passages (paged; level, focus, status todo|done, premium free, sort fit|popular|level), Review cards due, what the learner's misses say
 *   GET  /intensive/lessons/:key                one passage to play: the video, the gist question, the sentences' times (never their text)
 *   POST /intensive/lessons/:key/start          a signed-in learner gets an attempt (guests play without one)
 *   POST /intensive/lessons/:key/gist           { choice, attempt_id? } -> right, answer, why
 *   POST /intensive/check                       { sentence_id, typed, round 1|2, listens, reveal?, slow_typed?, attempt_id? } -> the words right and
 *                                               wrong, the sentence, its traps with the real sound; round 1 also gives a first label per miss.
 *                                               reveal: false (round 1) returns only the score, the marks and a hint (the sentence up to the
 *                                               first word missed, the rest as stars); retry: true = a try after a hint, not saved
 *                                               (POST /intensive/slow takes `hinted`: word indices the hints gave away, never "speed")
 *   POST /intensive/slow                        { sentence_id, typed, slow_typed, unknown[], heard?, attempt_id? } -> the final labels;
 *                                               `confirm` = misses to ask "misheard or misspelt?" about, `heard` the answers
 *                                               (a word right at 0.75x is "speed"); makes a Review card for a missed sentence
 *   GET  /intensive/word-clips?word=&not=       the word said in other videos (subtitle lines, one per channel), to hear it more
 *   POST /intensive/attempts/:id/finish         -> the passage's result, the labels, XP
 *   GET  /intensive/review                      Review cards due: the sentence's video and times, never its text
 *   POST /intensive/review/answer               { sentence_id, typed, listens, slow? } -> checked, next review in days
 *
 * Guests can play free passages; nothing is saved for them.
 */
import { IL, FUNCTION_WORDS, NOT_LISTENING, diffWords, hintOf, isRight, labelMisses, likelyUnknown, newCard, toConfirm, type Heard, reviewGrade, schedule, cardColumns, sentenceLabel, tokens, type Label, type Trap } from '../lib/intensive';
import { thumbOf } from '../lib/extensive';
import { UUID_RE } from '../lib/lessons';
import { isPremiumUser } from '../lib/premium';
import { isStaff } from '../lib/staff';
import { grantRewards, recordPractice, vnDay } from '../lib/xp';

const KEY_RE = /^[a-z0-9]{8}$/;
const clean = (v: unknown, max = 600) => String(v ?? '').slice(0, max);

export function registerIntensiveRoutes(router: any, context: any) {
	const { database, logger } = context;
	const wrap = (what: string, handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
		try {
			return await handler(req, res);
		} catch (error: any) {
			logger?.error?.(`[intensive] ${what} failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};
	const userOf = (req: any) => (req.accountability?.user as string | undefined) || null;
	const staffPreview = (req: any) => isStaff(req.accountability) && !!req.query?.preview;

	const findLesson = (key: string) => {
		if (!KEY_RE.test(key) && !UUID_RE.test(key)) return null;
		return database('il_lessons as l').join('source_videos as sv', 'sv.id', 'l.source_video_id')
			.select('l.*', 'sv.youtube_video_id', 'sv.channel_name', 'sv.thumbnail_url')
			.where(UUID_RE.test(key) ? 'l.id' : 'l.short_id', key).first();
	};
	/** A sentence with its lesson, when the learner may play it (published, or an editor's preview) */
	const sentenceOf = async (id: string, req: any) => {
		if (!UUID_RE.test(id)) return null;
		const s = await database('il_sentences as s').join('il_lessons as l', 'l.id', 's.lesson_id')
			.select('s.*', 'l.status', 'l.is_premium').where('s.id', id).first();
		if (!s) return null;
		if (s.status !== 'published' && !isStaff(req.accountability)) return null;
		return s;
	};
	const ownAttempt = async (req: any, lessonId?: string) => {
		const userId = userOf(req);
		const id = String(req.params?.id || req.body?.attempt_id || '');
		if (!userId || !UUID_RE.test(id)) return null;
		const a = await database('il_attempts').where({ id, user_id: userId }).first();
		return a && (!lessonId || a.lesson_id === lessonId) ? a : null;
	};
	/** Learner text in another language (the base, Vietnamese, is in the base columns): il_translations, keys
	 *  title | intro | gist_prompt | gist_o<i> | gist_explain | s<n>:t<j>:note | s<n>:t<j>:real */
	const trOf = async (lessonId: string, lang: string) => {
		if (lang === 'vi-VN') return null;
		const rows = await database('il_translations').select('key', 'text').where({ lesson_id: lessonId, lang });
		return new Map<string, string>(rows.map((r: any) => [r.key, r.text]));
	};
	const pickOr = (tr: Map<string, string> | null, key: string, base: string | null) => tr?.get(key) ?? base;
	/** A sentence's traps, with the note and the real-sound text in the learner's language where there is one */
	const trapsOf = (s: any, tr: Map<string, string> | null = null): Trap[] => (Array.isArray(s.traps) ? s.traps : []).map((t: Trap, j: number) => ({
		...t, note: pickOr(tr, `s${s.n}:t${j}:note`, t.note ?? null) ?? undefined, real: pickOr(tr, `s${s.n}:t${j}:real`, t.real ?? null) ?? undefined,
	}));

	// What a learner's misses say: a label named only after enough misses over enough passages
	const mainOf = async (userId: string) => {
		const { rows } = await database.raw(`
			SELECT l->>'label' AS label, count(*)::int AS misses, count(DISTINCT a.lesson_id)::int AS lessons
			FROM il_results r JOIN il_attempts a ON a.id = r.attempt_id, jsonb_array_elements(r.labels) l
			WHERE a.user_id = ? AND r.round = 1 AND r.date_created > now() - interval '30 days'
			GROUP BY 1 ORDER BY 2 DESC`, [userId]);
		const main = rows.find((r: any) => r.misses >= IL.mainMisses && r.lessons >= IL.mainLessons) || null;
		return { counts: rows as { label: Label; misses: number; lessons: number }[], main: main as { label: Label; misses: number; lessons: number } | null };
	};

	const CARD_SQL = `
		SELECT l.id, l.short_id, COALESCE(tt.text, l.title) AS title, l.level, l.topic, COALESCE(tn.name, t.name) AS topic_name, l.focus, l.is_premium, l.start_ms, l.end_ms,
			sv.youtube_video_id, sv.thumbnail_url, sv.channel_name,
			(SELECT count(*)::int FROM il_sentences s WHERE s.lesson_id = l.id) AS sentences,
			(SELECT count(*)::int FROM il_attempts a WHERE a.lesson_id = l.id AND a.finished_at IS NOT NULL) AS plays
			%DONE%
		FROM il_lessons l
		JOIN source_videos sv ON sv.id = l.source_video_id
		LEFT JOIN video_topics t ON t.code = l.topic
		LEFT JOIN video_topic_translations tn ON tn.code = l.topic AND tn.lang = '%LANG%'
		LEFT JOIN il_translations tt ON tt.lesson_id = l.id AND tt.lang = '%LANG%' AND tt.key = 'title'
		WHERE l.status = 'published'`;
	/** The learner's language (?lang=xx-XX); the topic name falls back to the base (Vietnamese) one */
	const langOf = (req: any) => (/^[a-z]{2}-[A-Z]{2}$/.test(String(req.query?.lang ?? req.body?.lang ?? '')) ? String(req.query?.lang ?? req.body?.lang) : 'vi-VN');
	const cardSql = (userId: string | null, lang = 'vi-VN') => CARD_SQL.replace(/%LANG%/g, lang).replace('%DONE%', userId
		? `, EXISTS (SELECT 1 FROM il_attempts a WHERE a.lesson_id = l.id AND a.user_id = '${userId}' AND a.finished_at IS NOT NULL) AS done`
		: ', false AS done');
	const card = (r: any, premium: boolean) => ({
		id: r.id, short_id: r.short_id, title: r.title, level: r.level, topic_name: r.topic_name, focus: r.focus, sentences: r.sentences,
		seconds: Math.round((r.end_ms - r.start_ms) / 1000), thumbnail: thumbOf(r), channel: r.channel_name,
		is_premium: !!r.is_premium, locked: !!r.is_premium && !premium, done: !!r.done,
	});

	router.get('/intensive/home', wrap('home', async (req, res) => {
		const userId = userOf(req);
		const premium = await isPremiumUser(database, userId, logger);
		const page = Math.max(1, Number(req.query?.page) || 1);
		const limit = Math.min(48, Math.max(1, Number(req.query?.limit) || 12));
		const params: any[] = [];
		let where = '';
		const level = Number(req.query?.level) || 0;
		if (level >= 1 && level <= 3) { where += ' AND l.level = ?'; params.push(level); }
		const focus = String(req.query?.focus || '');
		if (focus) { where += ' AND l.focus = ?'; params.push(focus); }
		if (String(req.query?.premium) === 'free') where += ' AND l.is_premium = false';
		// Done or not: only a signed-in learner has a "done"
		const status = userId ? String(req.query?.status || '') : '';
		const outer = status === 'todo' ? ' WHERE x.done = false' : status === 'done' ? ' WHERE x.done = true' : '';
		const sort = String(req.query?.sort || 'fit');
		const order = sort === 'level' ? 'x.level, x.title' : sort === 'popular' ? 'x.plays DESC, x.title' : 'x.done, x.level, x.title';
		const { rows } = await database.raw(`SELECT *, count(*) OVER()::int AS full_count FROM (${cardSql(userId, langOf(req))}${where}) x${outer}
			ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);
		const due = userId ? Number((await database('il_review_cards').where('user_id', userId).where('due', '<=', database.fn.now()).count('* as n').first())?.n || 0) : 0;
		const mine = userId ? await mainOf(userId) : { counts: [], main: null };
		return res.json({ success: true, data: { items: rows.map((r: any) => card(r, premium)), total: rows[0]?.full_count || 0, page, limit, due, signed_in: !!userId, ...mine } });
	}));

	router.get('/intensive/lessons/:key', wrap('lesson', async (req, res) => {
		const userId = userOf(req);
		const l = await findLesson(String(req.params.key));
		if (!l || (l.status !== 'published' && !staffPreview(req))) return res.status(404).json({ success: false, message: 'Not found' });
		const premium = await isPremiumUser(database, userId, logger);
		const locked = !!l.is_premium && !premium && !req.accountability?.admin;
		const sentences = locked ? [] : await database('il_sentences').select('id', 'n', 'start_ms', 'end_ms', 'text').where('lesson_id', l.id).orderBy('n');
		const tr = await trOf(l.id, langOf(req));
		return res.json({ success: true, data: {
			id: l.id, short_id: l.short_id, title: pickOr(tr, 'title', l.title), level: l.level, intro: pickOr(tr, 'intro', l.intro), focus: l.focus, channel: l.channel_name,
			video_id: l.youtube_video_id, start: l.start_ms, end: l.end_ms, is_premium: !!l.is_premium, locked, status: l.status,
			gist: { prompt: pickOr(tr, 'gist_prompt', l.gist_prompt), options: (l.gist_options as string[]).map((o, i) => pickOr(tr, `gist_o${i}`, o)) },
			// The text of a sentence stays on the server until the learner has typed it
			sentences: sentences.map((s: any) => ({ id: s.id, n: s.n, start: s.start_ms, end: s.end_ms, words: tokens(s.text).length })),
		} });
	}));

	router.post('/intensive/lessons/:key/start', wrap('start', async (req, res) => {
		const userId = userOf(req);
		if (!userId) return res.json({ success: true, data: { attempt_id: null } });
		const l = await findLesson(String(req.params.key));
		if (!l || (l.status !== 'published' && !staffPreview(req))) return res.status(404).json({ success: false, message: 'Not found' });
		if (l.is_premium && !(await isPremiumUser(database, userId, logger))) return res.status(403).json({ success: false, code: 'PREMIUM', message: 'Premium only' });
		// A fresh go drops the unfinished ones
		await database('il_attempts').where({ user_id: userId, lesson_id: l.id }).whereNull('finished_at').delete();
		const [row] = await database('il_attempts').insert({ user_id: userId, lesson_id: l.id }).returning('id');
		return res.json({ success: true, data: { attempt_id: row.id ?? row } });
	}));

	router.post('/intensive/lessons/:key/gist', wrap('gist', async (req, res) => {
		const l = await findLesson(String(req.params.key));
		const choice = Number(req.body?.choice);
		if (!l || !Number.isInteger(choice)) return res.status(404).json({ success: false, message: 'Not found' });
		const right = choice === l.gist_answer;
		const a = await ownAttempt(req, l.id);
		if (a && !a.finished_at) await database('il_attempts').where('id', a.id).update({ gist_choice: choice, gist_right: right });
		const tr = await trOf(l.id, langOf(req));
		return res.json({ success: true, data: { right, answer: l.gist_answer, explain: pickOr(tr, 'gist_explain', l.gist_explain) } });
	}));

	/** A sentence's translation in the learner's language: another language from il_translations ('s<n>:sub'), else the base (il_sentences.sub) */
	const subOfSentence = async (sentenceId: string, lessonId: string, lang: string): Promise<string | null> => {
		if (lang !== 'vi-VN') {
			const row = await database('il_translations').where({ lesson_id: lessonId, lang }).whereRaw(`key = 's' || (SELECT n FROM il_sentences WHERE id = ?)::text || ':sub'`, [sentenceId]).first('text');
			if (row) return row.text;
		}
		const base = await database('il_sentences').where({ id: sentenceId }).first('sub');
		return base?.sub ?? null;
	};
	router.post('/intensive/check', wrap('check', async (req, res) => {
		const s = await sentenceOf(String(req.body?.sentence_id || ''), req);
		if (!s) return res.status(404).json({ success: false, message: 'Not found' });
		const round = Number(req.body?.round) === 2 ? 2 : 1;
		const typed = clean(req.body?.typed);
		const listens = Math.max(1, Math.min(9, Math.round(Number(req.body?.listens) || 1)));
		const d = diffWords(s.text, typed);
		const traps = trapsOf(s, await trOf(s.lesson_id, langOf(req)));
		const labels = round === 1 ? labelMisses(s.text, traps, d.words, [], null, typed) : [];
		const slowTyped = clean(req.body?.slow_typed);
		const a = await ownAttempt(req, s.lesson_id);
		// A retry after a hint is not saved: round 1 keeps the first try
		if (a && !a.finished_at && !req.body?.retry) {
			await database.raw(`INSERT INTO il_results (attempt_id, sentence_id, round, typed, words_total, words_right, listens, labels)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb)
				ON CONFLICT (attempt_id, sentence_id, round) DO UPDATE SET typed = EXCLUDED.typed, words_total = EXCLUDED.words_total,
					words_right = EXCLUDED.words_right, listens = EXCLUDED.listens, labels = EXCLUDED.labels`,
			[a.id, s.id, round, typed, d.total, d.right, listens, JSON.stringify(labels)]);
		}
		// reveal: false holds the sentence back (the learner is about to try again blind at 0.75x): only the score goes out
		// (with marks on what was typed: which words are wrong and where words are missing, never which words they should be)
		if (round === 1 && req.body?.reveal === false) return res.json({ success: true, data: { right: d.right, total: d.total, ok: isRight(d), marks: d.marks, tail_gap: d.tailGap, hint: hintOf(s.text, d.words) } });
		const slow = slowTyped ? diffWords(s.text, slowTyped) : null;
		return res.json({ success: true, data: {
			right: d.right, total: d.total, ok: isRight(d), words: d.words, marks: d.marks, tail_gap: d.tailGap, text: s.text, labels,
			sub: await subOfSentence(s.id, s.lesson_id, langOf(req)),
			traps: round === 1 ? traps : [],
			slow: slow ? { right: slow.right, total: slow.total, words: slow.words, marks: slow.marks, tail_gap: slow.tailGap } : null,
		} });
	}));

	router.post('/intensive/slow', wrap('slow', async (req, res) => {
		const s = await sentenceOf(String(req.body?.sentence_id || ''), req);
		if (!s) return res.status(404).json({ success: false, message: 'Not found' });
		const typed = clean(req.body?.typed);
		const slowTyped = clean(req.body?.slow_typed);
		const first = diffWords(s.text, typed);
		// No answer yet about which words are new: rare words are taken as unknown until the learner says otherwise
		const unknown: string[] = Array.isArray(req.body?.unknown)
			? req.body.unknown.slice(0, 40).map((w: unknown) => clean(w, 40)).filter(Boolean)
			: likelyUnknown(first.words);
		const slow = slowTyped ? diffWords(s.text, slowTyped) : null;
		const hinted: number[] = (Array.isArray(req.body?.hinted) ? req.body.hinted : []).map(Number).filter((n: number) => Number.isInteger(n) && n >= 0).slice(0, 80);
		// The learner's answers to "misheard or misspelt?": { word: 'spelling' | 'misheard' }
		const heard: Record<string, Heard> = {};
		for (const [w, h] of Object.entries(req.body?.heard && typeof req.body.heard === 'object' ? req.body.heard : {}).slice(0, 40)) {
			if (h === 'spelling' || h === 'misheard') heard[clean(w, 40).toLowerCase().replace(/['’]/g, '')] = h;
		}
		const traps = trapsOf(s, await trOf(s.lesson_id, langOf(req)));
		const confirm = toConfirm(labelMisses(s.text, traps, first.words, unknown, slow?.words ?? null, typed, hinted));
		const raw = labelMisses(s.text, traps, first.words, unknown, slow?.words ?? null, typed, hinted, heard);
		// The skill each miss points to: its name and how many lessons it has (only skills that are published)
		const slugs = [...new Set(raw.map((m) => m.skill).filter((x): x is string => !!x))];
		const skills: any[] = slugs.length ? (await database.raw(`
			SELECT k.slug, k.name, (SELECT count(*)::int FROM listening_lessons l WHERE l.skill_id = k.id AND l.status = 'published') AS lessons
			FROM listening_skills k WHERE k.status = 'published' AND k.slug = ANY(?)`, [slugs])).rows : [];
		const misses = raw.map(({ skill, ...m }) => ({ ...m, ...(skill && skills.find((k) => k.slug === skill) ? { skill: skills.find((k) => k.slug === skill) } : {}) }));
		const label = sentenceLabel(misses);
		const userId = userOf(req);
		const a = await ownAttempt(req, s.lesson_id);
		if (a && !a.finished_at) {
			await database('il_results').where({ attempt_id: a.id, sentence_id: s.id, round: 1 })
				.update({ unknown: JSON.stringify(unknown), slow_typed: slowTyped || null, labels: JSON.stringify(misses) });
		}
		// A missed sentence (not only unknown words) comes back as a Review card; one already held keeps its schedule
		let cardMade = false;
		if (userId && a && label && misses.some((m) => !NOT_LISTENING.includes(m.label))) {
			const made = await database('il_review_cards').insert(newCard(userId, s.id, label)).onConflict(['user_id', 'sentence_id']).ignore().returning('sentence_id');
			cardMade = made.length > 0;
		}
		// The words worth asking "do you know it?" about: content words (everyone knows "do" or "the")
		const ask = [...new Set(misses.map((m) => m.word).filter((w) => !FUNCTION_WORDS.has(w.replace(/'/g, ''))))];
		return res.json({ success: true, data: { misses, label, unknown, ask, confirm, slow_right: slow?.right ?? null, slow_total: slow?.total ?? null, card: cardMade } });
	}));

	/** A word heard in other videos of the library (other speakers): up to 5 subtitle lines, one per channel */
	router.get('/intensive/word-clips', wrap('word-clips', async (req, res) => {
		const word = String(req.query?.word || '').toLowerCase().replace(/[‘’]/g, "'").trim();
		if (!/^[a-z][a-z']{1,29}$/.test(word)) return res.status(400).json({ success: false, message: 'Bad word' });
		const not = String(req.query?.not || '');
		const re = `\\m${word.replace(/'/g, "['’]")}\\M`;
		const { rows } = await database.raw(`
			SELECT * FROM (
				SELECT DISTINCT ON (sv.channel_name) sv.youtube_video_id AS video_id, sv.channel_name AS channel,
					(c->>'start')::int AS start, (c->>'end')::int AS "end", c->>'text' AS text
				FROM source_videos sv, jsonb_array_elements(sv.transcript) c
				WHERE sv.status = 'published' AND sv.transcript_kind = 'manual' AND sv.youtube_video_id <> ?
					AND sv.transcript::text ~* ? AND c->>'text' ~* ?
					AND (c->>'end')::int - (c->>'start')::int BETWEEN 800 AND 9000
				ORDER BY sv.channel_name, length(c->>'text')
			) x ORDER BY random() LIMIT 5`, [not, re, re]);
		return res.json({ success: true, data: { word, items: rows } });
	}));

	router.post('/intensive/attempts/:id/finish', wrap('finish', async (req, res) => {
		const userId = userOf(req);
		const a = await ownAttempt(req);
		if (!userId || !a) return res.status(404).json({ success: false, message: 'Not found' });
		const rows = await database('il_results as r').join('il_sentences as s', 's.id', 'r.sentence_id')
			.select('s.n', 'r.round', 'r.words_right', 'r.words_total', 'r.labels').where('r.attempt_id', a.id).orderBy('s.n');
		const sentences = new Map<number, { n: number; total: number; r1: number | null; r2: number | null }>();
		const labels: Record<string, number> = {};
		for (const r of rows) {
			const e = sentences.get(r.n) || { n: r.n, total: r.words_total, r1: null, r2: null };
			if (r.round === 1) {
				e.r1 = r.words_right; e.total = r.words_total;
				for (const m of r.labels || []) labels[m.label] = (labels[m.label] || 0) + 1;
			} else e.r2 = r.words_right;
			sentences.set(r.n, e);
		}
		let xp = 0;
		let firstTime = false;
		if (!a.finished_at) {
			await database('il_attempts').where('id', a.id).update({ finished_at: database.fn.now() });
			const first = !(await database('il_attempts').where({ user_id: userId, lesson_id: a.lesson_id }).whereNotNull('finished_at').whereNot('id', a.id).first());
			firstTime = first;
			const won = await recordPractice(database, userId, {
				attempts: sentences.size,
				xp: first
					? { reason: 'intensive', dedupe: `intensive:${a.lesson_id}`, lessonId: null }
					: { reason: 'intensive', dedupe: `intensive:${a.lesson_id}:${vnDay()}`, lessonId: null, amount: IL.xpAgain },
			});
			xp = won.xp;
			await grantRewards(context, req.schema, userId, won.rewards);
		}
		const cards = Number((await database('il_review_cards as c').join('il_sentences as s', 's.id', 'c.sentence_id')
			.where({ 'c.user_id': userId, 's.lesson_id': a.lesson_id }).count('* as n').first())?.n || 0);
		// Each sentence's translation: the base (Vietnamese) in il_sentences.sub, another language in il_translations ('s<n>:sub');
		// a missing one falls back to the base
		const subs: Record<string, string> = {};
		for (const s of await database('il_sentences').select('n', 'sub').where('lesson_id', a.lesson_id)) if (s.sub) subs[String(s.n)] = s.sub;
		const tr = await trOf(a.lesson_id, langOf(req));
		if (tr) for (const [k, v] of tr) if (/^s\d+:sub$/.test(k)) subs[k.slice(1, -4)] = v;
		return res.json({ success: true, data: { gist_right: a.gist_right, sentences: [...sentences.values()], labels, cards, xp, first: firstTime, subs, ...(await mainOf(userId)) } });
	}));

	router.get('/intensive/review', wrap('review', async (req, res) => {
		const userId = userOf(req);
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const due = await database.raw(`
			SELECT c.sentence_id, c.label, s.start_ms, s.end_ms, s.text, sv.youtube_video_id
			FROM il_review_cards c
			JOIN il_sentences s ON s.id = c.sentence_id
			JOIN il_lessons l ON l.id = s.lesson_id
			JOIN source_videos sv ON sv.id = l.source_video_id
			WHERE c.user_id = ? AND c.due <= now() AND l.status = 'published'
			ORDER BY c.due LIMIT ${IL.reviewSession}`, [userId]);
		const total = Number((await database('il_review_cards').where('user_id', userId).where('due', '<=', database.fn.now()).count('* as n').first())?.n || 0);
		return res.json({ success: true, data: { total, items: due.rows.map((r: any) => ({
			sentence_id: r.sentence_id, label: r.label, video_id: r.youtube_video_id, start: r.start_ms, end: r.end_ms, words: tokens(r.text).length,
		})) } });
	}));

	router.post('/intensive/review/answer', wrap('review-answer', async (req, res) => {
		const userId = userOf(req);
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const s = await sentenceOf(String(req.body?.sentence_id || ''), req);
		const row = s ? await database('il_review_cards').where({ user_id: userId, sentence_id: s.id }).first() : null;
		if (!s || !row) return res.status(404).json({ success: false, message: 'Not found' });
		const listens = Math.max(1, Math.min(9, Math.round(Number(req.body?.listens) || 1)));
		const d = diffWords(s.text, clean(req.body?.typed));
		const correct = isRight(d);
		const grade = reviewGrade(correct, listens, !!req.body?.slow);
		const next = schedule(row, grade);
		await database('il_review_cards').where({ user_id: userId, sentence_id: s.id }).update(cardColumns(next));
		const won = await recordPractice(database, userId, {
			attempts: 1,
			xp: correct ? { reason: 'intensive_review', dedupe: `intensive_review:${s.id}:${vnDay()}`, lessonId: null } : null,
		});
		await grantRewards(context, req.schema, userId, won.rewards);
		const days = Math.max(0, Math.round((new Date(next.due).getTime() - Date.now()) / 86400000));
		return res.json({ success: true, data: { correct, right: d.right, total: d.total, words: d.words, text: s.text, traps: trapsOf(s, await trOf(s.lesson_id, langOf(req))), next_in_days: days, xp: won.xp } });
	}));
}
