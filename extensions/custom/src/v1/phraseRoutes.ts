/**
 * Phrase Lab for learners (lib/phrases.ts). `?locale=vi|en` picks the translation.
 *
 *   GET  /phrases/types                 types + my numbers (learned, can use), limits, due today
 *   GET  /phrases/types/:slug           one type and its phrases (my level, locked)
 *   GET  /phrases/lesson/:slug          everything a lesson shows; 403 PREMIUM_REQUIRED | DAILY_LIMIT
 *   POST /phrases/lesson/:slug/finish   { self_rating } -> level 1, first review date, XP
 *   GET  /phrases/review/due            today's review session (mode chosen by level)
 *   POST /phrases/review/:phraseId      { mode, correct?, self_rating?, ms, clip_id?, situation_index? }
 *   GET  /me/phrases                    my phrase bank: phrases per level, reflex speed per week
 */
import { Rating } from 'ts-fsrs';
import { UUID_RE } from '../lib/lessons';
import {
	PHRASE_XP, REVIEW_SESSION, SELF_RATING, TZ, daysUntil, jsonList, levelAfter, loadPhraseCatalog, modeFor, pickSituation,
	pickTranslation, ratingOf, schedule, cardColumns, todayKey, type ReviewMode, type SelfRating,
} from '../lib/phrases';

const MODES: ReviewMode[] = ['choose', 'next_line', 'reflex'];
/** Seconds of film played before the line in "next line" */
const LEAD_IN = 6;

const shuffle = <T>(list: T[]) => {
	const a = [...list];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j]!, a[i]!];
	}
	return a;
};

export function registerPhraseRoutes(router: any, context: any) {
	const { database, logger } = context;
	const fail = (res: any, what: string, error: any) => {
		logger?.error?.(`[phrases] ${what} failed: ${String(error)}`);
		return res.status(500).json({ success: false, message: 'Server error' });
	};
	const needUser = (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		if (!userId) res.status(401).json({ success: false, message: 'Unauthorized' });
		return userId as string | null;
	};
	const localeOf = (req: any) => String(req.query?.locale || '').slice(0, 5);

	const typeCard = (t: any, locale: string) => {
		const tr = pickTranslation(t.translations, locale);
		return { id: t.id, slug: t.slug, icon: t.icon, is_premium: !!t.is_premium, name: tr?.name || t.name, description: tr?.description || '' };
	};

	// ── Types ─────────────────────────────────────────────────────────────
	router.get('/phrases/types', async (req: any, res: any) => {
		try {
			const c = await loadPhraseCatalog(req, context);
			const locale = localeOf(req);
			const levels = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<number, number>;
			let due = 0;
			const now = Date.now();
			for (const p of c.progress.values()) {
				levels[p.level] = (levels[p.level] || 0) + 1;
				if (new Date(p.due).getTime() <= now) due++;
			}
			const types = c.types.map((t: any) => {
				const list = c.byType.get(t.id) || [];
				return {
					...typeCard(t, locale),
					total: list.length,
					learned: list.filter((p) => c.progress.has(p.id)).length,
					can_use: list.filter((p) => c.progress.get(p.id)?.level === 4).length,
					free: list.filter((p) => !c.isPremiumContent(p)).length,
				};
			}).filter((t: any) => t.total > 0);
			return res.json({
				success: true,
				data: {
					types,
					me: c.userId ? { premium: c.premium, new_today: c.newToday, new_limit: c.newLimit, due, learned: c.progress.size, levels } : null,
				},
			});
		} catch (error) {
			return fail(res, 'Load types', error);
		}
	});

	router.get('/phrases/types/:slug', async (req: any, res: any) => {
		try {
			const c = await loadPhraseCatalog(req, context);
			const type = c.types.find((t: any) => t.slug === String(req.params.slug));
			if (!type) return res.status(404).json({ success: false, message: 'Not found' });
			const locale = localeOf(req);
			const phrases = (c.byType.get(type.id) || []).map((p: any) => ({
				id: p.id,
				slug: p.slug,
				number: c.numberOf(p),
				text: p.text,
				meaning: pickTranslation(c.phraseTrById.get(p.id), locale)?.meaning || '',
				level: c.progress.get(p.id)?.level ?? 0,
				is_premium: c.isPremiumContent(p),
				locked: c.isLocked(p),
				clips: c.clipsById.get(p.id)?.clips || 0,
				thumbnail: c.clipsById.get(p.id)?.thumbnail || '',
				youtube_video_id: c.clipsById.get(p.id)?.youtube_video_id || '',
			}));
			return res.json({
				success: true,
				data: {
					type: typeCard(type, locale),
					phrases,
					me: c.userId ? { premium: c.premium, new_today: c.newToday, new_limit: c.newLimit } : null,
				},
			});
		} catch (error) {
			return fail(res, 'Load type', error);
		}
	});

	// ── Lesson ────────────────────────────────────────────────────────────
	router.get('/phrases/lesson/:slug', async (req: any, res: any) => {
		try {
			const c = await loadPhraseCatalog(req, context);
			const phrase = c.phrases.find((p: any) => p.slug === String(req.params.slug));
			if (!phrase) return res.status(404).json({ success: false, message: 'Not found' });
			const type = c.typeById.get(phrase.type_id);
			const locale = localeOf(req);
			const learned = c.progress.get(phrase.id) || null;
			const base = { slug: phrase.slug, text: phrase.text, type: typeCard(type, locale) };
			if (c.isLocked(phrase)) return res.status(403).json({ success: false, code: 'PREMIUM_REQUIRED', data: base });
			if (c.userId && !learned && !c.canStartNew()) {
				return res.status(403).json({ success: false, code: 'DAILY_LIMIT', data: { ...base, new_limit: c.newLimit } });
			}

			const [trRows, clips] = await Promise.all([
				database('phrases_translations').select('*').where('phrases_id', phrase.id),
				database('phrase_clips as c')
					.leftJoin('source_videos as sv', 'sv.id', 'c.source_video_id')
					.select('c.id', 'c.youtube_video_id', 'c.start_time', 'c.end_time', 'c.line_text', 'c.context', 'sv.title as video_title')
					.where({ 'c.phrase_id': phrase.id, 'c.status': 'published' })
					.orderByRaw('c.sort ASC NULLS LAST, c.date_created ASC'),
			]);
			const tr = pickTranslation(trRows, locale) || ({} as any);
			const clipLimit = c.premium ? clips.length : c.cfg.phraseFreeClips;
			const list = (c.byType.get(phrase.type_id) || []);
			const index = list.findIndex((p) => p.id === phrase.id);
			const next = list.slice(index + 1).find((p) => !c.progress.has(p.id)) || null;

			return res.json({
				success: true,
				data: {
					...base,
					id: phrase.id,
					number: c.numberOf(phrase),
					total_in_type: list.length,
					text_linked: phrase.text_linked || phrase.text,
					ipa: phrase.ipa || '',
					kind: phrase.kind,
					meaning: tr.meaning || '',
					usage: tr.usage || '',
					avoid: tr.avoid || '',
					similar: jsonList(tr.similar_phrases),
					replies: jsonList(tr.replies),
					// The lesson's reflex step uses the first situation; reviews use the others first
					situation: jsonList(tr.situations)[0] || null,
					clips: clips.slice(0, clipLimit).map((clip: any) => ({
						id: clip.id,
						youtube_video_id: clip.youtube_video_id,
						start: Number(clip.start_time),
						end: Number(clip.end_time),
						line_text: clip.line_text || '',
						context: clip.context || '',
						video_title: clip.video_title || '',
					})),
					more_clips: Math.max(0, clips.length - clipLimit),
					level: learned?.level ?? 0,
					learned: !!learned,
					next: next ? { slug: next.slug, text: next.text, locked: c.isLocked(next) } : null,
				},
			});
		} catch (error) {
			return fail(res, 'Load lesson', error);
		}
	});

	router.post('/phrases/lesson/:slug/finish', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		const self = String(req.body?.self_rating || 'good') as SelfRating;
		if (!SELF_RATING[self]) return res.status(400).json({ success: false, message: 'Invalid rating' });
		try {
			const c = await loadPhraseCatalog(req, context);
			const phrase = c.phrases.find((p: any) => p.slug === String(req.params.slug));
			if (!phrase) return res.status(404).json({ success: false, message: 'Not found' });
			const existing = c.progress.get(phrase.id);
			if (existing) {
				// Done again: no new card, no XP
				return res.json({ success: true, data: { level: existing.level, next_in_days: daysUntil(existing.due), xp: 0, again: true } });
			}
			if (c.isLocked(phrase)) return res.status(403).json({ success: false, code: 'PREMIUM_REQUIRED' });
			if (!c.canStartNew()) return res.status(403).json({ success: false, code: 'DAILY_LIMIT', data: { new_limit: c.newLimit } });

			const grade = SELF_RATING[self];
			const card = schedule(null, grade);
			const inserted = await database('phrase_progress')
				.insert({ user_id: userId, phrase_id: phrase.id, level: 1, learned_at: database.fn.now(), ...cardColumns(card) })
				.onConflict(['user_id', 'phrase_id']).ignore()
				.returning('id');
			if (!inserted.length) return res.json({ success: true, data: { level: 1, next_in_days: daysUntil(card.due), xp: 0, again: true } });
			await Promise.all([
				database('phrase_review_logs').insert({ user_id: userId, phrase_id: phrase.id, mode: 'lesson', rating: grade, correct: true, level_before: 0, level_after: 1 }),
				database('phrases').where('id', phrase.id).increment('learners_count', 1),
			]);
			return res.json({ success: true, data: { level: 1, next_in_days: daysUntil(card.due), xp: PHRASE_XP.lesson, again: false } });
		} catch (error) {
			return fail(res, 'Finish lesson', error);
		}
	});

	// ── Review ────────────────────────────────────────────────────────────
	router.get('/phrases/review/due', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		const limit = Math.min(30, Math.max(1, Number(req.query.limit) || REVIEW_SESSION));
		try {
			const locale = localeOf(req);
			const due = await database('phrase_progress as pp')
				.join('phrases as p', 'p.id', 'pp.phrase_id')
				.select('pp.*', 'p.text', 'p.type_id', 'p.text_linked')
				.where('pp.user_id', userId)
				.where('p.status', 'published')
				.where('pp.due', '<=', database.fn.now())
				.orderBy('pp.due', 'asc')
				.limit(limit * 2);
			const total = await database('phrase_progress').where('user_id', userId).count('* as n').first();
			if (!due.length) {
				const nextDue = await database('phrase_progress').where('user_id', userId).min('due as d').first();
				return res.json({ success: true, data: { items: [], learned: Number(total?.n) || 0, next_due: nextDue?.d || null } });
			}

			// Mix the types: avoid two phrases of the same type in a row when possible
			const picked: any[] = [];
			const pool = due.slice(0, limit);
			while (pool.length) {
				const prev = picked[picked.length - 1];
				const i = pool.findIndex((r: any) => r.type_id !== prev?.type_id);
				picked.push(pool.splice(i < 0 ? 0 : i, 1)[0]);
			}

			const ids = picked.map((r) => r.phrase_id);
			const typeIds = [...new Set(picked.map((r) => r.type_id))];
			const [trRows, clips, others] = await Promise.all([
				database('phrases_translations').select('*').whereIn('phrases_id', ids),
				database('phrase_clips').select('id', 'phrase_id', 'youtube_video_id', 'start_time', 'end_time', 'line_text', 'context')
					.whereIn('phrase_id', ids).where('status', 'published').orderByRaw('sort ASC NULLS LAST, date_created ASC'),
				// Wrong options: other published phrases, same types first
				database('phrases as p').leftJoin('phrases_translations as t', 't.phrases_id', 'p.id')
					.select('p.id', 'p.text', 'p.type_id', 't.languages_code', 't.meaning')
					.where('p.status', 'published')
					.orderByRaw('CASE WHEN p.type_id = ANY(?::uuid[]) THEN 0 ELSE 1 END, random()', [`{${typeIds.join(',')}}`])
					.limit(200),
			]);
			const trOf = (id: string) => pickTranslation(trRows.filter((t: any) => t.phrases_id === id), locale) || ({} as any);
			const clipsOf = (id: string) => clips.filter((c: any) => c.phrase_id === id);
			const otherPhrases = new Map<string, { text: string; type_id: string; meanings: any[] }>();
			for (const o of others) {
				if (!otherPhrases.has(o.id)) otherPhrases.set(o.id, { text: o.text, type_id: o.type_id, meanings: [] });
				if (o.meaning) otherPhrases.get(o.id)!.meanings.push({ languages_code: o.languages_code, meaning: o.meaning });
			}
			/**
			 * Wrong options. Same type first where the film decides the answer (next line, meaning);
			 * other types first for "which phrase fits this situation", where a phrase of the same
			 * type (No way / Not going to happen) could be right too.
			 */
			const distractors = (row: any, n: number, sameTypeFirst = true) => {
				const list = [...otherPhrases.entries()].filter(([id]) => id !== row.phrase_id);
				const same = shuffle(list.filter(([, o]) => o.type_id === row.type_id));
				const rest = shuffle(list.filter(([, o]) => o.type_id !== row.type_id));
				return (sameTypeFirst ? [...same, ...rest] : [...rest, ...same]).slice(0, n).map(([, o]) => o);
			};

			const items = picked.map((row: any) => {
				const tr = trOf(row.phrase_id);
				const situations = jsonList(tr.situations).filter((s: any) => typeof s === 'string' && s.trim());
				const ownClips = clipsOf(row.phrase_id);
				const reflexDays = jsonList(row.reflex_days);
				const mode = modeFor(row.level, { hasClip: ownClips.length > 0, situations: situations.length, reps: row.reps });
				const base = {
					phrase_id: row.phrase_id,
					mode,
					level: row.level,
					text: row.text,
					text_linked: row.text_linked || row.text,
					meaning: tr.meaning || '',
				};
				if (mode === 'choose') {
					// Odd reviews: which phrase fits this situation; else: what does it mean
					const situationIndex = situations.length && (row.reps % 2 === 1 || !tr.meaning) ? pickSituation(situations.length, reflexDays, row.reps) : null;
					if (situationIndex !== null) {
						const options = shuffle([row.text, ...distractors(row, 3, false).map((o) => o.text)]);
						return { ...base, variant: 'choose_phrase', prompt: situations[situationIndex], options, answer: row.text, situation_index: situationIndex };
					}
					const wrong = jsonList(tr.wrong_meanings).filter((m: any) => typeof m === 'string' && m.trim()).slice(0, 2);
					const fill = distractors(row, 3 - wrong.length).map((o) => pickTranslation(o.meanings, locale)?.meaning).filter(Boolean);
					const options = shuffle([...new Set([tr.meaning, ...wrong, ...fill].filter(Boolean))]).slice(0, 4);
					const clip = ownClips[0];
					return {
						...base,
						variant: 'choose_meaning',
						options,
						answer: tr.meaning,
						clip: clip ? { id: clip.id, youtube_video_id: clip.youtube_video_id, start: Number(clip.start_time), end: Number(clip.end_time) } : null,
					};
				}
				if (mode === 'next_line') {
					// A different film than last time, when the phrase has several
					const clip = ownClips[row.reps % ownClips.length];
					const start = Number(clip.start_time);
					return {
						...base,
						variant: row.level >= 3 ? 'next_line_say' : 'next_line_choose',
						clip: {
							id: clip.id,
							youtube_video_id: clip.youtube_video_id,
							lead_start: Math.max(0, start - LEAD_IN),
							start,
							end: Number(clip.end_time),
							line_text: clip.line_text || '',
							context: clip.context || '',
						},
						options: row.level >= 3 ? [] : shuffle([row.text, ...distractors(row, 3).map((o) => o.text)]),
						answer: row.text,
					};
				}
				const situationIndex = pickSituation(situations.length, reflexDays, row.reps) ?? 0;
				return {
					...base,
					variant: 'reflex',
					prompt: situations[situationIndex],
					situation_index: situationIndex,
					answer: row.text,
					replies: jsonList(tr.replies).slice(0, 2),
				};
			});
			return res.json({ success: true, data: { items, learned: Number(total?.n) || 0, next_due: null } });
		} catch (error) {
			return fail(res, 'Load review', error);
		}
	});

	router.post('/phrases/review/:phraseId', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		const phraseId = String(req.params.phraseId || '');
		if (!UUID_RE.test(phraseId)) return res.status(400).json({ success: false, message: 'Invalid phrase' });
		const body = req.body || {};
		const mode = String(body.mode) as ReviewMode;
		if (!MODES.includes(mode)) return res.status(400).json({ success: false, message: 'Invalid mode' });
		const self = body.self_rating ? (String(body.self_rating) as SelfRating) : undefined;
		if (self && !SELF_RATING[self]) return res.status(400).json({ success: false, message: 'Invalid rating' });
		const ms = Math.min(600000, Math.max(0, Math.round(Number(body.ms) || 0)));
		const clipId = UUID_RE.test(String(body.clip_id || '')) ? String(body.clip_id) : null;
		const situationIndex = Number.isInteger(body.situation_index) && body.situation_index >= 0 && body.situation_index < 50 ? body.situation_index : null;
		try {
			const row = await database('phrase_progress').where({ user_id: userId, phrase_id: phraseId }).first();
			if (!row) return res.status(404).json({ success: false, message: 'Not in your phrases' });
			const grade = ratingOf(mode, { correct: body.correct === true, self_rating: self, ms });
			const correct = grade !== Rating.Again;
			const today = todayKey();
			const next = levelAfter(row.level, mode, grade, jsonList(row.reflex_days), mode === 'reflex' ? situationIndex : null, today);
			const card = schedule(row, grade);
			// One XP reward per phrase and day (answering the same due phrase twice does not pay twice)
			const paidToday = correct && await database('phrase_review_logs')
				.where({ user_id: userId, phrase_id: phraseId, correct: true })
				.whereNot('mode', 'lesson')
				.whereRaw(`(date_created AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date`)
				.first('id');
			await database('phrase_progress').where('id', row.id).update({
				level: next.level,
				reflex_days: JSON.stringify(next.reflexDays),
				...cardColumns(card),
				date_updated: database.fn.now(),
			});
			await database('phrase_review_logs').insert({
				user_id: userId,
				phrase_id: phraseId,
				mode,
				rating: grade,
				correct,
				ms: ms || null,
				level_before: row.level,
				level_after: next.level,
				clip_id: clipId,
				situation_index: situationIndex,
			});
			return res.json({
				success: true,
				data: {
					correct,
					level_before: row.level,
					level_after: next.level,
					next_in_days: daysUntil(card.due),
					xp: correct && !paidToday ? PHRASE_XP.review : 0,
				},
			});
		} catch (error) {
			return fail(res, 'Save review', error);
		}
	});

	// ── My phrase bank ────────────────────────────────────────────────────
	router.get('/me/phrases', async (req: any, res: any) => {
		const userId = needUser(req, res);
		if (!userId) return;
		try {
			const locale = localeOf(req);
			const [rows, speed] = await Promise.all([
				database('phrase_progress as pp')
					.join('phrases as p', 'p.id', 'pp.phrase_id')
					.join('phrase_types as t', 't.id', 'p.type_id')
					.leftJoin('phrases_translations as tr', 'tr.phrases_id', 'p.id')
					.select('p.id', 'p.slug', 'p.text', 't.slug as type_slug', 'pp.level', 'pp.due', 'pp.learned_at', 'tr.languages_code', 'tr.meaning')
					.where('pp.user_id', userId)
					.orderBy('pp.learned_at', 'desc'),
				// Average time to a right reflex answer, per week (last 8 weeks)
				database.raw(`
					SELECT to_char(date_trunc('week', date_created AT TIME ZONE '${TZ}'), 'YYYY-MM-DD') AS week,
						ROUND(AVG(ms))::int AS ms, COUNT(*)::int AS answers
					FROM phrase_review_logs
					WHERE user_id = ? AND mode = 'reflex' AND correct AND ms > 0 AND ms < 60000
						AND date_created >= now() - interval '8 weeks'
					GROUP BY 1 ORDER BY 1
				`, [userId]),
			]);
			const byId = new Map<string, any>();
			for (const r of rows) {
				if (!byId.has(r.id)) byId.set(r.id, { id: r.id, slug: r.slug, text: r.text, type_slug: r.type_slug, level: r.level, due: r.due, learned_at: r.learned_at, tr: [] });
				if (r.languages_code) byId.get(r.id).tr.push({ languages_code: r.languages_code, meaning: r.meaning });
			}
			const phrases = [...byId.values()].map(({ tr, ...p }) => ({ ...p, meaning: pickTranslation(tr, locale)?.meaning || '' }));
			const levels = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<number, number>;
			for (const p of phrases) levels[p.level] = (levels[p.level] || 0) + 1;
			const now = Date.now();
			return res.json({
				success: true,
				data: {
					phrases,
					levels,
					due: phrases.filter((p) => new Date(p.due).getTime() <= now).length,
					reflex_speed: (speed.rows || []).map((r: any) => ({ week: r.week, ms: Number(r.ms) || 0, answers: Number(r.answers) || 0 })),
				},
			});
		} catch (error) {
			return fail(res, 'Load my phrases', error);
		}
	});
}
