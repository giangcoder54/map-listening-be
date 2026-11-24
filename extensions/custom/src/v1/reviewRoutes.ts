/**
 * The daily review, one session for every kind of card (spec: "Intensive: ôn tập theo loại lỗi").
 *
 *   GET  /daily-review                    ?size=25  the learner's day: cards due (words, sound patterns, pairs, spelling, sentences),
 *                                         each as one exercise; `prompt` = the popup is due (once a day), `compact` = three "later"s in a row
 *   GET  /daily-review/status             {total, minutes, prompt, compact, skips} without building a session: what the popup asks on every page load
 *   POST /daily-review/answer             { kind, id, choice?, token?, typed?, gotit?, listens?, slow?, ms? } -> right or not, what to learn from it
 *   POST /daily-review/suspend            { kind, id }   "known, don't ask again": the card leaves review, nothing is deleted
 *   POST /daily-review/prompted           { action: 'shown' | 'later' | 'started' }   the popup was shown / answered
 *   (the popup itself reads its question from GET /me/engagement `review`, no request of its own)
 *   POST /daily-review/add                { attempt_id, items: [{ kind, text, other?, sentence_n, real?, note?, skill?, wrong? }] }
 *                                         the result screen's "add to review": a word goes to user_words, the rest to il_cards
 *
 * An exercise is easy first and harder as the learner gets it right (right_streak):
 *   0  hear it, choose among 2-3        1  hear it in another voice, choose        2+  hear it, type the word or phrase
 * Pairs are always a choice of two, spelling is always typed, a sentence is "got it / not yet". A review of any card is a
 * row of review_log. The answer is never sent: a choice is checked against `token`, a typed answer on the server.
 */
import { createHash } from 'node:crypto';
import { wordKey } from '../lib/dict';
import { diffWords, FUNCTION_WORDS, isRight, rankOf, reviewGrade, sameWord, schedule, cardColumns, tokens } from '../lib/intensive';
import { UUID_RE, answerOf } from '../lib/lessons';
import { targetOf } from '../lib/runs';
import { mixUps } from '../lib/mixups';
import { masteryOf } from '../lib/review';
import { readClips, wrongOf } from './lessonRoutes';
import { cleanIpa, meaningFor, meaningPool, shorten } from '../lib/meanings';
import { grantRewards, recordPractice, vnDay } from '../lib/xp';
import { CAP, KINDS, SECONDS, reviewPrompt, type Kind } from '../lib/reviewDue';

const clean = (v: unknown, max = 600) => String(v ?? '').slice(0, max);
/** Every card's schedule is a row of review_cards (user, kind, ref_id); what the card is about is in its own table */
const CONTENT: Partial<Record<Kind, string>> = { word: 'user_words', pattern: 'il_cards', pair: 'il_cards', spell: 'il_cards' };
const regexSafe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]").replace(/ /g, '\\s+');
const shuffle = <T,>(a: T[]) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j]!, b[i]!]; } return b; };
const lev = (a: string, b: string) => {
	const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
	for (let j = 1; j <= b.length; j++) d[0]![j] = j;
	for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
	return d[a.length]![b.length]!;
};

export function registerReviewRoutes(router: any, context: any) {
	const { database, logger } = context;
	const secret = String(process.env.SECRET || process.env.KEY || 'guidelingo-review');
	const tag = (id: string, w: string) => createHash('sha1').update(`${secret}|${id}|${w.toLowerCase()}`).digest('hex').slice(0, 12);
	const wrap = (what: string, handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
		try {
			return await handler(req, res);
		} catch (error: any) {
			logger?.error?.(`[daily-review] ${what} failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};
	// The subtitle-line index (migration 2026-11-27) follows every write to source_videos by trigger; this once-a-start call only fills it
	// the first time (or repairs it) and takes milliseconds when there is nothing to do.
	setTimeout(() => void database.raw('SELECT refresh_transcript_lines()').catch((e: unknown) => logger?.warn?.(`[daily-review] transcript_lines refresh failed: ${String(e)}`)), 5000).unref?.();
	const userOf = (req: any) => (req.accountability?.user as string | undefined) || null;

	/** Lines of the published, hand-made transcripts where a phrase is said, kept for an hour: one scan of every transcript costs about a
	 *  second, so a session asks for all its phrases at once (`warm`) and the exercises then pick from memory. */
	type Line = { video_id: string; start: number; end: number; text: string };
	const lineCache = new Map<string, { at: number; lines: Line[] }>();
	const LINE_TTL = 60 * 60 * 1000;
	const groupKey = (forms: string[]) => forms.map((f) => f.toLowerCase()).sort().join('|');
	/** The word of a phrase the index can look up: its longest run of letters (the lines found are then checked against the whole phrase) */
	const lookup = (forms: string[]) => [...new Set(forms.map((f) => (f.toLowerCase().match(/[a-z]+/g) || []).sort((x, y) => y.length - x.length)[0]).filter(Boolean))].join(' | ');
	const scan = async (groups: string[][]) => {
		const todo = groups.filter((g) => { const hit = lineCache.get(groupKey(g)); return !hit || Date.now() - hit.at > LINE_TTL; });
		await Promise.all(todo.map(async (g) => {
			const q = lookup(g);
			let lines: Line[] = [];
			let at = Date.now();
			try {
				if (q) {
					const re = `\m(${g.map(regexSafe).join('|')})\M`;
					const { rows } = await database.raw(`
						SELECT video_id, start_ms AS start, end_ms AS "end", text FROM transcript_lines
						WHERE tsv @@ to_tsquery('simple', ?) AND text ~* ? AND end_ms - start_ms BETWEEN 1200 AND 8000
						ORDER BY random() LIMIT 40`, [q, re]);
					lines = rows as Line[];
				}
			} catch (e) {
				logger?.warn?.(`[daily-review] line lookup failed: ${String(e)}`);
				at = Date.now() - LINE_TTL + 60_000; // try again in a minute
			}
			lineCache.set(groupKey(g), { at, lines });
		}));
		if (lineCache.size > 2000) for (const k of [...lineCache.keys()].slice(0, 500)) lineCache.delete(k);
	};
	/** A line of another video where the phrase is said */
	const libraryLine = async (forms: string[], notVideo: string | null) => {
		await scan([forms]);
		const lines = lineCache.get(groupKey(forms))?.lines || [];
		const pick = lines.filter((l) => l.video_id !== notVideo);
		return pick.length ? pick[Math.floor(Math.random() * pick.length)] : undefined;
	};
	/** The subtitle line of a clip (the published, hand-made transcripts), for a clip saved without its text */
	const lineAt = async (videoId: string, startMs: number) => {
		const row = await database('transcript_lines').select('text').where('video_id', videoId).whereRaw('abs(start_ms - ?) < 600', [startMs]).orderByRaw('abs(start_ms - ?)', [startMs]).first().catch(() => null);
		return row?.text ? String(row.text) : '';
	};
	/** The line with the phrase left out, for typing it in */
	const blank = (text: string, forms: string[]) => {
		const m = new RegExp(`(^|[^A-Za-z'’])(${forms.map(regexSafe).join('|')})(?![A-Za-z'’])`, 'i').exec(text);
		if (!m) return { before: text, after: '', letters: 0 };
		const at = m.index + m[1]!.length;
		return { before: text.slice(0, at), after: text.slice(at + m[2]!.length), letters: m[2]!.replace(/\s+/g, ' ').length };
	};
	/** Wrong answers that could be heard for the word: common words that start alike and are near in length and spelling
	 *  (reside: realize, reserve). The common words are the ones with a meaning in word_meanings, held in memory for an hour. */
	let common: { at: number; words: string[] } | null = null;
	const commonWords = async () => {
		if (common && Date.now() - common.at < LINE_TTL) return common.words;
		const words: string[] = await database('word_meanings').where({ common: true, ord: 1 }).whereRaw("word ~ '^[a-z]{3,}$'").distinct('word').pluck('word').then((ws: string[]) => ws.filter((w) => rankOf(w) <= 12000)).catch(() => []);
		common = { at: Date.now(), words };
		return words;
	};
	const lookAlikes = async (word: string, n = 2) => {
		const w = word.toLowerCase();
		const skip = (x: string) => x === w || x.startsWith(w) || w.startsWith(x);
		const all = await commonWords();
		let pool: string[] = [];
		// Three letters alike first, two when that leaves too few
		for (const len of [3, 2]) {
			if (pool.length >= 6) break;
			pool = all.filter((x) => x.startsWith(w.slice(0, len)) && Math.abs(x.length - w.length) <= 2 && !skip(x));
		}
		if (pool.length < n) {
			const rows = await database('il_sentences').select('text').orderByRaw('random()').limit(60);
			pool = [...new Set<string>(rows.flatMap((r: any) => tokens(r.text)).filter((x: string) => /^[a-z]{3,}$/.test(x) && !skip(x) && Math.abs(x.length - w.length) <= 2))];
		}
		// Near in spelling first; among the near ones, a few at random so the same two are not always offered
		const ranked = pool.sort((a, b) => lev(a, w) - lev(b, w));
		return shuffle(ranked.slice(0, Math.max(n * 4, 8))).slice(0, n).sort((a, b) => lev(a, w) - lev(b, w));
	};

	/** Another word of the sentence in its place: wrong sentences that are only a little off (a word heard as one that sounds like it) */
	const nearSentences = async (text: string, n = 2) => {
		const parts = text.split(/([A-Za-z']+)/);
		const spots = shuffle(parts.map((p, i) => ({ p, i })).filter(({ p, i }) => i % 2 === 1 && p.length >= 4 && !FUNCTION_WORDS.has(p.toLowerCase())));
		const out: string[] = [];
		const used = new Set<number>();
		for (const { p, i } of spots) {
			if (out.length >= n) break;
			const [alt] = await lookAlikes(p, 1);
			if (!alt || used.has(i)) continue;
			used.add(i);
			const swap = p[0] === p[0]!.toUpperCase() ? alt[0]!.toUpperCase() + alt.slice(1) : alt;
			out.push(parts.map((x, j) => (j === i ? swap : x)).join(''));
		}
		return out;
	};
	/** The first letter of every word and a dot for each of the others: "T··· w·· i·· ..." */
	const firstLetters = (text: string) => text.replace(/([A-Za-z])([A-Za-z']*)/g, (_m, a: string, b: string) => a + '·'.repeat(b.length));
	/** Wrong answers for "what does it mean": the meanings of other words in the same language and part of speech as the right one
	 *  (all of them one-line senses of the same kind, so the right one does not stand out) */
	const wrongMeanings = async (right: string, pos: string | null, lang: string, n = 2) => {
		const r = right.toLowerCase();
		const ok = (m: string) => m && m.toLowerCase() !== r && !m.toLowerCase().includes(r) && !r.includes(m.toLowerCase());
		const out: string[] = [];
		for (const m of shuffle(await meaningPool(database, lang, pos))) { if (ok(m) && !out.includes(m)) out.push(m); if (out.length >= n) break; }
		return out;
	};

	/** A form's clip to ask now: a random one of its published clips (never the same one twice by plan), with the part to hear
	 *  and the wrong answers heard for it. `ref` picks a given clip (the answer is checked against the clip that was shown). */
	const formClip = async (lessonId: string, ref?: string) => {
		const rows = (await readClips(database, [lessonId])).filter((c: any) => (ref ? c.id === ref : ['core', 'voice', 'pool'].includes(c.role)) && c.youtube_video_id && c.start_time != null && c.end_time != null && c.transcript);
		if (!rows.length) return null;
		const row = ref ? rows[0]! : rows[Math.floor(Math.random() * rows.length)]!;
		const lesson = await database('listening_lessons').select('text').where('id', lessonId).first();
		const answer = answerOf(row, lesson?.text || '', 'per_clip');
		const focus = String(row.focus_text || '').trim() || null;
		const target = targetOf({ answer, focus });
		const own = wrongOf(row);
		const wrong = (own.length ? own : mixUps(target)).filter((w: string) => w.toLowerCase() !== target.toLowerCase());
		return { row, target, wrong, lesson };
	};

	/** One due card as the exercise the learner sees now. The harder the streak, the less is given:
	 *  word      0 see the word, choose its meaning   1 hear it, choose the word   2 see the meaning, type the word   3+ hear it, type the word
	 *  sentence  0 hear it, choose the sentence       1 hear it, type it (first letters given)   2+ hear it, type it */
	const exercise = async (kind: Kind, r: any, _userId: string, lang: string) => {
		const streak = Number(r.right_streak) || 0;
		const id = (kind === 'sentence' ? r.sentence_id : kind === 'form' ? r.lesson_id : r.id) as string;
		const base = { kind, id, streak };
		if (kind === 'form') {
			const picked = await formClip(id);
			if (!picked) return null;
			const { row, target, wrong } = picked;
			const plain = String(row.transcript || '').replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim();
			const clip = { video_id: row.youtube_video_id, start: Math.round(Number(row.start_time) * 1000), end: Math.round(Number(row.end_time) * 1000) };
			const shown = { ...base, ref: row.id as string, clip, ...blank(plain, [target]) };
			if (streak < 2 && wrong.length) return { ...shown, mode: 'choose', prompt: 'phrase', options: shuffle([target, ...wrong.slice(0, 2)]), token: tag(id, target) };
			return { ...shown, mode: 'type', prompt: 'phrase' };
		}
		if (kind === 'sentence') {
			const s = await database('il_sentences as s').join('il_lessons as l', 'l.id', 's.lesson_id').join('source_videos as sv', 'sv.id', 'l.source_video_id')
				.select('s.text', 's.start_ms', 's.end_ms', 'sv.youtube_video_id as video_id').where('s.id', r.sentence_id).first();
			if (!s) return null;
			const clip = { video_id: s.video_id, start: s.start_ms, end: s.end_ms };
			if (streak === 0) {
				const wrong = await nearSentences(s.text);
				if (wrong.length >= 1) return { ...base, mode: 'choose', prompt: 'sentenceChoose', clip, options: shuffle([s.text, ...wrong]), token: tag(id, s.text) };
			}
			return { ...base, mode: 'type', prompt: 'sentenceType', clip, ...(streak <= 1 ? { hint: firstLetters(s.text) } : {}) };
		}
		if (kind === 'word') {
			const forms = [r.word, ...(r.forms || [])];
			const own = r.video_id && r.start_ms != null ? { video_id: r.video_id, start: r.start_ms, end: r.end_ms ?? r.start_ms + 3000, text: r.example || '' } : null;
			let line = streak >= 1 || !own ? ((await libraryLine(forms, r.video_id)) || own) : own;
			if (line && !line.text) line = { ...line, text: await lineAt(line.video_id, line.start) };
			if (line && !line.text) line = (await libraryLine(forms, r.video_id)) || line;   // no text to show with the clip: another clip that has it
			if (!line) return null;
			const clip = { video_id: line.video_id, start: line.start, end: line.end };
			// The meaning in the learner's language (the Wiktionary edition of it), else the one saved with the word
			const found = await meaningFor(database, r.word, lang);
			const meaning = found?.short || (r.meaning ? shorten(String(r.meaning)) : '');
			// A word seen for the first time is taught before it is asked: the word, how it sounds, what it means, a line it is said in
			const learn = Number(r.reps) === 0 && streak === 0 ? { word: r.shown, ipa: cleanIpa(r.ipa) || (await fromDict(r.word, lang)).ipa, meaning: found?.meaning || r.meaning || meaning, text: line.text || '' } : undefined;
			const base2 = learn ? { ...base, learn } : base;
			if (streak === 0 && meaning) {
				const wrong = await wrongMeanings(meaning, found?.pos ?? null, lang);
				if (wrong.length >= 1) return { ...base2, mode: 'choose', prompt: 'meaning', term: r.shown, clip, options: shuffle([meaning, ...wrong]), token: tag(id, meaning) };
			}
			if (streak === 2 && meaning) return { ...base2, mode: 'type', prompt: 'recall', hint: meaning, clip, letters: r.shown.length };
			if (streak >= 2) return { ...base2, mode: 'type', prompt: 'word', clip, ...(line.text ? blank(line.text, forms) : {}) };
			const wrong = await lookAlikes(r.word);
			if (wrong.length < 1) return { ...base2, mode: 'type', prompt: 'word', clip, ...(line.text ? blank(line.text, forms) : {}) };
			return { ...base2, mode: 'choose', prompt: 'word', clip, ...(line.text ? blank(line.text, forms) : {}), options: shuffle([r.shown, ...wrong]), token: tag(id, r.shown) };
		}
		// pattern / pair / spell: the sentence the learner missed it in
		const sentence = r.sentence_id ? await database('il_sentences').select('text').where('id', r.sentence_id).first() : null;
		const own = r.video_id && r.start_ms != null ? { video_id: r.video_id, start: r.start_ms, end: r.end_ms ?? r.start_ms + 3000, text: sentence?.text || '' } : null;
		if (kind === 'pair') {
			const [a, b] = (Array.isArray(r.options) ? r.options : []).map(String);
			if (!a || !b) return null;
			// The word said: the sentence's own, or the other one of the pair heard in another video; decided by the card and the day
			const dayPick = createHash('sha1').update(`${id}|${vnDay()}`).digest()[0]! % 2 === 0;
			const ownWord = String(r.real || a);
			const otherWord = ownWord === a ? b : a;
			let said = dayPick ? ownWord : otherWord;
			let line: any = said === ownWord ? own : await libraryLine([said], r.video_id);
			if (!line) { said = ownWord; line = own; }
			if (!line) return null;
			return { ...base, mode: 'choose', prompt: 'pair', clip: { video_id: line.video_id, start: line.start, end: line.end }, ...(line.text ? blank(line.text, [said]) : {}), options: shuffle([a, b]), token: tag(id, said) };
		}
		const forms = [r.shown];
		const line = streak >= 1 && kind === 'pattern' ? ((await libraryLine(forms, r.video_id)) || own) : own;
		if (!line) return null;
		const clip = { video_id: line.video_id, start: line.start, end: line.end };
		if (kind === 'pattern' && streak < 2) {
			const wrong: string[] = (Array.isArray(r.options) ? r.options : []).map(String).filter((w: string) => w && w.toLowerCase() !== r.shown.toLowerCase()).slice(0, 2);
			if (wrong.length) return { ...base, mode: 'choose', prompt: 'phrase', clip, ...(line.text ? blank(line.text, forms) : {}), options: shuffle([r.shown, ...wrong]), token: tag(id, r.shown) };
		}
		return { ...base, mode: 'type', prompt: kind === 'spell' ? 'spell' : 'phrase', clip, ...(line.text ? blank(line.text, forms) : {}) };
	};

	/** Cards (review_cards rows) of a kind, as the exercises read them: the card's schedule with what it is about
	 *  (a word, a pattern...). `id` is the content's id; a sentence card has `sentence_id`, a form card `lesson_id`. */
	const withContent = async (kind: Kind, cards: any[]) => {
		const table = CONTENT[kind];
		const rows = table && cards.length ? await database(table).whereIn('id', cards.map((c) => c.ref_id)) : [];
		const byId = new Map<string, any>(rows.map((r: any) => [r.id, r]));
		return cards.flatMap((c) => {
			if (kind === 'sentence') return [{ ...c, sentence_id: c.ref_id }];
			if (kind === 'form') return [{ ...c, lesson_id: c.ref_id }];
			const r = byId.get(c.ref_id);
			return r ? [{ ...c, ...r }] : [];
		});
	};
	/** One card of the learner, schedule and content together (null: none) */
	const cardRow = async (kind: Kind, id: string, userId: string) => {
		const card = await database('review_cards').where({ user_id: userId, kind, ref_id: id }).first();
		return card ? (await withContent(kind, [card]))[0] ?? null : null;
	};
	const cardWhere = (kind: Kind, id: string, userId: string) => ({ user_id: userId, kind, ref_id: id });

	/** The cards due now, per kind, oldest first */
	const due = async (userId: string) => {
		const live = (kinds: Kind[], limit: number) => database('review_cards').where('user_id', userId).whereIn('kind', kinds)
			.where('due', '<=', database.fn.now()).whereNull('suspended_at').orderBy('due').limit(limit);
		const entries = await Promise.all(KINDS.map(async (k) => [k, await withContent(k, await live([k], CAP[k] + 20))] as const));
		return Object.fromEntries(entries) as Record<Kind, any[]>;
	};

	/** The popup's question, answered without building a session: how many cards are due (as many as a session would hold), is it
	 *  time to ask (once a day, not after three "later"s in a row), or is it the slim bar. Three counts and one read of the user. */
	router.get('/daily-review/status', wrap('status', async (req, res) => {
		const userId = userOf(req);
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const size = Math.max(1, Math.min(60, Number(req.query?.size) || 25));
		return res.json({ success: true, data: (await reviewPrompt(database, userId, size)).review });
	}));

	router.get('/daily-review', wrap('session', async (req, res) => {
		const userId = userOf(req);
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const size = Math.max(1, Math.min(60, Number(req.query?.size) || 25));
		const lang = clean(req.query?.lang, 8) || 'vi';
		const by = await due(userId);
		const total = KINDS.reduce((n, k) => n + by[k].length, 0);
		// Round-robin over the kinds, each within its cap, so a session mixes them (never many of one kind in a row)
		const queues = KINDS.map((k) => by[k].slice(0, CAP[k]).map((r) => ({ k, r })));
		const picked: { k: Kind; r: any }[] = [];
		while (picked.length < size && queues.some((q) => q.length)) for (const q of queues) { const x = q.shift(); if (x && picked.length < size) picked.push(x); }
		// One scan of the transcripts for every phrase the session needs from other videos
		await scan(picked.flatMap(({ k, r }): string[][] => {
			const streak = Number(r.right_streak) || 0;
			if (k === 'word' && streak >= 1) return [[r.word, ...(r.forms || [])]];
			if (k === 'pattern' && streak >= 1) return [[r.shown]];
			if (k === 'pair') return (Array.isArray(r.options) ? r.options : []).map((o: unknown) => [String(o)]);
			return [];
		})).catch((e: unknown) => logger?.warn?.(`[daily-review] library scan failed: ${String(e)}`));
		const items = (await Promise.all(picked.map(({ k, r }) => exercise(k, r, userId, lang).catch(() => null)))).filter(Boolean);
		// Where each clip is from: the learner can open the video, and say which one is wrong
		const ids = [...new Set(items.map((i: any) => i.clip.video_id))];
		const titles: Record<string, string> = Object.fromEntries((ids.length ? await database('source_videos').select('youtube_video_id', 'title').whereIn('youtube_video_id', ids) : []).map((t: any) => [t.youtube_video_id, t.title]));
		for (const i of items as any[]) i.clip.title = titles[i.clip.video_id] || null;
		const u = await database('directus_users').where('id', userId).first('review_prompted_on', 'review_skips');
		const today = vnDay();
		const shownOn = u?.review_prompted_on ? new Date(u.review_prompted_on).toISOString().slice(0, 10) : null;
		const skips = Number(u?.review_skips) || 0;
		const minutes = Math.max(1, Math.round(picked.reduce((n, { k }) => n + SECONDS[k], 0) / 60));
		return res.json({ success: true, data: { total: items.length, due: total, minutes, items, prompt: items.length > 0 && shownOn !== today && skips < 3, compact: items.length > 0 && skips >= 3, skips } });
	}));

	router.post('/daily-review/prompted', wrap('prompted', async (req, res) => {
		const userId = userOf(req);
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const action = req.body?.action;
		// 'shown': the popup came up, so it is not asked again today (any device); the "later" count is left as it is
		if (action === 'shown') {
			await database('directus_users').where('id', userId).update({ review_prompted_on: vnDay() });
			return res.json({ success: true, data: null });
		}
		const later = action === 'later';
		const u = await database('directus_users').where('id', userId).first('review_skips');
		await database('directus_users').where('id', userId).update({ review_prompted_on: vnDay(), review_skips: later ? (Number(u?.review_skips) || 0) + 1 : 0 });
		return res.json({ success: true, data: null });
	}));

	router.post('/daily-review/report', wrap('report', async (req, res) => {
		const userId = userOf(req);
		const kind = String(req.body?.kind) as Kind;
		const id = String(req.body?.id || '');
		const issue = String(req.body?.issue || '');
		if (!userId || !KINDS.includes(kind) || !id || !['subtitle_off', 'wrong_answer', 'marked_wrong', 'video_issue', 'other'].includes(issue)) return res.status(400).json({ success: false, message: 'Bad request' });
		const r = await cardRow(kind, id, userId).catch(() => null);
		const clip = req.body?.clip || {};
		await database('review_issues').insert({
			user_id: userId, card_kind: kind, card_id: id.slice(0, 64), word: clean(r?.word || r?.shown, 80) || null,
			video_id: clean(clip.video_id, 40) || r?.video_id || null, start_ms: Number.isFinite(Number(clip.start)) ? Math.round(Number(clip.start)) : null, end_ms: Number.isFinite(Number(clip.end)) ? Math.round(Number(clip.end)) : null,
			issue, comment: clean(req.body?.comment, 2000) || null,
		});
		return res.json({ success: true, data: null });
	}));

	router.post('/daily-review/suspend', wrap('suspend', async (req, res) => {
		const userId = userOf(req);
		const kind = String(req.body?.kind) as Kind;
		const id = String(req.body?.id || '');
		if (!userId || !KINDS.includes(kind) || !UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad request' });
		await database('review_cards').where(cardWhere(kind, id, userId)).update({ suspended_at: database.fn.now() });
		return res.json({ success: true, data: null });
	}));

	router.post('/daily-review/answer', wrap('answer', async (req, res) => {
		const userId = userOf(req);
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const kind = String(req.body?.kind) as Kind;
		const id = String(req.body?.id || '');
		if (!KINDS.includes(kind) || !UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad request' });
		const r = await cardRow(kind, id, userId);
		if (!r) return res.status(404).json({ success: false, message: 'Not found' });
		const listens = Math.max(1, Math.min(9, Math.round(Number(req.body?.listens) || 1)));
		const choice = clean(req.body?.choice, 300);
		const typedRaw = clean(req.body?.typed, 300);
		const typed = tokens(typedRaw);
		const sentenceRow = kind === 'sentence' ? await database('il_sentences').select('text', 'sub').where('id', r.sentence_id).first() : null;
		const sameAll = (want: string[], opts: { exact?: boolean } = {}) => want.length === typed.length && want.every((w, k) => {
			const s = sameWord(w, typed[k]!);
			return opts.exact ? s === 'ok' : !!s;
		});
		let correct = false;
		let marked: ReturnType<typeof diffWords> | null = null;
		let formInfo: Awaited<ReturnType<typeof formClip>> = null;
		if (kind === 'sentence' && !choice && sentenceRow && typedRaw) { marked = diffWords(sentenceRow.text, typedRaw); correct = isRight(marked); }
		else if (kind === 'sentence' && !choice) correct = !!req.body?.gotit;
		else if (choice) correct = tag(id, choice) === String(req.body?.token || '');
		else if (kind === 'form') {
			const f = await formClip(id, UUID_RE.test(String(req.body?.ref || '')) ? String(req.body.ref) : '__none__');
			correct = !!f && sameAll(tokens(f.target), { exact: false });
			formInfo = f;
		}
		else if (kind === 'word') correct = [r.word, ...(r.forms || [])].some((f: string) => sameAll(tokens(f)));
		else if (kind === 'pattern') correct = sameAll(tokens(r.shown));
		else if (kind === 'spell') correct = sameAll(tokens(r.shown), { exact: true });
		const grade = reviewGrade(correct, listens, !!req.body?.slow);
		const next = schedule(r, grade);
		const update: Record<string, unknown> = { ...cardColumns(next) };
		update.right_streak = correct ? (Number(r.right_streak) || 0) + 1 : 0;
		await database('review_cards').where(cardWhere(kind, id, userId)).update(update);
		// A form's rule: how well its forms are held now (the bar on the rule's page)
		if (kind === 'form') {
			const l = await database('listening_lessons').select('skill_id').where('id', id).first();
			if (l?.skill_id) {
				const cards = await database('review_cards as c').join('listening_lessons as l', 'l.id', 'c.ref_id').select('c.*').where({ 'c.user_id': userId, 'c.kind': 'form', 'l.skill_id': l.skill_id });
				await database.raw(`INSERT INTO listening_skill_progress (user_id, skill_id, mastery, date_updated) VALUES (?, ?, ?, now())
					ON CONFLICT (user_id, skill_id) DO UPDATE SET mastery = EXCLUDED.mastery, date_updated = now()`, [userId, l.skill_id, masteryOf(cards)]);
			}
		}
		await database('review_log').insert({ user_id: userId, card_kind: kind, card_id: id, rating: grade, answer: (choice || typed.join(' ') || (req.body?.gotit ? 'got it' : 'not yet')).slice(0, 80), review_duration: Number.isFinite(Number(req.body?.ms)) ? Math.max(0, Math.min(600000, Math.round(Number(req.body.ms)))) : null });
		const won = await recordPractice(database, userId, {
			attempts: 1,
			xp: correct ? { reason: kind === 'word' ? 'word_review' : kind === 'form' ? 'review' : 'intensive_review', dedupe: `daily:${kind}:${id}:${vnDay()}`, lessonId: null } : null,
		});
		await grantRewards(context, req.schema, userId, won.rewards);
		// What the learner sees after answering: how it is really said, the meaning, the sentence
		let reveal: Record<string, unknown> = {};
		if (kind === 'word') {
			const found = await meaningFor(database, r.word, clean(req.body?.lang, 8) || 'vi');
			reveal = { shown: r.shown, meaning: found?.meaning || r.meaning, ipa: cleanIpa(r.ipa) || (await fromDict(r.word, clean(req.body?.lang, 8) || 'vi')).ipa, answers: [r.shown, found?.short, r.meaning ? shorten(String(r.meaning)) : null].filter(Boolean) };
		}
		else if (kind === 'form') {
			const row = formInfo?.row;
			// Only the phrase and what it means: no respelling, no rule. The meaning is looked up for the whole phrase only (the first word alone would give a wrong sense).
			const lang = clean(req.body?.lang, 8) || 'vi';
			const target = String(formInfo?.target || '').toLowerCase().trim();
			const found = target ? await meaningFor(database, target, lang) : null;
			reveal = { shown: formInfo?.target, meaning: found?.short || null, text: row ? String(row.transcript || '').replace(/[\[\]]/g, '') : null, answers: [formInfo?.target] };
		}
		else if (kind === 'sentence') {
			reveal = { shown: sentenceRow?.text, sub: sentenceRow?.sub, answers: [sentenceRow?.text], ...(marked ? { words: marked.words } : {}) };
		} else {
			const s = r.sentence_id ? await database('il_sentences').select('text', 'sub').where('id', r.sentence_id).first() : null;
			reveal = { shown: r.shown, real: r.real && kind !== 'pair' ? r.real : null, note: r.note, skill: r.skill, text: s?.text, sub: s?.sub };
		}
		const days = Math.max(0, Math.round((new Date(next.due).getTime() - Date.now()) / 86400000));
		return res.json({ success: true, data: { correct, reveal, next_in_days: days, streak: update.right_streak ?? null, xp: won.xp } });
	}));

	/** Meaning (the learner's language when Wiktionary has it, else the English gloss) and IPA of a word */
	const fromDict = async (word: string, lang: string) => {
		const row = await database('wiktionary_en').select('doc').where({ w: word }).first();
		let doc = row?.doc;
		if (!doc) return { meaning: null, ipa: null };
		const l = String(lang || 'vi').slice(0, 2);
		const own = await meaningFor(database, word, l);
		if (own) return { meaning: own.meaning, ipa: cleanIpa(row.doc.ipa || doc.ipa) };
		let meaning = (Array.isArray(doc.tr?.[l]) ? doc.tr[l].join(', ') : doc.tr?.[l]) || doc.senses?.[0]?.g || null;
		if (!meaning && doc.form_of?.lemma) {
			doc = (await database('wiktionary_en').select('doc').where({ w: doc.form_of.lemma }).first())?.doc || doc;
			meaning = doc.senses?.[0]?.g || null;
		}
		return { meaning, ipa: cleanIpa(row.doc.ipa || doc.ipa) };
	};

	router.post('/daily-review/add', wrap('add', async (req, res) => {
		const userId = userOf(req);
		const aid = String(req.body?.attempt_id || '');
		if (!userId || !UUID_RE.test(aid)) return res.status(400).json({ success: false, message: 'Bad request' });
		const a = await database('il_attempts').where({ id: aid, user_id: userId }).first();
		if (!a) return res.status(404).json({ success: false, message: 'Not found' });
		const lessonRow = await database('il_lessons as l').join('source_videos as sv', 'sv.id', 'l.source_video_id').select('sv.youtube_video_id as video_id').where('l.id', a.lesson_id).first();
		const sentences = await database('il_sentences').where('lesson_id', a.lesson_id);
		let added = 0;
		for (const it of (Array.isArray(req.body?.items) ? req.body.items : []).slice(0, 80)) {
			const kind = String(it?.kind);
			const s = sentences.find((x: any) => x.n === Number(it?.sentence_n));
			if (!s || !['word', 'pattern', 'pair', 'spell'].includes(kind)) continue;
			const text = clean(it?.text, 80).trim();
			const own = { sentence_id: s.id, video_id: lessonRow?.video_id ?? null, start_ms: s.start_ms, end_ms: s.end_ms };
			if (kind === 'word') {
				const word = wordKey(text);
				if (!word) continue;
				const d = await fromDict(word, clean(req.body?.lang, 8));
				const made = await database('user_words').insert({
					user_id: userId, word, shown: text.toLowerCase(), forms: [], meaning: d.meaning, ipa: d.ipa, source: 'intensive', source_id: s.id,
					video_id: lessonRow?.video_id ?? null, start_ms: s.start_ms, end_ms: s.end_ms, example: s.text,
				}).onConflict(['user_id', 'word']).ignore().returning('id');
				added += made.length;
				continue;
			}
			const words = tokens(text);
			if (!words.length) continue;
			let key = words.join(' ');
			let shown = text;
			let options: string[] = (Array.isArray(it?.wrong) ? it.wrong : []).map((w: unknown) => clean(w, 80)).filter(Boolean).slice(0, 3);
			let real: string | null = clean(it?.real, 120) || null;
			if (kind === 'pair') {
				const other = tokens(clean(it?.other, 80)).join(' ');
				if (!other || other === key) continue;
				const [a1, b1] = [key, other].sort();
				options = [a1!, b1!];
				real = key;
				key = `${a1}|${b1}`;
				shown = `${a1} / ${b1}`;
			}
			const made = await database('il_cards').insert({
				user_id: userId, kind, key, shown, real, note: clean(it?.note, 300) || null, skill: clean(it?.skill, 60) || null, options: JSON.stringify(options), ...own,
			}).onConflict(['user_id', 'kind', 'key']).ignore().returning('id');
			added += made.length;
		}
		return res.json({ success: true, data: { added } });
	}));
}
