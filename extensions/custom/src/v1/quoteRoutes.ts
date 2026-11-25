/**
 * The quote in the daily review popup (table review_quotes, managed in adminQuoteRoutes.ts).
 *
 *   GET /quotes/today?lang=   one approved quote for the Vietnam day, the same for everyone that day:
 *                             { id, quote, meaning, author }. meaning is null for an English learner
 *                             (the quote is already English). data is null while no quote is approved.
 */
import { langOf } from '../lib/extensive';
import { vnDay } from '../lib/xp';

export function registerQuoteRoutes(router: any, context: any) {
	const { database, logger } = context;

	router.get('/quotes/today', async (req: any, res: any) => {
		try {
			const lang = langOf(req.query.lang);
			// md5(id + day): a fixed shuffle per day, so reopening the popup keeps the same line
			const q = (await database.raw(
				`SELECT q.id, q.quote,
					COALESCE((SELECT t.text FROM review_quote_translations t WHERE t.quote_id = q.id AND t.lang = ? AND t.key = 'meaning'), q.meaning) AS meaning,
					COALESCE((SELECT t.text FROM review_quote_translations t WHERE t.quote_id = q.id AND t.lang = ? AND t.key = 'author'), q.author) AS author
				 FROM review_quotes q WHERE q.status = 'approved'
				 ORDER BY md5(q.id::text || ?) LIMIT 1`,
				[lang, lang, vnDay()],
			)).rows[0];
			if (q && lang.startsWith('en-')) q.meaning = null;
			res.set('Cache-Control', 'public, max-age=600');
			return res.json({ success: true, data: q || null });
		} catch (error: any) {
			logger?.error?.(`[quotes] today failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	});
}
