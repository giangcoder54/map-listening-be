/**
 * Is a lesson ready to publish? One list of checks for the publish hook
 * (hook/lessonReadyCheck.ts), the admin lesson page and the admin lesson list.
 *
 * A lesson (one form of a rule) is played from its pool (lib/runs.ts): a first test of 3,
 * practice of 5-6 with a trap, a retest of 3, and the same pool feeds the skip-ahead tests
 * and the reviews. So it needs, at least:
 *   core 1, voice 1, challenge 1, trap 1, pool 9 (3 + 3 + 3; 10-12 is better)
 *   every pool clip has its focus (the part with the rule: gaps, taps, highlights)
 *   3 clips with wrong choices ("which one did you hear?")
 *   an explanation, and both explanation sounds ("said clearly" / "said naturally")
 * Lessons published before these checks stay published; the checks apply when a lesson
 * goes from draft to published.
 */
export const READY = { core: 1, voice: 1, challenge: 1, trap: 1, pool: 9, poolGood: 12, choices: 3 };

export type Check = { key: string; ok: boolean; have: number; need: number; text: string };
export type Readiness = { ok: boolean; checks: Check[]; counts: Record<'core' | 'voice' | 'pool' | 'challenge' | 'trap', number> };

const hasChoices = (v: unknown) => {
	const list = typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v;
	return Array.isArray(list) && list.some((x) => String(x ?? '').trim());
};

export async function readinessOf(db: any, lessonId: string): Promise<Readiness> {
	const [clips, lesson, trs] = await Promise.all([
		db('listening_clips').select('role', 'focus_text', 'choices').where({ lesson_id: lessonId, status: 'published' }).whereNotNull('role'),
		db('listening_lessons').select('explain_clear_url', 'explain_natural_url').where('id', lessonId).first(),
		db('listening_lessons_translations').select('explanation').where('listening_lessons_id', lessonId),
	]);
	const counts = { core: 0, voice: 0, pool: 0, challenge: 0, trap: 0 };
	for (const c of clips) if (c.role in counts) counts[c.role as keyof typeof counts]++;
	const pool = clips.filter((c: any) => c.role === 'pool');
	const focused = pool.filter((c: any) => String(c.focus_text || '').trim()).length;
	const withChoices = clips.filter((c: any) => (c.role === 'pool' || c.role === 'trap') && hasChoices(c.choices)).length;
	const explained = trs.some((t: any) => String(t.explanation || '').trim());
	const audio = Number(!!lesson?.explain_clear_url) + Number(!!lesson?.explain_natural_url);

	const checks: Check[] = [
		{ key: 'core', ok: counts.core === READY.core, have: counts.core, need: READY.core, text: 'Exactly 1 core clip (opens the lesson)' },
		{ key: 'voice', ok: counts.voice >= READY.voice, have: counts.voice, need: READY.voice, text: 'At least 1 other-voice clip' },
		{ key: 'pool', ok: counts.pool >= READY.pool, have: counts.pool, need: READY.pool, text: `At least ${READY.pool} pool clips (${READY.poolGood} is better)` },
		{ key: 'challenge', ok: counts.challenge >= READY.challenge, have: counts.challenge, need: READY.challenge, text: 'At least 1 challenge clip' },
		{ key: 'trap', ok: counts.trap >= READY.trap, have: counts.trap, need: READY.trap, text: 'At least 1 trap clip (where the rule does not apply)' },
		{ key: 'focus', ok: pool.length > 0 && focused === pool.length, have: focused, need: pool.length, text: 'Every pool clip has its focus (the part with the rule)' },
		{ key: 'choices', ok: withChoices >= READY.choices, have: withChoices, need: READY.choices, text: `At least ${READY.choices} pool or trap clips with wrong choices` },
		{ key: 'explanation', ok: explained, have: Number(explained), need: 1, text: 'An explanation' },
		{ key: 'audio', ok: audio === 2, have: audio, need: 2, text: 'Both sounds: said clearly and said naturally' },
	];
	return { ok: checks.every((c) => c.ok), checks, counts };
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
