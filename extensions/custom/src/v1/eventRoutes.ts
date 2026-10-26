/**
 * What people do on the site, guests included (table learning_events,
 * database/migrations/2026-10-21_analytics.sql). Read by the admin dashboard.
 *
 *   POST /events   { event, lesson_key?, step?, path?, anonymous_id? }
 *                  event: visit | lesson_open | lesson_start | step | result | landing | skip | setting
 *                  (landing: the home page ear test, step = play | answer | right | cta;
 *                  skip: "Skip this step", step = voice | challenge | more;
 *                  setting: a practice setting chosen, step = voice_type | challenge_hard...,
 *                  2026-10-26_practice_modes.sql)
 *                  One row per person, Vietnam day, event, lesson and step: repeats are
 *                  dropped. Never fails the page: a bad body is a 400, a server error a 204.
 *
 * Real people only (2026-10-26_analytics_humans.sql): the site sends nothing before the
 * visitor scrolls, taps or types (useLearningEvents), and known bots and headless browsers
 * are dropped here with a 204.
 */
import { PRACTICE, UUID_RE } from '../lib/lessons';

const TZ = 'Asia/Ho_Chi_Minh';
const ANON_ID_RE = /^[A-Za-z0-9-]{16,64}$/;
const EVENTS = ['visit', 'lesson_open', 'lesson_start', 'step', 'result', 'landing', 'skip', 'setting'];
const STEPS: Record<string, string[]> = {
	step: ['type', 'voice', 'challenge', 'more'],
	landing: ['play', 'answer', 'right', 'cta'],
	skip: ['voice', 'challenge', 'more'],
	setting: [...PRACTICE.voice.map((v) => `voice_${v}`), ...PRACTICE.challenge.map((v) => `challenge_${v}`)],
};
const LESSON_EVENTS = ['lesson_open', 'lesson_start', 'step', 'result', 'skip'];
/** Crawlers, link previews, speed tests and headless browsers (they can run the page's JS) */
const BOT_UA_RE = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|inspectiontool|phantomjs|puppeteer|playwright|selenium|python-requests|curl|wget/i;

export function registerEventRoutes(router: any, context: any) {
	const { database, logger } = context;

	router.post('/events', async (req: any, res: any) => {
		const body = req.body || {};
		const ua = String(req.headers?.['user-agent'] || '');
		if (!ua || BOT_UA_RE.test(ua)) return res.status(204).end();
		const userId = req.accountability?.user ?? null;
		const anonymousId = typeof body.anonymous_id === 'string' && ANON_ID_RE.test(body.anonymous_id) ? body.anonymous_id : null;
		const event = String(body.event || '');
		if (!EVENTS.includes(event)) return res.status(400).json({ success: false, message: 'Unknown event' });
		if (!userId && !anonymousId) return res.status(400).json({ success: false, message: 'Who is it?' });
		const steps = STEPS[event];
		const step = steps && steps.includes(body.step) ? body.step : null;
		if (steps && !step) return res.status(400).json({ success: false, message: 'Which step?' });
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
				ON CONFLICT (day, actor_key, event, (COALESCE(lesson_id, '00000000-0000-0000-0000-000000000000'::uuid)), (COALESCE(step, '')))
				DO UPDATE SET human = true WHERE NOT learning_events.human
			`, [userId ? `u:${userId}` : `a:${anonymousId}`, userId, anonymousId, event, lessonId, step, path]);
			return res.json({ success: true });
		} catch (error) {
			logger?.warn?.(`[events] ${event} not saved: ${String(error)}`);
			return res.status(204).end();
		}
	});
}
