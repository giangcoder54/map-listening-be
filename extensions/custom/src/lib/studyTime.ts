/**
 * Study time (database/migrations/2026-11-27_study_time.sql): seconds a learner worked, per Vietnam day.
 *
 * touchStudy() is called on every practice event (recordPractice, the Intensive check / slow / gist). It adds the
 * time since the learner's previous event, up to GAP_CAP seconds; a longer gap is a break and adds NEW_SITTING
 * (the first clip of a sitting is heard before the first answer). Two small writes, no scan: reading the total is a
 * sum over a few hundred day rows. It never throws: a failure here must not lose an answer.
 * addStudySeconds() adds time measured elsewhere (Extensive Listening's listened time).
 */
import { vnDay } from './days';

/** A gap longer than this between two events is a break (Anki caps a card at 60 s; listening takes a little longer) */
export const GAP_CAP = 120;
/** Seconds counted for the first event after a break */
export const NEW_SITTING = 20;

export async function touchStudy(database: any, userId: string, today = vnDay()) {
	try {
		await database.transaction(async (trx: any) => {
			const row = (await trx.raw(
				`SELECT extract(epoch FROM now() - last_at)::float AS gap FROM user_study_clock WHERE user_id = ? FOR UPDATE`, [userId],
			)).rows[0];
			await trx.raw(
				`INSERT INTO user_study_clock (user_id, last_at) VALUES (?, now()) ON CONFLICT (user_id) DO UPDATE SET last_at = now()`, [userId],
			);
			const gap = row ? Number(row.gap) : null;
			const add = gap === null || gap > GAP_CAP ? NEW_SITTING : Math.max(0, Math.round(gap));
			if (add > 0) await addSeconds(trx, userId, add, today);
		});
	} catch {
		/* the time is a statistic; the practice itself is already saved */
	}
}

/** Seconds measured by the feature itself (Extensive: the time the audio was listened to) */
export async function addStudySeconds(database: any, userId: string, seconds: number, today = vnDay()) {
	if (!(seconds > 0)) return;
	try {
		await addSeconds(database, userId, Math.round(seconds), today);
	} catch {
		/* see touchStudy */
	}
}

const addSeconds = (db: any, userId: string, seconds: number, day: string) => db.raw(
	`INSERT INTO user_study_time (user_id, day, seconds) VALUES (?, ?, ?)
	 ON CONFLICT (user_id, day) DO UPDATE SET seconds = user_study_time.seconds + EXCLUDED.seconds`, [userId, day, seconds],
);
