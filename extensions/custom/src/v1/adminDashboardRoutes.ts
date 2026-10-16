/**
 * Admin home numbers (Directus admins only). Days are Vietnam days (Asia/Ho_Chi_Minh).
 *
 *   GET /admin/dashboard   ?days=7|30|90 (default 30) &month=YYYY-MM (default this month)
 *                          -> daily series for the period and the one before it, sales of
 *                             both, the month's goals with progress, sign-up funnel,
 *                             every lesson used in the period, most used / hardest first
 *                             (the page paginates them)
 *   PUT /admin/goals       { month, targets: { <metric>: number | null } }  null = no goal
 *   GET /admin/my-progress ?month=  the caller's lessons vs the team goal; admins and
 *                          content editors (admins also get every author's numbers)
 *
 * Definitions:
 *   active learner  an account with at least one answer (listening_attempts) that day
 *   WAU / MAU       active learners in the 7 / 30 days up to that day
 *   lesson start    first time a learner (account or anonymous) opens a lesson
 *   accuracy        share of first tries (attempt_number = 1) that were right
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
			(SELECT count(*) FROM directus_users WHERE status = 'active' AND gl_created_at >= t0 AND gl_created_at < t1)::int AS new_users,
			(SELECT count(*) FROM directus_users WHERE status = 'active' AND gl_created_at < t1)::int AS total_users,
			(SELECT count(DISTINCT user_id) FROM listening_attempts WHERE date_created >= t0 AND date_created < t1)::int AS dau,
			(SELECT count(DISTINCT user_id) FROM listening_attempts WHERE date_created >= t1 - interval '7 days' AND date_created < t1)::int AS wau,
			(SELECT count(DISTINCT user_id) FROM listening_attempts WHERE date_created >= t1 - interval '30 days' AND date_created < t1)::int AS mau,
			(SELECT count(*) FROM listening_attempts WHERE date_created >= t0 AND date_created < t1)::int AS attempts,
			(SELECT count(*) FROM listening_lesson_learners WHERE date_created >= t0 AND date_created < t1)::int AS lesson_starts,
			(SELECT count(*) FROM listening_progress WHERE status = 'completed' AND completed_at >= t0 AND completed_at < t1)::int AS completions,
			(SELECT count(*) FROM listening_lessons WHERE status = 'published' AND published_at >= t0 AND published_at < t1)::int AS lessons_published
		FROM days ORDER BY day
	`, [from, to])).rows;

	/** Paid orders and revenue per currency between two Vietnam days (inclusive) */
	const sales = async (from: string, to: string) => {
		const rows = (await database.raw(`
			SELECT lower(currency) AS currency, count(*)::int AS orders, sum(amount)::bigint AS amount
			FROM purchase_histories
			WHERE status = 'published' AND amount > 0
				AND coalesce(date_transfer, date_created) >= (?::date::timestamp AT TIME ZONE '${TZ}')
				AND coalesce(date_transfer, date_created) < ((?::date + 1)::timestamp AT TIME ZONE '${TZ}')
			GROUP BY 1
		`, [from, to])).rows;
		return {
			orders: rows.reduce((n: number, r: any) => n + r.orders, 0),
			revenue: rows.map((r: any) => ({ currency: r.currency, amount: Number(r.amount) })),
		};
	};

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
				WHERE status = 'active' AND gl_created_at >= (?::date::timestamp AT TIME ZONE '${TZ}')
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
				FROM listening_attempts, r WHERE lesson_id IS NOT NULL AND date_created >= r.t0 AND date_created < r.t1
				GROUP BY 1
			),
			s AS (
				SELECT lesson_id, count(*)::int AS starts
				FROM listening_lesson_learners, r WHERE date_created >= r.t0 AND date_created < r.t1 GROUP BY 1
			),
			c AS (
				SELECT lesson_id, count(*)::int AS completions
				FROM listening_progress, r WHERE status = 'completed' AND completed_at >= r.t0 AND completed_at < r.t1 GROUP BY 1
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
			WHERE status = 'active' AND is_premium AND (premium_until IS NULL OR premium_until > now())
		`)).rows[0].n;

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
			},
		});
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
