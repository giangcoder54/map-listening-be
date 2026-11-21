/**
 * The numbers on the profile page, in one small request (the lobby routes also rank lessons for "For you", too heavy for this):
 *
 *   GET /profile/stats   -> { time: { total_s, week_s }, il: { done, main }, el: { done, listened_s, level }, words: { all, known, learning } }
 *
 * time: user_study_time (lib/studyTime.ts). The rest are counts over the learner's own rows.
 */
import { IL } from '../lib/intensive';
import { vnDay } from '../lib/days';

const KNOWN_DAYS = 21;
const EL_DEFAULT_LEVEL = 3;

export function registerProfileRoutes(router: any, context: any) {
	const { database, logger } = context;

	router.get('/profile/stats', async (req: any, res: any) => {
		const userId = req.accountability?.user as string | undefined;
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		try {
			const today = vnDay();
			const [time, il, mainRows, el, level, words] = await Promise.all([
				database.raw(`SELECT coalesce(sum(seconds), 0)::int AS total_s,
						coalesce(sum(seconds) FILTER (WHERE day >= date_trunc('week', ?::date)), 0)::int AS week_s
					FROM user_study_time WHERE user_id = ?`, [today, userId]),
				database.raw(`SELECT count(DISTINCT lesson_id)::int AS done FROM il_attempts WHERE user_id = ? AND finished_at IS NOT NULL`, [userId]),
				database.raw(`SELECT l->>'label' AS label, count(*)::int AS misses, count(DISTINCT a.lesson_id)::int AS lessons
					FROM il_results r JOIN il_attempts a ON a.id = r.attempt_id, jsonb_array_elements(r.labels) l
					WHERE a.user_id = ? AND r.round = 1 AND r.date_created > now() - interval '30 days'
					GROUP BY 1 ORDER BY 2 DESC`, [userId]),
				database.raw(`SELECT count(DISTINCT lesson_id)::int AS done, coalesce(sum(listened_s), 0)::int AS listened_s
					FROM el_attempts WHERE user_id = ? AND finished_at IS NOT NULL`, [userId]),
				database('el_levels').select('level').where('user_id', userId).first(),
				database.raw(`SELECT count(*)::int AS all,
						count(*) FILTER (WHERE c.last_review IS NOT NULL AND c.stability >= ?)::int AS known,
						count(*) FILTER (WHERE c.last_review IS NOT NULL AND c.stability < ?)::int AS learning
					FROM user_words w LEFT JOIN review_cards c ON c.ref_id = w.id AND c.kind = 'word' WHERE w.user_id = ?`, [KNOWN_DAYS, KNOWN_DAYS, userId]),
			]);
			// A label is named only after enough misses over enough passages (as /intensive/home says it)
			const main = mainRows.rows.find((r: any) => r.misses >= IL.mainMisses && r.lessons >= IL.mainLessons)?.label ?? null;
			return res.json({ success: true, data: {
				time: time.rows[0],
				il: { done: il.rows[0].done, main },
				el: { done: el.rows[0].done, listened_s: el.rows[0].listened_s, level: level?.level ?? EL_DEFAULT_LEVEL },
				words: words.rows[0],
			} });
		} catch (error) {
			logger?.error?.(`[profile] stats failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	});
}
