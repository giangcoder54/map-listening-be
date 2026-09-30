/**
 * Listening Lab: groups, skills, lessons and clips.
 *
 *   listening_groups     Connected Speech         answer_mode, is_premium
 *     listening_skills   H-dropping               category ("Elision"), is_premium
 *       listening_lessons  "tell him"             text = the answer, is_premium, sort
 *         listening_clips  step type | voice | challenge (+ challenge_mode, answer)
 *
 * A lesson is played as: 1 type (its "type" clips) -> 2 voice -> 3 challenge ->
 * 4 more (the "type" clip of other lessons of the same skill) -> result.
 * A step with no clip is left out. Every clip of a step has to be answered.
 *
 * Premium: a lesson is locked for a free learner when its group, its skill or the lesson
 * itself is premium. Progress lives in listening_progress (one row per user x lesson).
 */
import { isPremiumUser } from './premium';

export type AnswerMode = 'one_answer' | 'per_clip';
export type StepKey = 'type' | 'voice' | 'challenge' | 'more';
export const CLIP_STEPS: StepKey[] = ['type', 'voice', 'challenge'];
export const MORE_COUNT = 3;

type Translation = { languages_code: string; [k: string]: any };

export type GroupRow = {
	id: string;
	name: string;
	slug: string;
	sort: number | null;
	answer_mode: AnswerMode;
	is_premium: boolean;
	translations: Translation[];
};
export type SkillRow = {
	id: string;
	group_id: string;
	name: string;
	slug: string;
	sort: number | null;
	category: string | null;
	is_premium: boolean;
	translations: Translation[];
};
export type LessonRow = {
	id: string;
	skill_id: string;
	short_id: string;
	text: string;
	difficulty: string;
	is_premium: boolean;
	sort: number | null;
	learners_count: number | null;
};

const bySort = (a: { sort: number | null; name?: string }, b: { sort: number | null; name?: string }) =>
	(a.sort ?? 999) - (b.sort ?? 999) || String(a.name || '').localeCompare(String(b.name || ''));

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The answer of a clip: its own `answer`; else the whole transcript for a "whole sentence"
 * challenge; else the [bracketed] part (per-clip groups); else the lesson text.
 */
export function answerOf(
	clip: { answer?: string | null; transcript?: string | null; step?: string | null; challenge_mode?: string | null },
	lessonText: string,
	mode: AnswerMode,
) {
	if (clip.answer && clip.answer.trim()) return clip.answer.trim();
	if (clip.step === 'challenge' && clip.challenge_mode === 'sentence') {
		const sentence = String(clip.transcript || '').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
		if (sentence) return sentence;
	}
	if (mode === 'per_clip') {
		const m = String(clip.transcript || '').match(/\[([^\]]+)\]/);
		if (m?.[1]) return m[1].trim();
	}
	return lessonText;
}

/**
 * Everything the list pages, "next" and "more practice" need, in a few queries.
 * Read with the database directly: free learners must still see premium lessons
 * (locked) and count them in progress. Only public metadata is read here.
 */
export async function loadLessonGraph(req: any, context: any) {
	const { database, logger } = context;
	const userId: string | null = req.accountability?.user ?? null;

	const [groupRows, skillRows, lessonRows, groupTr, skillTr, clipRows] = await Promise.all([
		database('listening_groups').select('id', 'name', 'slug', 'sort', 'answer_mode', 'is_premium').where('status', 'published'),
		database('listening_skills').select('id', 'group_id', 'name', 'slug', 'sort', 'category', 'is_premium').where('status', 'published'),
		database('listening_lessons').select('id', 'skill_id', 'short_id', 'text', 'difficulty', 'is_premium', 'sort', 'learners_count').where('status', 'published'),
		database('listening_groups_translations').select('listening_groups_id as owner', 'languages_code', 'description'),
		database('listening_skills_translations').select('listening_skills_id as owner', 'languages_code', 'description', 'example'),
		database.raw(`
			SELECT c.lesson_id,
				COUNT(*)::int AS total_clips,
				COUNT(*) FILTER (WHERE c.step = 'type')::int AS type_clips,
				(ARRAY_AGG(sv.thumbnail_url ORDER BY (c.step = 'type') DESC, c.sort NULLS LAST, c.id))[1] AS thumbnail
			FROM listening_clips c
			LEFT JOIN source_videos sv ON sv.id = c.source_video_id
			WHERE c.lesson_id IS NOT NULL AND c.step IS NOT NULL
			GROUP BY c.lesson_id
		`),
	]);

	const trOf = (rows: any[]) => {
		const map = new Map<string, Translation[]>();
		for (const { owner, ...tr } of rows) {
			if (!owner) continue;
			if (!map.has(owner)) map.set(owner, []);
			map.get(owner)!.push(tr);
		}
		return map;
	};
	const gTr = trOf(groupTr);
	const sTr = trOf(skillTr);

	const groups: GroupRow[] = groupRows
		.map((g: any) => ({ ...g, answer_mode: g.answer_mode === 'per_clip' ? 'per_clip' : 'one_answer', translations: gTr.get(g.id) || [] }))
		.sort(bySort);
	const groupById = new Map(groups.map((g) => [g.id, g]));
	const skills: SkillRow[] = skillRows
		.filter((s: any) => groupById.has(s.group_id))
		.map((s: any) => ({ ...s, translations: sTr.get(s.id) || [] }))
		.sort(bySort);
	const skillById = new Map(skills.map((s) => [s.id, s]));
	const lessons: LessonRow[] = lessonRows.filter((l: any) => skillById.has(l.skill_id));

	const clipStats = new Map<string, { total: number; type: number; thumbnail: string }>();
	for (const row of clipRows?.rows || []) {
		clipStats.set(row.lesson_id, { total: Number(row.total_clips) || 0, type: Number(row.type_clips) || 0, thumbnail: row.thumbnail || '' });
	}
	// A lesson without a step-1 clip cannot be played: it is not listed anywhere
	const playable = lessons.filter((l) => (clipStats.get(l.id)?.type || 0) > 0);

	const lessonsBySkill = new Map<string, LessonRow[]>();
	for (const s of skills) lessonsBySkill.set(s.id, []);
	for (const l of playable) lessonsBySkill.get(l.skill_id)!.push(l);
	for (const list of lessonsBySkill.values()) {
		list.sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999) || a.id.localeCompare(b.id));
	}
	const lessonById = new Map(playable.map((l) => [l.id, l]));

	const done = new Set<string>();
	const started = new Set<string>();
	if (userId) {
		const rows = await database('listening_progress').select('lesson_id', 'status').where('user_id', userId);
		for (const r of rows) (r.status === 'completed' ? done : started).add(r.lesson_id);
	}

	const premium = userId ? await isPremiumUser(database, userId, logger) : false;

	const skillOf = (l: LessonRow) => skillById.get(l.skill_id)!;
	const groupOf = (l: LessonRow) => groupById.get(skillOf(l).group_id)!;
	/** Premium content: the lesson, its skill or its group. */
	const isPremiumContent = (l: LessonRow) => l.is_premium || skillOf(l).is_premium || groupOf(l).is_premium;
	const isLocked = (l: LessonRow) => !premium && isPremiumContent(l);
	const numberOf = (l: LessonRow) => (lessonsBySkill.get(l.skill_id) || []).findIndex((x) => x.id === l.id) + 1;

	/** Public card of a lesson. `text` is the answer in one-answer groups: only once done. */
	const lessonCard = (l: LessonRow) => {
		const showText = groupOf(l).answer_mode === 'per_clip' || done.has(l.id);
		return {
			id: l.id,
			short_id: l.short_id,
			number: numberOf(l),
			text: showText ? l.text : null,
			difficulty: l.difficulty,
			is_premium: isPremiumContent(l),
			locked: isLocked(l),
			done: done.has(l.id),
			in_progress: started.has(l.id),
			total_clips: clipStats.get(l.id)?.total || 0,
			learners_count: Number(l.learners_count) || 0,
			thumbnail: clipStats.get(l.id)?.thumbnail || '',
			skill_id: l.skill_id,
		};
	};

	/** First lesson to do: not done and open, else not done (locked). */
	const nextOf = (list: LessonRow[]) =>
		list.find((l) => !done.has(l.id) && !isLocked(l)) || list.find((l) => !done.has(l.id)) || null;

	const counts = (list: LessonRow[]) => ({
		total: list.length,
		done: list.filter((l) => done.has(l.id)).length,
		free: list.filter((l) => !isPremiumContent(l)).length,
	});

	const skillSummary = (s: SkillRow) => {
		const list = lessonsBySkill.get(s.id) || [];
		const next = nextOf(list);
		return {
			id: s.id,
			group_id: s.group_id,
			name: s.name,
			slug: s.slug,
			category: s.category,
			is_premium: s.is_premium || groupById.get(s.group_id)!.is_premium,
			translations: s.translations,
			...counts(list),
			next: next ? { id: next.id, short_id: next.short_id, number: numberOf(next), locked: isLocked(next) } : null,
		};
	};

	const groupSummary = (g: GroupRow) => {
		const own = skills.filter((s) => s.group_id === g.id);
		const list = own.flatMap((s) => lessonsBySkill.get(s.id) || []);
		const next = nextOf(list);
		return {
			id: g.id,
			name: g.name,
			slug: g.slug,
			answer_mode: g.answer_mode,
			is_premium: g.is_premium,
			translations: g.translations,
			...counts(list),
			next: next ? { id: next.id, short_id: next.short_id, number: numberOf(next), locked: isLocked(next) } : null,
			skills: own.map(skillSummary),
		};
	};

	const findLesson = (key: string) =>
		playable.find((l) => (UUID_RE.test(key) ? l.id === key : l.short_id === key)) || null;

	return {
		userId, premium, groups, groupById, skills, skillById, lessons: playable, lessonById, lessonsBySkill, clipStats,
		done, started, skillOf, groupOf, isPremiumContent, isLocked, numberOf, lessonCard, nextOf, skillSummary, groupSummary, findLesson,
	};
}

export type LessonGraph = Awaited<ReturnType<typeof loadLessonGraph>>;
