/**
 * Weekly challenge (database/migrations/2026-11-13_weekly_challenge.sql, web docs/weekly-challenge-plan.md).
 *
 * One round a week, free for everyone while it is live (guests too): a lesson of kind 'challenge'
 * (kept off the path, lib/lessons.ts) whose steps (`practice`) name the clips to hear. A step may
 * name any clip, so a round can be made of bank clips (lib/bank.ts hides them from the bank while
 * the round is open). A round is live from starts_at to ends_at. The first go a learner finishes while it is live is
 * the official one (listening_challenge_results): it counts in "x% passed" and wins Xu. Later
 * goes, and goes once it is closed, are practice only.
 * Closed rounds stay playable: last week's round free, older ones cost Xu (Premium free), bought
 * for good like a lesson (listening_unlocks).
 */
import { FORMATS, type Format, type RunItem } from './runs';

export const CHALLENGE = {
	/** Xu to open an old round, when the row sets none */
	price: { archive: 40 },
	/** Xu for passing the official go, and for a perfect one on top */
	earn: { pass: 50, perfect: 20 },
};

export type ChallengeRow = {
	id: string; lesson_id: string; week: string; status: string;
	starts_at: Date | string; ends_at: Date | string; pass_score: number; max_listens: number; price_xu: number | null;
	participants: number; passed_count: number; item_stats: Record<string, number> | null;
	short_id: string; title_vi: string | null; title_en: string | null; total: number;
};
export type ChallengeState = 'scheduled' | 'live' | 'closed';

export const stateOf = (c: Pick<ChallengeRow, 'starts_at' | 'ends_at'>, now = Date.now()): ChallengeState =>
	now < new Date(c.starts_at).getTime() ? 'scheduled' : now < new Date(c.ends_at).getTime() ? 'live' : 'closed';

/** Published rounds, newest week first, with their lesson's title and clip count */
export async function loadChallenges(db: any, where: { id?: string; shortId?: string; week?: string } = {}): Promise<ChallengeRow[]> {
	const q = db('listening_challenges as c')
		.join('listening_lessons as l', 'l.id', 'c.lesson_id')
		.leftJoin('listening_lessons_translations as tv', function (this: any) { this.on('tv.listening_lessons_id', 'l.id').andOnVal('tv.languages_code', 'vi-VN'); })
		.leftJoin('listening_lessons_translations as te', function (this: any) { this.on('te.listening_lessons_id', 'l.id').andOnVal('te.languages_code', 'en-US'); })
		.select('c.*', 'l.short_id', 'tv.title as title_vi', 'te.title as title_en', 'l.practice')
		// One round a week: 'hard' rows of the first version are never read
		.where('c.status', 'published').where('l.status', 'published').where('c.tier', 'normal')
		.orderBy('c.starts_at', 'desc');
	if (where.id) q.where('c.id', where.id);
	if (where.shortId) q.where('l.short_id', where.shortId);
	if (where.week) q.where('c.week', where.week);
	const rows = await q;
	return rows.map((r: any) => ({ ...r, total: challengeItems(r.practice).length, practice: undefined }));
}

/** The round's items: the lesson's steps, in order (every format, typed ones too) */
export function challengeItems(value: unknown): RunItem[] {
	const list = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
	if (!Array.isArray(list)) return [];
	return list
		.filter((s: any) => s && typeof s.clip_id === 'string' && (FORMATS as string[]).includes(s.format))
		.map((s: any) => ({
			clip_id: s.clip_id,
			phase: 'test' as const,
			format: s.format as Format,
			...(Array.isArray(s.wrong) && s.wrong.length ? { wrong: s.wrong.map((w: unknown) => String(w ?? '').trim()).filter(Boolean) } : {}),
			result: null,
		}));
}

/**
 * Each item with the lesson its clip belongs to (a step may name any clip), in the same order;
 * a step whose clip is gone is left out
 */
export async function withLessons(db: any, items: RunItem[]): Promise<RunItem[]> {
	if (!items.length) return items;
	const rows = await db('listening_clips').select('id', 'lesson_id').whereIn('id', items.map((it) => it.clip_id)).where('status', 'published');
	const lessonOf = new Map<string, string>(rows.map((r: any) => [r.id, r.lesson_id]));
	return items.flatMap((it) => (lessonOf.get(it.clip_id) ? [{ ...it, lesson_id: lessonOf.get(it.clip_id)! }] : []));
}

/** The newest week with a closed round: its normal round is free to everyone */
export function lastClosedWeek(all: ChallengeRow[], now = Date.now()) {
	return all.find((c) => stateOf(c, now) === 'closed')?.week ?? null;
}

/** Xu to open a round for a learner without Premium (0: free) */
export function priceOf(c: ChallengeRow, lastClosed: string | null, now = Date.now()) {
	if (c.price_xu != null) return Math.max(0, c.price_xu);
	const state = stateOf(c, now);
	if (state !== 'closed' || c.week === lastClosed) return 0;
	return CHALLENGE.price.archive;
}

/** Score and pass mark of a finished run */
export function scoreOf(items: RunItem[], passScore: number) {
	const score = items.filter((it) => it.result?.correct).length;
	return { score, total: items.length, passed: items.length > 0 && score >= Math.min(passScore, items.length) };
}

/** % of official goes right, per clip */
export async function itemStatsOf(db: any, challengeId: string): Promise<Record<string, number>> {
	const { rows } = await db.raw(`
		SELECT it->>'clip_id' AS clip_id, round(100.0 * avg(CASE WHEN (it->'result'->>'correct')::boolean THEN 1 ELSE 0 END))::int AS pct
		FROM listening_challenge_results r
		JOIN listening_runs ru ON ru.id = r.run_id
		CROSS JOIN LATERAL jsonb_array_elements(ru.items) it
		WHERE r.challenge_id = ? AND it->'result' IS NOT NULL AND jsonb_typeof(it->'result') = 'object'
		GROUP BY 1
	`, [challengeId]);
	return Object.fromEntries(rows.map((r: any) => [r.clip_id, Number(r.pct)]));
}

/** Item stats of a closed round are kept on its row the first time they are asked for */
export async function cachedItemStats(db: any, c: ChallengeRow) {
	if (c.item_stats && stateOf(c) === 'closed') return c.item_stats;
	const stats = await itemStatsOf(db, c.id);
	if (stateOf(c) === 'closed') await db('listening_challenges').where('id', c.id).update({ item_stats: JSON.stringify(stats) });
	return stats;
}

/** Share of the other official goes this score equals or beats (0–100); null when alone */
export async function beatsOf(db: any, challengeId: string, score: number, participants: number) {
	if (participants <= 1) return null;
	const atMost = Number((await db('listening_challenge_results').where('challenge_id', challengeId).where('score', '<=', score).count('* as n').first())?.n) || 0;
	return Math.max(0, Math.min(100, Math.round(((atMost - 1) / (participants - 1)) * 100)));
}
