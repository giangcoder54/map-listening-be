/**
 * Kim cương ledger upkeep, run each night by hook/index.ts (web repo docs/xu-v2-backend.md mục 3, 9).
 *
 *   rollupCoinDaily  totals per Vietnam day and reason into coin_daily (the admin stats read it);
 *                    team and test accounts (directus_users.is_internal) are left out
 *   checkLedger      sum(coin_events.amount) must equal user_xp.coins - coins_debt for every learner;
 *                    a mismatch is written to coin_mismatches and told to the admin, never fixed here:
 *                    the admin posts a correcting row (reason 'admin')
 */
import { TZ, vnDay } from './days';

/** Vietnam hour, 0-23 */
export const vnHour = (date = new Date()) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(date));

/** 'YYYY-MM-DD' n days before a 'YYYY-MM-DD' day */
export const dayBefore = (day: string, n = 1) => {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - n);
	return d.toISOString().slice(0, 10);
};

/**
 * Re-count coin_daily from `fromDay` on (all days when the table is still empty). Safe to run
 * again: each (day, reason) row is replaced by a fresh count.
 */
export async function rollupCoinDaily(db: any, fromDay?: string) {
	let from = fromDay;
	if (!from) {
		const any = await db('coin_daily').first('day');
		from = any ? dayBefore(vnDay(), 2) : '1970-01-01';
	}
	const res = await db.raw(
		`INSERT INTO coin_daily (day, reason, earned, spent, events, users)
		 SELECT e.day, e.reason,
		        COALESCE(SUM(GREATEST(e.amount, 0)), 0),
		        COALESCE(SUM(GREATEST(-e.amount, 0)), 0),
		        COUNT(*), COUNT(DISTINCT e.user_id)
		 FROM coin_events e
		 JOIN directus_users u ON u.id = e.user_id AND u.is_internal IS NOT TRUE
		 WHERE e.day >= ?
		 GROUP BY e.day, e.reason
		 ON CONFLICT (day, reason) DO UPDATE SET
		   earned = EXCLUDED.earned, spent = EXCLUDED.spent, events = EXCLUDED.events, users = EXCLUDED.users`,
		[from],
	);
	return { from, rows: Number(res?.rowCount) || 0 };
}

export type LedgerMismatch = { user_id: string; ledger: number; purse: number; debt: number };

/** Learners whose purse does not match their ledger (read only) */
export async function findMismatches(db: any): Promise<LedgerMismatch[]> {
	const res = await db.raw(
		`SELECT u.user_id, COALESCE(l.total, 0)::bigint AS ledger, u.coins::bigint AS purse, u.coins_debt::bigint AS debt
		 FROM user_xp u
		 LEFT JOIN (SELECT user_id, SUM(amount) AS total FROM coin_events GROUP BY user_id) l ON l.user_id = u.user_id
		 WHERE COALESCE(l.total, 0) <> u.coins - u.coins_debt`,
	);
	return (res?.rows || []).map((r: any) => ({ user_id: r.user_id, ledger: Number(r.ledger), purse: Number(r.purse), debt: Number(r.debt) }));
}

/** Write today's mismatches; returns the ones not written before today (to tell the admin about) */
export async function checkLedger(db: any, today = vnDay()) {
	const found = await findMismatches(db);
	if (!found.length) return { found: 0, fresh: [] as LedgerMismatch[] };
	const fresh: LedgerMismatch[] = [];
	for (const m of found) {
		const seen = await db('coin_mismatches').where('user_id', m.user_id).whereNull('resolved_at').where('checked_on', '<', today).first('id');
		const row = await db('coin_mismatches')
			.insert({ checked_on: today, user_id: m.user_id, ledger: m.ledger, purse: m.purse, debt: m.debt })
			.onConflict(['checked_on', 'user_id']).ignore()
			.returning('id');
		if (row.length && !seen) fresh.push(m);
	}
	return { found: found.length, fresh };
}

/** The nightly job: once a day at 03:00 Vietnam time (the hook calls it every hour) */
export async function nightlyCoinJob(db: any, notify: (msg: string) => void, logger?: any, now = new Date()) {
	if (vnHour(now) !== 3) return null;
	try {
		const rollup = await rollupCoinDaily(db);
		const ledger = await checkLedger(db, vnDay(now));
		if (ledger.fresh.length) {
			const list = ledger.fresh.slice(0, 10).map((m) => `${m.user_id}: sổ ${m.ledger}, ví ${m.purse}, nợ ${m.debt}`).join('\n');
			notify(`⚠️ Kim cương: ${ledger.fresh.length} người có ví lệch sổ cái\n${list}`);
		}
		logger?.info?.(`[gems] nightly: coin_daily from ${rollup.from} (${rollup.rows} rows), ledger mismatches ${ledger.found}`);
		return { rollup, ledger };
	} catch (error) {
		logger?.error?.(`[gems] nightly job failed: ${String(error)}`);
		return null;
	}
}
