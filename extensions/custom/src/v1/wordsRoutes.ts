/**
 * "Từ của tôi": the words a learner saved with the bookmark button, from any feature (Extensive, Intensive, the
 * dictionary), in one store (user_words, migration 2026-11-20_user_words.sql) with one FSRS card per word.
 *
 *   GET  /words                 ?q=&filter=all|due|new|learning|known&sort=new|due|az&page=&limit=  the list, with counts
 *   GET  /words/saved           ?w=a,b,c  which of these words are saved (for bookmark buttons)
 *   POST /words                 { word, shown?, meaning?, ipa?, source, source_id?, video_id?, start_ms?, end_ms?, example?, forms? }
 *                               saves a word (once; a word already saved keeps its card). Meaning and IPA come from
 *                               the dictionary when the caller has none.
 *   POST /words/remove          { word }
 *   GET  /words/review          the words due: each one heard in a line of a video (another video when the library has
 *                               one), the line with the word left out. The word itself is not sent.
 *   POST /words/review/answer   { id, typed, listens, slow? } -> right or not, the word, its meaning, next review in days
 *
 * A word's stage: new (never reviewed), learning, known (held for 21 days or more).
 */
import { wordKey } from '../lib/dict';
import { reviewGrade, sameWord, schedule, cardColumns, tokens } from '../lib/intensive';
import { REVIEW } from '../lib/review';
import { UUID_RE } from '../lib/lessons';
import { isPremiumUser } from '../lib/premium';
import { grantRewards, recordPractice, vnDay } from '../lib/xp';

const SOURCES = ['extensive', 'intensive', 'dict'];
const KNOWN_DAYS = 21;
const clean = (v: unknown, max = 600) => String(v ?? '').slice(0, max);
const intOr = (v: unknown) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null);
/** A regex (Postgres) for the word and its forms as whole words */
const wordsRe = (forms: string[]) => `\\m(${forms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]").replace(/ /g, '\\s+')).join('|')})\\M`;

export function registerWordsRoutes(router: any, context: any) {
	const { database, logger } = context;
	const wrap = (what: string, handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
		try {
			return await handler(req, res);
		} catch (error: any) {
			logger?.error?.(`[words] ${what} failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};
	const userOf = (req: any) => (req.accountability?.user as string | undefined) || null;
	const stageOf = (r: any) => (!r.last_review ? 'new' : Number(r.stability) >= KNOWN_DAYS ? 'known' : 'learning');
	const item = (r: any) => ({
		id: r.id, word: r.word, shown: r.shown, meaning: r.meaning, ipa: r.ipa, source: r.source,
		video_id: r.video_id, start: r.start_ms, end: r.end_ms, example: r.example,
		stage: stageOf(r), due: r.due, saved_at: r.date_created,
	});

	/** Meaning (the learner's language when Wiktionary has it, else the English gloss) and IPA */
	const fromDict = async (word: string, lang: string) => {
		const row = await database('wiktionary_en').select('doc').where({ w: word }).first();
		let doc = row?.doc;
		if (!doc) return { meaning: null, ipa: null };
		const l = String(lang || 'vi').slice(0, 2);
		let meaning = (Array.isArray(doc.tr?.[l]) ? doc.tr[l].join(', ') : doc.tr?.[l]) || doc.senses?.[0]?.g || null;
		if (!meaning && doc.form_of?.lemma) {
			doc = (await database('wiktionary_en').select('doc').where({ w: doc.form_of.lemma }).first())?.doc || doc;
			meaning = doc.senses?.[0]?.g || null;
		}
		return { meaning, ipa: row.doc.ipa || doc.ipa || null };
	};

	router.get('/words', wrap('list', async (req, res) => {
		const userId = userOf(req);
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const page = Math.max(1, Number(req.query?.page) || 1);
		const limit = Math.min(60, Math.max(1, Number(req.query?.limit) || 24));
		const q = wordKey(String(req.query?.q || ''));
		const filter = String(req.query?.filter || 'all');
		const sort = String(req.query?.sort || 'new');
		const base = () => database('user_words').where('user_id', userId);
		const list = base();
		if (q) list.where((w: any) => w.where('word', 'like', `%${q}%`).orWhereRaw('lower(meaning) like ?', [`%${q}%`]));
		if (filter === 'due') list.where('due', '<=', database.fn.now());
		else if (filter === 'new') list.whereNull('last_review');
		else if (filter === 'learning') list.whereNotNull('last_review').where('stability', '<', KNOWN_DAYS);
		else if (filter === 'known') list.whereNotNull('last_review').where('stability', '>=', KNOWN_DAYS);
		const total = Number((await list.clone().count('* as n').first())?.n || 0);
		list.orderBy(sort === 'az' ? [{ column: 'word' }] : sort === 'due' ? [{ column: 'due' }, { column: 'word' }] : [{ column: 'date_created', order: 'desc' }]);
		const rows = await list.limit(limit).offset((page - 1) * limit);
		const c = (await database.raw(`SELECT count(*)::int AS all,
				count(*) FILTER (WHERE due <= now())::int AS due,
				count(*) FILTER (WHERE last_review IS NULL)::int AS new,
				count(*) FILTER (WHERE last_review IS NOT NULL AND stability < ?)::int AS learning,
				count(*) FILTER (WHERE last_review IS NOT NULL AND stability >= ?)::int AS known
			FROM user_words WHERE user_id = ?`, [KNOWN_DAYS, KNOWN_DAYS, userId])).rows[0];
		return res.json({ success: true, data: { items: rows.map(item), total, page, limit, counts: c } });
	}));

	router.get('/words/saved', wrap('saved', async (req, res) => {
		const userId = userOf(req);
		const ws = String(req.query?.w || '').split(',').map((w) => wordKey(w)).filter((w): w is string => !!w).slice(0, 100);
		if (!userId || !ws.length) return res.json({ success: true, data: { saved: [] } });
		const rows = await database('user_words').select('word').where('user_id', userId).whereIn('word', ws);
		return res.json({ success: true, data: { saved: rows.map((r: any) => r.word) } });
	}));

	router.post('/words', wrap('save', async (req, res) => {
		const userId = userOf(req);
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const b = req.body || {};
		const word = wordKey(String(b.word || ''));
		if (!word) return res.status(400).json({ success: false, message: 'Bad word' });
		const source = SOURCES.includes(b.source) ? b.source : 'dict';
		let meaning = clean(b.meaning, 400).trim() || null;
		let ipa = clean(b.ipa, 80).trim() || null;
		if (!meaning || !ipa) {
			const d = await fromDict(word, b.lang);
			meaning ||= d.meaning; ipa ||= d.ipa;
		}
		const forms = (Array.isArray(b.forms) ? b.forms : []).map((f: unknown) => wordKey(String(f || ''))).filter((f: string | null) => f && f !== word).slice(0, 8);
		await database('user_words').insert({
			user_id: userId, word, shown: clean(b.shown, 80).trim() || word, forms, meaning, ipa, source,
			source_id: UUID_RE.test(String(b.source_id || '')) ? b.source_id : null,
			video_id: /^[\w-]{11}$/.test(String(b.video_id || '')) ? b.video_id : null,
			start_ms: intOr(b.start_ms), end_ms: intOr(b.end_ms), example: clean(b.example, 400).trim() || null,
		}).onConflict(['user_id', 'word']).ignore();
		const row = await database('user_words').where({ user_id: userId, word }).first();
		return res.json({ success: true, data: item(row) });
	}));

	router.post('/words/remove', wrap('remove', async (req, res) => {
		const userId = userOf(req);
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const word = wordKey(String(req.body?.word || ''));
		if (word) await database('user_words').where({ user_id: userId, word }).delete();
		return res.json({ success: true, data: null });
	}));

	/** A line of a video where the word (or one of its forms) is said: another video first, else the line it was saved from */
	const lineOf = async (r: any) => {
		const forms = [r.word, ...(r.forms || [])];
		const re = wordsRe(forms);
		const { rows } = await database.raw(`
			SELECT sv.youtube_video_id AS video_id, (c->>'start')::int AS start, (c->>'end')::int AS "end", c->>'text' AS text
			FROM source_videos sv, jsonb_array_elements(sv.transcript) c
			WHERE sv.status = 'published' AND sv.transcript_kind = 'manual' AND sv.youtube_video_id IS DISTINCT FROM ?
				AND sv.transcript::text ~* ? AND c->>'text' ~* ?
				AND (c->>'end')::int - (c->>'start')::int BETWEEN 1200 AND 8000
			ORDER BY random() LIMIT 1`, [r.video_id, re, re]);
		const line = rows[0] || (r.video_id && r.start_ms != null && r.example ? { video_id: r.video_id, start: r.start_ms, end: r.end_ms ?? r.start_ms + 3000, text: r.example } : null);
		if (!line) return null;
		// The line with the word left out: before / after, and how many letters it has
		const m = new RegExp(`(^|[^A-Za-z'’])(${forms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]").replace(/ /g, '\\s+')).join('|')})(?![A-Za-z'’])`, 'i').exec(line.text);
		if (!m) return { ...line, before: line.text, after: '', letters: 0 };
		const at = m.index + m[1].length;
		return { ...line, before: line.text.slice(0, at), after: line.text.slice(at + m[2].length), letters: m[2].replace(/\s+/g, ' ').length };
	};

	router.get('/words/review', wrap('review', async (req, res) => {
		const userId = userOf(req);
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const size = (await isPremiumUser(database, userId, logger)) ? REVIEW.session : REVIEW.free;
		const due = await database('user_words').where('user_id', userId).where('due', '<=', database.fn.now()).orderBy('due').limit(size);
		const total = Number((await database('user_words').where('user_id', userId).where('due', '<=', database.fn.now()).count('* as n').first())?.n || 0);
		const items = (await Promise.all(due.map(async (r: any) => {
			const line = await lineOf(r);
			return line ? { id: r.id, source: r.source, video_id: line.video_id, start: line.start, end: line.end, before: line.before, after: line.after, letters: line.letters } : null;
		}))).filter(Boolean);
		return res.json({ success: true, data: { total, size, items } });
	}));

	router.post('/words/review/answer', wrap('review-answer', async (req, res) => {
		const userId = userOf(req);
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const id = String(req.body?.id || '');
		const r = UUID_RE.test(id) ? await database('user_words').where({ id, user_id: userId }).first() : null;
		if (!r) return res.status(404).json({ success: false, message: 'Not found' });
		const listens = Math.max(1, Math.min(9, Math.round(Number(req.body?.listens) || 1)));
		const typed = tokens(clean(req.body?.typed, 80));
		// Right = the word or one of its forms, a spelling slip allowed (lib/intensive.ts sameWord)
		const correct = [r.word, ...(r.forms || [])].some((f: string) => {
			const want = tokens(f);
			return want.length === typed.length && want.every((w, k) => !!sameWord(w, typed[k]!));
		});
		const next = schedule(r, reviewGrade(correct, listens, !!req.body?.slow));
		await database('user_words').where('id', r.id).update(cardColumns(next));
		const won = await recordPractice(database, userId, {
			attempts: 1,
			xp: correct ? { reason: 'word_review', dedupe: `word_review:${r.id}:${vnDay()}`, lessonId: null } : null,
		});
		await grantRewards(context, req.schema, userId, won.rewards);
		const days = Math.max(0, Math.round((new Date(next.due).getTime() - Date.now()) / 86400000));
		return res.json({ success: true, data: { correct, word: r.shown, meaning: r.meaning, ipa: r.ipa, next_in_days: days, xp: won.xp } });
	}));
}
