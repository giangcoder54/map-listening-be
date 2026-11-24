/**
 * Every review card lives in one table, review_cards (database/migrations/2026-12-03_review_cards.sql): words, sound
 * patterns, pairs, spelling, sentences and Listening Lab forms. How many are due, in one place, so the header's red
 * number, the /review page and the buttons of each feature all show the same number.
 */
import { vnDay } from './days';

export const KINDS = ['word', 'pattern', 'pair', 'spell', 'sentence', 'form'] as const;
export type Kind = (typeof KINDS)[number];
/** The most of each kind in one session, so no kind crowds the rest out */
export const CAP: Record<Kind, number> = { word: 10, pattern: 8, pair: 6, spell: 3, sentence: 5, form: 5 };
export const SECONDS: Record<Kind, number> = { word: 12, pattern: 12, pair: 8, spell: 12, sentence: 15, form: 15 };

export async function dueReviews(database: any, userId: string): Promise<number> {
	const row = await database('review_cards').where('user_id', userId).where('due', '<=', database.fn.now()).whereNull('suspended_at').count('* as n').first();
	return Number(row?.n) || 0;
}

export type ReviewPrompt = { total: number; minutes: number; prompt: boolean; compact: boolean; skips: number };

/**
 * The daily review popup's question, without building a session: one grouped count (index review_cards_due) and one read
 * of the user. `due` = every card due (the header's red number); `review.total` = as many as one session holds.
 * prompt = cards due, not asked yet today (Vietnam day), fewer than three "later"s in a row; compact = the slim bar instead.
 */
export async function reviewPrompt(database: any, userId: string, size = 25): Promise<{ due: number; review: ReviewPrompt }> {
	const [rows, u] = await Promise.all([
		database('review_cards').where('user_id', userId).where('due', '<=', database.fn.now()).whereNull('suspended_at').select('kind').count('* as n').groupBy('kind'),
		database('directus_users').where('id', userId).first('review_prompted_on', 'review_skips'),
	]);
	const count = (k: Kind) => Number(rows.find((r: any) => r.kind === k)?.n) || 0;
	const due = rows.reduce((n: number, r: any) => n + (Number(r.n) || 0), 0);
	const held = Object.fromEntries(KINDS.map((k) => [k, Math.min(count(k), CAP[k])])) as Record<Kind, number>;
	const total = Math.min(size, KINDS.reduce((n, k) => n + held[k], 0));
	const minutes = Math.max(1, Math.round(KINDS.reduce((n, k) => n + held[k] * SECONDS[k], 0) / 60));
	const shownOn = u?.review_prompted_on ? new Date(u.review_prompted_on).toISOString().slice(0, 10) : null;
	const skips = Number(u?.review_skips) || 0;
	return { due, review: { total, minutes, prompt: total > 0 && shownOn !== vnDay() && skips < 3, compact: total > 0 && skips >= 3, skips } };
}
