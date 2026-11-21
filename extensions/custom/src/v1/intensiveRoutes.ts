/**
 * Intensive Listening for learners (lib/intensive.ts says how a sentence is checked and labelled).
 *
 *   GET  /intensive/home                        passages (paged; level, focus, status todo|done, premium free, sort fit|popular|level; fit, the default, is "For you": my topics and one in four from another topic, lib/recommend.ts, guests send ?topics=a,b), Review cards due, what the learner's misses say
 *   GET  /intensive/lessons/:key                one passage to play: the video, the gist question, the sentences' times (never their text)
 *   POST /intensive/lessons/:key/start          a signed-in learner gets an attempt (guests play without one)
 *   POST /intensive/lessons/:key/gist           { choice, round?: 1|2, attempt_id? } -> saved (never marked: the answer is on the result)
 *   POST /intensive/ladder                      { sentence_id, typed, used, done[], avoid[] } -> the narrowing ladder for a content key word still missed: a clear line with a blank ({ before, after }) and whether its meaning can be asked
 *   POST /intensive/ladder/clear                { sentence_id, typed, done[], heard } -> heard (typed the missing word)
 *   POST /intensive/ladder/meaning              { sentence_id, typed, choice? } -> options (no choice) or right (choice null = "I don't know": a new word)
 *   POST /intensive/ladder/skip | /ladder/practice | /attempts/:id/practice   closed without answering | a clip for a missed key word on the result | how that round went
 *   POST /intensive/lessons/:key/feedback | /diag-vote   the result card (rating 1-3, tags, comment) | a thumb on one diagnosis *   GET  /intensive/lessons/:key/gist-answer    the answer, why, the sentences that hold it, key words by sentence
 *   POST /intensive/check                       { sentence_id, typed, round 1|2, listens, reveal?, slow_typed?, attempt_id? } -> the words right and
 *                                               wrong, the sentence, its traps with the real sound; round 1 also gives a first label per miss.
 *                                               reveal: false (round 1) returns only the score, the marks and a hint (the sentence up to the
 *                                               first word missed, the rest as stars); retry: true = a try after a hint, not saved
 *                                               (POST /intensive/slow takes `hinted`: word indices the hints gave away, never "speed")
 *   POST /intensive/slow                        { sentence_id, typed, slow_typed, unknown[], heard?, attempt_id? } -> the final labels;
 *                                               `confirm` = misses to ask "misheard or misspelt?" about, `heard` the answers
 *                                               (a word right at 0.75x is "speed"); makes a Review card for a missed sentence
 *   POST /intensive/explain                     { sentence_id, typed, lang } -> the AI's reason per missed word (sound, IPA, a tip), cached in
 *                                               il_explain; { available: false } when the AI is off (lib/ilExplain.ts)
 *   GET  /intensive/word-clips?word=&not=       the word said in other videos (subtitle lines, one per channel), to hear it more
 *   POST /intensive/attempts/:id/finish         -> the passage's result, the labels, XP
 *   GET  /intensive/review                      Review cards due: the sentence's video and times, never its text
 *   POST /intensive/review/answer               { sentence_id, typed, listens, slow? } -> checked, next review in days
 *
 * Guests can play free passages; nothing is saved for them.
 */
import { dueReviews } from '../lib/reviewDue';
import { IL, FUNCTION_WORDS, NOT_LISTENING, diffWords, hintOf, isRight, labelMisses, likelyUnknown, withChunks, rankOf, newCard, sameWord, toConfirm, type Heard, sentenceLabel, tokens, type Label, type Trap } from '../lib/intensive';
import { meaningFor, meaningPool } from '../lib/meanings';
import { thumbOf } from '../lib/extensive';
import { TOPIC_JOINS, interestOf, lessonTopicSql, rankAll, topicsParam } from '../lib/recommend';
import { UUID_RE } from '../lib/lessons';
import { isPremiumUser } from '../lib/premium';
import { isStaff } from '../lib/staff';
import { grantRewards, recordPractice, vnDay } from '../lib/xp';
import { touchStudy } from '../lib/studyTime';
import { aiConfigured } from '../lib/ai';
import { explainMisses, missRuns } from '../lib/ilExplain';

const KEY_RE = /^[a-z0-9]{8}$/;
/** A passage's readable key, from its title (il_lessons.slug): you-cant-unboil-an-egg */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const clean = (v: unknown, max = 600) => String(v ?? '').slice(0, max);

/** A user id put straight into SQL text: only a real UUID, anything else cannot reach the query */
const sqlUuid = (id: string) => {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Bad user id');
	return id;
};

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
		if (!UUID_RE.test(key) && !KEY_RE.test(key) && !(key.length <= 120 && SLUG_RE.test(key))) return null;
		return database('il_lessons as l').join('source_videos as sv', 'sv.id', 'l.source_video_id')
			.select('l.*', 'sv.youtube_video_id', 'sv.channel_name', 'sv.thumbnail_url')
			.where((q: any) => (UUID_RE.test(key) ? q.where('l.id', key) : q.where('l.short_id', key).orWhere('l.slug', key))).first();
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
	 *  title | intro | explore | gist_prompt | gist_o<i> | gist_explain | s<n>:t<j>:note | s<n>:t<j>:real | s<n>:sub */
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

	/** The shared chunks (il_chunks, edited in the admin), as traps. Few rows, read at most once a minute */
	let chunkCache: { at: number; rows: Trap[] } | null = null;
	const chunksOf = async (): Promise<Trap[]> => {
		if (chunkCache && Date.now() - chunkCache.at < 60_000) return chunkCache.rows;
		const rows = await database('il_chunks').where('active', true).select('text', 'kind', 'real', 'note', 'skill');
		chunkCache = { at: Date.now(), rows: rows.map((r: any) => ({ text: r.text, kind: r.kind, real: r.real ?? undefined, note: r.note ?? undefined, skill: r.skill ?? undefined })) };
		return chunkCache.rows;
	};

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

	// The topic is the passage's own, else its video's (lib/recommend.ts lessonTopicSql)
	const CARD_SQL = `
		SELECT l.id, l.short_id, l.slug, COALESCE(tt.text, l.title) AS title, l.level, %TOPIC% AS topic, COALESCE(tn.name, vt.name) AS topic_name, l.focus, l.is_premium, l.start_ms, l.end_ms,
			sv.youtube_video_id, sv.thumbnail_url, sv.channel_name,
			(SELECT count(*)::int FROM il_sentences s WHERE s.lesson_id = l.id) AS sentences,
			(SELECT count(*)::int FROM il_attempts a WHERE a.lesson_id = l.id AND a.finished_at IS NOT NULL) AS plays
			%DONE%
		FROM il_lessons l
		JOIN source_videos sv ON sv.id = l.source_video_id
		${TOPIC_JOINS}
		LEFT JOIN video_topics vt ON vt.code = %TOPIC%
		LEFT JOIN video_topic_translations tn ON tn.code = %TOPIC% AND tn.lang = '%LANG%'
		LEFT JOIN il_translations tt ON tt.lesson_id = l.id AND tt.lang = '%LANG%' AND tt.key = 'title'
		WHERE l.status = 'published'`;
	/** The learner's language (?lang=xx-XX); the topic name falls back to the base (Vietnamese) one */
	const langOf = (req: any) => (/^[a-z]{2}-[A-Z]{2}$/.test(String(req.query?.lang ?? req.body?.lang ?? '')) ? String(req.query?.lang ?? req.body?.lang) : 'vi-VN');
	const cardSql = (userId: string | null, lang = 'vi-VN') => CARD_SQL.replace(/%TOPIC%/g, lessonTopicSql('l')).replace(/%LANG%/g, lang).replace('%DONE%', userId
		? `, EXISTS (SELECT 1 FROM il_attempts a WHERE a.lesson_id = l.id AND a.user_id = '${sqlUuid(userId)}' AND a.finished_at IS NOT NULL) AS done`
		: ', false AS done');
	const card = (r: any, premium: boolean) => ({
		id: r.id, short_id: r.short_id, slug: r.slug, title: r.title, level: r.level, topic: r.topic, topic_name: r.topic_name, focus: r.focus, sentences: r.sentences,
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
		let rows: any[];
		let total: number;
		if (sort === 'fit') {
			// "For you": the whole filtered list ranked (a few hundred cards at most), then the page cut from it
			const picks = topicsParam(req.query?.topics);
			const interest = await interestOf(database, userId, picks);
			const all = (await database.raw(`SELECT x.*, (SELECT count(*)::int FROM il_attempts a WHERE a.lesson_id = x.id) AS starts
				FROM (${cardSql(userId, langOf(req))}${where}) x${outer}`, params)).rows;
			// Easier passages first: Level 1 fits best
			const ranked = rankAll(all.map((r: any) => ({ ...card(r, premium), starts: r.starts })), interest, (r: any) => 1 - 0.15 * (Number(r.level) - 1),
				`${userId || 'guest'}:${new Date().toISOString().slice(0, 10)}:${picks.join(',')}`);
			total = ranked.length;
			rows = ranked.slice((page - 1) * limit, page * limit).map(({ starts, ...c }: any) => c);
		} else {
			const res2 = await database.raw(`SELECT *, count(*) OVER()::int AS full_count FROM (${cardSql(userId, langOf(req))}${where}) x${outer}
				ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);
			total = res2.rows[0]?.full_count || 0;
			rows = res2.rows.map((r: any) => card(r, premium));
		}
		const due = userId ? await dueReviews(database, userId) : 0;
		const mine = userId ? await mainOf(userId) : { counts: [], main: null };
		return res.json({ success: true, data: { items: rows, total, page, limit, due, signed_in: !!userId, ...mine } });
	}));

	router.get('/intensive/lessons/:key', wrap('lesson', async (req, res) => {
		const userId = userOf(req);
		const l = await findLesson(String(req.params.key));
		if (!l || (l.status !== 'published' && !staffPreview(req))) return res.status(404).json({ success: false, message: 'Not found' });
		const premium = await isPremiumUser(database, userId, logger);
		const locked = !!l.is_premium && !premium && !req.accountability?.admin;
		const sentences = locked ? [] : await database('il_sentences').select('id', 'n', 'start_ms', 'end_ms', 'text').where('lesson_id', l.id).orderBy('n');
		const tr = await trOf(l.id, langOf(req));
		// The learner's last finished go: the page opens its result instead of a fresh start
		const last = userId ? await database('il_attempts').where({ user_id: userId, lesson_id: l.id }).whereNotNull('finished_at').orderBy('finished_at', 'desc').first('seq') : null;
		return res.json({ success: true, data: {
			last_result: last?.seq ?? null,
			id: l.id, short_id: l.short_id, slug: l.slug, title: pickOr(tr, 'title', l.title), level: l.level, intro: pickOr(tr, 'intro', l.intro), focus: l.focus, channel: l.channel_name,
			// "Khám phá": what the video teaches, shown on the result (not to a learner the passage is locked for)
			explore: locked ? null : pickOr(tr, 'explore', l.explore ?? null),
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
		const prev = await database('il_attempts').where({ user_id: userId, lesson_id: l.id }).max('seq as m').first();
		const seq = Number(prev?.m || 0) + 1;
		const [row] = await database('il_attempts').insert({ user_id: userId, lesson_id: l.id, seq }).returning(['id', 'seq']);
		return res.json({ success: true, data: { attempt_id: row.id, seq: row.seq } });
	}));

	/** The gist answer is only saved here, never marked: round 1 is asked before the sentences, round 2 after them, and the
	 *  learner sees right or wrong only on the result (GET .../gist-answer), so the two answers can be compared. */
	router.post('/intensive/lessons/:key/gist', wrap('gist', async (req, res) => {
		const l = await findLesson(String(req.params.key));
		const choice = Number(req.body?.choice);
		if (!l || !Number.isInteger(choice)) return res.status(404).json({ success: false, message: 'Not found' });
		const second = Number(req.body?.round) === 2;
		const right = choice === l.gist_answer;
		const a = await ownAttempt(req, l.id);
		if (a && !a.finished_at) {
			await database('il_attempts').where('id', a.id).update(second ? { gist_choice2: choice, gist_right2: right } : { gist_choice: choice, gist_right: right });
			await touchStudy(database, a.user_id);
		}
		return res.json({ success: true, data: { saved: !!a } });
	}));

	/** The answer to the gist question, with the sentences that hold it and each sentence's key words (lower case, no
	 *  apostrophe) by sentence n: the page matches them with the words the learner missed. Asked for on the result only. */
	router.get('/intensive/lessons/:key/gist-answer', wrap('gist-answer', async (req, res) => {
		const l = await findLesson(String(req.params.key));
		if (!l || (l.status !== 'published' && !staffPreview(req))) return res.status(404).json({ success: false, message: 'Not found' });
		const tr = await trOf(l.id, langOf(req));
		const keys: Record<string, string[]> = {};
		for (const s of await database('il_sentences').select('n', 'key_words').where('lesson_id', l.id)) if (s.key_words?.length) keys[String(s.n)] = s.key_words;
		return res.json({ success: true, data: { answer: l.gist_answer, explain: pickOr(tr, 'gist_explain', l.gist_explain), sentences: l.gist_sentences || [], keys } });
	}));

	// ── The narrowing ladder (before the answer is shown) ─────────────────────────────
	// A CONTENT key word (il_sentences.key_words, not a small word like but / not / can't) still missed after the retry at
	// 0.75x: 1. hear a line of another video where it is said clearly and type the missing word (the line is shown with a
	// blank: heard = only fast speech hides it); 2. if not, pick its meaning (knows it = knows the spelling, not the sound;
	// wrong or "I don't know" = a new word). Small key words skip the ladder (their cause is known: they are reduced in fast
	// speech) and go straight to practice. Stateless: each call sends the sentence, the last typed try, and `done` (words
	// already diagnosed in this passage, never asked twice).
	const LADDER_MAX = 2;
	const keyOf = (w: string) => w.toLowerCase().replace(/['’]/g, '');
	const wordsArg = (v: unknown): string[] => (Array.isArray(v) ? v.slice(0, 20).map((w) => keyOf(clean(w, 40))).filter(Boolean) : []);
	/** The missed key word to diagnose: the first missed content word of the sentence that was not asked before */
	const ladderWord = (s: any, typed: string, done: string[] = []): string | null => {
		const keys = new Set<string>(s.key_words || []);
		if (!keys.size) return null;
		return diffWords(s.text, typed).words.find((x) => (x.status === 'wrong' || x.status === 'missing') && keys.has(keyOf(x.w)) && !FUNCTION_WORDS.has(keyOf(x.w)) && !done.includes(keyOf(x.w)))?.w ?? null;
	};
	type Cloze = { video_id: string; start: number; end: number; before: string; after: string };
	/** A line of another video with the word in the middle (never the first or last word, so a cut cannot clip it), shown
	 *  as before / after the blank. `clear`: said slowly. `avoid`: lines already tried ("video:start"). */
	const clozeClip = async (word: string, notVideo: string, clear: boolean, avoid: string[] = []): Promise<Cloze | null> => {
		const w = word.toLowerCase().replace(/[^a-z']/g, '').replace(/'/g, "['’]");
		if (!w) return null;
		const { rows } = await database.raw(`
			SELECT sv.youtube_video_id AS video_id, (c->>'start')::int AS start, (c->>'end')::int AS "end", c->>'text' AS text
			FROM source_videos sv, jsonb_array_elements(sv.transcript) c
			WHERE sv.status = 'published' AND sv.transcript_kind = 'manual' AND sv.youtube_video_id <> ?
				AND sv.transcript::text ~* ? AND c->>'text' ~* ?
				AND (c->>'end')::int - (c->>'start')::int BETWEEN 1200 AND 7000
			ORDER BY random() LIMIT 60`, [notVideo, `\\m${w}\\M`, `\\m${w}\\M`]);
		const target = keyOf(word);
		for (const r of rows) {
			const text = String(r.text || '').replace(/\s+/g, ' ').trim();
			if (/[\[\]♪]/.test(text) || avoid.includes(`${r.video_id}:${r.start}`)) continue;
			const toks = text.split(' ');
			if (toks.length < 4 || toks.length > 14) continue;
			if (clear && toks.length / ((r.end - r.start) / 1000) > 3.0) continue;
			const at = toks.map((t, i) => (keyOf(t.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '')) === target ? i : -1)).filter((i) => i >= 0);
			if (at.length !== 1 || at[0]! < 1 || at[0]! > toks.length - 2) continue;
			const i = at[0]!;
			return { video_id: r.video_id, start: Number(r.start), end: Number(r.end), before: toks.slice(0, i).join(' '), after: toks.slice(i + 1).join(' ') };
		}
		return null;
	};
	const baseLang = (req: any) => langOf(req).slice(0, 2).toLowerCase();
	/** The meaning to ask for: only a content word with a meaning in the learner's language */
	const askableMeaning = async (word: string, req: any) => {
		if (FUNCTION_WORDS.has(keyOf(word))) return null;
		return meaningFor(database, keyOf(word), baseLang(req));
	};
	const saveLadder = async (a: any, sentenceId: string, word: string, outcome: string) => {
		if (!a || a.finished_at) return;
		await database('il_results').where({ attempt_id: a.id, sentence_id: sentenceId, round: 1 }).update({ ladder: JSON.stringify({ word: keyOf(word), outcome }) });
	};
	const lessonVideo = async (lessonId: string) =>
		(await database('il_lessons as l').join('source_videos as sv', 'sv.id', 'l.source_video_id').where('l.id', lessonId).first('sv.youtube_video_id'))?.youtube_video_id || '';
	router.post('/intensive/ladder', wrap('ladder', async (req, res) => {
		const s = await sentenceOf(String(req.body?.sentence_id || ''), req);
		if (!s) return res.status(404).json({ success: false, message: 'Not found' });
		const done = wordsArg(req.body?.done);
		const used = Math.max(0, Math.min(9, Number(req.body?.used) || 0));
		// Two turns a passage; the last one is kept for a sentence that holds the gist (if the passage says which they are)
		const lesson = await database('il_lessons').where('id', s.lesson_id).first('gist_sentences');
		const gist: number[] = (lesson?.gist_sentences || []).map(Number);
		if (used >= LADDER_MAX || (used === LADDER_MAX - 1 && gist.length && !gist.includes(Number(s.n)))) return res.json({ success: true, data: { available: false } });
		const word = ladderWord(s, clean(req.body?.typed), done);
		if (!word) return res.json({ success: true, data: { available: false } });
		const clip = await clozeClip(word, await lessonVideo(s.lesson_id), true, Array.isArray(req.body?.avoid) ? req.body.avoid.slice(0, 20).map((x: unknown) => clean(x, 60)) : []);
		const meaning = !!(await askableMeaning(word, req));
		return res.json({ success: true, data: { available: !!clip || meaning, clip, meaning } });
	}));
	router.post('/intensive/ladder/clear', wrap('ladder-clear', async (req, res) => {
		const s = await sentenceOf(String(req.body?.sentence_id || ''), req);
		if (!s) return res.status(404).json({ success: false, message: 'Not found' });
		const word = ladderWord(s, clean(req.body?.typed), wordsArg(req.body?.done));
		if (!word) return res.json({ success: true, data: { heard: false, next: 'none', word: null } });
		const a = await ownAttempt(req, s.lesson_id);
		const heard = !!sameWord(word, clean(req.body?.heard, 40));
		if (heard) { await saveLadder(a, s.id, word, 'clear'); return res.json({ success: true, data: { heard: true, next: 'none', word } }); }
		// Not heard: the meaning is asked for next (a word with no meaning to ask ends the ladder here)
		if (await askableMeaning(word, req)) return res.json({ success: true, data: { heard: false, next: 'meaning', word: null } });
		await saveLadder(a, s.id, word, 'unclear');
		return res.json({ success: true, data: { heard: false, next: 'none', word } });
	}));
	router.post('/intensive/ladder/meaning', wrap('ladder-meaning', async (req, res) => {
		const s = await sentenceOf(String(req.body?.sentence_id || ''), req);
		if (!s) return res.status(404).json({ success: false, message: 'Not found' });
		const word = ladderWord(s, clean(req.body?.typed), wordsArg(req.body?.done));
		const m = word ? await askableMeaning(word, req) : null;
		if (!word || !m) return res.json({ success: true, data: { available: false } });
		const a = await ownAttempt(req, s.lesson_id);
		const choice = req.body?.choice;
		if (choice === undefined) {
			// Three meanings, one right: the others are first senses of other words of the same kind
			const pool = (await meaningPool(database, baseLang(req), m.pos)).filter((x) => x && x !== m.short);
			const wrong = [...new Set(pool)].sort(() => Math.random() - 0.5).slice(0, 2);
			const options = [m.short, ...wrong].sort(() => Math.random() - 0.5);
			return res.json({ success: true, data: { available: options.length >= 2, word, options } });
		}
		// null = "I don't know": the learner says it is a new word
		const right = choice !== null && String(choice) === m.short;
		await saveLadder(a, s.id, word, right ? 'known' : 'new');
		return res.json({ success: true, data: { right, word, meaning: m.short } });
	}));
	/** The learner closed the drawer without answering: kept as skipped (no diagnosis, nothing asked again) */
	router.post('/intensive/ladder/skip', wrap('ladder-skip', async (req, res) => {
		const s = await sentenceOf(String(req.body?.sentence_id || ''), req);
		if (!s) return res.status(404).json({ success: false, message: 'Not found' });
		const word = ladderWord(s, clean(req.body?.typed), wordsArg(req.body?.done));
		if (word) await saveLadder(await ownAttempt(req, s.lesson_id), s.id, word, 'skipped');
		return res.json({ success: true });
	}));
	/** "Practise the key words you missed" (result): another line with the word, said as people really say it, with a blank.
	 *  The word must be a key word of that sentence; the learner has seen the answer by now, so it is not hidden. */
	router.post('/intensive/ladder/practice', wrap('ladder-practice', async (req, res) => {
		const s = await sentenceOf(String(req.body?.sentence_id || ''), req);
		if (!s) return res.status(404).json({ success: false, message: 'Not found' });
		const word = keyOf(clean(req.body?.word, 40));
		if (!word || !(s.key_words || []).includes(word)) return res.status(422).json({ success: false, message: 'Not a key word of this sentence' });
		const clip = await clozeClip(word, await lessonVideo(s.lesson_id), false, Array.isArray(req.body?.avoid) ? req.body.avoid.slice(0, 20).map((x: unknown) => clean(x, 60)) : []);
		return res.json({ success: true, data: { clip, word } });
	}));
	/** How the practice round at the end went: { total, done, right } */
	router.post('/intensive/attempts/:id/practice', wrap('practice', async (req, res) => {
		const a = await ownAttempt(req);
		if (!a) return res.json({ success: true });
		const n = (v: unknown) => Math.max(0, Math.min(99, Math.round(Number(v) || 0)));
		await database('il_attempts').where('id', a.id).update({ practice: JSON.stringify({ total: n(req.body?.total), done: n(req.body?.done), right: n(req.body?.right) }) });
		return res.json({ success: true });
	}));

	// ── Why a learner missed words: the AI's reason per missed word, cached by sentence + typed answer + language ──
	const explainHits = new Map<string, number[]>();
	/** At most 40 AI calls per learner (or address) per 10 minutes; a cached answer costs nothing and is never counted */
	const explainAllowed = (key: string) => {
		const now = Date.now();
		const hits = (explainHits.get(key) || []).filter((t) => now - t < 600_000);
		const ok = hits.length < 40;
		if (ok) hits.push(now);
		explainHits.set(key, hits);
		return ok;
	};
	/** { sentence_id, typed (the first try), lang } -> { available, items: [{ word, heard, ipa_word, ipa_heard, why, tip }] } (available false = AI off or down) */
	router.post('/intensive/explain', wrap('explain', async (req, res) => {
		const s = await sentenceOf(String(req.body?.sentence_id || ''), req);
		const typed = clean(req.body?.typed);
		if (!s || !typed.trim()) return res.status(422).json({ success: false, message: 'Bad request' });
		const runs = missRuns(s.text, typed);
		if (!runs.length) return res.json({ success: true, data: { available: true, items: [] } });
		const lang = langOf(req);
		const typedKey = tokens(typed).join(' ').slice(0, 600);
		const hit = await database('il_explain').where({ sentence_id: s.id, lang, typed_key: typedKey }).first();
		if (hit) return res.json({ success: true, data: { available: true, items: hit.items } });
		if (!aiConfigured()) return res.json({ success: true, data: { available: false, items: [] } });
		if (!explainAllowed(userOf(req) || String(req.ip))) return res.status(429).json({ success: false, message: 'Too many requests' });
		const items = await explainMisses({ sentence: s.text, typed, runs, lang, logger });
		if (!items) return res.json({ success: true, data: { available: false, items: [] } });
		await database.raw(`INSERT INTO il_explain (sentence_id, typed_key, lang, items) VALUES (?, ?, ?, ?::jsonb) ON CONFLICT (sentence_id, lang, typed_key) DO NOTHING`, [s.id, typedKey, lang, JSON.stringify(items)]);
		return res.json({ success: true, data: { available: true, items } });
	}));

	// ── Feedback on the flow: a card on the result, and a thumb on each diagnosis ──────────────
	const ANON_RE = /^[A-Za-z0-9-]{16,64}$/;
	const IL_TAGS = ['too_long', 'too_hard', 'too_easy', 'retry_annoying', 'diagnosis_wrong', 'wrong_answer'];
	const who = (req: any) => {
		const userId = userOf(req);
		const anon = String(req.body?.anonymous_id || '');
		return userId ? { user_id: userId, anonymous_id: null } : ANON_RE.test(anon) ? { user_id: null, anonymous_id: anon } : null;
	};
	router.post('/intensive/lessons/:key/feedback', wrap('feedback', async (req, res) => {
		const l = await findLesson(String(req.params.key));
		const w = who(req);
		const rating = Number(req.body?.rating);
		if (!l || !w || ![1, 2, 3].includes(rating)) return res.status(422).json({ success: false, message: 'Bad request' });
		const tags = (Array.isArray(req.body?.tags) ? req.body.tags : []).filter((t: unknown) => IL_TAGS.includes(String(t))).slice(0, 6);
		const comment = clean(req.body?.comment, 1000).trim() || null;
		const row = { lesson_id: l.id, ...w, rating, tags, comment, locale: clean(req.body?.locale, 10) || null };
		const target = w.user_id ? '(lesson_id, user_id) WHERE user_id IS NOT NULL' : '(lesson_id, anonymous_id) WHERE user_id IS NULL';
		await database.raw(`INSERT INTO il_feedback (lesson_id, user_id, anonymous_id, rating, tags, comment, locale) VALUES (?, ?, ?, ?, ?::text[], ?, ?)
			ON CONFLICT ${target} DO UPDATE SET rating = EXCLUDED.rating, tags = EXCLUDED.tags, comment = EXCLUDED.comment, locale = EXCLUDED.locale, date_created = now()`,
		[row.lesson_id, row.user_id, row.anonymous_id, rating, `{${tags.join(',')}}`, comment, row.locale]);
		return res.json({ success: true });
	}));
	/** A thumb on one diagnosis: { sentence (n), word, outcome, vote 1 | -1 } */
	router.post('/intensive/lessons/:key/diag-vote', wrap('diag-vote', async (req, res) => {
		const l = await findLesson(String(req.params.key));
		const w = who(req);
		const vote = Number(req.body?.vote);
		const n = Number(req.body?.sentence);
		const outcome = String(req.body?.outcome || '');
		const word = keyOf(clean(req.body?.word, 40));
		if (!l || !w || ![1, -1].includes(vote) || !Number.isInteger(n) || n < 1 || n > 99 || !word || !['clear', 'known', 'new', 'unclear'].includes(outcome)) return res.status(422).json({ success: false, message: 'Bad request' });
		const target = w.user_id ? '(lesson_id, user_id, sentence_n, word) WHERE user_id IS NOT NULL' : '(lesson_id, anonymous_id, sentence_n, word) WHERE user_id IS NULL';
		await database.raw(`INSERT INTO il_diag_votes (lesson_id, user_id, anonymous_id, sentence_n, word, outcome, vote) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT ${target} DO UPDATE SET vote = EXCLUDED.vote, outcome = EXCLUDED.outcome, date_created = now()`, [l.id, w.user_id, w.anonymous_id, n, word, outcome, vote]);
		return res.json({ success: true });
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
		const labels = round === 1 ? labelMisses(s.text, withChunks(traps, await chunksOf()), d.words, [], null, typed) : [];
		const slowTyped = clean(req.body?.slow_typed);
		const a = await ownAttempt(req, s.lesson_id);
		if (a && !a.finished_at) await touchStudy(database, a.user_id);
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

	/** "Report a problem" on the sentence on screen: POST /intensive/lessons/:key/issue { issue, comment?, sentence?, typed? } */
	router.post('/intensive/lessons/:key/issue', wrap('issue', async (req, res) => {
		const userId = userOf(req);
		if (!userId) return res.status(401).json({ success: false, message: 'Login first' });
		const lesson = await findLesson(String(req.params?.key || ''));
		if (!lesson) return res.status(404).json({ success: false, message: 'Lesson not found' });
		const issue = String(req.body?.issue || '');
		if (!['subtitle_off', 'wrong_answer', 'marked_wrong', 'video_issue', 'other'].includes(issue)) return res.status(422).json({ success: false, message: 'Invalid issue' });
		const str = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) || null : null);
		const n = Number(req.body?.sentence);
		await database('il_issues').insert({ lesson_id: lesson.id, sentence_n: Number.isInteger(n) && n > 0 && n < 500 ? n : null, user_id: userId, issue, comment: str(req.body?.comment, 2000), typed: str(req.body?.typed, 300) });
		return res.json({ success: true });
	}));
	router.post('/intensive/slow', wrap('slow', async (req, res) => {
		const s = await sentenceOf(String(req.body?.sentence_id || ''), req);
		if (!s) return res.status(404).json({ success: false, message: 'Not found' });
		const typed = clean(req.body?.typed);
		const slowTyped = clean(req.body?.slow_typed);
		const first = diffWords(s.text, typed);
		// Words the learner said are new, plus rare words they did not mark as anything else (they may not mark at all)
		const words40 = (v: unknown): string[] => (Array.isArray(v) ? v.slice(0, 40).map((w: unknown) => clean(w, 40)).filter(Boolean) : []);
		const bareOf = (w: string) => w.toLowerCase().replace(/['’]/g, '');
		const known = new Set(words40(req.body?.known).map(bareOf));
		const unknown: string[] = [...new Set([...words40(req.body?.unknown), ...likelyUnknown(first.words).filter((w) => !known.has(bareOf(w)))])];
		const slow = slowTyped ? diffWords(s.text, slowTyped) : null;
		const hinted: number[] = (Array.isArray(req.body?.hinted) ? req.body.hinted : []).map(Number).filter((n: number) => Number.isInteger(n) && n >= 0).slice(0, 80);
		// The learner's answers to "misheard or misspelt?": { word: 'spelling' | 'misheard' }
		const heard: Record<string, Heard> = {};
		for (const [w, h] of Object.entries(req.body?.heard && typeof req.body.heard === 'object' ? req.body.heard : {}).slice(0, 40)) {
			if (h === 'spelling' || h === 'misheard') heard[clean(w, 40).toLowerCase().replace(/['’]/g, '')] = h;
		}
		const traps = trapsOf(s, await trOf(s.lesson_id, langOf(req)));
		const marked = withChunks(traps, await chunksOf());
		const confirm = toConfirm(labelMisses(s.text, marked, first.words, unknown, slow?.words ?? null, typed, hinted));
		const raw = labelMisses(s.text, marked, first.words, unknown, slow?.words ?? null, typed, hinted, heard);
		// The skill each miss points to: its name and how many lessons it has (only skills that are published)
		const slugs = [...new Set(raw.map((m) => m.skill).filter((x): x is string => !!x))];
		const skills: any[] = slugs.length ? (await database.raw(`
			SELECT k.slug, k.name, (SELECT count(*)::int FROM listening_lessons l WHERE l.skill_id = k.id AND l.status = 'published') AS lessons
			FROM listening_skills k WHERE k.status = 'published' AND k.slug = ANY(?)`, [slugs])).rows : [];
		// Words typed right that the learner marks as not really heard (a lucky guess): kept as misses of their own kind,
		// so they reach the result and Review; the score is not changed. kind: new | blur | other
		const GUESS: Record<string, Label> = { new: 'vocab', blur: 'sound', other: 'confusable' };
		for (const g of (Array.isArray(req.body?.guessed) ? req.body.guessed : []).slice(0, 40)) {
			const w = first.words[Number(g?.i)];
			const label = GUESS[String(g?.kind)];
			if (w && label && (w.status === 'ok' || w.status === 'typo') && !raw.some((m) => m.guessAt === Number(g.i))) raw.push({ word: w.w, label, guessAt: Number(g.i) });
		}
		const misses = raw.map(({ skill, ...m }) => ({ ...m, ...(skill && skills.find((k) => k.slug === skill) ? { skill: skills.find((k) => k.slug === skill) } : {}) }));
		const label = sentenceLabel(misses);
		const userId = userOf(req);
		const a = await ownAttempt(req, s.lesson_id);
		if (a && !a.finished_at) await touchStudy(database, a.user_id);
		if (a && !a.finished_at) {
			// The learner's own marks (phrases and why), so a result opened again shows what they said
			const marks = (Array.isArray(req.body?.marks) ? req.body.marks : []).slice(0, 40)
				.map((m: any) => ({ idx: (Array.isArray(m?.idx) ? m.idx : []).map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n < first.words.length).slice(0, 12), kind: String(m?.kind) }))
				.filter((m: any) => m.idx.length && ['new', 'blur', 'other', 'spell'].includes(m.kind));
			await database('il_results').where({ attempt_id: a.id, sentence_id: s.id, round: 1 })
				.update({ unknown: JSON.stringify(unknown), slow_typed: slowTyped || null, labels: JSON.stringify(misses), marks: JSON.stringify(marks) });
		}
		// A missed sentence (not only unknown words) comes back as a Review card; one already held keeps its schedule
		let cardMade = false;
		if (userId && a && label && misses.some((m) => !NOT_LISTENING.includes(m.label))) {
			const made = await database('review_cards').insert(newCard(userId, s.id, label)).onConflict(['user_id', 'kind', 'ref_id']).ignore().returning('ref_id');
			cardMade = made.length > 0;
		}
		// The words worth asking "do you know it?" about: not linking / speed / weak / spelling misses (the word is known, only
		// its sound was lost), not function words, not the 2,000 commonest words of the library
		const ask = [...new Set(misses
			.filter((m) => !['linking', 'speed', 'weak', 'spelling'].includes(m.label))
			.map((m) => m.word)
			.filter((w) => !FUNCTION_WORDS.has(w.replace(/'/g, '')) && rankOf(w) > 2000))];
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
		const cards = Number((await database('review_cards as c').join('il_sentences as s', 's.id', 'c.ref_id')
			.where({ 'c.user_id': userId, 'c.kind': 'sentence', 's.lesson_id': a.lesson_id }).count('* as n').first())?.n || 0);
		// Each sentence's translation: the base (Vietnamese) in il_sentences.sub, another language in il_translations ('s<n>:sub');
		// a missing one falls back to the base
		const subs: Record<string, string> = {};
		for (const s of await database('il_sentences').select('n', 'sub').where('lesson_id', a.lesson_id)) if (s.sub) subs[String(s.n)] = s.sub;
		const tr = await trOf(a.lesson_id, langOf(req));
		if (tr) for (const [k, v] of tr) if (/^s\d+:sub$/.test(k)) subs[k.slice(1, -4)] = v;
		return res.json({ success: true, data: { gist_right: a.gist_right, gist: { first: a.gist_choice ?? null, second: a.gist_choice2 ?? null }, sentences: [...sentences.values()], labels, cards, xp, first: firstTime, subs, ...(await mainOf(userId)) } });
	}));

	/** A finished go opened again (the result page, /listening-lab/intensive/<key>?result=<id>): each sentence as the
	 *  result screen had it (what was typed, the check, the labels, the learner's marks), the time spent, the Review cards */
	const attemptResult = async (req: any, res: any, a: any) => {
		const userId = userOf(req);
		if (!userId || !a || !a.finished_at) return res.status(404).json({ success: false, message: 'Not found' });
		const lang = langOf(req);
		const tr = await trOf(a.lesson_id, lang);
		const sentences = await database('il_sentences').where('lesson_id', a.lesson_id).orderBy('n');
		const results = await database('il_results').where({ attempt_id: a.id, round: 1 });
		const byId = new Map(results.map((r: any) => [r.sentence_id, r]));
		const subs: Record<string, string> = {};
		const rows = sentences.map((s: any) => {
			const r: any = byId.get(s.id);
			const sub = pickOr(tr, `s${s.n}:sub`, s.sub ?? null);
			if (sub) subs[String(s.n)] = sub;
			if (!r) return null;
			const d = diffWords(s.text, r.typed);
			const slow = r.slow_typed ? diffWords(s.text, r.slow_typed) : null;
			// Labels saved by /slow carry the skill as an object; the first check's ones only as a slug (dropped)
			const misses = (r.labels || []).map((m: any) => (m && typeof m.skill === 'string' ? (({ skill, ...x }: any) => x)(m) : m));
			return {
				typed: r.typed, slow_typed: r.slow_typed || '', listens: r.listens, marks: r.marks || [], ladder: r.ladder || null,
				check: { right: d.right, total: d.total, ok: isRight(d), words: d.words, marks: d.marks, tail_gap: d.tailGap, text: s.text, labels: misses, sub, traps: trapsOf(s, tr),
					slow: slow ? { right: slow.right, total: slow.total, words: slow.words, marks: slow.marks, tail_gap: slow.tailGap } : null },
				slow: d.right < d.total || misses.length ? { misses, label: sentenceLabel(misses), unknown: r.unknown || [], ask: [], confirm: [], slow_right: slow?.right ?? null, slow_total: slow?.total ?? null, card: false } : null,
			};
		});
		const cards = Number((await database('review_cards as c').join('il_sentences as s', 's.id', 'c.ref_id')
			.where({ 'c.user_id': userId, 'c.kind': 'sentence', 's.lesson_id': a.lesson_id }).count('* as n').first())?.n || 0);
		const minutes = Math.max(1, Math.round((new Date(a.finished_at).getTime() - new Date(a.date_created).getTime()) / 60000));
		return res.json({ success: true, data: { id: a.id, seq: a.seq, lesson_id: a.lesson_id, finished_at: a.finished_at, minutes, gist_right: a.gist_right, gist: { first: a.gist_choice ?? null, second: a.gist_choice2 ?? null }, rows, cards, subs, ...(await mainOf(userId!)) } });
	};
	router.get('/intensive/attempts/:id', wrap('attempt', async (req, res) => attemptResult(req, res, await ownAttempt(req))));
	/** The same by the learner's go number at the passage: /intensive/lessons/you-cant-unboil-an-egg/results/3 */
	router.get('/intensive/lessons/:key/results/:seq', wrap('result', async (req, res) => {
		const userId = userOf(req);
		const l = userId ? await findLesson(String(req.params.key)) : null;
		const seq = Number(req.params.seq);
		if (!l || !Number.isInteger(seq) || seq < 1) return res.status(404).json({ success: false, message: 'Not found' });
		return attemptResult(req, res, await database('il_attempts').where({ user_id: userId, lesson_id: l.id, seq }).first());
	}));
}
