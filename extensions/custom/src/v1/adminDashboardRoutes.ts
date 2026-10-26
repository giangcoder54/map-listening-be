/**
 * Admin home numbers (Directus admins only). Days are Vietnam days (Asia/Ho_Chi_Minh).
 *
 *   GET /admin/dashboard   ?days=7|30|90 (default 30) &month=YYYY-MM (default this month)
 *                          -> daily series for the period and the one before it, sales of
 *                             both, the month's goals with progress, sign-up funnel,
 *                             every lesson used in the period, most used / hardest first
 *                             (the page paginates them)
 *   PUT /admin/goals       { month, targets: { <metric>: number | null } }  null = no goal
 *   POST   /admin/releases      { day: YYYY-MM-DD, title }  a change shipped, marked on the charts
 *   DELETE /admin/releases/:id
 *   GET /admin/my-progress ?month=  the caller's lessons vs the team goal; admins and
 *                          content editors (admins also get every author's numbers)
 *
 * Definitions:
 *   active learner  an account with at least one answer (listening_attempts) that day
 *   WAU / MAU       active learners in the 7 / 30 days up to that day
 *   lesson start    first time a learner (account or anonymous) opens a lesson
 *   accuracy        share of first tries (attempt_number = 1) that were right
 *
 * North Star: weekly learners = accounts that reached the result card of at least one lesson
 * that week (listening_progress completed, updated that week, or a `result` event).
 *
 * Team and test accounts (directus_users.is_internal, 2026-10-21_analytics.sql) are left out
 * of every number.
 *
 * Visitor journey, steps and coming back (2026-10-21_analytics.sql): `journey`, `landing` and
 * the event columns of `steps` come from learning_events (guests included). Only rows from real
 * people count (`human`, 2026-10-26_analytics_humans.sql: bots dropped, nothing sent before a
 * scroll, tap or key), so they start on the day that was deployed: `events_since`. The answer
 * columns of `steps` and `retention` also use listening_attempts, so they have the past too.
 *
 * Practice settings (2026-10-26_practice_modes.sql): `practice` = per step, who reached it and
 * who pressed "Skip this step"; per setting, the accounts that played that way (their answers),
 * the people who picked it in the period (events) and the accounts that have it saved now.
 *
 * Sign-up dates: accounts made before 2026-10-09 got a date estimated from their first
 * activity (database/migrations/2026-10-15_admin_dashboard.sql). `estimated_signups` counts
 * the ones with no trace at all, which still carry the deploy time.
 */
import { staffRole } from '../lib/staff';

const TZ = 'Asia/Ho_Chi_Minh';
const PERIODS = [7, 30, 90];
export const GOAL_METRICS = ['lessons_published', 'new_users', 'paid_orders', 'revenue_vnd', 'learning_dau'] as const;
type GoalMetric = (typeof GOAL_METRICS)[number];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** SQL: the row's user (column `col`, may be NULL for a guest) is not a team or test account */
const real = (col: string) => `NOT EXISTS (SELECT 1 FROM directus_users iu WHERE iu.id = ${col} AND iu.is_internal)`;

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
		)
		SELECT to_char(day, 'YYYY-MM-DD') AS day,
			(SELECT count(*) FROM directus_users WHERE status = 'active' AND NOT is_internal AND gl_created_at >= t0 AND gl_created_at < t1)::int AS new_users,
			(SELECT count(*) FROM directus_users WHERE status = 'active' AND NOT is_internal AND gl_created_at < t1)::int AS total_users,
			(SELECT count(DISTINCT user_id) FROM listening_attempts WHERE date_created >= t0 AND date_created < t1 AND ${real('user_id')})::int AS dau,
			(SELECT count(DISTINCT user_id) FROM listening_attempts WHERE date_created >= t1 - interval '7 days' AND date_created < t1 AND ${real('user_id')})::int AS wau,
			(SELECT count(DISTINCT user_id) FROM listening_attempts WHERE date_created >= t1 - interval '30 days' AND date_created < t1 AND ${real('user_id')})::int AS mau,
			(SELECT count(*) FROM listening_attempts WHERE date_created >= t0 AND date_created < t1 AND ${real('user_id')})::int AS attempts,
			(SELECT count(*) FROM listening_lesson_learners WHERE date_created >= t0 AND date_created < t1 AND ${real('user_id')})::int AS lesson_starts,
			(SELECT count(*) FROM listening_progress WHERE status = 'completed' AND completed_at >= t0 AND completed_at < t1 AND ${real('user_id')})::int AS completions,
			(SELECT count(*) FROM listening_lessons WHERE status = 'published' AND published_at >= t0 AND published_at < t1)::int AS lessons_published
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
		per AS (
			SELECT person,
				bool_or(event = 'lesson_open') AS opened,
				bool_or(event = 'lesson_start') AS started,
				bool_or(event = 'result') AS finished,
				bool_or(uid IS NOT NULL) AS account,
				count(DISTINCT day) AS days
			FROM p GROUP BY person
		)
		SELECT count(*)::int AS visitors,
			count(*) FILTER (WHERE opened)::int AS opened,
			count(*) FILTER (WHERE started)::int AS started,
			count(*) FILTER (WHERE finished)::int AS finished,
			count(*) FILTER (WHERE finished AND account)::int AS finished_with_account,
			count(*) FILTER (WHERE account)::int AS with_account,
			count(*) FILTER (WHERE days >= 2)::int AS came_back
		FROM per
	`, [from, to])).rows[0];

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
	 * Where a lesson is left, step by step, among lessons that have that step:
	 *   started / reached    people who pressed Start / got to the step (events: guests too, since deploy)
	 *   sessions / answered  accounts that answered in the lesson / answered in the step
	 */
	const lessonSteps = async (from: string, to: string) => {
		const ev = (await database.raw(`
			WITH ${PEOPLE_CTE},
			started AS (SELECT DISTINCT person, lesson_id FROM p WHERE event = 'lesson_start'),
			ls AS (SELECT DISTINCT lesson_id, step FROM listening_clips WHERE status = 'published' AND step IS NOT NULL)
			SELECT ls.step, count(*)::int AS eligible,
				count(*) FILTER (WHERE EXISTS (
					SELECT 1 FROM p WHERE p.person = s.person AND p.lesson_id = s.lesson_id AND p.event = 'step' AND p.step = ls.step
				))::int AS reached
			FROM started s JOIN ls ON ls.lesson_id = s.lesson_id
			GROUP BY ls.step
			UNION ALL
			SELECT 'result', count(*)::int,
				count(*) FILTER (WHERE EXISTS (
					SELECT 1 FROM p WHERE p.person = s.person AND p.lesson_id = s.lesson_id AND p.event = 'result'
				))::int
			FROM started s
		`, [from, to])).rows;
		const ans = (await database.raw(`
			WITH r AS (
				SELECT (?::date::timestamp AT TIME ZONE '${TZ}') AS t0, ((?::date + 1)::timestamp AT TIME ZONE '${TZ}') AS t1
			),
			a AS (
				SELECT DISTINCT user_id, lesson_id, step FROM listening_attempts, r
				WHERE lesson_id IS NOT NULL AND date_created >= r.t0 AND date_created < r.t1 AND ${real('user_id')}
			),
			sessions AS (SELECT DISTINCT user_id, lesson_id FROM a),
			ls AS (SELECT DISTINCT lesson_id, step FROM listening_clips WHERE status = 'published' AND step IS NOT NULL)
			SELECT ls.step, count(*)::int AS eligible,
				count(*) FILTER (WHERE EXISTS (SELECT 1 FROM a WHERE a.user_id = s.user_id AND a.lesson_id = s.lesson_id AND a.step = ls.step))::int AS answered
			FROM sessions s JOIN ls ON ls.lesson_id = s.lesson_id
			GROUP BY ls.step
			UNION ALL
			SELECT 'result', count(*)::int,
				count(*) FILTER (WHERE EXISTS (
					SELECT 1 FROM listening_progress pr WHERE pr.user_id = s.user_id AND pr.lesson_id = s.lesson_id AND pr.status = 'completed'
				))::int
			FROM sessions s
		`, [from, to])).rows;
		return ['type', 'voice', 'challenge', 'more', 'result'].map((step) => {
			const e = ev.find((r: any) => r.step === step);
			const a = ans.find((r: any) => r.step === step);
			return { step, started: e?.eligible || 0, reached: e?.reached || 0, sessions: a?.eligible || 0, answered: a?.answered || 0 };
		});
	};

	/** Steps 2-4: reached / skipped (people), the settings picked in the period, the ones saved now */
	const practice = async (from: string, to: string) => {
		const ev = (await database.raw(`
			WITH ${PEOPLE_CTE}
			SELECT event, step, count(DISTINCT person)::int AS people FROM p
			WHERE (event = 'step' AND step IN ('voice', 'challenge', 'more')) OR event IN ('skip', 'setting')
			GROUP BY event, step
		`, [from, to])).rows;
		const saved = (await database.raw(`
			SELECT 'voice_' || coalesce(practice_prefs->>'voice', 'type') AS k, count(*)::int AS n FROM directus_users
			WHERE practice_prefs IS NOT NULL AND status = 'active' AND NOT is_internal GROUP BY 1
			UNION ALL
			SELECT 'challenge_' || coalesce(practice_prefs->>'challenge', 'medium'), count(*)::int FROM directus_users
			WHERE practice_prefs IS NOT NULL AND status = 'active' AND NOT is_internal GROUP BY 1
		`)).rows;
		// What accounts actually played (listening_attempts.mode), defaults included: each account
		// once per step, by the last mode it used in the period. Step 3 from whole-sentence clips
		// only (a "faster" clip is the same at medium and hard). Counted from the first attempt
		// made with these settings, so the weeks before them (all "type it" / "hard") stay out.
		const used = (await database.raw(`
			WITH r AS (
				SELECT greatest(
					(?::date::timestamp AT TIME ZONE '${TZ}'),
					(SELECT min(date_created) FROM listening_attempts WHERE mode IN ('listen', 'sentence_medium', 'sentence_easy', 'speed_easy'))
				) AS t0, ((?::date + 1)::timestamp AT TIME ZONE '${TZ}') AS t1
			),
			last AS (
				SELECT DISTINCT ON (user_id, step) user_id, step, mode FROM listening_attempts, r
				WHERE step IN ('voice', 'challenge') AND date_created >= r.t0 AND date_created < r.t1 AND ${real('user_id')}
					AND (step = 'voice' OR mode IN ('sentence', 'sentence_medium', 'sentence_easy'))
				ORDER BY user_id, step, date_created DESC
			)
			SELECT CASE
					WHEN step = 'voice' THEN CASE WHEN mode = 'listen' THEN 'voice_listen' ELSE 'voice_type' END
					WHEN mode = 'sentence_easy' THEN 'challenge_easy'
					WHEN mode = 'sentence_medium' THEN 'challenge_medium'
					ELSE 'challenge_hard'
				END AS k, count(*)::int AS n
			FROM last GROUP BY 1
		`, [from, to])).rows;
		const n = (event: string, step: string) => ev.find((r: any) => r.event === event && r.step === step)?.people || 0;
		const settings = ['voice_type', 'voice_listen', 'challenge_easy', 'challenge_medium', 'challenge_hard'];
		return {
			steps: ['voice', 'challenge', 'more'].map((step) => ({ step, reached: n('step', step), skipped: n('skip', step) })),
			settings: settings.map((key) => ({
				key,
				used: used.find((r: any) => r.k === key)?.n || 0,
				picked: n('setting', key),
				saved: saved.find((r: any) => r.k === key)?.n || 0,
			})),
		};
	};

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
			SELECT DISTINCT user_id, (date_created AT TIME ZONE '${TZ}')::date AS d FROM listening_attempts WHERE user_id IN (SELECT id FROM u)
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

		// ── Funnel: accounts that signed up in the period ──
		const funnel = (await database.raw(`
			WITH u AS (
				SELECT id FROM directus_users
				WHERE status = 'active' AND NOT is_internal AND gl_created_at >= (?::date::timestamp AT TIME ZONE '${TZ}')
			)
			SELECT
				(SELECT count(*) FROM u)::int AS signups,
				(SELECT count(*) FROM u WHERE EXISTS (SELECT 1 FROM listening_attempts a WHERE a.user_id = u.id))::int AS answered,
				(SELECT count(*) FROM u WHERE EXISTS (SELECT 1 FROM listening_progress p WHERE p.user_id = u.id AND p.status = 'completed'))::int AS completed,
				(SELECT count(*) FROM u WHERE EXISTS (SELECT 1 FROM purchase_histories p WHERE p."user" = u.id AND p.status = 'published' AND p.amount > 0))::int AS paid
		`, [from])).rows[0];

		// ── Lessons in the period ──
		const lessons = (await database.raw(`
			WITH r AS (
				SELECT (?::date::timestamp AT TIME ZONE '${TZ}') AS t0, ((?::date + 1)::timestamp AT TIME ZONE '${TZ}') AS t1
			),
			a AS (
				SELECT lesson_id, count(*)::int AS attempts, count(DISTINCT user_id)::int AS learners,
					avg(CASE WHEN is_correct THEN 1 ELSE 0 END) FILTER (WHERE attempt_number = 1) AS accuracy,
					count(*) FILTER (WHERE attempt_number = 1)::int AS first_tries
				FROM listening_attempts, r WHERE lesson_id IS NOT NULL AND date_created >= r.t0 AND date_created < r.t1 AND ${real('user_id')}
					AND answer IS DISTINCT FROM '[HEARD]'
				GROUP BY 1
			),
			s AS (
				SELECT lesson_id, count(*)::int AS starts
				FROM listening_lesson_learners, r WHERE date_created >= r.t0 AND date_created < r.t1 AND ${real('user_id')} GROUP BY 1
			),
			c AS (
				SELECT lesson_id, count(*)::int AS completions
				FROM listening_progress, r WHERE status = 'completed' AND completed_at >= r.t0 AND completed_at < r.t1 AND ${real('user_id')} GROUP BY 1
			)
			SELECT l.id, l.short_id, l.text, l.status, sk.name AS skill,
				coalesce(s.starts, 0) AS starts, coalesce(a.learners, 0) AS learners, coalesce(a.attempts, 0) AS attempts,
				coalesce(c.completions, 0) AS completions, coalesce(a.first_tries, 0) AS first_tries, a.accuracy
			FROM listening_lessons l
			LEFT JOIN listening_skills sk ON sk.id = l.skill_id
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

		const estimated = (await database.raw(`
			SELECT coalesce(sum(n), 0)::int AS n FROM (
				SELECT count(*) AS n FROM directus_users GROUP BY gl_created_at HAVING count(*) >= 3
			) x
		`)).rows[0].n;
		const premium = (await database.raw(`
			SELECT count(*)::int AS n FROM directus_users
			WHERE status = 'active' AND NOT is_internal AND is_premium AND (premium_until IS NULL OR premium_until > now())
		`)).rows[0].n;

		const [journey, landing, steps, retention, eventsSince, northStar, releases, practiceStats] = await Promise.all([
			visitorJourney(from, today), landingFunnel(from, today), lessonSteps(from, today), comingBack(today),
			database('learning_events').where('human', true).min('day as d').first().then((r: any) => (r?.d ? vnDay(new Date(r.d)) : null)),
			weeklyLearners(today),
			// Every change since the start of the 12 weeks of the North Star chart
			database.raw(`
				SELECT r.id, to_char(r.day, 'YYYY-MM-DD') AS day, r.title, u.email
				FROM admin_releases r LEFT JOIN directus_users u ON u.id = r.user_created
				WHERE r.day >= least(?::date, date_trunc('week', ?::date)::date - 77)
				ORDER BY r.day DESC, r.id DESC
			`, [prevFrom, today]).then((r: any) => r.rows),
			practice(from, today),
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
				premium_users: premium,
				month: { month, days: monthDays, elapsed, goals },
				funnel,
				popular_lessons: popular,
				hardest_lessons: hardest,
				estimated_signups: estimated,
				events_since: eventsSince,
				journey,
				landing,
				steps,
				practice: practiceStats,
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
