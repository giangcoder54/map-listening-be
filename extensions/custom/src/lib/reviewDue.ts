/**
 * Every review card lives in one table, review_cards (database/migrations/2026-12-03_review_cards.sql): words, sound
 * patterns, pairs, spelling, sentences and Listening Lab forms. How many are due, in one place, so the header's red
 * number, the /review page and the buttons of each feature all show the same number.
 */
export async function dueReviews(database: any, userId: string): Promise<number> {
	const row = await database('review_cards').where('user_id', userId).where('due', '<=', database.fn.now()).whereNull('suspended_at').count('* as n').first();
	return Number(row?.n) || 0;
}
