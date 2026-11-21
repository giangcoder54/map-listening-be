/**
 * Feedback on a lesson (table listening_feedback, migration 2026-10-16_listening_feedback.sql).
 *
 *   POST  /listening-lab/lessons/:key/feedback   { rating 1-3, tags?, comment?, score?, locale?, anonymous_id? }
 *                                                one row per learner (or guest browser) and lesson
 *   GET   /admin/listening-feedback              ?status=new|done&rating=1|2|3&page=1&limit=20 (staff)
 *   PATCH /admin/listening-feedback/:id          { status?: 'new' | 'done', featured?: boolean, featured_name?: string } (staff)
 *   GET   /landing/testimonials                  public: quotes for the landing page = approved site_testimonials
 *                                                + lesson feedback staff featured (2026-11-19_feedback_featured.sql)
 *   POST  /landing/testimonials                  { quote 20-500, name?, anonymous_id?, website (honeypot), turnstile_token }
 *                                                anyone; lands as 'pending' (2026-11-19_site_testimonials.sql)
 *   GET   /admin/site-testimonials               ?status=pending|approved|rejected (staff)
 *   PATCH /admin/site-testimonials/:id           { status?, name?, quote? } (staff)
 *
 * Answers to the lesson page questions (table listening_answers, 2026-10-21_listening_answers.sql):
 *
 *   POST  /listening-lab/lessons/:key/answers    { kind, question, answer, comment?, clip_id?, step?,
 *                                                  context?, locale?, anonymous_id? }
 *                                                one row per learner, question, lesson and clip
 *   GET   /admin/listening-answers               ?kind=result|explanation|issue&question=&answer=&status=
 *                                                &page=1&limit=20 (staff): rows, counts, worst explanations
 *   PATCH /admin/listening-answers/:id           { status: 'new' | 'done' } (staff)
 */
import { UUID_RE } from '../lib/lessons';
import { isStaff } from '../lib/staff';
import { clientIp, isLimited } from '../lib/rateLimit';
import { verifyTurnstile } from '../lib/turnstile';

const ANON_ID_RE = /^[A-Za-z0-9-]{16,64}$/;
export const FEEDBACK_TAGS = ['too_hard', 'too_easy', 'wrong_answer', 'subtitle_off', 'unclear_explanation', 'video_issue'] as const;

/** kind -> question -> the answers it takes. 'skip' (result card, passed over) is added below. */
export const QUESTIONS: Record<string, Record<string, readonly string[]>> = {
	result: {
		goal: ['exam', 'movies', 'work', 'general'],
		challenge: ['just_right', 'too_easy', 'missed_words', 'which_wrong'],
		enough: ['got_it', 'need_practice', 'still_unclear'],
		first_level: ['too_easy', 'just_right', 'too_hard'],
		skill_more: ['more_lessons', 'video_explanation', 'speaking', 'enough'],
		length: ['too_short', 'just_right', 'too_long'],
		// "Ideas to make GuideLingo better" under the result card: the idea is the comment
		site_idea: ['idea'],
	},
	explanation: {
		explanation: ['up', 'down', 'still_unclear', 'need_example', 'wrong', 'too_long'],
	},
	issue: {
		clip_issue: ['subtitle_off', 'wrong_answer', 'marked_wrong', 'video_issue', 'other'],
	},
};
const answersOf = (kind: string, question: string) => {
	const list = QUESTIONS[kind]?.[question];
	if (!list) return null;
	return kind === 'result' ? [...list, 'skip'] : list;
};
/** Context kept with an answer: a few flat numbers / short strings, nothing else */
const cleanContext = (raw: unknown) => {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
	const out: Record<string, string | number | boolean> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 12)) {
		if (!/^[a-z_]{1,24}$/.test(k)) continue;
		if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 100) / 100;
		else if (typeof v === 'boolean') out[k] = v;
		else if (typeof v === 'string') out[k] = v.slice(0, 200);
	}
	return out;
};

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
						'f.id', 'f.rating', 'f.tags', 'f.comment', 'f.score', 'f.locale', 'f.status', 'f.featured', 'f.featured_name', 'f.date_created', 'f.date_updated',
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

	router.post('/listening-lab/lessons/:key/answers', async (req: any, res: any) => {
		const key = String(req.params.key || '');
		if (!key || key.length > 64) return res.status(400).json({ success: false, message: 'Invalid lesson key' });
		const userId = req.accountability?.user ?? null;
		const body = req.body || {};
		const anonymousId = !userId && typeof body.anonymous_id === 'string' && ANON_ID_RE.test(body.anonymous_id) ? body.anonymous_id : null;
		if (!userId && !anonymousId) return res.status(400).json({ success: false, message: 'Who is sending it?' });
		const kind = String(body.kind || '');
		const question = String(body.question || '');
		const answer = String(body.answer || '');
		if (!answersOf(kind, question)?.includes(answer)) return res.status(400).json({ success: false, message: 'Invalid answer' });
		const clipId = typeof body.clip_id === 'string' && UUID_RE.test(body.clip_id) ? body.clip_id : null;
		if (kind !== 'result' && !clipId) return res.status(400).json({ success: false, message: 'Which clip?' });
		const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 2000) || null : null;
		const step = typeof body.step === 'string' && /^[a-z]{1,20}$/.test(body.step) ? body.step : null;
		const locale = typeof body.locale === 'string' ? body.locale.slice(0, 10) : null;
		const context = cleanContext(body.context);

		try {
			const lesson = await database('listening_lessons').select('id').where(UUID_RE.test(key) ? { id: key } : { short_id: key }).first();
			if (!lesson) return res.status(404).json({ success: false, message: 'Lesson not found' });
			if (clipId && !(await database('listening_clips').select('id').where({ id: clipId }).first())) {
				return res.status(404).json({ success: false, message: 'Clip not found' });
			}
			const learnerKey = userId ? `u:${userId}` : `a:${anonymousId}`;
			// Answering again updates the row; a later "skip" never wipes a real answer
			await database.raw(`
				INSERT INTO listening_answers (kind, question, answer, comment, lesson_id, clip_id, step, user_id, anonymous_id, learner_key, context, locale)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)
				ON CONFLICT (question, lesson_id, learner_key, (COALESCE(clip_id, '00000000-0000-0000-0000-000000000000'::uuid))) DO UPDATE SET
					answer = EXCLUDED.answer, comment = COALESCE(EXCLUDED.comment, listening_answers.comment),
					step = EXCLUDED.step, context = EXCLUDED.context, locale = EXCLUDED.locale,
					status = 'new', date_updated = now()
				WHERE EXCLUDED.answer <> 'skip' OR listening_answers.answer = 'skip'
			`, [kind, question, answer, comment, lesson.id, clipId, step, userId, anonymousId, learnerKey, JSON.stringify(context), locale]);
			return res.json({ success: true });
		} catch (error) {
			return fail(res, 'Save answer', error);
		}
	});

	router.get('/admin/listening-answers', async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Forbidden' });
		const q = req.query || {};
		const kind = QUESTIONS[q.kind] ? String(q.kind) : 'result';
		const question = typeof q.question === 'string' && QUESTIONS[kind][q.question] ? q.question : null;
		const answer = typeof q.answer === 'string' && /^[a-z_]{1,40}$/.test(q.answer) ? q.answer : null;
		const status = q.status === 'new' || q.status === 'done' ? q.status : null;
		const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
		const page = Math.max(1, Number(q.page) || 1);
		try {
			const filtered = () => {
				const qb = database('listening_answers as a').where('a.kind', kind);
				if (question) qb.where('a.question', question);
				if (answer) qb.where('a.answer', answer);
				if (status) qb.where('a.status', status);
				return qb;
			};
			const [rows, total, counts, clips, goals, goalOthers, levels, goalLevels, sources, sourceOthers] = await Promise.all([
				filtered()
					.join('listening_lessons as l', 'l.id', 'a.lesson_id')
					.leftJoin('listening_clips as c', 'c.id', 'a.clip_id')
					.leftJoin('directus_users as u', 'u.id', 'a.user_id')
					.select(
						'a.id', 'a.question', 'a.answer', 'a.comment', 'a.step', 'a.context', 'a.status', 'a.locale', 'a.date_updated',
						'l.id as lesson_id', 'l.text as lesson_text', 'l.short_id',
						'a.clip_id', 'c.transcript as clip_transcript', 'c.answer as clip_answer',
						'u.email', 'u.first_name', 'u.last_name',
					)
					.orderBy('a.date_updated', 'desc')
					.limit(limit)
					.offset((page - 1) * limit),
				filtered().count('* as n').first(),
				// Every answer of every question of this kind: the bars on the page
				database('listening_answers').where('kind', kind).select('question', 'answer').count('* as n').groupBy('question', 'answer'),
				// Explanations: the clips most often found unclear first
				kind !== 'explanation' ? Promise.resolve([]) : database('listening_answers as a')
					.join('listening_lessons as l', 'l.id', 'a.lesson_id')
					.join('listening_clips as c', 'c.id', 'a.clip_id')
					.where('a.kind', 'explanation')
					.groupBy('a.clip_id', 'c.transcript', 'c.answer', 'c.step', 'l.id', 'l.text', 'l.short_id')
					.select(
						'a.clip_id', 'c.transcript', 'c.answer', 'c.step', 'l.id as lesson_id', 'l.text as lesson_text', 'l.short_id',
						database.raw(`COUNT(*) FILTER (WHERE a.answer = 'up')::int AS up`),
						database.raw(`COUNT(*) FILTER (WHERE a.answer <> 'up')::int AS down`),
					)
					.orderByRaw(`COUNT(*) FILTER (WHERE a.answer <> 'up') DESC, COUNT(*) DESC`)
					.limit(10),
				// Signed-in learners: the survey after sign-in (2026-10-21_learning_goal.sql), several
				// goals each: one count per goal, plus how many people answered ('people') or skipped
				kind !== 'result' ? Promise.resolve({ rows: [] }) : database.raw(`
					SELECT g AS goal, COUNT(*)::int AS n
					FROM directus_users, jsonb_array_elements_text(learning_goals) AS g
					WHERE jsonb_typeof(learning_goals) = 'array'
					GROUP BY g
					UNION ALL
					SELECT 'people', COUNT(*)::int FROM directus_users
					WHERE jsonb_typeof(learning_goals) = 'array' AND NOT learning_goals @> '["skip"]'::jsonb
				`),
				// Their own words when none of the goals fit
				kind !== 'result' ? Promise.resolve([]) : database('directus_users')
					.whereRaw(`learning_goals @> '["other"]'::jsonb`)
					.whereNotNull('learning_goal_other')
					.select('learning_goal_other as text', 'learning_goal_at as date', 'email')
					.orderBy('learning_goal_at', 'desc')
					.limit(30),
				// Their listening level, one each (2026-10-30_listening_level.sql)
				kind !== 'result' ? Promise.resolve([]) : database('directus_users')
					.whereNotNull('listening_level')
					.groupBy('listening_level')
					.select('listening_level as level')
					.count('* as n'),
				// Goal x level: learners who answered both, one count per goal they picked
				kind !== 'result' ? Promise.resolve({ rows: [] }) : database.raw(`
					SELECT g AS goal, listening_level AS level, COUNT(*)::int AS n
					FROM directus_users, jsonb_array_elements_text(learning_goals) AS g
					WHERE jsonb_typeof(learning_goals) = 'array' AND listening_level IS NOT NULL
					GROUP BY g, listening_level
				`),
				// Where they first heard of us, one each (2026-11-13_heard_from.sql)
				kind !== 'result' ? Promise.resolve([]) : database('directus_users')
					.whereNotNull('heard_from')
					.groupBy('heard_from')
					.select('heard_from as source')
					.count('* as n'),
				kind !== 'result' ? Promise.resolve([]) : database('directus_users')
					.where('heard_from', 'other')
					.whereNotNull('heard_from_other')
					.select('heard_from_other as text', 'heard_from_at as date', 'email')
					.orderBy('heard_from_at', 'desc')
					.limit(30),
			]);
			const byQuestion: Record<string, Record<string, number>> = {};
			for (const c of counts as any[]) (byQuestion[c.question] ||= {})[c.answer] = Number(c.n) || 0;
			return res.json({
				success: true,
				data: {
					kind, rows, total: Number(total?.n) || 0, counts: byQuestion, clips,
					user_goals: Object.fromEntries(((goals as any).rows || []).map((g: any) => [g.goal, Number(g.n) || 0])),
					goal_others: goalOthers,
					user_sources: Object.fromEntries((sources as any[]).map((s) => [s.source, Number(s.n) || 0])),
						source_others: sourceOthers,
						user_levels: Object.fromEntries((levels as any[]).map((l) => [l.level, Number(l.n) || 0])),
					/** { goal: { level: n } } */
					user_goal_levels: ((goalLevels as any).rows || []).reduce((acc: Record<string, Record<string, number>>, r: any) => {
						(acc[r.goal] ||= {})[r.level] = Number(r.n) || 0;
						return acc;
					}, {}),
				},
			});
		} catch (error) {
			return fail(res, 'List answers', error);
		}
	});

	router.patch('/admin/listening-answers/:id', async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Forbidden' });
		const id = String(req.params.id || '');
		const status = req.body?.status;
		if (!UUID_RE.test(id) || (status !== 'new' && status !== 'done')) return res.status(400).json({ success: false, message: 'Invalid' });
		try {
			const n = await database('listening_answers').where({ id }).update({ status, date_updated: database.fn.now() });
			return n ? res.json({ success: true }) : res.status(404).json({ success: false, message: 'Not found' });
		} catch (error) {
			return fail(res, 'Update answer', error);
		}
	});

	router.patch('/admin/listening-feedback/:id', async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Forbidden' });
		const id = String(req.params.id || '');
		const body = req.body || {};
		const patch: Record<string, unknown> = {};
		if (body.status === 'new' || body.status === 'done') patch.status = body.status;
		if (typeof body.featured === 'boolean') patch.featured = body.featured;
		if (typeof body.featured_name === 'string') patch.featured_name = body.featured_name.trim().slice(0, 60) || null;
		if (!UUID_RE.test(id) || !Object.keys(patch).length) return res.status(400).json({ success: false, message: 'Invalid' });
		try {
			// Only a good rating with a comment can go on the landing page
			if (patch.featured === true) {
				const row = await database('listening_feedback').select('rating', 'comment').where({ id }).first();
				if (!row) return res.status(404).json({ success: false, message: 'Not found' });
				if (row.rating !== 3 || !row.comment) return res.status(400).json({ success: false, message: 'Only a good rating with a comment can be featured' });
			}
			// date_updated moves with the status (as before); picking a quote alone leaves it, it is not new feedback
			if (patch.status) patch.date_updated = database.fn.now();
			const n = await database('listening_feedback').where({ id }).update(patch);
			return n ? res.json({ success: true }) : res.status(404).json({ success: false, message: 'Not found' });
		} catch (error) {
			return fail(res, 'Update', error);
		}
	});

	// Landing page quotes: public. Approved quotes written on the site, plus lesson feedback staff
	// featured. No account data: the name is the one typed by the writer / staff.
	router.get('/landing/testimonials', async (_req: any, res: any) => {
		try {
			const [site, lessons] = await Promise.all([
				// Name and photo come from the writer's profile only when they ticked "show me"
				database('site_testimonials as t').leftJoin('directus_users as u', 'u.id', 't.user_id')
					.select('t.id', 't.quote', 't.name', 't.locale', 't.date_updated', 't.show_profile', 'u.first_name', 'u.last_name', 'u.avatar', 'u.avatar_url')
					.where('t.status', 'approved').orderBy('t.date_updated', 'desc').limit(12),
				database('listening_feedback')
					.select('id', 'comment as quote', 'featured_name as name', 'locale', 'date_updated')
					.where({ featured: true, rating: 3 })
					.whereNotNull('comment')
					.orderBy('date_updated', 'desc')
					.limit(9),
			]);
			const merged = [...site, ...lessons]
				.sort((a: any, b: any) => +new Date(b.date_updated) - +new Date(a.date_updated))
				.slice(0, 12)
				.map((r: any) => {
					const own = r.show_profile === true;
					// First name and the initial of the last one: "Lan N."
					const profileName = own ? [r.first_name, r.last_name ? `${String(r.last_name).trim().charAt(0).toUpperCase()}.` : ''].filter(Boolean).join(' ') : '';
					return {
						id: r.id, quote: r.quote, locale: r.locale,
						name: r.name || profileName || null,
						avatar: own ? r.avatar || null : null,
						avatar_url: own && !r.avatar ? r.avatar_url || null : null,
					};
				});
			res.set('Cache-Control', 'public, max-age=300');
			return res.json({ success: true, data: merged });
		} catch (error) {
			return fail(res, 'Testimonials', error);
		}
	});

	// Should the learner be asked for a few words now? Signed in, has not written one, and has finished 3 lessons.
	router.get('/landing/my-testimonial', async (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		if (!userId) return res.json({ success: true, data: { eligible: false } });
		try {
			const [mine, done] = await Promise.all([
				database('site_testimonials').where({ user_id: userId }).first('id'),
				database('listening_progress').where({ user_id: userId }).whereNotNull('completed_at').count('* as n').first(),
			]);
			return res.json({ success: true, data: { eligible: !mine && Number((done as any)?.n) >= 3 } });
		} catch (error) {
			return fail(res, 'My testimonial', error);
		}
	});

	// Anyone can write one; it is not public until staff approve it
	router.post('/landing/testimonials', async (req: any, res: any) => {
		const body = req.body || {};
		if (typeof body.website === 'string' && body.website.trim()) return res.status(201).json({ success: true }); // honeypot
		const quote = typeof body.quote === 'string' ? body.quote.trim() : '';
		if (quote.length < 20 || quote.length > 500) return res.status(400).json({ success: false, code: 'INVALID', message: 'Write between 20 and 500 characters.' });
		const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) || null : null;
		const userId = req.accountability?.user ?? null;
		const anonymousId = !userId && typeof body.anonymous_id === 'string' && ANON_ID_RE.test(body.anonymous_id) ? body.anonymous_id : null;
		if (!userId && !anonymousId) return res.status(400).json({ success: false, message: 'Who is sending it?' });
		const locale = typeof body.locale === 'string' ? body.locale.slice(0, 10) : null;
		// Real name and photo from the profile: only for a signed-in writer who ticked the box
		const showProfile = !!userId && body.consent === true;
		// 3 per hour per IP, however many accounts or browsers
		if (isLimited('testimonial', clientIp(req), 3, 3600000)) return res.status(429).json({ success: false, code: 'TOO_MANY_REQUESTS', message: 'Please try again later.' });
		// Guests prove they are people; signed-in learners are already known
		if (!userId && !(await verifyTurnstile(body.turnstile_token, clientIp(req), logger))) {
			return res.status(400).json({ success: false, code: 'CAPTCHA_FAILED', message: 'Captcha check failed' });
		}
		try {
			const conflict = userId ? '(user_id) WHERE user_id IS NOT NULL' : '(anonymous_id) WHERE user_id IS NULL';
			// Writing again replaces the earlier quote and sends it back for review
			await database.raw(`
				INSERT INTO site_testimonials (user_id, anonymous_id, name, quote, locale, show_profile)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT ${conflict} DO UPDATE SET
					name = EXCLUDED.name, quote = EXCLUDED.quote, locale = EXCLUDED.locale, show_profile = EXCLUDED.show_profile,
					status = 'pending', date_updated = now()
			`, [userId, anonymousId, name, quote, locale, showProfile]);
			return res.status(201).json({ success: true });
		} catch (error) {
			return fail(res, 'Testimonial save', error);
		}
	});

	router.get('/admin/site-testimonials', async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Forbidden' });
		const status = ['pending', 'approved', 'rejected'].includes(req.query?.status) ? req.query.status : null;
		try {
			const qb = database('site_testimonials as t').leftJoin('directus_users as u', 'u.id', 't.user_id')
				.select('t.id', 't.name', 't.quote', 't.locale', 't.status', 't.show_profile', 't.date_created', 't.date_updated', 'u.email', 'u.first_name', 'u.last_name')
				.orderBy('t.date_created', 'desc').limit(100);
			if (status) qb.where('t.status', status);
			const [rows, counts] = await Promise.all([qb, database('site_testimonials').select('status').count('* as n').groupBy('status')]);
			return res.json({ success: true, data: { rows, counts: Object.fromEntries(counts.map((c: any) => [c.status, Number(c.n) || 0])) } });
		} catch (error) {
			return fail(res, 'Testimonial list', error);
		}
	});

	router.patch('/admin/site-testimonials/:id', async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Forbidden' });
		const id = String(req.params.id || '');
		const body = req.body || {};
		const patch: Record<string, unknown> = {};
		if (['pending', 'approved', 'rejected'].includes(body.status)) patch.status = body.status;
		if (typeof body.name === 'string') patch.name = body.name.trim().slice(0, 60) || null;
		if (typeof body.quote === 'string' && body.quote.trim().length >= 20 && body.quote.trim().length <= 500) patch.quote = body.quote.trim();
		if (!UUID_RE.test(id) || !Object.keys(patch).length) return res.status(400).json({ success: false, message: 'Invalid' });
		try {
			patch.date_updated = database.fn.now();
			const n = await database('site_testimonials').where({ id }).update(patch);
			return n ? res.json({ success: true }) : res.status(404).json({ success: false, message: 'Not found' });
		} catch (error) {
			return fail(res, 'Testimonial update', error);
		}
	});
}
