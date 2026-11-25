/**
 * "Từ của tôi": the words a learner saved with the bookmark button, from any feature (Extensive, Intensive, the
 * dictionary), in one store (user_words, migration 2026-11-20_user_words.sql) its schedule is a card in review_cards; reviewing is /review (v1/reviewRoutes.ts).
 *
 *   GET  /words                 ?q=&stage=all|due|new|learning|known&sort=new|due|az&page=&limit=  the list, with counts
 *   GET  /words/saved           ?w=a,b,c  which of these words are saved (for bookmark buttons)
 *   POST /words                 { word, shown?, meaning?, ipa?, source, source_id?, video_id?, start_ms?, end_ms?, example?, forms? }
 *                               saves a word (once; a word already saved keeps its card, made by a trigger). Meaning and IPA come from
 *                               the dictionary when the caller has none.
 *   POST /words/remove          { word }
 *   POST /words/archive         { word, archived }  hide a word from the list and from review without losing its progress (the card's suspended_at)
 *
 * A word's stage: new (never reviewed), learning, known (held for 21 days or more).
 */
import { wordKey } from '../lib/dict';
import { dueReviews } from '../lib/reviewDue';
import { UUID_RE } from '../lib/lessons';
import { cleanIpa, meaningFor } from '../lib/meanings';

const SOURCES = ['extensive', 'intensive', 'dict'];
const KNOWN_DAYS = 21;
const clean = (v: unknown, max = 600) => String(v ?? '').slice(0, max);
/** A whole number the integer columns can hold; anything else is not kept */
const intOr = (v: unknown) => (v !== null && v !== '' && Math.abs(Math.round(Number(v))) <= 2147483647 ? Math.round(Number(v)) : null);
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
		id: r.id, word: r.word, shown: r.shown, meaning: r.meaning, ipa: cleanIpa(r.ipa), source: r.source,
		video_id: r.video_id, start: r.start_ms, end: r.end_ms, example: r.example,
		stage: stageOf(r), archived: !!r.suspended_at, due: r.due, saved_at: r.date_created,
	});

	/** Meaning (the learner's language when Wiktionary has it, else the English gloss) and IPA */
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

	router.get('/words', wrap('list', async (req, res) => {
		const userId = userOf(req);
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const page = Math.max(1, Number(req.query?.page) || 1);
		const limit = Math.min(60, Math.max(1, Number(req.query?.limit) || 24));
		const q = wordKey(String(req.query?.q || ''));
		const filter = String(req.query?.stage || 'all');
		const sort = String(req.query?.sort || 'new');
		// The schedule of a word is its card in review_cards (the one table of every review card)
		const list = database('user_words as w').leftJoin('review_cards as c', function (this: any) { this.on('c.ref_id', 'w.id').andOn('c.kind', database.raw("'word'")); })
			.select('w.*', 'c.due', 'c.stability', 'c.last_review', 'c.suspended_at').where('w.user_id', userId);
		if (filter === 'archived') list.whereNotNull('c.suspended_at'); else list.whereNull('c.suspended_at');
		if (q) list.where((w: any) => w.where('w.word', 'like', `%${q}%`).orWhereRaw('lower(w.meaning) like ?', [`%${q}%`]));
		if (filter === 'due') list.where('c.due', '<=', database.fn.now());
		else if (filter === 'new') list.whereNull('c.last_review');
		else if (filter === 'learning') list.whereNotNull('c.last_review').where('c.stability', '<', KNOWN_DAYS);
		else if (filter === 'known') list.whereNotNull('c.last_review').where('c.stability', '>=', KNOWN_DAYS);
		const total = Number((await list.clone().clearSelect().count('* as n').first())?.n || 0);
		list.orderBy(sort === 'az' ? [{ column: 'w.word' }] : sort === 'due' ? [{ column: 'c.due' }, { column: 'w.word' }] : [{ column: 'w.date_created', order: 'desc' }]);
		const rows = await list.limit(limit).offset((page - 1) * limit);
		const c = (await database.raw(`SELECT count(*) FILTER (WHERE c.suspended_at IS NULL)::int AS all,
				count(*) FILTER (WHERE c.suspended_at IS NOT NULL)::int AS archived,
				count(*) FILTER (WHERE c.suspended_at IS NULL AND c.due <= now())::int AS due,
				count(*) FILTER (WHERE c.suspended_at IS NULL AND c.last_review IS NULL)::int AS new,
				count(*) FILTER (WHERE c.suspended_at IS NULL AND c.last_review IS NOT NULL AND c.stability < ?)::int AS learning,
				count(*) FILTER (WHERE c.suspended_at IS NULL AND c.last_review IS NOT NULL AND c.stability >= ?)::int AS known
			FROM user_words w LEFT JOIN review_cards c ON c.ref_id = w.id AND c.kind = 'word' WHERE w.user_id = ?`, [KNOWN_DAYS, KNOWN_DAYS, userId])).rows[0];
		// The button's number is every card due (all kinds), the same as the header's: one review for everything
		c.due = await dueReviews(database, userId);
		// The meaning is shown in the learner's language now, not the one it was saved in (the saved text is the last fallback)
		const l = String(req.query?.lang || 'vi').slice(0, 2).toLowerCase();
		const items = await Promise.all(rows.map(async (r: any) => ({ ...item(r), meaning: (await fromDict(r.word, l)).meaning || r.meaning })));
		return res.json({ success: true, data: { items, total, page, limit, counts: c } });
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
		const row = await database('user_words as w').leftJoin('review_cards as c', function (this: any) { this.on('c.ref_id', 'w.id').andOn('c.kind', database.raw("'word'")); })
			.select('w.*', 'c.due', 'c.stability', 'c.last_review').where({ 'w.user_id': userId, 'w.word': word }).first();
		return res.json({ success: true, data: item(row) });
	}));

	router.post('/words/archive', wrap('archive', async (req, res) => {
		const userId = userOf(req);
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const word = wordKey(String(req.body?.word || ''));
		const w = word ? await database('user_words').select('id').where({ user_id: userId, word }).first() : null;
		if (!w) return res.status(404).json({ success: false, message: 'Not found' });
		await database('review_cards').where({ user_id: userId, kind: 'word', ref_id: w.id }).update({ suspended_at: req.body?.archived === false ? null : database.fn.now() });
		return res.json({ success: true, data: null });
	}));

	router.post('/words/remove', wrap('remove', async (req, res) => {
		const userId = userOf(req);
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const word = wordKey(String(req.body?.word || ''));
		if (word) await database('user_words').where({ user_id: userId, word }).delete();
		return res.json({ success: true, data: null });
	}));
}
