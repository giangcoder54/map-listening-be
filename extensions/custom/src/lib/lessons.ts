/**
 * Listening Lab: groups, skills, lessons and clips.
 *
 *   listening_groups     Connected Speech         answer_mode, is_premium
 *     listening_skills   H-dropping (a rule)      category ("Elision"), is_premium, pass_ratio
 *       listening_lessons  one form of the rule   text = its typical phrase, kind, is_premium, sort
 *         listening_clips  the lesson's pool       role core | voice | pool | challenge | trap
 *
 * A lesson is played as a run (lib/runs.ts): the server draws its items from the pool.
 *
 * Premium: a lesson is locked for a free learner when its group, its skill or the lesson
 * itself is premium, unless they bought it with Xu (listening_unlocks, lib/coins.ts).
 * Progress lives in listening_progress (one row per user x lesson).
 */
import { isPremiumUser } from './premium';

export type AnswerMode = 'one_answer' | 'per_clip';
export type StepKey = 'type' | 'voice' | 'challenge' | 'more';
export const CLIP_STEPS: StepKey[] = ['type', 'voice', 'challenge', 'more'];

/**
 * How a learner likes to practise (directus_users.practice_prefs, 2026-10-26_practice_modes.sql):
 * step 2 typed again or only listened to, how much of step 3 is typed. The lesson page
 * applies it; the server stores it and checks the answers the same way whatever the level.
 */
export const PRACTICE = { voice: ['type', 'listen'], challenge: ['easy', 'medium', 'hard'] } as const;
export type PracticePrefs = { voice: (typeof PRACTICE.voice)[number]; challenge: (typeof PRACTICE.challenge)[number] };
export const DEFAULT_PRACTICE: PracticePrefs = { voice: 'type', challenge: 'medium' };
/** The stored value, anything unknown back to its default */
export function practicePrefsOf(raw: any): PracticePrefs {
	const v = raw && typeof raw === 'object' ? raw : {};
	return {
		voice: (PRACTICE.voice as readonly string[]).includes(v.voice) ? v.voice : DEFAULT_PRACTICE.voice,
		challenge: (PRACTICE.challenge as readonly string[]).includes(v.challenge) ? v.challenge : DEFAULT_PRACTICE.challenge,
	};
}

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
	date_created: string | null;
	kind?: 'pattern' | 'trap' | 'mixed' | null;
};

const bySort = (a: { sort: number | null; name?: string }, b: { sort: number | null; name?: string }) =>
	(a.sort ?? 999) - (b.sort ?? 999) || String(a.name || '').localeCompare(String(b.name || ''));

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The answer of a clip: its own `answer`; else the [bracketed] part for per-clip groups,
 * step 4 "more practice" (other phrases: "let him go" in a "tell him" lesson) and a "whole
 * sentence" challenge (lines outside the brackets are context, heard but not typed); else
 * the lesson text.
 */
export function answerOf(
	clip: { answer?: string | null; transcript?: string | null; step?: string | null; role?: string | null; challenge_mode?: string | null },
	lessonText: string,
	mode: AnswerMode,
) {
	if (clip.answer && clip.answer.trim()) return clip.answer.trim();
	const otherPhrase = clip.step === 'more' || (clip.step !== 'type' && (clip.role === 'pool' || clip.role === 'trap'));
	if (mode === 'per_clip' || otherPhrase || (clip.step === 'challenge' && clip.challenge_mode === 'sentence')) {
		const m = String(clip.transcript || '').match(/\[([^\]]+)\]/);
		if (m?.[1]) return m[1].replace(/\s+/g, ' ').trim();
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
		database('listening_lessons').select('id', 'skill_id', 'short_id', 'text', 'difficulty', 'is_premium', 'sort', 'learners_count', 'date_created', 'kind').where('status', 'published'),
		database('listening_groups_translations').select('listening_groups_id as owner', 'languages_code', 'description'),
		database('listening_skills_translations').select('listening_skills_id as owner', 'languages_code', 'description', 'example'),
		database.raw(`
			SELECT c.lesson_id,
				COUNT(*)::int AS total_clips,
				COUNT(*) FILTER (WHERE c.role IN ('core', 'pool'))::int AS type_clips,
				(ARRAY_AGG(sv.thumbnail_url ORDER BY (c.role = 'core') DESC, c.sort NULLS LAST, c.id))[1] AS thumbnail
			FROM listening_clips c
			LEFT JOIN source_videos sv ON sv.id = c.source_video_id
			WHERE c.lesson_id IS NOT NULL AND c.role IS NOT NULL AND c.status = 'published'
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
	// A lesson without a clip to type (core or pool) cannot be played: it is not listed anywhere
	const playable = lessons.filter((l) => (clipStats.get(l.id)?.type || 0) > 0);

	const lessonsBySkill = new Map<string, LessonRow[]>();
	for (const s of skills) lessonsBySkill.set(s.id, []);
	for (const l of playable) lessonsBySkill.get(l.skill_id)!.push(l);
	for (const list of lessonsBySkill.values()) {
		list.sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999) || a.id.localeCompare(b.id));
	}
	const lessonById = new Map(playable.map((l) => [l.id, l]));

	const done = new Set<string>();
	const testedOut = new Set<string>();
	const started = new Set<string>();
	const unlocked = new Set<string>();
	let premium = false;
	if (userId) {
		const [rows, buys, isPremium] = await Promise.all([
			database('listening_progress').select('lesson_id', 'status').where('user_id', userId),
			database('listening_unlocks').select('lesson_id').where('user_id', userId),
			isPremiumUser(database, userId, logger),
		]);
		for (const r of rows) {
			if (r.status === 'in_progress') started.add(r.lesson_id);
			else done.add(r.lesson_id);
			if (r.status === 'tested_out') testedOut.add(r.lesson_id);
		}
		for (const r of buys) unlocked.add(r.lesson_id);
		premium = isPremium;
	}

	const skillOf = (l: LessonRow) => skillById.get(l.skill_id)!;
	const groupOf = (l: LessonRow) => groupById.get(skillOf(l).group_id)!;
	/** Premium content: the lesson, its skill or its group. */
	const isPremiumContent = (l: LessonRow) => l.is_premium || skillOf(l).is_premium || groupOf(l).is_premium;
	/** Open: free content, a Premium learner, or a lesson bought with Xu (kept after Premium ends) */
	const isLocked = (l: LessonRow) => !premium && isPremiumContent(l) && !unlocked.has(l.id);
	const numberOf = (l: LessonRow) => (lessonsBySkill.get(l.skill_id) || []).findIndex((x) => x.id === l.id) + 1;
	/**
	 * The lessons of a rule open one after the other for a signed-in learner: a lesson opens
	 * once every lesson before it is done or skipped by a test (its skip-ahead test is always
	 * there). A lesson already started stays open. Guests keep no progress: nothing is locked.
	 */
	const isOrderLocked = (l: LessonRow) => {
		if (!userId || done.has(l.id) || started.has(l.id)) return false;
		for (const x of lessonsBySkill.get(l.skill_id) || []) {
			if (x.id === l.id) return false;
			if (!done.has(x.id)) return true;
		}
		return false;
	};

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
			/** Bought with Xu */
			unlocked: unlocked.has(l.id),
			/** An earlier lesson of the rule is not done yet: learn it, or pass this one's skip-ahead test */
			order_locked: isOrderLocked(l),
			kind: l.kind || 'pattern',
			done: done.has(l.id),
			tested_out: testedOut.has(l.id),
			in_progress: started.has(l.id),
			total_clips: clipStats.get(l.id)?.total || 0,
			learners_count: Number(l.learners_count) || 0,
			date_created: l.date_created,
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
		done, started, testedOut, skillOf, groupOf, isPremiumContent, isLocked, isOrderLocked, numberOf, lessonCard, nextOf, skillSummary, groupSummary, findLesson,
	};
}

export type LessonGraph = Awaited<ReturnType<typeof loadLessonGraph>>;
