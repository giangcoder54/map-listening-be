/**
 * Ngôi sao may mắn, for the team (lesson page of the admin): how often each clip of a lesson is heard right
 * the first time, to pick the clips that should take a star. Which clips take one, and what they win and
 * lose, are the clip's own fields (listening_clips.star_on / star_win / star_lose), saved with the clip.
 *
 *   GET /admin/clips/star-stats?lesson_id=   { [clip_id]: { n, right } }  first try per learner, no hint
 */
import { UUID_RE } from '../lib/lessons';
import { isStaff } from '../lib/staff';

export function registerAdminStarRoutes(router: any, context: any) {
	const { database, logger } = context;
	router.get('/admin/clips/star-stats', async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Admins and editors only' });
		try {
			const lessonId = String(req.query.lesson_id || '');
			if (!UUID_RE.test(lessonId)) return res.status(400).json({ success: false, code: 'BAD_REQUEST' });
			const rows = await database.raw(
				`SELECT f.clip_id, count(*)::int AS n, count(*) FILTER (WHERE f.is_correct)::int AS right
				 FROM (
					SELECT DISTINCT ON (a.user_id, a.clip_id) a.clip_id, a.is_correct
					FROM listening_attempts a
					JOIN listening_clips c ON c.id = a.clip_id
					WHERE c.lesson_id = ? AND a.user_id IS NOT NULL AND a.used_hint = false
						AND a.phase IN ('voice', 'practice', 'challenge', 'post', 'test', 'review')
					ORDER BY a.user_id, a.clip_id, a.date_created
				 ) f GROUP BY f.clip_id`,
				[lessonId],
			);
			const data: Record<string, { n: number; right: number }> = {};
			for (const r of rows.rows) data[r.clip_id] = { n: Number(r.n), right: Number(r.right) };
			return res.json({ success: true, data });
		} catch (error: any) {
			logger?.error?.(`[admin-stars] ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	});
}
