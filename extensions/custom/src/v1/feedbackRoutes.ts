/**
 * Feedback on a lesson (table listening_feedback, migration 2026-10-16_listening_feedback.sql).
 *
 *   POST  /listening-lab/lessons/:key/feedback   { rating 1-3, tags?, comment?, score?, locale?, anonymous_id? }
 *                                                one row per learner (or guest browser) and lesson
 *   GET   /admin/listening-feedback              ?status=new|done&rating=1|2|3&page=1&limit=20 (staff)
 *   PATCH /admin/listening-feedback/:id          { status: 'new' | 'done' } (staff)
 */
import { UUID_RE } from '../lib/lessons';
import { isStaff } from '../lib/staff';

const ANON_ID_RE = /^[A-Za-z0-9-]{16,64}$/;
export const FEEDBACK_TAGS = ['too_hard', 'too_easy', 'wrong_answer', 'subtitle_off', 'unclear_explanation', 'video_issue'] as const;

export function registerFeedbackRoutes(router: any, context: any) {
	const { database, logger } = context;
	const fail = (res: any, what: string, error: any) => {
		logger?.error?.(`[feedback] ${what} failed: ${String(error)}`);
		return res.status(500).json({ success: false, message: 'Server error' });
	};

	router.post('/listening-lab/lessons/:key/feedback', async (req: any, res: any) => {
		const key = String(req.params.key || '');
		if (!key || key.length > 64) return res.status(400).json({ success: false, message: 'Invalid lesson key' });
		const userId = req.accountability?.user ?? null;
		const body = req.body || {};
		const anonymousId = !userId && typeof body.anonymous_id === 'string' && ANON_ID_RE.test(body.anonymous_id) ? body.anonymous_id : null;
		if (!userId && !anonymousId) return res.status(400).json({ success: false, message: 'Who is sending it?' });
		const rating = Number(body.rating);
		if (![1, 2, 3].includes(rating)) return res.status(400).json({ success: false, message: 'Invalid rating' });
		const tags = Array.isArray(body.tags) ? [...new Set(body.tags.filter((t: unknown) => FEEDBACK_TAGS.includes(t as any)))] : [];
		const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 2000) || null : null;
		const score = Number.isFinite(body.score) ? Math.max(0, Math.min(100, Math.round(body.score))) : null;
		const locale = typeof body.locale === 'string' ? body.locale.slice(0, 10) : null;

		try {
			const lesson = await database('listening_lessons').select('id').where(UUID_RE.test(key) ? { id: key } : { short_id: key }).first();
			if (!lesson) return res.status(404).json({ success: false, message: 'Lesson not found' });

			const values = [lesson.id, userId, anonymousId, rating, JSON.stringify(tags), comment, score, locale];
			// Sending again (e.g. the rating first, the details after): same row, back to "new"
			const conflict = userId ? '(lesson_id, user_id) WHERE user_id IS NOT NULL' : '(lesson_id, anonymous_id) WHERE user_id IS NULL';
			await database.raw(`
				INSERT INTO listening_feedback (lesson_id, user_id, anonymous_id, rating, tags, comment, score, locale)
				VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?)
				ON CONFLICT ${conflict} DO UPDATE SET
					rating = EXCLUDED.rating, tags = EXCLUDED.tags, comment = EXCLUDED.comment,
					score = COALESCE(EXCLUDED.score, listening_feedback.score), locale = EXCLUDED.locale,
					status = 'new', date_updated = now()
			`, values);
			return res.json({ success: true });
		} catch (error) {
			return fail(res, 'Save', error);
		}
	});

	router.get('/admin/listening-feedback', async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Forbidden' });
		const q = req.query || {};
		const status = q.status === 'new' || q.status === 'done' ? q.status : null;
		const rating = [1, 2, 3].includes(Number(q.rating)) ? Number(q.rating) : null;
		const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
		const page = Math.max(1, Number(q.page) || 1);
		try {
			const filtered = () => {
				const qb = database('listening_feedback as f');
				if (status) qb.where('f.status', status);
				if (rating) qb.where('f.rating', rating);
				return qb;
			};
			const [rows, total, counts] = await Promise.all([
				filtered()
					.join('listening_lessons as l', 'l.id', 'f.lesson_id')
					.leftJoin('listening_skills as s', 's.id', 'l.skill_id')
					.leftJoin('directus_users as u', 'u.id', 'f.user_id')
					.select(
						'f.id', 'f.rating', 'f.tags', 'f.comment', 'f.score', 'f.locale', 'f.status', 'f.date_created', 'f.date_updated',
						'l.id as lesson_id', 'l.text as lesson_text', 'l.short_id', 's.name as skill_name',
						'u.email', 'u.first_name', 'u.last_name',
					)
					.orderBy('f.date_updated', 'desc')
					.limit(limit)
					.offset((page - 1) * limit),
				filtered().count('* as n').first(),
				// Per rating, within the status filter: the numbers on the filter buttons
				(() => {
					const qb = database('listening_feedback').select('rating').count('* as n').groupBy('rating');
					if (status) qb.where('status', status);
					return qb;
				})(),
			]);
			return res.json({
				success: true,
				data: {
					rows: rows.map((r: any) => ({ ...r, tags: Array.isArray(r.tags) ? r.tags : [] })),
					total: Number(total?.n) || 0,
					by_rating: Object.fromEntries(counts.map((c: any) => [c.rating, Number(c.n) || 0])),
				},
			});
		} catch (error) {
			return fail(res, 'List', error);
		}
	});

	router.patch('/admin/listening-feedback/:id', async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Forbidden' });
		const id = String(req.params.id || '');
		const status = req.body?.status;
		if (!UUID_RE.test(id) || (status !== 'new' && status !== 'done')) return res.status(400).json({ success: false, message: 'Invalid' });
		try {
			const n = await database('listening_feedback').where({ id }).update({ status, date_updated: database.fn.now() });
			return n ? res.json({ success: true }) : res.status(404).json({ success: false, message: 'Not found' });
		} catch (error) {
			return fail(res, 'Update', error);
		}
	});
}
