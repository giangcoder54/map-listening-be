/**
 * "Bạn có biết?": the daily card on the landing page (table dyk_cards, 2026-12-08_dyk.sql).
 *
 *   GET /dyk/today?lang=         today's card (Vietnam day); a day nobody scheduled gets the next card by rule
 *   GET /dyk/:day?lang=          the card of a past or current day, 404 for a day not yet reached or not scheduled
 *
 * Public, guests included. The answer travels with the card: it is a taste, it earns no XP, and the browser
 * grades it. Tomorrow's card never leaves the server.
 *
 * Picking a day (first request of the day): an approved card whose lesson is published and free, not shown
 * in the last REPEAT_DAYS, never-shown first, then the longest ago. If every card is too recent the
 * repeat rule is dropped, so the page never has no card while approved ones exist.
 */
import { BASE_LANG, langOf } from '../lib/extensive';
import { vnDay } from '../lib/xp';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const REPEAT_DAYS = 60;

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
			correct: card.correct,
			answer: say('answer', card.answer),
			line: card.line || null,
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

	router.get('/dyk/today', serve(true));
	router.get('/dyk/:day', serve(false));
}
