/**
 * The topics a learner likes (lib/recommend.ts uses them for "For you").
 *
 *   GET  /interest/topics?lang=      every topic that has published lessons (name in the learner's language),
 *                                    my picks and whether I answered the question
 *   POST /interest/topics            { topics: string[], skipped?: boolean } signed in; guests keep picks in the browser
 */
import { langOf } from '../lib/extensive';
import { TOPIC_JOINS, TOPIC_RE, lessonTopicSql } from '../lib/recommend';

export function registerInterestRoutes(router: any, context: any) {
	const { database, logger } = context;
	const wrap = (what: string, handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
		try {
			return await handler(req, res);
		} catch (error: any) {
			logger?.error?.(`[interest] ${what} failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};
	const userOf = (req: any) => (req.accountability?.user as string | undefined) || null;

	router.get('/interest/topics', wrap('topics', async (req, res) => {
		const userId = userOf(req);
		const lang = langOf(req.query?.lang);
		const { rows } = await database.raw(`
			WITH lt AS (
				SELECT topic FROM el_lessons WHERE status = 'published'
				UNION ALL
				SELECT ${lessonTopicSql('l')} FROM il_lessons l JOIN source_videos sv ON sv.id = l.source_video_id ${TOPIC_JOINS} WHERE l.status = 'published'
			)
			SELECT vt.code, COALESCE(tn.name, vt.name) AS name, count(*)::int AS n
			FROM lt JOIN video_topics vt ON vt.code = lt.topic
			LEFT JOIN video_topic_translations tn ON tn.code = vt.code AND tn.lang = ?
			GROUP BY vt.code, tn.name, vt.name, vt.sort ORDER BY vt.sort`, [lang]);
		const picked = userId ? await database('user_topic_prefs').where('user_id', userId).pluck('topic') : [];
		const asked = userId ? !!(await database('user_topic_survey').where('user_id', userId).first('user_id')) : false;
		return res.json({ success: true, data: { topics: rows, picked, asked, signed_in: !!userId } });
	}));

	router.post('/interest/topics', wrap('save', async (req, res) => {
		const userId = userOf(req);
		if (!userId) return res.status(401).json({ success: false, message: 'Sign in' });
		const skipped = !!req.body?.skipped;
		const wanted = skipped ? [] : (Array.isArray(req.body?.topics) ? req.body.topics : []).map(String).filter((s: string) => TOPIC_RE.test(s)).slice(0, 20);
		const known = wanted.length ? await database('video_topics').whereIn('code', wanted).pluck('code') : [];
		await database.transaction(async (trx: any) => {
			// Skipping keeps earlier picks; answering replaces them
			if (!skipped) {
				await trx('user_topic_prefs').where('user_id', userId).delete();
				if (known.length) await trx('user_topic_prefs').insert(known.map((topic: string) => ({ user_id: userId, topic })));
			}
			await trx('user_topic_survey').insert({ user_id: userId, skipped, date_updated: new Date() }).onConflict('user_id').merge();
		});
		return res.json({ success: true, data: { picked: known } });
	}));
}
