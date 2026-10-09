/**
 * Placement test: 10 short clips from free lessons of one-answer groups, one per skill
 * where possible, multiple choice (the right phrase + 3 others of the same group).
 *
 *   GET  /placement/test       the questions (which option is right stays on the server)
 *   POST /placement/submit     { answers: [{ clip_id, choice }], anonymous_id? } -> level + what to practise
 *   GET  /placement/me         my last result
 *
 * Only free lessons are used: the options are lesson texts, which are the answers.
 */
import { answerOf, loadLessonGraph, UUID_RE } from '../lib/lessons';
import { normalizeAnswer } from './engagementRoutes';

const QUESTIONS = 10;
const ANON_ID_RE = /^[A-Za-z0-9-]{16,64}$/;

/** % right -> level. CEFR-like labels learners already know. */
export const LEVELS = [
	{ min: 85, level: 'C1' },
	{ min: 65, level: 'B2' },
	{ min: 40, level: 'B1' },
	{ min: 0, level: 'A2' },
];
export const levelOf = (percent: number) => LEVELS.find((l) => percent >= l.min)!.level;

const shuffle = <T>(list: T[]) => {
	const a = [...list];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j]!, a[i]!];
	}
	return a;
};

export function registerPlacementRoutes(router: any, context: any) {
	const { database, logger } = context;
	const fail = (res: any, what: string, error: any) => {
		logger?.error?.(`[placement] ${what} failed: ${String(error)}`);
		return res.status(500).json({ success: false, message: 'Server error' });
	};

	/** First "type" clip with a video of each free lesson */
	async function firstClips(lessonIds: string[]) {
		if (!lessonIds.length) return new Map<string, any>();
		const rows = await database('listening_clips as c')
			.join('source_videos as sv', 'sv.id', 'c.source_video_id')
			.select('c.id', 'c.lesson_id', 'c.step', 'c.challenge_mode', 'c.answer', 'c.transcript', 'c.start_time', 'c.end_time', 'c.playback_rate', 'sv.youtube_video_id')
			.whereIn('c.lesson_id', lessonIds)
			.where('c.step', 'type')
			.whereNotNull('c.start_time')
			.orderBy([{ column: 'c.sort', order: 'asc', nulls: 'last' }, { column: 'c.id' }]);
		const map = new Map<string, any>();
		for (const r of rows) if (!map.has(r.lesson_id)) map.set(r.lesson_id, r);
		return map;
	}

	router.get('/placement/test', async (_req: any, res: any) => {
		try {
			const g = await loadLessonGraph({ accountability: null }, context);
			// One-answer groups only: in per-clip groups (Numbers...) the lesson text is a label,
			// not something you hear, so it cannot be a wrong option
			const free = g.lessons.filter((l) => !g.isPremiumContent(l) && g.groupOf(l).answer_mode === 'one_answer');
			const clips = await firstClips(free.map((l) => l.id));
			const playable = free.filter((l) => clips.has(l.id));

			// One lesson per skill first (easy -> hard), then fill up to QUESTIONS
			const order = { easy: 0, medium: 1, hard: 2 } as Record<string, number>;
			const bySkill = new Map<string, typeof playable>();
			for (const l of shuffle(playable)) {
				if (!bySkill.has(l.skill_id)) bySkill.set(l.skill_id, []);
				bySkill.get(l.skill_id)!.push(l);
			}
			const picked: typeof playable = [];
			for (const list of shuffle([...bySkill.values()])) if (picked.length < QUESTIONS) picked.push(list[0]!);
			for (const l of shuffle(playable)) if (picked.length < QUESTIONS && !picked.includes(l)) picked.push(l);
			picked.sort((a, b) => (order[a.difficulty] ?? 1) - (order[b.difficulty] ?? 1));

			const questions = picked.map((l) => {
				const clip = clips.get(l.id);
				const group = g.groupOf(l);
				const right = answerOf(clip, l.text, group.answer_mode);
				// Distractors: other phrases of the same group, then any
				const pool = [
					...shuffle(free.filter((o) => o.id !== l.id && g.groupOf(o).id === group.id)),
					...shuffle(free.filter((o) => o.id !== l.id)),
				].map((o) => o.text.trim()).filter((t) => normalizeAnswer(t) !== normalizeAnswer(right));
				const options = [right];
				for (const t of pool) if (options.length < 4 && !options.some((o) => normalizeAnswer(o) === normalizeAnswer(t))) options.push(t);
				return {
					clip_id: clip.id,
					skill: { name: g.skillOf(l).name, slug: g.skillOf(l).slug },
					youtube_video_id: clip.youtube_video_id,
					start_time: Number(clip.start_time) || 0,
					end_time: Number(clip.end_time) || 0,
					rate: Number(clip.playback_rate) || 1,
					options: shuffle(options),
				};
			});
			return res.json({ success: true, data: { questions } });
		} catch (error) {
			return fail(res, 'Build test', error);
		}
	});

	router.post('/placement/submit', async (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		const body = req.body || {};
		const answers = Array.isArray(body.answers) ? body.answers.slice(0, 20) : [];
		const ids = answers.map((a: any) => String(a?.clip_id || '')).filter((id: string) => UUID_RE.test(id));
		if (!ids.length) return res.status(400).json({ success: false, message: 'No answers' });
		try {
			const rows = await database('listening_clips as c')
				.join('listening_lessons as l', 'l.id', 'c.lesson_id')
				.join('listening_skills as s', 's.id', 'l.skill_id')
				.join('listening_groups as g', 'g.id', 's.group_id')
				.select('c.id', 'c.step', 'c.challenge_mode', 'c.answer', 'c.transcript', 'l.text', 'l.short_id',
					's.name as skill_name', 's.slug as skill_slug', 'g.answer_mode',
					database.raw('(l.is_premium OR s.is_premium OR g.is_premium) AS premium_content'))
				.whereIn('c.id', ids);
			const byId = new Map(rows.map((r: any) => [r.id, r]));

			const results = answers
				.filter((a: any) => byId.has(String(a?.clip_id)))
				.map((a: any) => {
					const r: any = byId.get(String(a.clip_id));
					const right = answerOf(r, r.text, r.answer_mode === 'per_clip' ? 'per_clip' : 'one_answer');
					return {
						clip_id: r.id,
						correct: normalizeAnswer(String(a.choice ?? '')) === normalizeAnswer(right),
						choice: String(a.choice ?? '').slice(0, 255),
						answer: r.premium_content ? null : right,
						lesson_short_id: r.short_id,
						skill: { name: r.skill_name, slug: r.skill_slug },
					};
				});
			const score = results.filter((r: any) => r.correct).length;
			const total = results.length;
			const percent = total ? Math.round((score / total) * 100) : 0;
			const level = levelOf(percent);

			// Skills missed, most missed first: what to practise
			const missed = new Map<string, { name: string; slug: string; missed: number }>();
			for (const r of results) {
				if (r.correct) continue;
				const m = missed.get(r.skill.slug) || { ...r.skill, missed: 0 };
				m.missed++;
				missed.set(r.skill.slug, m);
			}
			const focus = [...missed.values()].sort((a, b) => b.missed - a.missed).slice(0, 4);

			const anonymousId = typeof body.anonymous_id === 'string' && ANON_ID_RE.test(body.anonymous_id) ? body.anonymous_id : null;
			const [saved] = await database('placement_results')
				.insert({ user_id: userId, anonymous_id: anonymousId, score, total, level, details: JSON.stringify({ results, focus }) })
				.returning('id');
			return res.json({ success: true, data: { id: saved?.id || saved, score, total, percent, level, focus, results } });
		} catch (error) {
			return fail(res, 'Submit test', error);
		}
	});

	router.get('/placement/me', async (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		try {
			const row = await database('placement_results').where('user_id', userId).orderBy('date_created', 'desc').first();
			if (!row) return res.json({ success: true, data: null });
			const details = typeof row.details === 'string' ? JSON.parse(row.details) : row.details || {};
			return res.json({
				success: true,
				data: { score: row.score, total: row.total, percent: row.total ? Math.round((row.score / row.total) * 100) : 0, level: row.level, focus: details.focus || [], date_created: row.date_created },
			});
		} catch (error) {
			return fail(res, 'Load my result', error);
		}
	});

	// A guest took the test, then signed up: keep their result
	router.post('/placement/claim', async (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		const id = String(req.body?.id || '');
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
		try {
			await database('placement_results').where({ id }).whereNull('user_id').where('date_created', '>', database.raw("now() - interval '1 day'")).update({ user_id: userId });
			return res.json({ success: true });
		} catch (error) {
			return fail(res, 'Claim result', error);
		}
	});
}
