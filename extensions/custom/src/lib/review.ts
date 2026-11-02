/**
 * Review by form (listening_review_cards, one FSRS card per learner x lesson). Same
 * scheduler settings as Phrase Lab (lib/phrases.ts on feature/phrase-lab): whole days,
 * 90% retention, a year at most.
 *
 * A card is made when a lesson is finished (first review tomorrow) or skipped by a test
 * (first review in a week). A review item is a NEW clip of the form (lib/runs.ts
 * drawReview), so the learner hears the rule, not a remembered answer. Its grade:
 *   wrong or "I can't hear it" Again · right with slow play or 3+ listens Hard
 *   right on the 2nd listen Good · right on the 1st listen Easy
 */
import { createEmptyCard, fsrs, generatorParameters, Rating, type Card, type Grade } from 'ts-fsrs';
import type { ItemResult } from './runs';

const scheduler = fsrs(generatorParameters({
	request_retention: 0.9,
	maximum_interval: 365,
	enable_fuzz: true,
	enable_short_term: false,
}));

/** Review items a session: free learners get REVIEW.free a day, Premium REVIEW.session a go */
export const REVIEW = { session: 10, free: 5, testedOutDays: 7 };

export const cardOf = (row: any): Card => ({
	due: new Date(row.due),
	stability: Number(row.stability) || 0,
	difficulty: Number(row.difficulty) || 0,
	elapsed_days: Number(row.elapsed_days) || 0,
	scheduled_days: Number(row.scheduled_days) || 0,
	learning_steps: Number(row.learning_steps) || 0,
	reps: Number(row.reps) || 0,
	lapses: Number(row.lapses) || 0,
	state: Number(row.state) || 0,
	last_review: row.last_review ? new Date(row.last_review) : undefined,
});

export const cardColumns = (card: Card) => ({
	due: card.due,
	stability: card.stability,
	difficulty: card.difficulty,
	elapsed_days: Math.round(card.elapsed_days || 0),
	scheduled_days: Math.round(card.scheduled_days || 0),
	learning_steps: card.learning_steps || 0,
	reps: card.reps,
	lapses: card.lapses,
	state: card.state,
	last_review: card.last_review || null,
});

export function gradeOf(r: Pick<ItemResult, 'correct' | 'listens' | 'slow' | 'hint'>): Grade {
	if (!r.correct || r.hint) return Rating.Again;
	if (r.slow || r.listens >= 3) return Rating.Hard;
	if (r.listens === 2) return Rating.Good;
	return Rating.Easy;
}

/** The card after a review */
export const schedule = (row: any | null, grade: Grade, now = new Date()) =>
	scheduler.next(row ? cardOf(row) : createEmptyCard(now), now, grade).card;

/**
 * How well a rule is held now: the mean chance of recalling its forms (0-1). It falls day
 * by day without review, so the rule's bar fades. A form never reviewed counts as learned
 * just now (1) until its first review is due.
 */
export function masteryOf(rows: any[], now = new Date()) {
	if (!rows.length) return 0;
	const sum = rows.reduce((n, row) => {
		if (!row.last_review) return n + (new Date(row.due) > now ? 1 : 0.9);
		return n + Number(scheduler.get_retrievability(cardOf(row), now, false));
	}, 0);
	return Math.max(0, Math.min(1, sum / rows.length));
}
