/**
 * Listening Lab endpoints (groups > skills > lessons > clips, see lib/lessons.ts).
 *
 *   GET  /listening-lab/groups                 every group with its skills + "continue" card
 *   GET  /listening-lab/groups/:slug           one group and its skills
 *   GET  /listening-lab/skills/:slug           one skill and its lessons, in order
 *   GET  /listening-lab/lessons/:key           a lesson: card, explanation, lock (:key = short_id or id);
 *                                              its items come with a run (v1/runRoutes.ts)
 *   GET  /listening-lab/lessons/:key/next      what to do after this lesson
 *   GET  /listening-lab/progress/clips         clip ids this learner answered right
 *   GET  /listening-lab/my-progress            profile page
 *   GET  /listening-lab/my-activity            daily counts for the heatmap
 *
 * The answer of a one-answer lesson is its text: lesson cards only show it once the
 * learner has finished the lesson.
 */
import { UUID_RE, answerOf, loadLessonGraph, type LessonGraph, type LessonRow } from '../lib/lessons';
import { COIN } from '../lib/coins';
import { masteryOf } from '../lib/review';

const badKey = (key: string) => !key || key.length > 64;

/** Clip fields a player needs, with the video it comes from. */
export async function readClips(database: any, lessonIds: string[]) {
	if (!lessonIds.length) return [];
	return database('listening_clips as c')
		.leftJoin('source_videos as sv', 'sv.id', 'c.source_video_id')
		.select(
			'c.id', 'c.lesson_id', 'c.step', 'c.role', 'c.focus_text', 'c.difficulty', 'c.sort', 'c.challenge_mode', 'c.answer', 'c.transcript',
			'c.start_time', 'c.end_time', 'c.explanation_en', 'c.explanation_vi', 'c.playback_rate', 'c.sounds_like',
			'c.explanation_image', 'c.explanation_video', 'c.answer_format', 'c.choices',
			'sv.id as video_id', 'sv.youtube_video_id', 'sv.title as video_title', 'sv.channel_name', 'sv.thumbnail_url',
			'c.cues',
			// Clips saved before cues: the lines of the video's transcript (ms) said in the segment
			database.raw(`CASE WHEN c.cues IS NULL AND jsonb_typeof(sv.transcript) = 'array' AND c.start_time IS NOT NULL AND c.end_time IS NOT NULL
				THEN jsonb_path_query_array(sv.transcript, ?::jsonpath,
					jsonb_build_object('s', c.start_time::numeric * 1000 + 50, 'e', c.end_time::numeric * 1000 - 50)) END AS source_lines`,
			['$[*] ? (@.end > $s && @.start < $e)']),
		)
		.whereIn('c.lesson_id', lessonIds)
		.whereNotNull('c.role')
		.where('c.status', 'published')
		.orderBy([{ column: 'c.sort', order: 'asc', nulls: 'last' }, { column: 'c.id' }]);
}

/**
 * @param pool phrases the wrong choices are picked from when the admin set none (other
 *             lessons of the skill, other answers of the lesson)
 */
export function clipOut(row: any, lessonText: string, mode: ReturnType<LessonGraph['groupOf']>['answer_mode'], open: boolean, pool: string[] = []) {
	const video = {
		id: row.video_id,
		youtube_video_id: row.youtube_video_id,
		title: row.video_title,
		channel_name: row.channel_name,
		thumbnail_url: row.thumbnail_url,
	};
	const base = { id: row.id, lesson_id: row.lesson_id, role: row.role, sort: row.sort, mode: row.challenge_mode || null, rate: Number(row.playback_rate) || null, video };
	if (!open) return { ...base, answer: null, transcript: null, start_time: null, end_time: null, cues: null, lines: null, format: 'type', choices: null, media: null };
	const cues = cuesOf(row.cues);
	const answer = answerOf(row, lessonText, mode);
	const choices = row.answer_format === 'choice' && answer ? choicesOf(row, answer, pool) : null;
	return {
		...base,
		answer,
		// 'choice': pick the answer among `choices` instead of typing it
		format: choices ? 'choice' : 'type',
		choices,
		// Image / video of its explanation; null = the lesson's
		media: mediaOf(row),
		transcript: row.transcript,
		start_time: row.start_time,
		end_time: row.end_time,
		// Subtitle lines; else (older clips) the video's lines, which the page lays the transcript on
		cues,
		lines: cues ? null : sourceLines(row.source_lines),
		translations: clipTranslations(row),
		// How the phrase sounds here ("o-fyu-GO"); null = none
		sounds_like: String(row.sounds_like ?? '').trim() || null,
	};
}

const normPhrase = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Same order on every load of a clip (resuming must not reshuffle its choices) */
function seededShuffle<T>(list: T[], seed: string): T[] {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
	const next = () => {
		h = Math.imul(h ^ (h >>> 15), 2246822507);
		h = Math.imul(h ^ (h >>> 13), 3266489909);
		return ((h ^= h >>> 16) >>> 0) / 4294967296;
	};
	const out = [...list];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

/**
 * Choices of a "pick the answer" clip: the answer and the wrong ones set by the admin, else 3
 * phrases of the pool. Null when there is nothing to put next to the answer.
 */
export function choicesOf(row: any, answer: string, pool: string[]): string[] | null {
	const list = typeof row.choices === 'string' ? safeJson(row.choices) : row.choices;
	const key = normPhrase(answer);
	const seen = new Set([key]);
	const pick = (items: unknown[], max: number) => {
		const out: string[] = [];
		for (const item of items) {
			const text = String(item ?? '').replace(/\s+/g, ' ').trim();
			const k = normPhrase(text);
			if (!text || !k || seen.has(k)) continue;
			seen.add(k);
			out.push(text);
			if (out.length >= max) break;
		}
		return out;
	};
	let wrong = Array.isArray(list) ? pick(list, 5) : [];
	if (!wrong.length) wrong = pick(seededShuffle(pool, String(row.id)), 3);
	if (!wrong.length) return null;
	return seededShuffle([answer, ...wrong], `${row.id}:choices`);
}

/** YouTube video id and start (s) of a link: watch?v=, youtu.be/, embed/, shorts/; ?t=1m30s / &start=90 */
function youtubeOf(url: unknown): { id: string; start: number } | null {
	const text = String(url ?? '').trim();
	const id = text.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i)?.[1]
		|| (/^[\w-]{11}$/.test(text) ? text : null);
	if (!id) return null;
	const t = text.match(/[?&#](?:t|start)=([0-9hms]+)/i)?.[1] || '';
	let start = 0;
	if (/^\d+$/.test(t)) start = Number(t);
	else for (const [, n, unit] of t.matchAll(/(\d+)([hms])/g)) start += Number(n) * ({ h: 3600, m: 60, s: 1 } as any)[unit!];
	return { id, start };
}

/** Image (file id) and YouTube video of an explanation; null when it has neither */
function mediaOf(row: any): { image: string | null; video: { id: string; start: number } | null } | null {
	// An uploaded file (its id) or an https:// link
	const raw = String(row?.explanation_image ?? '').trim();
	const image = UUID_RE.test(raw) || /^https:\/\/\S+$/i.test(raw) ? raw : null;
	const video = youtubeOf(row?.explanation_video);
	return image || video ? { image, video } : null;
}

export async function lessonMedia(database: any, lessonIds: string[]) {
	const map = new Map<string, ReturnType<typeof mediaOf>>();
	if (!lessonIds.length) return map;
	const rows = await database('listening_lessons').select('id', 'explanation_image', 'explanation_video').whereIn('id', lessonIds);
	for (const r of rows) {
		const m = mediaOf(r);
		if (m) map.set(r.id, m);
	}
	return map;
}

/** Saved subtitle lines [{ start (s), text }]; null when there are fewer than two */
function cuesOf(value: unknown): { start: number; text: string }[] | null {
	const list = typeof value === 'string' ? safeJson(value) : value;
	if (!Array.isArray(list)) return null;
	const cues = list
		.map((c: any) => ({ start: Number(c?.start), text: String(c?.text ?? '').trim() }))
		.filter((c) => Number.isFinite(c.start) && c.text);
	return cues.length > 1 ? cues : null;
}

/** Lines of the video's transcript in the segment, in seconds */
function sourceLines(value: unknown): { start: number; text: string }[] | null {
	const list = typeof value === 'string' ? safeJson(value) : value;
	if (!Array.isArray(list) || list.length < 2) return null;
	return list
		.map((l: any) => ({ start: Math.round(Number(l?.start) / 100) / 10, text: String(l?.text ?? '').trim() }))
		.filter((l) => Number.isFinite(l.start) && l.text);
}

function safeJson(text: string) {
	try { return JSON.parse(text); } catch { return null; }
}

/** Explanation of a clip, shaped like the lesson's translations. Empty: the page shows the lesson's. */
function clipTranslations(row: any): { languages_code: string; explanation: string | null; tips?: string | null }[] {
	return [
		{ languages_code: 'en', explanation: row.explanation_en },
		{ languages_code: 'vi', explanation: row.explanation_vi },
	].filter((tr) => tr.explanation && String(tr.explanation).trim());
}

export async function lessonTranslations(database: any, lessonIds: string[]) {
	if (!lessonIds.length) return new Map<string, any[]>();
	const rows = await database('listening_lessons_translations')
		.select('listening_lessons_id as lesson_id', 'languages_code', 'title', 'explanation', 'tips')
		.whereIn('listening_lessons_id', lessonIds);
	const map = new Map<string, any[]>();
	for (const { lesson_id, ...tr } of rows) {
		if (!map.has(lesson_id)) map.set(lesson_id, []);
		map.get(lesson_id)!.push(tr);
	}
	return map;
}

/** Lessons listed on a skill card of the group page */
const PREVIEW_COUNT = 5;

export function registerLessonRoutes(router: any, context: any) {
	const { database, logger } = context;
	const fail = (res: any, what: string, error: any) => {
		logger?.error?.(`[listening-lab] ${what} failed: ${String(error)}`);
		return res.status(500).json({ success: false, message: 'Server error' });
	};

	// ── Groups ────────────────────────────────────────────────────────────
	router.get('/listening-lab/groups', async (req: any, res: any) => {
		try {
			const g = await loadLessonGraph(req, context);
			const groups = g.groups.map(g.groupSummary).filter((x) => x.total > 0 || x.skills.length > 0);

			// "Continue": skill of the lesson practised last, if it still has something to do
			let resume: { skill_id: string } | null = null;
			if (g.userId) {
				const last = await database('listening_progress').select('lesson_id').where('user_id', g.userId)
					.orderBy('date_updated', 'desc').first();
				const lesson = last ? g.lessonById.get(last.lesson_id) : null;
				if (lesson && g.skillSummary(g.skillOf(lesson)).next) resume = { skill_id: lesson.skill_id };
			}
			return res.json({ success: true, data: { premium: g.premium, groups, resume } });
		} catch (error) {
			return fail(res, 'Load groups', error);
		}
	});

	// Public paths for sitemap.xml: slugs and short ids only, never a lesson's text (its answer)
	router.get('/listening-lab/sitemap', async (req: any, res: any) => {
		try {
			const g = await loadLessonGraph(req, context);
			return res.json({
				success: true,
				data: {
					groups: g.groups.filter((x) => (g.groupSummary(x).total > 0)).map((x) => x.slug),
					skills: g.skills.filter((s) => (g.lessonsBySkill.get(s.id) || []).length > 0).map((s) => s.slug),
					lessons: g.lessons.map((l) => l.short_id),
				},
			});
		} catch (error) {
			return fail(res, 'Load sitemap', error);
		}
	});

	router.get('/listening-lab/groups/:slug', async (req: any, res: any) => {
		const slug = String(req.params.slug || '');
		if (badKey(slug)) return res.status(400).json({ success: false, message: 'Invalid group' });
		try {
			const g = await loadLessonGraph(req, context);
			const group = g.groups.find((x) => x.slug === slug);
			if (!group) return res.status(404).json({ success: false, message: 'Group not found' });
			// Each skill card previews its first lessons, as the old category cards did
			const summary = g.groupSummary(group);
			const skills = summary.skills.map((s: any) => ({
				...s,
				lessons: (g.lessonsBySkill.get(s.id) || []).slice(0, PREVIEW_COUNT).map(g.lessonCard),
			}));
			return res.json({ success: true, data: { premium: g.premium, group: { ...summary, skills } } });
		} catch (error) {
			return fail(res, 'Load group', error);
		}
	});

	// ── Skills ────────────────────────────────────────────────────────────
	router.get('/listening-lab/skills/:slug', async (req: any, res: any) => {
		const slug = String(req.params.slug || '');
		if (badKey(slug)) return res.status(400).json({ success: false, message: 'Invalid skill' });
		try {
			const g = await loadLessonGraph(req, context);
			const skill = g.skills.find((x) => x.slug === slug);
			if (!skill) return res.status(404).json({ success: false, message: 'Skill not found' });
			const group = g.groupById.get(skill.group_id)!;
			const lessons = g.lessonsBySkill.get(skill.id) || [];
			// The learner on this rule: learning / mastered / tested out, the bar that fades without
			// review, and the rule's test (skip it: Premium; final test: once every open lesson is done)
			let standing: any = null;
			if (g.userId) {
				const [row, cards, settings, tried] = await Promise.all([
					database('listening_skill_progress').where({ user_id: g.userId, skill_id: skill.id }).first(),
					database('listening_review_cards as c').join('listening_lessons as l', 'l.id', 'c.lesson_id')
						.select('c.*').where({ 'c.user_id': g.userId, 'l.skill_id': skill.id }),
					database('listening_skills').select('test_size', 'pass_ratio').where('id', skill.id).first(),
					database('listening_runs').where({ user_id: g.userId, mode: 'skill_test', skill_id: skill.id })
						.where('started_at', '>=', database.raw(`date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'`))
						.count('* as n').first(),
				]);
				const open = lessons.filter((l) => !g.isLocked(l));
				const allDone = open.length > 0 && open.every((l) => g.done.has(l.id));
				standing = {
					status: row?.status || (cards.length ? 'learning' : null),
					mastery: Math.round(masteryOf(cards) * 100),
					lessons_done: lessons.filter((l) => g.done.has(l.id)).length,
					test: {
						kind: allDone ? 'final' : 'skip',
						available: open.length > 0 && (allDone || g.premium),
						size: Number(settings?.test_size) || 8,
						pass: Math.round((Number(settings?.pass_ratio) || 0.8) * 100),
						// A second go the same day costs Xu
						retest_price: Number(tried?.n) > 0 ? COIN.retest : 0,
					},
				};
			}
			return res.json({
				success: true,
				data: {
					premium: g.premium,
					skill: { ...g.skillSummary(skill), group: { id: group.id, name: group.name, slug: group.slug, answer_mode: group.answer_mode } },
					lessons: lessons.map(g.lessonCard),
					standing,
				},
			});
		} catch (error) {
			return fail(res, 'Load skill', error);
		}
	});

	// ── One lesson ────────────────────────────────────────────────────────
	// Card, explanation and lock. The items to answer come with a run (v1/runRoutes.ts).
	// Locked lesson: no text or explanation, but its preview (video title, thumbnail) for
	// visitors and SEO, and the Xu price to buy it. A lesson merged into another form answers
	// { redirect: short_id }.
	router.get('/listening-lab/lessons/:key', async (req: any, res: any) => {
		const key = String(req.params.key || '');
		if (badKey(key)) return res.status(400).json({ success: false, message: 'Invalid lesson key' });
		try {
			const g = await loadLessonGraph(req, context);
			const lesson = g.findLesson(key);
			if (!lesson) {
				const moved = await database('listening_lessons as l')
					.join('listening_lessons as t', 't.id', 'l.redirect_lesson_id')
					.where(UUID_RE.test(key) ? { 'l.id': key } : { 'l.short_id': key })
					.first('t.short_id');
				if (moved) return res.json({ success: true, data: { redirect: moved.short_id } });
				return res.status(404).json({ success: false, message: 'Lesson not found' });
			}

			const skill = g.skillOf(lesson);
			const group = g.groupOf(lesson);
			const open = !g.isLocked(lesson);
			const [rows, trs, media, extra] = await Promise.all([
				readClips(database, [lesson.id]),
				lessonTranslations(database, [lesson.id]),
				lessonMedia(database, [lesson.id]),
				database('listening_lessons').select('explain_clear_url', 'explain_natural_url').where('id', lesson.id).first(),
			]);
			const first = rows.find((r: any) => r.role === 'core') || rows[0];
			const preview = first ? clipOut(first, lesson.text, group.answer_mode, false).video : null;

			return res.json({
				success: true,
				data: {
					locked: !open,
					premium: g.premium,
					unlock: !open ? { price: COIN.unlock[lesson.kind || 'pattern'] ?? COIN.unlock.pattern } : null,
					lesson: {
						...g.lessonCard(lesson),
						text: open ? lesson.text : null,
						translations: open ? trs.get(lesson.id) || [] : [],
						media: open ? media.get(lesson.id) || null : null,
						// "Said clearly" and "said naturally", side by side on the explanation screen
						explain_audio: open && (extra?.explain_clear_url || extra?.explain_natural_url)
							? { clear: extra.explain_clear_url || null, natural: extra.explain_natural_url || null }
							: null,
					},
					skill: { id: skill.id, name: skill.name, slug: skill.slug, category: skill.category },
					group: { id: group.id, name: group.name, slug: group.slug, answer_mode: group.answer_mode },
					preview,
					pool: rows.length,
				},
			});
		} catch (error) {
			return fail(res, 'Load lesson', error);
		}
	});

	// The next lesson of the skill (open ones first); once the skill is done, the next skill
	// of the group, then any other group. ?finished=1 (the result card, before its progress
	// save lands) counts the current lesson as done; while the lesson is still being worked
	// on it only counts if it was finished before.
	router.get('/listening-lab/lessons/:key/next', async (req: any, res: any) => {
		const key = String(req.params.key || '');
		if (badKey(key)) return res.status(400).json({ success: false, message: 'Invalid lesson key' });
		try {
			const g = await loadLessonGraph(req, context);
			const lesson = g.findLesson(key);
			if (!lesson) return res.status(404).json({ success: false, message: 'Lesson not found' });

			const done = new Set(g.done);
			if (req.query?.finished === '1') done.add(lesson.id);
			const skill = g.skillOf(lesson);
			const skillLessons = g.lessonsBySkill.get(skill.id) || [];
			// Never suggest the lesson on screen
			const todo = (list: LessonRow[]) => list.filter((l) => !done.has(l.id) && l.id !== lesson.id);
			const lessonDone = done.has(lesson.id);

			let mode: 'continue' | 'skill_completed' | 'all_completed' = 'continue';
			let nextSkill = skill;
			let pool = todo(skillLessons);
			if (!pool.length) {
				// "completed" only once this lesson is done too, not while it is being worked on
				const sameGroup = g.skills.filter((s) => s.group_id === skill.group_id && s.id !== skill.id);
				const rest = g.skills.filter((s) => s.group_id !== skill.group_id);
				const found = [...sameGroup, ...rest].find((s) => todo(g.lessonsBySkill.get(s.id) || []).length > 0);
				if (found) {
					if (lessonDone) mode = 'skill_completed';
					nextSkill = found;
					pool = todo(g.lessonsBySkill.get(found.id) || []);
				} else {
					if (lessonDone) mode = 'all_completed';
					pool = skillLessons.filter((l) => l.id !== lesson.id);
				}
			}
			if (mode !== 'all_completed') {
				pool = [...pool].sort((a, b) => Number(g.isLocked(a)) - Number(g.isLocked(b)));
			}
			const picked = pool.slice(0, 5).map((l) => ({ ...g.lessonCard(l), done: done.has(l.id) }));
			const ref = (s: typeof skill) => ({ id: s.id, name: s.name, slug: s.slug });

			return res.json({
				success: true,
				data: {
					mode,
					skill: ref(skill),
					next_skill: nextSkill.id !== skill.id ? ref(nextSkill) : null,
					progress: { done: skillLessons.filter((l) => done.has(l.id)).length, total: skillLessons.length },
					next: picked[0] || null,
					others: picked.slice(1),
				},
			});
		} catch (error) {
			return fail(res, 'Load next lesson', error);
		}
	});

	router.get('/listening-lab/progress/clips', async (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		if (!userId) return res.json({ success: true, data: [] });
		try {
			const rows = await database('listening_attempts').distinct('clip_id').where({ user_id: userId, is_correct: true });
			return res.json({ success: true, data: rows.map((r: any) => r.clip_id).filter(Boolean) });
		} catch (error) {
			return fail(res, 'Load clip progress', error);
		}
	});

	// ── Profile ───────────────────────────────────────────────────────────
	// Lessons practised with their status, daily activity, accuracy per skill.
	router.get('/listening-lab/my-progress', async (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		try {
			const lessonsRes = await database.raw(`
				WITH mine AS (
					SELECT a.lesson_id,
						COUNT(DISTINCT a.clip_id) FILTER (WHERE a.is_correct)::int AS completed_clips,
						COUNT(*) FILTER (WHERE a.answer IS DISTINCT FROM '[REVEALED]' AND a.answer IS DISTINCT FROM '[HEARD]')::int AS checks,
						COUNT(*) FILTER (WHERE a.is_correct)::int AS correct_checks,
						COUNT(*) FILTER (WHERE a.answer = '[REVEALED]')::int AS reveals,
						MIN(a.date_created) AS first_at, MAX(a.date_created) AS last_at
					FROM listening_attempts a
					WHERE a.user_id = ? AND a.lesson_id IS NOT NULL
					GROUP BY a.lesson_id
				)
				SELECT l.id, l.short_id, l.text, l.difficulty, l.learners_count,
					s.id AS skill_id, s.name AS skill_name, s.slug AS skill_slug,
					g.id AS group_id, g.name AS group_name, g.slug AS group_slug, g.answer_mode,
					(SELECT COUNT(*) FROM listening_clips c WHERE c.lesson_id = l.id AND c.role IS NOT NULL)::int AS total_clips,
					(SELECT sv.title FROM listening_clips c JOIN source_videos sv ON sv.id = c.source_video_id
						WHERE c.lesson_id = l.id ORDER BY (c.role = 'core') DESC, c.sort NULLS LAST LIMIT 1) AS video_title,
					(SELECT sv.thumbnail_url FROM listening_clips c JOIN source_videos sv ON sv.id = c.source_video_id
						WHERE c.lesson_id = l.id ORDER BY (c.role = 'core') DESC, c.sort NULLS LAST LIMIT 1) AS thumbnail_url,
					COALESCE(p.status, 'in_progress') AS status,
					mine.completed_clips, mine.checks, mine.correct_checks, mine.reveals,
					mine.first_at, GREATEST(mine.last_at, p.date_updated) AS last_at
				FROM mine
				JOIN listening_lessons l ON l.id = mine.lesson_id
				JOIN listening_skills s ON s.id = l.skill_id
				JOIN listening_groups g ON g.id = s.group_id
				LEFT JOIN listening_progress p ON p.user_id = ? AND p.lesson_id = l.id
				ORDER BY last_at DESC NULLS LAST
			`, [userId, userId]);

			const challenges = (lessonsRes.rows || []).map((r: any) => {
				const perClip = r.answer_mode === 'per_clip';
				const total = Number(r.total_clips) || 0;
				const completedClips = Math.min(Number(r.completed_clips) || 0, total);
				const completed = r.status === 'completed';
				return {
					target_id: r.id,
					short_id: r.short_id,
					text: r.text,
					difficulty: r.difficulty,
					types: [
						{ id: r.skill_id, name: r.skill_name, slug: r.skill_slug },
						...(r.group_name !== r.skill_name ? [{ id: r.group_id, name: r.group_name, slug: r.group_slug }] : []),
					],
					progress_mode: perClip ? 'per_clip' : 'single_answer',
					video_title: r.video_title,
					thumbnail_url: r.thumbnail_url,
					learners_count: Number(r.learners_count) || 0,
					total_clips: total,
					completed_clips: completedClips,
					percentage: completed ? 100 : perClip && total ? Math.round((completedClips / total) * 100) : 0,
					status: completed ? 'completed' : 'in_progress',
					checks: Number(r.checks) || 0,
					correct_checks: Number(r.correct_checks) || 0,
					reveals: Number(r.reveals) || 0,
					first_practiced_at: r.first_at,
					last_practiced_at: r.last_at,
				};
			});

			const totalChecks = challenges.reduce((n: number, c: any) => n + c.checks, 0);
			const totalCorrect = challenges.reduce((n: number, c: any) => n + c.correct_checks, 0);
			const summary = {
				challenges_practiced: challenges.length,
				challenges_completed: challenges.filter((c: any) => c.status === 'completed').length,
				average_percentage: challenges.length
					? Math.round(challenges.reduce((n: number, c: any) => n + c.percentage, 0) / challenges.length)
					: 0,
				clips_completed: challenges.reduce((n: number, c: any) => n + c.completed_clips, 0),
				accuracy_rate: totalChecks ? Math.round((totalCorrect / totalChecks) * 100) : 0,
				last_practiced_at: challenges[0]?.last_practiced_at ?? null,
			};

			const activity = ((await database.raw(`
				SELECT to_char(DATE(date_created AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD') AS day,
					COUNT(*)::int AS checks, COUNT(*) FILTER (WHERE is_correct)::int AS correct
				FROM listening_attempts
				WHERE user_id = ? AND answer IS DISTINCT FROM '[REVEALED]' AND answer IS DISTINCT FROM '[HEARD]' AND date_created >= NOW() - INTERVAL '365 days'
				GROUP BY 1 ORDER BY 1
			`, [userId])).rows || []).map((r: any) => ({ day: r.day, checks: Number(r.checks) || 0, correct: Number(r.correct) || 0 }));

			const by_type = ((await database.raw(`
				SELECT s.id AS type_id, s.name, s.slug, COUNT(*)::int AS checks, COUNT(*) FILTER (WHERE a.is_correct)::int AS correct
				FROM listening_attempts a
				JOIN listening_lessons l ON l.id = a.lesson_id
				JOIN listening_skills s ON s.id = l.skill_id
				WHERE a.user_id = ? AND a.answer IS DISTINCT FROM '[REVEALED]' AND a.answer IS DISTINCT FROM '[HEARD]'
				GROUP BY s.id, s.name, s.slug
				ORDER BY checks DESC
			`, [userId])).rows || []).map((r: any) => {
				const checks = Number(r.checks) || 0;
				const correct = Number(r.correct) || 0;
				return { type_id: r.type_id, name: r.name, slug: r.slug, checks, correct, accuracy: checks ? Math.round((correct / checks) * 100) : 0 };
			});

			return res.json({ success: true, data: { summary, challenges, activity, by_type } });
		} catch (error) {
			return fail(res, 'Load my progress', error);
		}
	});

	router.get('/listening-lab/my-activity', async (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		try {
			// Answers per Vietnam day: one row a day in user_daily_stats (lib/xp.ts)
			const rows = (await database.raw(`
				SELECT to_char(day, 'YYYY-MM-DD') AS day, attempts AS count
				FROM user_daily_stats
				WHERE user_id = ? AND attempts > 0 AND day > (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 365
				ORDER BY 1
			`, [userId])).rows || [];
			return res.json({ success: true, data: Object.fromEntries(rows.map((r: any) => [r.day, Number(r.count) || 0])) });
		} catch (error) {
			return fail(res, 'Load activity', error);
		}
	});
}

/**
 * Count a learner once per lesson (user or guest cookie id). A guest who signs up later
 * is converted to their user key instead of being counted twice.
 */
export async function registerLearner(database: any, lessonId: string, userId: string | null, anonymousId: string | null): Promise<boolean> {
	try {
		return await database.transaction(async (trx: any) => {
			if (userId) {
				const userKey = `u:${userId}`;
				if (await trx('listening_lesson_learners').where({ lesson_id: lessonId, learner_key: userKey }).first('id')) return false;
				if (anonymousId) {
					const converted = await trx('listening_lesson_learners')
						.where({ lesson_id: lessonId, learner_key: `a:${anonymousId}` })
						.update({ learner_key: userKey, user_id: userId });
					if (converted > 0) return false;
				}
			}
			const key = userId ? `u:${userId}` : `a:${anonymousId}`;
			const inserted = await trx('listening_lesson_learners')
				.insert({ lesson_id: lessonId, user_id: userId, anonymous_id: anonymousId, learner_key: key })
				.onConflict(['lesson_id', 'learner_key'])
				.ignore()
				.returning('id');
			if (!inserted.length) return false;
			await trx('listening_lessons').where('id', lessonId).increment('learners_count', 1);
			return true;
		});
	} catch (error: any) {
		// 23505: a parallel request already counted this learner
		if (error?.code === '23505') return false;
		throw error;
	}
}
