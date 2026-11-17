/**
 * The practice bank, "Kho bài tập", for the team (/admin/practice).
 *
 *   GET   /admin/practice                  every video of the bank (any status) with its sentences:
 *                                          shown / hidden, and the default Xu price
 *   GET   /admin/practice/:id              one video's sentences (its answer, rule, level, hidden or not)
 *   GET   /admin/practice/candidates       videos with sentences that are not in the bank yet
 *   POST  /admin/practice                  { source_video_id } puts a video in the bank (as a draft)
 *   PATCH /admin/practice/:id              { title?, status?, is_premium?, price_xu? } admins only
 *   PUT   /admin/practice/clips/:clipId    { hidden } keep a sentence out of the bank (or back in)
 *
 * A sentence is a published clip of the video (lib/bank.ts CLIP_FILTER); hiding one only keeps the
 * bank from showing it (practice_hidden_clips), the clip stays in its lesson.
 */
import { BANK, CLIP_FILTER } from '../lib/bank';
import { UUID_RE } from '../lib/lessons';
import { isStaff } from '../lib/staff';

export function registerAdminPracticeRoutes(router: any, context: any) {
	const { database, logger } = context;
	const staff = (handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Admins and editors only' });
		try {
			return await handler(req, res);
		} catch (error: any) {
			logger?.error?.(`[admin-practice] ${req.method} ${req.path} failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};

	router.get('/admin/practice', staff(async (req, res) => {
		const { rows } = await database.raw(`
			SELECT p.id, p.short_id, p.title, p.status, p.is_premium, p.price_xu, p.sort, sv.youtube_video_id, sv.thumbnail_url,
				count(c.id)::int AS total,
				count(h.clip_id)::int AS hidden
			FROM practice_videos p
			JOIN source_videos sv ON sv.id = p.source_video_id
			LEFT JOIN (
				SELECT c.id, c.source_video_id FROM listening_clips c
				JOIN source_videos sv ON sv.id = c.source_video_id
				JOIN listening_lessons l ON l.id = c.lesson_id
				JOIN listening_skills s ON s.id = l.skill_id
				WHERE ${CLIP_FILTER}
			) c ON c.source_video_id = p.source_video_id
			LEFT JOIN practice_hidden_clips h ON h.clip_id = c.id
			GROUP BY p.id, sv.id
			ORDER BY p.sort, p.date_created`);
		return res.json({ success: true, data: { can_edit: !!req.accountability.admin, default_price: BANK.price, videos: rows.map((r: any) => ({
			id: r.id, short_id: r.short_id, title: r.title, status: r.status, is_premium: !!r.is_premium, price_xu: r.price_xu, sort: r.sort,
			thumbnail: r.thumbnail_url || `https://i.ytimg.com/vi/${r.youtube_video_id}/hqdefault.jpg`, total: r.total, hidden: r.hidden,
		})) } });
	}));

	router.get('/admin/practice/candidates', staff(async (_req, res) => {
		const { rows } = await database.raw(`
			SELECT sv.id, sv.title, sv.youtube_video_id, sv.thumbnail_url, count(c.id)::int AS clips
			FROM listening_clips c
			JOIN source_videos sv ON sv.id = c.source_video_id
			JOIN listening_lessons l ON l.id = c.lesson_id
			JOIN listening_skills s ON s.id = l.skill_id
			WHERE ${CLIP_FILTER} AND NOT EXISTS (SELECT 1 FROM practice_videos p WHERE p.source_video_id = sv.id)
			GROUP BY sv.id ORDER BY count(c.id) DESC, sv.title`);
		return res.json({ success: true, data: { videos: rows.map((r: any) => ({
			id: r.id, title: r.title, clips: r.clips, thumbnail: r.thumbnail_url || `https://i.ytimg.com/vi/${r.youtube_video_id}/hqdefault.jpg`,
		})) } });
	}));

	router.post('/admin/practice', staff(async (req, res) => {
		const id = String(req.body?.source_video_id || '');
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad video' });
		const sv = await database('source_videos').select('id', 'title').where('id', id).first();
		if (!sv) return res.status(404).json({ success: false, message: 'Video not found' });
		if (await database('practice_videos').where('source_video_id', id).first()) return res.status(409).json({ success: false, message: 'Already in the bank' });
		const { rows } = await database.raw(`
			INSERT INTO practice_videos (short_id, source_video_id, title, status, sort)
			VALUES (substr(md5(random()::text || clock_timestamp()::text), 1, 8), ?, left(trim(?), 200), 'draft', coalesce((SELECT max(sort) FROM practice_videos), 0) + 1)
			RETURNING id`, [id, sv.title || 'Video']);
		return res.json({ success: true, data: { id: rows[0].id } });
	}));

	router.get('/admin/practice/:id', staff(async (req, res) => {
		if (!UUID_RE.test(req.params.id)) return res.status(400).json({ success: false, message: 'Bad id' });
		const { rows } = await database.raw(`
			SELECT c.id, c.transcript, c.answer, c.difficulty, c.start_time, s.name AS rule, (h.clip_id IS NOT NULL) AS hidden
			FROM practice_videos p
			JOIN source_videos sv ON sv.id = p.source_video_id
			JOIN listening_clips c ON c.source_video_id = sv.id
			JOIN listening_lessons l ON l.id = c.lesson_id
			JOIN listening_skills s ON s.id = l.skill_id
			LEFT JOIN practice_hidden_clips h ON h.clip_id = c.id
			WHERE p.id = ? AND ${CLIP_FILTER}
			ORDER BY c.start_time, c.id`, [req.params.id]);
		return res.json({ success: true, data: { clips: rows.map((r: any) => ({
			id: r.id, text: String(r.transcript || '').replace(/[[\]]/g, ''), answer: r.answer || (String(r.transcript || '').match(/\[([^\]]+)\]/)?.[1] ?? ''),
			difficulty: r.difficulty, rule: r.rule, hidden: !!r.hidden,
		})) } });
	}));

	router.patch('/admin/practice/:id', staff(async (req, res) => {
		if (!req.accountability.admin) return res.status(403).json({ success: false, message: 'Admins only' });
		if (!UUID_RE.test(req.params.id)) return res.status(400).json({ success: false, message: 'Bad id' });
		const b = req.body || {};
		const patch: Record<string, unknown> = {};
		if (typeof b.title === 'string' && b.title.trim()) patch.title = b.title.trim().slice(0, 200);
		if (b.status === 'draft' || b.status === 'published') patch.status = b.status;
		if (typeof b.is_premium === 'boolean') patch.is_premium = b.is_premium;
		if ('price_xu' in b) {
			const n = b.price_xu === null || b.price_xu === '' ? null : Math.floor(Number(b.price_xu));
			if (n !== null && !(n >= 0 && n <= 100000)) return res.status(400).json({ success: false, message: 'Bad price' });
			patch.price_xu = n;
		}
		if (!Object.keys(patch).length) return res.status(400).json({ success: false, message: 'Nothing to change' });
		const n = await database('practice_videos').where('id', req.params.id).update(patch);
		return n ? res.json({ success: true }) : res.status(404).json({ success: false, message: 'Not found' });
	}));

	router.put('/admin/practice/clips/:clipId', staff(async (req, res) => {
		if (!UUID_RE.test(req.params.clipId)) return res.status(400).json({ success: false, message: 'Bad id' });
		if (req.body?.hidden) await database('practice_hidden_clips').insert({ clip_id: req.params.clipId }).onConflict('clip_id').ignore();
		else await database('practice_hidden_clips').where('clip_id', req.params.clipId).del();
		return res.json({ success: true });
	}));
}
