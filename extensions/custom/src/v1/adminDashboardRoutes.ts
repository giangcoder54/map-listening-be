/**
 * Admin home numbers (Directus admins only). Days are Vietnam days (Asia/Ho_Chi_Minh).
 *
 *   GET /admin/dashboard   ?days=7|30|90 (default 30) &month=YYYY-MM (default this month)
 *                          -> daily series for the period and the one before it, sales of
 *                             both, the month's goals with progress,
 *                             every lesson used in the period, most used / hardest first
 *                             (the page paginates them)
 *   PUT /admin/goals       { month, targets: { <metric>: number | null } }  null = no goal
 *   POST   /admin/releases      { day: YYYY-MM-DD, title }  a change shipped, marked on the charts
 *   DELETE /admin/releases/:id
 *   GET /admin/my-progress ?month=  the caller's lessons vs the team goal; admins and
 *                          content editors (admins also get every author's numbers)
 *
 * Definitions (the three modes count alike: Connected Speech incl. the practice bank,
 * Intensive Listening, Extensive Listening; see ANSWERS / FINISHES / STARTS below):
 *   answer           a clip answered, an Intensive sentence typed, an Extensive question answered
 *   active learner   an account with at least one answer that day
 *   WAU / MAU        active learners in the 7 / 30 days up to that day
 *   lesson start     first time a learner opens a lesson (Intensive / Extensive: accounts only)
 *   completion       a lesson finished (Intensive / Extensive: the first finish of each lesson)
 *   accuracy         share right on the first try (Intensive: words of round 1; Extensive: questions)
 *   lessons published  Connected Speech only (the other two keep no publish date)
 *
 * North Star: weekly learners = accounts that finished at least one lesson of any mode that week.
 *
 * Team and test accounts (directus_users.is_internal, 2026-10-21_analytics.sql) are left out
 * of every number.
 *
 * Visitor journey, home page and coming back (2026-10-21_analytics.sql): `journey` and
 * `landing` come from learning_events (guests included). Only rows from real people count
 * (`human`, 2026-10-26_analytics_humans.sql: bots dropped, nothing sent before a scroll, tap
 * or key), so they start on the day that was deployed: `events_since`. Intensive / Extensive
 * send no events: the journey adds them from their saved goes, so for signed-in accounts only.
 *
 */
import { staffRole } from '../lib/staff';

const TZ = 'Asia/Ho_Chi_Minh';
const PERIODS = [7, 30, 90];
export const GOAL_METRICS = ['lessons_published', 'new_users', 'paid_orders', 'revenue_vnd', 'learning_dau'] as const;
type GoalMetric = (typeof GOAL_METRICS)[number];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** SQL: the row's user (column `col`, may be NULL for a guest) is not a team or test account */
const real = (col: string) => `NOT EXISTS (SELECT 1 FROM directus_users iu WHERE iu.id = ${col} AND iu.is_internal)`;

/** Every answer of the three modes: (user_id, at). Extensive keeps no time per answer: its go's. */
const ANSWERS = `
	SELECT user_id, date_created AS at FROM listening_attempts
	UNION ALL
	SELECT a.user_id, r.date_created FROM il_results r JOIN il_attempts a ON a.id = r.attempt_id
	UNION ALL
	SELECT user_id, coalesce(finished_at, date_created) FROM el_attempts, jsonb_object_keys(el_attempts.answers)`;
/** Lessons finished: (user_id, lesson_id, at). Intensive / Extensive: the first finish only */
const FINISHES = `
	SELECT user_id, lesson_id, completed_at AS at FROM listening_progress WHERE status = 'completed' AND completed_at IS NOT NULL
	UNION ALL
	SELECT user_id, lesson_id, min(finished_at) FROM il_attempts WHERE finished_at IS NOT NULL GROUP BY 1, 2
	UNION ALL
	SELECT user_id, lesson_id, min(finished_at) FROM el_attempts WHERE finished_at IS NOT NULL GROUP BY 1, 2`;
/** Lessons started: (user_id, lesson_id, at), once per learner and lesson */
const STARTS = `
	SELECT user_id, lesson_id, date_created AS at FROM listening_lesson_learners
	UNION ALL
	SELECT user_id, lesson_id, min(date_created) FROM il_attempts GROUP BY 1, 2
	UNION ALL
	SELECT user_id, lesson_id, min(date_created) FROM el_attempts GROUP BY 1, 2`;

/** 'YYYY-MM-DD' of `date` in Vietnam */
const vnDay = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(date);
const addDays = (day: string, n: number) => {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
};
const daysInMonth = (month: string) => {
	const [y, m] = month.split('-').map(Number);
	return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
};

export function registerAdminDashboardRoutes(router: any, context: any) {
	const { database, logger } = context;
	const admin = (handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
		if (!req.accountability?.admin) return res.status(403).json({ success: false, message: 'Admins only' });
		try {
			return await handler(req, res);
		} catch (error: any) {
			if (error?.status) return res.status(error.status).json({ success: false, message: error.message });
			logger?.error?.(`[admin-dashboard] ${req.method} ${req.path} failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};
	const bad = (message: string) => Object.assign(new Error(message), { status: 400 });

	/** One row per Vietnam day from `from` to `to` (inclusive) */
	const dailySeries = async (from: string, to: string) => (await database.raw(`
		WITH days AS (
			SELECT d::date AS day,
				(d::timestamp AT TIME ZONE '${TZ}') AS t0,
				((d + interval '1 day')::timestamp AT TIME ZONE '${TZ}') AS t1
			FROM generate_series(?::date, ?::date, interval '1 day') AS d
		),
		answers AS (${ANSWERS}),
		starts AS (${STARTS}),
		finishes AS (${FINISHES})
		SELECT to_char(day, 'YYYY-MM-DD') AS day,
			(SELECT count(*) FROM directus_users WHERE status = 'active' AND NOT is_internal AND gl_created_at >= t0 AND gl_created_at < t1)::int AS new_users,
			(SELECT count(*) FROM directus_users WHERE status = 'active' AND NOT is_internal AND gl_created_at < t1)::int AS total_users,
			(SELECT count(DISTINCT user_id) FROM answers WHERE at >= t0 AND at < t1 AND ${real('user_id')})::int AS dau,
			(SELECT count(DISTINCT user_id) FROM answers WHERE at >= t1 - interval '7 days' AND at < t1 AND ${real('user_id')})::int AS wau,
			(SELECT count(DISTINCT user_id) FROM answers WHERE at >= t1 - interval '30 days' AND at < t1 AND ${real('user_id')})::int AS mau,
			(SELECT count(*) FROM answers WHERE at >= t0 AND at < t1 AND ${real('user_id')})::int AS attempts,
			(SELECT count(*) FROM starts WHERE at >= t0 AND at < t1 AND ${real('user_id')})::int AS lesson_starts,
			(SELECT count(*) FROM finishes WHERE at >= t0 AND at < t1 AND ${real('user_id')})::int AS completions,
			(SELECT count(*) FROM listening_lessons WHERE status = 'published' AND coalesce(kind, 'pattern') <> 'bank' AND published_at >= t0 AND published_at < t1)::int AS lessons_published
		FROM days ORDER BY day
	`, [from, to])).rows;

	/** Paid orders and revenue per currency between two Vietnam days (inclusive) */
	const sales = async (from: string, to: string) => {
		const rows = (await database.raw(`
			SELECT lower(currency) AS currency, count(*)::int AS orders, sum(amount)::bigint AS amount
			FROM purchase_histories
			WHERE status = 'published' AND amount > 0 AND ${real('"user"')}
				AND coalesce(date_transfer, date_created) >= (?::date::timestamp AT TIME ZONE '${TZ}')
				AND coalesce(date_transfer, date_created) < ((?::date + 1)::timestamp AT TIME ZONE '${TZ}')
			GROUP BY 1
		`, [from, to])).rows;
		return {
			orders: rows.reduce((n: number, r: any) => n + r.orders, 0),
			revenue: rows.map((r: any) => ({ currency: r.currency, amount: Number(r.amount) })),
		};
	};

	/**
	 * Everyone the site saw between two Vietnam days, as people: a guest's events count for
	 * the account they later signed in to (same anonymous_id). Team accounts left out.
	 */
	const PEOPLE_CTE = `
		ev AS (
			SELECT e.event, e.day, e.lesson_id, e.step, e.path, coalesce(e.user_id, m.user_id) AS uid, e.anonymous_id
			FROM learning_events e
			LEFT JOIN LATERAL (
				SELECT x.user_id FROM learning_events x
				WHERE e.user_id IS NULL AND x.anonymous_id = e.anonymous_id AND x.user_id IS NOT NULL LIMIT 1
			) m ON true
			WHERE e.human AND e.day BETWEEN ?::date AND ?::date
		),
		p AS (
			SELECT coalesce('u:' || uid::text, 'a:' || anonymous_id) AS person, uid, event, day, lesson_id, step, path
			FROM ev WHERE ${real('ev.uid')}
		)`;

	/** Visited -> opened a lesson -> pressed Start -> finished one; with an account; came back */
	const visitorJourney = async (from: string, to: string) => (await database.raw(`
		WITH ${PEOPLE_CTE},
		/* Intensive / Extensive goes in the period: a go is opened and started; finished when closed in it */
		other AS (
			SELECT 'u:' || g.user_id::text AS person, bool_or((g.finished_at AT TIME ZONE '${TZ}')::date BETWEEN ?::date AND ?::date) AS finished
			FROM (
				SELECT user_id, date_created, finished_at FROM il_attempts
				UNION ALL
				SELECT user_id, date_created, finished_at FROM el_attempts
			) g
			WHERE (g.date_created AT TIME ZONE '${TZ}')::date BETWEEN ?::date AND ?::date
				OR (g.finished_at AT TIME ZONE '${TZ}')::date BETWEEN ?::date AND ?::date
			GROUP BY 1
		),
		per AS (
			SELECT p.person,
				bool_or(event = 'lesson_open' OR o.person IS NOT NULL) AS opened,
				bool_or(event = 'lesson_start' OR o.person IS NOT NULL) AS started,
				bool_or(event = 'result' OR coalesce(o.finished, false)) AS finished,
				bool_or(uid IS NOT NULL) AS account,
				count(DISTINCT day) AS days
			FROM p LEFT JOIN other o ON o.person = p.person
			GROUP BY p.person
		)
		SELECT count(*)::int AS visitors,
			count(*) FILTER (WHERE opened)::int AS opened,
			count(*) FILTER (WHERE started)::int AS started,
			count(*) FILTER (WHERE finished)::int AS finished,
			count(*) FILTER (WHERE finished AND account)::int AS finished_with_account,
			count(*) FILTER (WHERE account)::int AS with_account,
			count(*) FILTER (WHERE days >= 2)::int AS came_back
		FROM per
	`, [from, to, from, to, from, to, from, to])).rows[0];

	/**
	 * Home page: people whose day started there (their `visit` was to /, /vi...) or who used its
	 * ear test -> played the clip -> picked an answer (the right one) -> clicked on to the
	 * lessons; and of them, who opened a lesson / pressed Start that day or later in the period.
	 */
	const landingFunnel = async (from: string, to: string) => (await database.raw(`
		WITH ${PEOPLE_CTE},
		landed AS (
			SELECT person, min(day) AS day FROM p
			WHERE (event = 'visit' AND path ~ '^/([a-z]{2}(-[A-Za-z]{2}){0,1}){0,1}/{0,1}$') OR event = 'landing'
			GROUP BY person
		),
		per AS (
			SELECT l.person,
				bool_or(p.event = 'landing' AND p.step = 'play') AS played,
				bool_or(p.event = 'landing' AND p.step = 'answer') AS answered,
				bool_or(p.event = 'landing' AND p.step = 'right') AS right_answer,
				bool_or(p.event = 'landing' AND p.step = 'cta') AS clicked,
				bool_or(p.event = 'lesson_open' AND p.day >= l.day) AS opened,
				bool_or(p.event = 'lesson_start' AND p.day >= l.day) AS started
			FROM landed l JOIN p ON p.person = l.person
			GROUP BY l.person
		)
		SELECT count(*)::int AS landed,
			count(*) FILTER (WHERE played)::int AS played,
			count(*) FILTER (WHERE answered)::int AS answered,
			count(*) FILTER (WHERE right_answer)::int AS right_answer,
			count(*) FILTER (WHERE clicked)::int AS clicked,
			count(*) FILTER (WHERE opened)::int AS opened,
			count(*) FILTER (WHERE started)::int AS started
		FROM per
	`, [from, to])).rows[0];

	/**
	 * Coming back, by sign-up week (last 8 weeks): accounts active (an answer or any event) on
	 * the day after sign-up, in days 1-7 and in days 8-30. `*_due` = accounts old enough for it.
	 */
	const comingBack = async (today: string) => (await database.raw(`
		WITH u AS (
			SELECT id, (gl_created_at AT TIME ZONE '${TZ}')::date AS d0
			FROM directus_users
			WHERE status = 'active' AND NOT is_internal
				AND gl_created_at >= (date_trunc('week', ?::date) - interval '7 weeks')::timestamp AT TIME ZONE '${TZ}'
		),
		learned AS (
			SELECT DISTINCT user_id, (at AT TIME ZONE '${TZ}')::date AS d FROM (${ANSWERS}) x WHERE user_id IN (SELECT id FROM u)
		),
		act AS (
			SELECT user_id, d FROM learned
			UNION
			SELECT DISTINCT user_id, day FROM learning_events WHERE user_id IN (SELECT id FROM u)
		),
		f AS (
			SELECT u.id, u.d0, date_trunc('week', u.d0)::date AS week,
				EXISTS (SELECT 1 FROM act WHERE act.user_id = u.id AND act.d = u.d0) AS day0,
				EXISTS (SELECT 1 FROM act WHERE act.user_id = u.id AND act.d = u.d0 + 1) AS day1,
				EXISTS (SELECT 1 FROM act WHERE act.user_id = u.id AND act.d BETWEEN u.d0 + 1 AND u.d0 + 7) AS week1,
				EXISTS (SELECT 1 FROM act WHERE act.user_id = u.id AND act.d BETWEEN u.d0 + 8 AND u.d0 + 30) AS month1,
				EXISTS (SELECT 1 FROM learned l WHERE l.user_id = u.id AND l.d = u.d0 + 1) AS day1_learned,
				EXISTS (SELECT 1 FROM learned l WHERE l.user_id = u.id AND l.d BETWEEN u.d0 + 1 AND u.d0 + 7) AS week1_learned,
				EXISTS (SELECT 1 FROM learned l WHERE l.user_id = u.id AND l.d BETWEEN u.d0 + 8 AND u.d0 + 30) AS month1_learned
			FROM u
		)
		SELECT to_char(week, 'YYYY-MM-DD') AS week, count(*)::int AS signups,
			count(*) FILTER (WHERE day0)::int AS learned_day0,
			count(*) FILTER (WHERE d0 + 1 <= ?::date)::int AS day1_due, count(*) FILTER (WHERE day1 AND d0 + 1 <= ?::date)::int AS day1,
			count(*) FILTER (WHERE d0 + 7 <= ?::date)::int AS week1_due, count(*) FILTER (WHERE week1 AND d0 + 7 <= ?::date)::int AS week1,
			count(*) FILTER (WHERE d0 + 30 <= ?::date)::int AS month1_due, count(*) FILTER (WHERE month1 AND d0 + 30 <= ?::date)::int AS month1,
			count(*) FILTER (WHERE day1_learned AND d0 + 1 <= ?::date)::int AS day1_learned,
			count(*) FILTER (WHERE week1_learned AND d0 + 7 <= ?::date)::int AS week1_learned,
			count(*) FILTER (WHERE month1_learned AND d0 + 30 <= ?::date)::int AS month1_learned
		FROM f GROUP BY week ORDER BY week DESC
	`, [today, today, today, today, today, today, today, today, today, today])).rows;

	/** North Star, the last 12 weeks (Monday first, this week so far last) */
	const weeklyLearners = async (today: string) => (await database.raw(`
		WITH w AS (
			SELECT generate_series(date_trunc('week', ?::date) - interval '11 weeks', date_trunc('week', ?::date), interval '1 week')::date AS week
		),
		done AS (
			SELECT user_id, (date_updated AT TIME ZONE '${TZ}')::date AS d FROM listening_progress WHERE status = 'completed' AND user_id IS NOT NULL
			UNION
			SELECT user_id, (completed_at AT TIME ZONE '${TZ}')::date FROM listening_progress WHERE completed_at IS NOT NULL AND user_id IS NOT NULL
			UNION
			SELECT user_id, day FROM learning_events WHERE event = 'result' AND user_id IS NOT NULL
			UNION
			SELECT user_id, (finished_at AT TIME ZONE '${TZ}')::date FROM il_attempts WHERE finished_at IS NOT NULL
			UNION
			SELECT user_id, (finished_at AT TIME ZONE '${TZ}')::date FROM el_attempts WHERE finished_at IS NOT NULL
		)
		SELECT to_char(w.week, 'YYYY-MM-DD') AS week,
			(SELECT count(DISTINCT done.user_id) FROM done WHERE done.d >= w.week AND done.d < w.week + 7 AND ${real('done.user_id')})::int AS learners
		FROM w ORDER BY w.week
	`, [today, today])).rows;

	router.get('/admin/dashboard', admin(async (req, res) => {
		const days = PERIODS.includes(Number(req.query.days)) ? Number(req.query.days) : 30;
		const today = vnDay(new Date());
		const month = MONTH_RE.test(String(req.query.month || '')) ? String(req.query.month) : today.slice(0, 7);
		const from = addDays(today, -(days - 1));
		const prevFrom = addDays(from, -days);
		const prevTo = addDays(from, -1);

		// Both periods in one go: the first `days` rows are the previous period
		const all = await dailySeries(prevFrom, today);
		const [now, before] = await Promise.all([sales(from, today), sales(prevFrom, prevTo)]);

		// ── Goals of `month` ──
		const monthFrom = `${month}-01`;
		const monthDays = daysInMonth(month);
		const monthTo = `${month}-${String(monthDays).padStart(2, '0')}`;
		// Days of the month already lived (0 for a future month, all of it for a past one)
		const elapsed = today < monthFrom ? 0 : today > monthTo ? monthDays : Number(today.slice(8, 10));
		const monthSeries = elapsed ? await dailySeries(monthFrom, elapsed === monthDays ? monthTo : today) : [];
		const monthSales = elapsed ? await sales(monthFrom, monthTo) : { orders: 0, revenue: [] };
		const sum = (k: string) => monthSeries.reduce((n: number, r: any) => n + r[k], 0);
		const actual: Record<GoalMetric, number> = {
			lessons_published: sum('lessons_published'),
			new_users: sum('new_users'),
			paid_orders: monthSales.orders,
			revenue_vnd: monthSales.revenue.find((r: any) => r.currency === 'vnd')?.amount || 0,
			learning_dau: monthSeries.length ? Math.round((sum('dau') / monthSeries.length) * 10) / 10 : 0,
		};
		const prevMonth = (() => {
			const [y, m] = month.split('-').map(Number);
			return m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, '0')}`;
		})();
		const goalRows = await database('admin_monthly_goals').whereIn('month', [month, prevMonth]).select('month', 'metric', 'target');
		const targetOf = (mo: string, metric: string) => {
			const row = goalRows.find((g: any) => g.month === mo && g.metric === metric);
			return row ? Number(row.target) : null;
		};
		const goals = GOAL_METRICS.map((metric) => ({
			metric,
			target: targetOf(month, metric),
			previous_target: targetOf(prevMonth, metric),
			actual: actual[metric],
			// Totals go on at the same pace; an average stays what it is
			forecast: metric === 'learning_dau' || !elapsed ? actual[metric] : Math.round((actual[metric] / elapsed) * monthDays),
		}));

		// ── Lessons in the period, the three modes ──
		const lessons = (await database.raw(`
			WITH r AS (
				SELECT (?::date::timestamp AT TIME ZONE '${TZ}') AS t0, ((?::date + 1)::timestamp AT TIME ZONE '${TZ}') AS t1
			),
			/* one row per answer; score: 0-1 on a first try, null on a later one */
			ans AS (
				SELECT lesson_id, user_id, date_created AS at,
					CASE WHEN attempt_number = 1 THEN CASE WHEN is_correct THEN 1.0 ELSE 0.0 END END AS score
				FROM listening_attempts WHERE lesson_id IS NOT NULL AND answer IS DISTINCT FROM '[HEARD]'
				UNION ALL
				SELECT a.lesson_id, a.user_id, x.date_created,
					CASE WHEN x.round = 1 THEN x.words_right::numeric / nullif(x.words_total, 0) END
				FROM il_results x JOIN il_attempts a ON a.id = x.attempt_id
				UNION ALL
				SELECT e.lesson_id, e.user_id, coalesce(e.finished_at, e.date_created), CASE WHEN (q.value->>'right')::boolean THEN 1.0 ELSE 0.0 END
				FROM el_attempts e, jsonb_each(e.answers) q
			),
			a AS (
				SELECT lesson_id, count(*)::int AS attempts, count(DISTINCT user_id)::int AS learners,
					avg(score) AS accuracy, count(score)::int AS first_tries
				FROM ans, r WHERE at >= r.t0 AND at < r.t1 AND ${real('user_id')}
				GROUP BY 1
			),
			s AS (
				SELECT lesson_id, count(*)::int AS starts
				FROM (${STARTS}) x, r WHERE at >= r.t0 AND at < r.t1 AND ${real('user_id')} GROUP BY 1
			),
			c AS (
				SELECT lesson_id, count(*)::int AS completions
				FROM (${FINISHES}) x, r WHERE at >= r.t0 AND at < r.t1 AND ${real('user_id')} GROUP BY 1
			),
			l AS (
				SELECT l.id, l.short_id, l.text, l.status, 'cs' AS mode, sk.name AS skill
				FROM listening_lessons l LEFT JOIN listening_skills sk ON sk.id = l.skill_id
				UNION ALL
				SELECT id, short_id, title, status, 'il', NULL FROM il_lessons
				UNION ALL
				SELECT id, short_id, title, status, 'el', NULL FROM el_lessons
			)
			SELECT l.id, l.short_id, l.text, l.status, l.mode, l.skill,
				coalesce(s.starts, 0) AS starts, coalesce(a.learners, 0) AS learners, coalesce(a.attempts, 0) AS attempts,
				coalesce(c.completions, 0) AS completions, coalesce(a.first_tries, 0) AS first_tries, a.accuracy
			FROM l
			LEFT JOIN a ON a.lesson_id = l.id
			LEFT JOIN s ON s.lesson_id = l.id
			LEFT JOIN c ON c.lesson_id = l.id
			WHERE a.lesson_id IS NOT NULL OR s.lesson_id IS NOT NULL OR c.lesson_id IS NOT NULL
		`, [from, today])).rows.map((r: any) => ({ ...r, accuracy: r.accuracy == null ? null : Number(r.accuracy) }));
		const popular = [...lessons]
			.sort((x: any, y: any) => y.starts - x.starts || y.attempts - x.attempts || y.completions - x.completions);
		// Enough first tries for the rate to mean something
		const hardest = lessons
			.filter((l: any) => l.first_tries >= 5 && l.accuracy != null)
			.sort((x: any, y: any) => x.accuracy - y.accuracy);

		const [journey, landing, retention, eventsSince, northStar, releases] = await Promise.all([
			visitorJourney(from, today), landingFunnel(from, today), comingBack(today),
			database('learning_events').where('human', true).min('day as d').first().then((r: any) => (r?.d ? vnDay(new Date(r.d)) : null)),
			weeklyLearners(today),
			// Every change since the start of the 12 weeks of the North Star chart
			database.raw(`
				SELECT r.id, to_char(r.day, 'YYYY-MM-DD') AS day, r.title, u.email
				FROM admin_releases r LEFT JOIN directus_users u ON u.id = r.user_created
				WHERE r.day >= least(?::date, date_trunc('week', ?::date)::date - 77)
				ORDER BY r.day DESC, r.id DESC
			`, [prevFrom, today]).then((r: any) => r.rows),
		]);

		return res.json({
			success: true,
			data: {
				timezone: TZ,
				today,
				days,
				period: { from, to: today },
				previous_period: { from: prevFrom, to: prevTo },
				daily: all.slice(days),
				previous_daily: all.slice(0, days),
				sales: now,
				previous_sales: before,
				month: { month, days: monthDays, elapsed, goals },
				popular_lessons: popular,
				hardest_lessons: hardest,
				events_since: eventsSince,
				journey,
				landing,
				retention,
				north_star: northStar,
				releases,
			},
		});
	}));

	router.post('/admin/releases', admin(async (req, res) => {
		const day = String(req.body?.day || '');
		const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 200) : '';
		if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) throw bad('day must be YYYY-MM-DD');
		if (!title) throw bad('title is required');
		const [row] = await database('admin_releases').insert({ day, title, user_created: req.accountability.user }).returning(['id']);
		return res.json({ success: true, data: { id: row?.id ?? row } });
	}));

	router.delete('/admin/releases/:id', admin(async (req, res) => {
		const id = Number(req.params.id);
		if (!Number.isInteger(id) || id <= 0) throw bad('Invalid id');
		const n = await database('admin_releases').where({ id }).delete();
		return n ? res.json({ success: true }) : res.status(404).json({ success: false, message: 'Not found' });
	}));

	router.put('/admin/goals', admin(async (req, res) => {
		const month = String(req.body?.month || '');
		if (!MONTH_RE.test(month)) throw bad('month must be YYYY-MM');
		const targets = req.body?.targets;
		if (!targets || typeof targets !== 'object') throw bad('targets is required');
		for (const [metric, value] of Object.entries(targets)) {
			if (!(GOAL_METRICS as readonly string[]).includes(metric)) throw bad(`Unknown metric: ${metric}`);
			if (value !== null && !(typeof value === 'number' && Number.isFinite(value) && value >= 0)) throw bad(`${metric}: a number ≥ 0, or null`);
		}
		await database.transaction(async (trx: any) => {
			for (const [metric, value] of Object.entries(targets)) {
				if (value === null) {
					await trx('admin_monthly_goals').where({ month, metric }).delete();
				} else {
					await trx('admin_monthly_goals')
						.insert({ month, metric, target: value, date_updated: new Date() })
						.onConflict(['month', 'metric']).merge(['target', 'date_updated']);
				}
			}
		});
		return res.json({ success: true });
	}));

	/**
	 * GET /admin/my-progress  (admins and content editors) ?month=YYYY-MM
	 * The signed-in account's lessons this month next to the team's lesson goal. Admins also
	 * get every author's numbers (lessons with no author were made before authors were kept).
	 */
	router.get('/admin/my-progress', async (req: any, res: any) => {
		const role = staffRole(req.accountability);
		if (!role) return res.status(403).json({ success: false, message: 'Admins and editors only' });
		try {
			const today = vnDay(new Date());
			const month = MONTH_RE.test(String(req.query.month || '')) ? String(req.query.month) : today.slice(0, 7);
			const monthDays = daysInMonth(month);
			const monthFrom = `${month}-01`;
			const monthTo = `${month}-${String(monthDays).padStart(2, '0')}`;
			const elapsed = today < monthFrom ? 0 : today > monthTo ? monthDays : Number(today.slice(8, 10));
			const inMonth = `l.published_at >= (?::date::timestamp AT TIME ZONE '${TZ}') AND l.published_at < ((?::date + 1)::timestamp AT TIME ZONE '${TZ}')`;

			const authors = (await database.raw(`
				SELECT l.user_created AS user_id,
					nullif(trim(concat_ws(' ', u.first_name, u.last_name)), '') AS name, u.email,
					count(*) FILTER (WHERE l.status = 'published' AND ${inMonth})::int AS published_month,
					count(*) FILTER (WHERE l.status = 'published')::int AS published_total,
					count(*) FILTER (WHERE l.status <> 'published')::int AS drafts
				FROM listening_lessons l
				LEFT JOIN directus_users u ON u.id = l.user_created
				WHERE coalesce(l.kind, 'pattern') <> 'bank'
				GROUP BY 1, 2, 3
				ORDER BY published_month DESC, published_total DESC
			`, [monthFrom, monthTo])).rows;
			const mine = authors.find((a: any) => a.user_id === req.accountability.user) || { published_month: 0, published_total: 0, drafts: 0 };
			const team = authors.reduce((n: number, a: any) => n + a.published_month, 0);
			const goal = await database('admin_monthly_goals').where({ month, metric: 'lessons_published' }).first('target');

			return res.json({
				success: true,
				data: {
					role,
					month,
					days: monthDays,
					elapsed,
					mine: { published_month: mine.published_month, published_total: mine.published_total, drafts: mine.drafts },
					team: { published_month: team, goal: goal ? Number(goal.target) : null },
					// Who made what: admins only (editors do not see each other's emails)
					authors: role === 'admin' ? authors : undefined,
				},
			});
		} catch (error: any) {
			logger?.error?.(`[admin-dashboard] GET /admin/my-progress failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	});
}
