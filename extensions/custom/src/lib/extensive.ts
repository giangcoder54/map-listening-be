/**
 * Extensive Listening (database/migrations/2026-11-17_extensive_listening.sql).
 *
 * A lesson is a range of a library video cut in parts; after each part one or two quick
 * questions on the main idea, at the end the "listen for" question again and a self rating.
 * Each answer is checked at once (the learner can replay the line the answer is in).
 *
 * The learner's Level (1..10, the scale of video_tags) moves after each finished lesson:
 *   up    the last UP_AFTER finished lessons at the learner's Level or above were all "good"
 *         (>= 80% right and not rated "little")
 *   down  a lesson at the learner's Level or below went badly (< 50% right, or rated "little")
 * The first Level comes from the placement test when there is one (A2 2, B1 4, B2 6, C1 8),
 * else DEFAULT_LEVEL.
 */
export const EL = {
	defaultLevel: 3,
	upAfter: 2,
	goodRatio: 0.8,
	badRatio: 0.5,
	/** Lessons suggested around the learner's Level */
	suggest: 12,
	xpAgain: 5,
};
export const PLACEMENT_LEVEL: Record<string, number> = { A2: 2, B1: 4, B2: 6, C1: 8 };
export const SELF_RATINGS = ['most', 'half', 'little'] as const;
export type SelfRating = (typeof SELF_RATINGS)[number];

export type Cue = { text: string; start: number; end: number };

/** Transcript lines inside [from, to] ms, cleaned for subtitles */
export function linesIn(transcript: unknown, from: number, to: number): Cue[] {
	const list = Array.isArray(transcript) ? transcript : [];
	return list
		.filter((c: any) => Number(c?.end) > from && Number(c?.start) < to)
		.map((c: any) => ({ text: String(c.text || '').replace(/\s+/g, ' ').trim(), start: Number(c.start), end: Number(c.end) }))
		.filter((c) => c.text);
}

export const isGood = (ratio: number, rating: SelfRating | null) => ratio >= EL.goodRatio && rating !== 'little';
export const isBad = (ratio: number, rating: SelfRating | null) => ratio < EL.badRatio || rating === 'little';

/** The learner's Level row, created from the placement test (or the default) the first time */
export async function levelRowOf(database: any, userId: string) {
	let row = await database('el_levels').where('user_id', userId).first();
	if (row) return row;
	const placed = await database('placement_results').select('level').where('user_id', userId).orderBy('date_created', 'desc').first().catch(() => null);
	const level = (placed?.level && PLACEMENT_LEVEL[placed.level]) || EL.defaultLevel;
	await database('el_levels').insert({ user_id: userId, level, source: placed?.level ? 'placement' : 'default' }).onConflict('user_id').ignore();
	row = await database('el_levels').where('user_id', userId).first();
	return row;
}

/** -1, 0 or +1 for the learner's Level after `attemptId` (already finished) */
export async function moveAfter(trx: any, userId: string, level: number, attempt: { id: string; level: number; ratio: number; rating: SelfRating | null }) {
	if (attempt.level <= level && isBad(attempt.ratio, attempt.rating)) return level > 1 ? -1 : 0;
	if (attempt.level < level || level >= 10) return 0;
	const recent = await trx('el_attempts')
		.select('right_count', 'total', 'self_rating', 'level')
		.where('user_id', userId).where('kind', 'first').whereNotNull('finished_at').where('level', '>=', level)
		.orderBy('finished_at', 'desc').limit(EL.upAfter);
	if (recent.length < EL.upAfter) return 0;
	return recent.every((r: any) => isGood(r.total ? r.right_count / r.total : 0, r.self_rating)) ? 1 : 0;
}

export const thumbOf = (r: { thumbnail_url?: string | null; youtube_video_id: string }) => r.thumbnail_url || `https://i.ytimg.com/vi/${r.youtube_video_id}/hqdefault.jpg`;

/** Learner language of the base columns; other languages come from el_translations / el_line_subs */
export const BASE_LANG = 'vi-VN';
export const langOf = (v: unknown) => (/^[a-z]{2}-[A-Z]{2}$/.test(String(v || '')) ? String(v) : BASE_LANG);

/** How many days an unfinished attempt can still be resumed */
export const RESUME_DAYS = 14;
