/**
 * Is a lesson ready to publish? One list of checks for the publish hook
 * (hook/lessonReadyCheck.ts), the admin lesson page and the admin lesson list.
 *
 * A lesson (one form of a rule) is played from its pool (lib/runs.ts): a first test of 2,
 * the practice the team wrote (4 steps: 3 pool clips + 1 trap), a challenge, and the same pool
 * feeds the skip-ahead tests and the reviews. So it needs, at least:
 *   core 1, voice 1, challenge 1, trap 1, pool 7 (3 for practice + 4 for the tests; 9 is better)
 *   every pool clip has its [bracketed] answer (what the learner has to hear: gaps, choices,
 *   word banks, highlights), or an answer of its own
 *   the practice: 4 steps, 1 of them a trap, each choice with 2+ options, each word bank with 2 wrong words
 *   an explanation, and both explanation sounds ("said clearly" / "said naturally")
 * Only core, voice, pool, challenge, the wrong answers of the practice and the explanation
 * hold publishing back; the rest are shown as recommended.
 * A review lesson (kind 'mixed' with review_of) has its own short list: 2 published lessons
 * reviewed with 8 pool clips between them, and a recap; its trap and challenge are recommended.
 * Lessons published before these checks stay published; the checks apply when a lesson
 * goes from draft to published.
 */
import { MIXED, PRACTICE, practiceOf, reviewOfValue, type PracticeStep } from './runs';

export const READY = { core: 1, voice: 1, challenge: 1, trap: 1, pool: 7, poolGood: 9 };

/** `required`: publishing waits for it; the others are recommended (the run copes without them) */
export type Check = { key: string; ok: boolean; have: number; need: number; text: string; required: boolean };

/** The checks a lesson needs to be published; the trap, the [brackets], the full practice and
 * the explanation sounds are recommended only (runs draw a practice and skip a missing trap) */
const REQUIRED = new Set(['core', 'voice', 'pool', 'challenge', 'practiceSteps', 'explanation']);
export type Readiness = { ok: boolean; checks: Check[]; counts: Record<'core' | 'voice' | 'pool' | 'challenge' | 'trap', number> };

export async function readinessOf(db: any, lessonId: string): Promise<Readiness> {
	const [clips, lesson, trs] = await Promise.all([
		db('listening_clips').select('id', 'role', 'answer', 'transcript').where({ lesson_id: lessonId, status: 'published' }).whereNotNull('role'),
		db('listening_lessons').select('explain_clear_url', 'explain_natural_url', 'practice', 'kind', 'review_of').where('id', lessonId).first(),
		db('listening_lessons_translations').select('explanation').where('listening_lessons_id', lessonId),
	]);
	const counts = { core: 0, voice: 0, pool: 0, challenge: 0, trap: 0 };
	for (const c of clips) if (c.role in counts) counts[c.role as keyof typeof counts]++;
	const explained = trs.some((t: any) => String(t.explanation || '').trim());
	const done = (list: Omit<Check, 'required'>[], required: Set<string>) => {
		const checks: Check[] = list.map((c) => ({ ...c, required: required.has(c.key) }));
		return { ok: checks.every((c) => c.ok || !c.required), checks, counts };
	};

	// A review lesson: its items come from the published lessons it reviews; it keeps only its own
	// trap and challenge (else theirs are used) and a short recap
	if (lesson?.kind === 'mixed' && reviewOfValue(lesson.review_of).length) {
		const ids = reviewOfValue(lesson.review_of).filter((id) => id !== lessonId);
		const [reviewed, theirs] = await Promise.all([
			db('listening_lessons').count('* as n').whereIn('id', ids).where('status', 'published').first(),
			db('listening_clips as c').join('listening_lessons as l', 'l.id', 'c.lesson_id')
				.whereIn('c.lesson_id', ids).where({ 'l.status': 'published', 'c.status': 'published' })
				.select(db.raw("count(*) FILTER (WHERE c.role = 'pool')::int AS pool"), db.raw("count(*) FILTER (WHERE c.role = 'trap')::int AS trap"),
					db.raw("count(*) FILTER (WHERE c.role = 'challenge')::int AS challenge"))
				.first(),
		]);
		const lessons = Number(reviewed?.n) || 0;
		const challenge = counts.challenge + (Number(theirs?.challenge) || 0);
		return done([
			{ key: 'reviewOf', ok: lessons >= MIXED.minLessons, have: lessons, need: MIXED.minLessons, text: `Reviews at least ${MIXED.minLessons} published lessons` },
			{ key: 'reviewPool', ok: (Number(theirs?.pool) || 0) >= MIXED.items, have: Number(theirs?.pool) || 0, need: MIXED.items, text: `Those lessons have at least ${MIXED.items} pool clips between them` },
			{ key: 'trap', ok: counts.trap >= READY.trap, have: counts.trap, need: READY.trap, text: 'A trap clip of its own (else one of theirs is used)' },
			{ key: 'challenge', ok: challenge >= READY.challenge, have: challenge, need: READY.challenge, text: 'A challenge clip, its own or theirs' },
			{ key: 'explanation', ok: explained, have: Number(explained), need: 1, text: 'A short recap of the forms (shown first)' },
		], new Set(['reviewOf', 'reviewPool', 'explanation']));
	}
	const pool = clips.filter((c: any) => c.role === 'pool');
	const marked = pool.filter((c: any) => String(c.answer || '').trim() || /\[[^\]]+\]/.test(String(c.transcript || ''))).length;
	// The practice: steps on a pool or trap clip of the lesson; a choice or a word bank needs
	// its wrong answers
	const byId = new Map<string, any>(clips.map((c: any) => [c.id, c]));
	const steps = practiceOf(lesson?.practice).filter((s) => ['pool', 'trap'].includes(byId.get(s.clip_id)?.role));
	const trapSteps = steps.filter((s) => byId.get(s.clip_id)!.role === 'trap').length;
	const stepOk = (s: PracticeStep) => s.format === 'gap' || s.wrong.length >= PRACTICE.wrong[s.format];
	const goodSteps = steps.filter(stepOk).length;
	const audio = Number(!!lesson?.explain_clear_url) + Number(!!lesson?.explain_natural_url);

	const list: Omit<Check, 'required'>[] = [
		{ key: 'core', ok: counts.core === READY.core, have: counts.core, need: READY.core, text: 'Exactly 1 core clip (opens the lesson)' },
		{ key: 'voice', ok: counts.voice >= READY.voice, have: counts.voice, need: READY.voice, text: 'At least 1 other-voice clip' },
		{ key: 'pool', ok: counts.pool >= READY.pool, have: counts.pool, need: READY.pool, text: `At least ${READY.pool} pool clips (${READY.poolGood} is better)` },
		{ key: 'challenge', ok: counts.challenge >= READY.challenge, have: counts.challenge, need: READY.challenge, text: 'At least 1 challenge clip' },
		{ key: 'trap', ok: counts.trap >= READY.trap, have: counts.trap, need: READY.trap, text: 'At least 1 trap clip (where the rule does not apply)' },
		{ key: 'marked', ok: pool.length > 0 && marked === pool.length, have: marked, need: pool.length, text: 'Every pool clip has its [bracketed] answer' },
		{ key: 'practice', ok: steps.length === PRACTICE.steps, have: steps.length, need: PRACTICE.steps, text: `Practice: ${PRACTICE.steps} steps on pool or trap clips` },
		{ key: 'practiceTrap', ok: trapSteps >= PRACTICE.traps, have: trapSteps, need: PRACTICE.traps, text: 'Practice: 1 step on a trap clip' },
		{ key: 'practiceSteps', ok: steps.length > 0 && goodSteps === steps.length, have: goodSteps, need: steps.length, text: `Practice: every choice has ${PRACTICE.wrong.choice + 1}+ options, every word bank ${PRACTICE.wrong.bank} wrong words` },
		{ key: 'explanation', ok: explained, have: Number(explained), need: 1, text: 'An explanation' },
		{ key: 'audio', ok: audio === 2, have: audio, need: 2, text: 'Both sounds: said clearly and said naturally' },
	];
	return done(list, REQUIRED);
}

/**
 * Can the rule's skip-ahead test (and final test) be drawn? It takes `test_size` items from
 * the pool and trap clips of the rule's published lessons.
 */
export async function skillTestReadiness(db: any, skillId: string) {
	const skill = await db('listening_skills').select('test_size', 'pass_ratio').where('id', skillId).first();
	const row = await db('listening_clips as c')
		.join('listening_lessons as l', 'l.id', 'c.lesson_id')
		.where({ 'l.skill_id': skillId, 'l.status': 'published', 'c.status': 'published' })
		.whereIn('c.role', ['pool', 'trap'])
		.select(db.raw('count(*)::int AS clips'), db.raw('count(DISTINCT l.id)::int AS lessons'))
		.first();
	const need = Number(skill?.test_size) || 8;
	return { ok: (Number(row?.clips) || 0) >= need, clips: Number(row?.clips) || 0, lessons: Number(row?.lessons) || 0, need, pass_ratio: Number(skill?.pass_ratio) || 0.8 };
}
