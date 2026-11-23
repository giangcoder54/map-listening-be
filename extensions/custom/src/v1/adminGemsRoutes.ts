/**
 * Admin: is the Kim cương economy healthy (Directus admins only). Web repo docs/xu-v2-tasks.md T0.4.
 *
 *   GET  /admin/gems/stats?weeks=8   per Vietnam week (Monday first): earned, spent, earned / spent,
 *                                    and the same by reason; the purse now; ledger mismatches;
 *                                    the numbers and feature switches in force
 *   POST /admin/gems/rollup          re-count coin_daily now (the nightly job does it at 03:00)
 *   POST /admin/gems/mismatches/:id/resolve   mark a mismatch as dealt with (after posting the correcting row)
 *
 * Past days come from coin_daily (lib/coinLedger.ts); today is counted live from coin_events.
 * Team and test accounts (directus_users.is_internal) are left out, as in the admin dashboard.
 */
import { COIN } from '../lib/coins';
import { gemsFlags } from '../lib/growthConfig';
import { rollupCoinDaily, dayBefore } from '../lib/coinLedger';
import { vnDay } from '../lib/days';

/** Monday of the week of a 'YYYY-MM-DD' day */
export const weekOf = (day: string) => {
	const d = new Date(`${day}T00:00:00Z`);
	const back = (d.getUTCDay() + 6) % 7;
	d.setUTCDate(d.getUTCDate() - back);
	return d.toISOString().slice(0, 10);
};

type Row = { day: string; reason: string; earned: number; spent: number; events: number };

/** Weeks, newest first; each with its totals and its reasons (biggest first) */
export function weeksOf(rows: Row[], firstWeek: string) {
	const byWeek = new Map<string, { earned: number; spent: number; events: number; reasons: Map<string, { earned: number; spent: number; events: number }> }>();
	for (let w = firstWeek; w <= weekOf(vnDay()); w = dayBefore(w, -7)) byWeek.set(w, { earned: 0, spent: 0, events: 0, reasons: new Map() });
	for (const r of rows) {
		const w = byWeek.get(weekOf(r.day));
		if (!w) continue;
		w.earned += r.earned; w.spent += r.spent; w.events += r.events;
		const x = w.reasons.get(r.reason) || { earned: 0, spent: 0, events: 0 };
		x.earned += r.earned; x.spent += r.spent; x.events += r.events;
		w.reasons.set(r.reason, x);
	}
	return [...byWeek.entries()].reverse().map(([week, w]) => ({
		week,
		earned: w.earned,
		spent: w.spent,
		events: w.events,
		/** earned / spent: above 1 for weeks in a row = Kim cương piling up */
		ratio: w.spent ? Math.round((w.earned / w.spent) * 100) / 100 : null,
		reasons: [...w.reasons.entries()]
			.map(([reason, x]) => ({ reason, ...x }))
			.sort((a, b) => b.earned + b.spent - (a.earned + a.spent)),
	}));
}

export function registerAdminGemsRoutes(router: any, context: any) {
	const { database, logger } = context;
	const admin = (handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
		if (!req.accountability?.admin) return res.status(403).json({ success: false, message: 'Admins only' });
		try {
			return await handler(req, res);
		} catch (error: any) {
			logger?.error?.(`[admin-gems] ${req.method} ${req.path} failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};

	router.get('/admin/gems/stats', admin(async (req, res) => {
		const weeks = Math.min(52, Math.max(1, Number(req.query.weeks) || 8));
		const today = vnDay();
		const firstWeek = dayBefore(weekOf(today), 7 * (weeks - 1));

		const past = await database('coin_daily').select('day', 'reason', 'earned', 'spent', 'events').where('day', '>=', firstWeek).where('day', '<', today);
		const live = await database('coin_events as e')
			.join('directus_users as u', 'u.id', 'e.user_id')
			.whereRaw('u.is_internal IS NOT TRUE')
			.where('e.day', today)
			.groupBy('e.reason')
			.select('e.reason',
				database.raw('COALESCE(SUM(GREATEST(e.amount, 0)), 0) AS earned'),
				database.raw('COALESCE(SUM(GREATEST(-e.amount, 0)), 0) AS spent'),
				database.raw('COUNT(*) AS events'));
		const rows: Row[] = [
			...past.map((r: any) => ({ day: typeof r.day === 'string' ? r.day.slice(0, 10) : vnDay(new Date(r.day)), reason: r.reason, earned: Number(r.earned), spent: Number(r.spent), events: Number(r.events) })),
			...live.map((r: any) => ({ day: today, reason: r.reason, earned: Number(r.earned), spent: Number(r.spent), events: Number(r.events) })),
		];

		const purse = await database('user_xp as x')
			.join('directus_users as u', 'u.id', 'x.user_id')
			.whereRaw('u.is_internal IS NOT TRUE')
			.first(
				database.raw('COALESCE(SUM(x.coins), 0) AS coins'),
				database.raw('COALESCE(SUM(x.coins_debt), 0) AS debt'),
				database.raw('COUNT(*) FILTER (WHERE x.coins > 0) AS holders'),
				database.raw('COUNT(*) FILTER (WHERE x.coins_debt > 0) AS in_debt'),
				database.raw("percentile_cont(0.5) WITHIN GROUP (ORDER BY x.coins) FILTER (WHERE x.coins > 0) AS median"),
			);
		const mismatches = await database('coin_mismatches as m')
			.leftJoin('directus_users as u', 'u.id', 'm.user_id')
			.whereNull('m.resolved_at')
			.orderBy('m.checked_on', 'desc')
			.limit(200)
			.select('m.id', 'm.checked_on', 'm.user_id', 'u.email', 'm.ledger', 'm.purse', 'm.debt');
		const rolledUpTo = await database('coin_daily').max('day as day').first();

		return res.json({
			success: true,
			data: {
				today,
				weeks: weeksOf(rows, firstWeek),
				purse: {
					coins: Number(purse?.coins) || 0,
					debt: Number(purse?.debt) || 0,
					holders: Number(purse?.holders) || 0,
					in_debt: Number(purse?.in_debt) || 0,
					median: purse?.median == null ? null : Math.round(Number(purse.median)),
				},
				mismatches: mismatches.map((m: any) => ({ ...m, ledger: Number(m.ledger), purse: Number(m.purse), debt: Number(m.debt) })),
				rolled_up_to: rolledUpTo?.day ? (typeof rolledUpTo.day === 'string' ? rolledUpTo.day.slice(0, 10) : vnDay(new Date(rolledUpTo.day))) : null,
				numbers: COIN,
				flags: gemsFlags(),
			},
		});
	}));

	router.post('/admin/gems/rollup', admin(async (_req, res) => {
		const out = await rollupCoinDaily(database, '1970-01-01');
		return res.json({ success: true, data: out });
	}));

	router.post('/admin/gems/mismatches/:id/resolve', admin(async (req, res) => {
		const id = Number(req.params.id);
		if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Bad id' });
		const n = await database('coin_mismatches').where('id', id).whereNull('resolved_at').update({ resolved_at: database.fn.now() });
		return res.json({ success: true, data: { resolved: n > 0 } });
	}));
}
