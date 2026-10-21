/**
 * Phrase Lab: everyday phrases from films (database/migrations/2026-10-19_phrase_lab.sql,
 * plan in docs/phrase-lab-roadmap.md of the web repo).
 *
 *   phrase_types > phrases > phrase_clips          content
 *   phrase_progress                                level + FSRS card, one row per user x phrase
 *   phrase_review_logs                             lesson finishes and review answers
 *
 * Levels: 1 recognise (lesson done) -> 2 understand (right in "choose") -> 3 recall (right in
 * "next line") -> 4 can use (right "reflex" on 2 different days with 2 different situations).
 * A wrong answer takes one level off (never below 1). FSRS (ts-fsrs) only decides WHEN a
 * phrase comes back; the level decides HOW it is reviewed (modeFor).
 *
 * Free learners: phraseFreePerType first phrases of each type, phraseFreeNewPerDay new phrases
 * a day, phraseFreeClips clips per phrase (lib/growthConfig.ts). Reviews are always free.
 */
import { createEmptyCard, fsrs, generatorParameters, Rating, type Card, type Grade } from 'ts-fsrs';
import { growthConfig } from './growthConfig';
import { isPremiumUser } from './premium';

export const TZ = 'Asia/Ho_Chi_Minh';
export const PHRASE_XP = { lesson: 20, review: 5 };
export const REVIEW_SESSION = 15;
export const DEFAULT_LOCALE = 'vi-VN';

export type Kind = 'reaction' | 'situational' | 'frame';
export type ReviewMode = 'choose' | 'next_line' | 'reflex';
export type SelfRating = 'again' | 'hard' | 'good';

const scheduler = fsrs(generatorParameters({
	request_retention: 0.9,
	maximum_interval: 365,
	enable_fuzz: true,
	// Whole days only: a phrase comes back tomorrow at the earliest, never in 10 minutes
	enable_short_term: false,
}));

/** "Got a second?" -> "got a second" (one row per phrase) */
export const normalizePhrase = (text: string) =>
	String(text || '').toLowerCase().replace(/[‘’`]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

export const slugify = (text: string) =>
	normalizePhrase(text).replace(/'/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'phrase';

/** Today in Vietnam time, "2026-10-19" */
export const todayKey = (date = new Date()) =>
	new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

/** The translation for a locale ("vi", "vi-VN", "en"...), else vi-VN, else the first */
export function pickTranslation<T extends { languages_code: string; [key: string]: any }>(rows: T[] | undefined, locale?: string): T | null {
	if (!rows?.length) return null;
	const lang = String(locale || '').slice(0, 2).toLowerCase();
	return rows.find((r) => r.languages_code.toLowerCase().startsWith(lang) && lang)
		|| rows.find((r) => r.languages_code === DEFAULT_LOCALE)
		|| rows[0]
		|| null;
}

export const jsonList = (value: any): any[] => {
	if (Array.isArray(value)) return value;
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}
	return [];
};

// ── FSRS card <-> phrase_progress row ──────────────────────────────────────
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

/** The card after a lesson (new) or a review */
export const schedule = (row: any | null, grade: Grade, now = new Date()) =>
	scheduler.next(row ? cardOf(row) : createEmptyCard(now), now, grade).card;

export const SELF_RATING: Record<SelfRating, Grade> = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good };

/**
 * Rating of an answer. Self-rated modes (reflex, next line said aloud): the learner's
 * "again / hard / good". Multiple choice: wrong = again, slow (> 6 s) = hard, fast
 * (< 2 s, "choose" only) = easy, else good.
 */
export function ratingOf(mode: ReviewMode, answer: { correct?: boolean; self_rating?: SelfRating; ms?: number }): Grade {
	if (answer.self_rating && SELF_RATING[answer.self_rating]) return SELF_RATING[answer.self_rating];
	if (!answer.correct) return Rating.Again;
	const ms = Number(answer.ms) || 0;
	if (ms > 6000) return Rating.Hard;
	if (mode === 'choose' && ms > 0 && ms < 2000) return Rating.Easy;
	return Rating.Good;
}

/** How a phrase is reviewed at a level */
export function modeFor(level: number, opts: { hasClip: boolean; situations: number; reps: number }): ReviewMode {
	if (level <= 1) return 'choose';
	if (level === 2) return opts.hasClip ? 'next_line' : 'choose';
	if (!opts.situations) return opts.hasClip ? 'next_line' : 'choose';
	// Can use: mostly reflex, now and then the film line again, for variety
	if (level >= 4 && opts.hasClip && opts.reps % 3 === 2) return 'next_line';
	return 'reflex';
}

export type ReflexDay = { day: string; situation: number };

/** Level after an answer, and the reflex days kept for level 4 */
export function levelAfter(level: number, mode: ReviewMode, grade: Grade, reflexDays: ReflexDay[], situation: number | null, today: string) {
	if (grade === Rating.Again) return { level: Math.max(1, level - 1), reflexDays };
	if (level === 1 && mode === 'choose') return { level: 2, reflexDays };
	if (level === 2 && mode === 'next_line') return { level: 3, reflexDays };
	if (level === 3 && mode === 'reflex') {
		const days = situation === null ? reflexDays : [...reflexDays.filter((d) => d.day !== today), { day: today, situation }].slice(-10);
		const dayCount = new Set(days.map((d) => d.day)).size;
		const situationCount = new Set(days.map((d) => d.situation)).size;
		return { level: dayCount >= 2 && situationCount >= 2 ? 4 : 3, reflexDays: days };
	}
	return { level, reflexDays };
}

/** A situation the learner has not answered right yet, else the next one in turn */
export function pickSituation(count: number, reflexDays: ReflexDay[], reps: number) {
	if (!count) return null;
	const used = new Set(reflexDays.map((d) => d.situation));
	for (let i = 0; i < count; i++) {
		const index = (reps + i) % count;
		if (!used.has(index)) return index;
	}
	return reps % count;
}

/** Whole days from now until a date (0 = today) */
export const daysUntil = (date: Date | string) =>
	Math.max(0, Math.round((new Date(date).getTime() - Date.now()) / 86400000));

/**
 * Types, phrases (with at least one published clip), the learner's progress and what is
 * locked, in a few queries. Read with the database directly: free learners still see
 * premium phrases (locked).
 */
export async function loadPhraseCatalog(req: any, context: any) {
	const { database, logger } = context;
	const userId: string | null = req.accountability?.user ?? null;
	const cfg = growthConfig();

	const [types, typeTr, phrases, phraseTr, clipStats] = await Promise.all([
		database('phrase_types').select('id', 'name', 'slug', 'sort', 'icon', 'is_premium').where('status', 'published').orderBy([{ column: 'sort', order: 'asc' }, 'name']),
		database('phrase_types_translations').select('phrase_types_id as owner', 'languages_code', 'name', 'description'),
		database('phrases').select('id', 'type_id', 'slug', 'text', 'text_linked', 'ipa', 'kind', 'is_premium', 'sort', 'learners_count', 'date_created').where('status', 'published'),
		database('phrases_translations').select('phrases_id as owner', 'languages_code', 'meaning'),
		database.raw(`
			SELECT c.phrase_id, COUNT(*)::int AS clips,
				(ARRAY_AGG(sv.thumbnail_url ORDER BY c.sort NULLS LAST, c.date_created))[1] AS thumbnail,
				(ARRAY_AGG(c.youtube_video_id ORDER BY c.sort NULLS LAST, c.date_created))[1] AS youtube_video_id
			FROM phrase_clips c
			LEFT JOIN source_videos sv ON sv.id = c.source_video_id
			WHERE c.status = 'published'
			GROUP BY c.phrase_id
		`),
	]);

	const group = (rows: any[]) => {
		const map = new Map<string, any[]>();
		for (const { owner, ...tr } of rows) {
			if (!map.has(owner)) map.set(owner, []);
			map.get(owner)!.push(tr);
		}
		return map;
	};
	const typeTrById = group(typeTr);
	const phraseTrById = group(phraseTr);
	const clipsById = new Map<string, { clips: number; thumbnail: string; youtube_video_id: string }>();
	for (const r of clipStats?.rows || []) clipsById.set(r.phrase_id, { clips: Number(r.clips) || 0, thumbnail: r.thumbnail || '', youtube_video_id: r.youtube_video_id || '' });

	const typeById = new Map<string, any>(types.map((t: any) => [t.id, { ...t, translations: typeTrById.get(t.id) || [] }]));
	const playable = phrases.filter((p: any) => typeById.has(p.type_id) && (clipsById.get(p.id)?.clips || 0) > 0);
	const byType = new Map<string, any[]>();
	for (const t of types) byType.set(t.id, []);
	for (const p of playable) byType.get(p.type_id)!.push(p);
	for (const list of byType.values()) {
		list.sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999) || String(a.date_created).localeCompare(String(b.date_created)) || a.id.localeCompare(b.id));
	}

	const progress = new Map<string, any>();
	let newToday = 0;
	if (userId) {
		const rows = await database('phrase_progress').select('*').where('user_id', userId);
		const today = todayKey();
		for (const r of rows) {
			progress.set(r.phrase_id, r);
			if (todayKey(new Date(r.learned_at)) === today) newToday++;
		}
	}
	const premium = userId ? await isPremiumUser(database, userId, logger) : false;

	const numberOf = (p: any) => (byType.get(p.type_id) || []).findIndex((x) => x.id === p.id) + 1;
	/** Premium content: the phrase or its type is premium, or it is past the free ones of its type */
	const isPremiumContent = (p: any) => !!(p.is_premium || typeById.get(p.type_id)?.is_premium || numberOf(p) > cfg.phraseFreePerType);
	/** Learned phrases stay open (they were open when learned) */
	const isLocked = (p: any) => !premium && !progress.has(p.id) && isPremiumContent(p);
	const newLimit = premium ? null : cfg.phraseFreeNewPerDay;
	/** A new phrase can be started today */
	const canStartNew = () => newLimit === null || newToday < newLimit;

	return {
		userId, premium, cfg, types: [...typeById.values()], typeById, phrases: playable, byType, phraseTrById, clipsById,
		progress, newToday, newLimit, numberOf, isPremiumContent, isLocked, canStartNew,
	};
}

export type PhraseCatalog = Awaited<ReturnType<typeof loadPhraseCatalog>>;
