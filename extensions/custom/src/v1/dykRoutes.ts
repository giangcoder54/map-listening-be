/**
 * "Bạn có biết?": the daily card on the landing page (table dyk_cards, 2026-12-08_dyk.sql).
 *
 *   GET /dyk/today?lang=         today's card (Vietnam day); a day nobody scheduled gets the next card by rule
 *   GET /dyk/:day?lang=          the card of a past or current day, 404 for a day not yet reached or not scheduled
 *
 * Public, guests included. The card goes out without its answer (it pays Kim cương, and rooms reuse the
 * cards): POST /dyk/answer grades it and sends the answer back. Tomorrow's card never leaves the server.
 *
 * Picking a day (first request of the day): an approved card whose lesson is published and free, not shown
 * in the last REPEAT_DAYS, never-shown first, then the longest ago. If every card is too recent the
 * repeat rule is dropped, so the page never has no card while approved ones exist.
 */
import { BASE_LANG, langOf } from '../lib/extensive';
import { vnDay } from '../lib/xp';
import { earnCoins } from '../lib/coins';
import { gemsOn } from '../lib/growthConfig';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const REPEAT_DAYS = 60;
/** Kim cương for a right answer on the daily card; the lucky star doubles it, a wrong answer costs nothing */
const DYK_GEMS = 10;

export function registerDykRoutes(router: any, context: any) {
	const { database, logger } = context;

	const pathOf = (c: any) =>
		c.kind === 'el' ? `/listening-lab/extensive/${c.lesson_key}` : c.kind === 'il' ? `/listening-lab/intensive/${c.lesson_key}` : `/skill/${c.lesson_key}`;

	const LESSON_OK = `(
		c.kind = 'cs'
		OR (c.kind = 'el' AND EXISTS (SELECT 1 FROM el_lessons l WHERE l.short_id = c.lesson_key AND l.status = 'published' AND NOT l.is_premium))
		OR (c.kind = 'il' AND EXISTS (SELECT 1 FROM il_lessons l WHERE l.short_id = c.lesson_key AND l.status = 'published' AND NOT l.is_premium))
	)`;

	/** The card scheduled for `day`; fills the day by rule when nobody did (only for today) */
	const cardFor = async (day: string, fill: boolean) => {
		const get = () => database('dyk_schedule as s').join('dyk_cards as c', 'c.id', 's.card_id').where('s.day', day).select('c.*').first();
		let card = await get();
		if (card || !fill) return card;
		for (const withRepeat of [true, false]) {
			const picked = await database.raw(
				`SELECT c.id FROM dyk_cards c
				 LEFT JOIN LATERAL (SELECT max(day) AS last FROM dyk_schedule s WHERE s.card_id = c.id) u ON true
				 WHERE c.status = 'approved' AND ${LESSON_OK}
				   ${withRepeat ? `AND (u.last IS NULL OR u.last <= ?::date - ${REPEAT_DAYS})` : ''}
				 ORDER BY u.last NULLS FIRST, c.date_created, c.id LIMIT 1`,
				withRepeat ? [day] : [],
			);
			const id = picked.rows?.[0]?.id;
			if (!id) continue;
			await database.raw(`INSERT INTO dyk_schedule (day, card_id, picked_by) VALUES (?, ?, 'auto') ON CONFLICT (day) DO NOTHING`, [day, id]);
			card = await get();
			if (card) return card;
		}
		return null;
	};

	const shape = async (card: any, day: string, lang: string) => {
		const tr = lang === BASE_LANG ? null : new Map<string, string>((await database('dyk_translations').select('key', 'text').where({ card_id: card.id, lang })).map((r: any) => [r.key, r.text]));
		const say = (key: string, base: string) => tr?.get(key) || base;
		return {
			day,
			id: card.id,
			kind: card.kind,
			hook: say('hook', card.hook),
			question: say('question', card.question),
			options: (card.options as string[]).map((o, i) => say(`option${i}`, o)),
			// The right option, the answer and the English line (which gives it away) come only with POST /dyk/answer
			tease: say('tease', card.tease || '') || null,
			video_id: card.youtube_video_id,
			start: Number(card.clip_start),
			end: Number(card.clip_end),
			path: pathOf(card),
		};
	};

	const serve = (fill: boolean) => async (req: any, res: any) => {
		try {
			const today = vnDay();
			const day = fill ? today : String(req.params.day || '');
			if (!fill && (!DAY_RE.test(day) || day > today)) return res.status(404).json({ success: false, message: 'No card' });
			const card = await cardFor(day, fill && day === today);
			if (!card) return res.status(fill ? 200 : 404).json({ success: !fill ? false : true, data: null });
			res.set('Cache-Control', 'public, max-age=300');
			return res.json({ success: true, data: await shape(card, day, langOf(req.query.lang)) });
		} catch (error) {
			logger?.warn?.(`[dyk] card failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};

	/**
	 * Grades today's card on the server; the right option, the answer and the English line come back only now.
	 * A signed-in learner has one try a day: the first answer, right or wrong, takes the key dyk:<day> (a wrong
	 * one with 0 Kim cương), so a reload and another option pays nothing. `star` is the free lucky star of the
	 * card: right = x2, wrong = nothing lost. Guests are graded too and earn nothing (the page asks them to sign in).
	 */
	router.post('/dyk/answer', async (req: any, res: any) => {
		const userId = req.accountability?.user as string | undefined;
		try {
			const day = vnDay();
			const card = await cardFor(day, false);
			const choice = Number(req.body?.choice);
			if (!card || String(req.body?.card_id) !== String(card.id) || !Number.isInteger(choice) || choice < 0 || choice >= (card.options as string[]).length) {
				return res.status(400).json({ success: false, code: 'BAD_REQUEST' });
			}
			const correct = choice === card.correct;
			const star = req.body?.star === true;
			let added = 0;
			let balance: number | null = null;
			let already = false;
			if (userId && gemsOn('cards', req.accountability)) {
				const r = await earnCoins(database, userId, { reason: 'card', amount: correct ? (star ? DYK_GEMS * 2 : DYK_GEMS) : 0, dedupe: `dyk:${day}`, meta: { dyk_card: card.id, star, correct } }, day);
				added = r.added;
				balance = r.coins;
				already = !('eventId' in r);
			}
			const lang = langOf(req.query.lang ?? req.body?.lang);
			const tr = lang === BASE_LANG ? null : new Map<string, string>((await database('dyk_translations').select('key', 'text').where({ card_id: card.id, lang })).map((r: any) => [r.key, r.text]));
			return res.json({ success: true, data: {
				correct, star, added, balance, already,
				correct_index: card.correct, answer: tr?.get('answer') || card.answer, line: card.line || null,
			} });
		} catch (error) {
			logger?.warn?.(`[dyk] answer failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	});

	/** Landing: the chest tiers with their price (public). Empty while chests are off, so the card just shows no rows */
	router.get('/landing/chests', async (req: any, res: any) => {
		try {
			if (!gemsOn('chests', req.accountability)) return res.json({ success: true, data: [] });
			const lang = langOf(req.query.lang);
			const rows = await database('chests').where('active', true).andWhere('once', false).orderBy('tier').select('code', 'price');
			const tr = await database('chest_translations').select('code', 'lang', 'name').whereIn('lang', [lang, BASE_LANG]).whereIn('code', rows.map((r: any) => r.code));
			const nameOf = (code: string) => tr.find((t: any) => t.code === code && t.lang === lang)?.name || tr.find((t: any) => t.code === code && t.lang === BASE_LANG)?.name || code;
			res.set('Cache-Control', 'public, max-age=300');
			return res.json({ success: true, data: rows.map((r: any) => ({ code: r.code, price: Number(r.price), name: nameOf(r.code) })) });
		} catch (error) {
			logger?.warn?.(`[dyk] landing chests failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	});

	router.get('/dyk/today', serve(true));
	router.get('/dyk/:day', serve(false));
}
