/**
 * What people do on the site, guests included (table learning_events,
 * database/migrations/2026-10-21_analytics.sql). Read by the admin dashboard.
 *
 *   POST /events   { event, lesson_key?, step?, path?, anonymous_id? }
 *                  event: visit | lesson_open | lesson_start | step | result
 *                  One row per person, Vietnam day, event, lesson and step: repeats are
 *                  dropped. Never fails the page: a bad body is a 400, a server error a 204.
 */
import { UUID_RE } from '../lib/lessons';

const TZ = 'Asia/Ho_Chi_Minh';
const ANON_ID_RE = /^[A-Za-z0-9-]{16,64}$/;
const EVENTS = ['visit', 'lesson_open', 'lesson_start', 'step', 'result'];
const STEPS = ['type', 'voice', 'challenge', 'more'];
const LESSON_EVENTS = ['lesson_open', 'lesson_start', 'step', 'result'];

export function registerEventRoutes(router: any, context: any) {
	const { database, logger } = context;

	router.post('/events', async (req: any, res: any) => {
		const body = req.body || {};
		const userId = req.accountability?.user ?? null;
		const anonymousId = typeof body.anonymous_id === 'string' && ANON_ID_RE.test(body.anonymous_id) ? body.anonymous_id : null;
		const event = String(body.event || '');
		if (!EVENTS.includes(event)) return res.status(400).json({ success: false, message: 'Unknown event' });
		if (!userId && !anonymousId) return res.status(400).json({ success: false, message: 'Who is it?' });
		const step = event === 'step' && STEPS.includes(body.step) ? body.step : null;
		if (event === 'step' && !step) return res.status(400).json({ success: false, message: 'Which step?' });
		const key = typeof body.lesson_key === 'string' ? body.lesson_key.slice(0, 64) : '';
		if (LESSON_EVENTS.includes(event) && !key) return res.status(400).json({ success: false, message: 'Which lesson?' });
		const path = typeof body.path === 'string' ? body.path.slice(0, 200) : null;

		try {
			let lessonId: string | null = null;
			if (key) {
				const lesson = await database('listening_lessons').select('id').where(UUID_RE.test(key) ? { id: key } : { short_id: key }).first();
				if (!lesson) return res.status(404).json({ success: false, message: 'Lesson not found' });
				lessonId = lesson.id;
			}
			await database.raw(`
				INSERT INTO learning_events (day, actor_key, user_id, anonymous_id, event, lesson_id, step, path)
				VALUES ((now() AT TIME ZONE '${TZ}')::date, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT DO NOTHING
			`, [userId ? `u:${userId}` : `a:${anonymousId}`, userId, anonymousId, event, lessonId, step, path]);
			return res.json({ success: true });
		} catch (error) {
			logger?.warn?.(`[events] ${event} not saved: ${String(error)}`);
			return res.status(204).end();
		}
	});
}
