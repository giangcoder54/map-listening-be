/**
 * Runs and Xu (lib/runs.ts, lib/review.ts, lib/coins.ts, database/migrations/2026-11-02_rule_flow.sql).
 *
 *   POST /listening-lab/lessons/:key/runs     start or resume a lesson   body: { anonymous_id?, restart? }
 *   POST /listening-lab/lessons/:key/test     skip-ahead test of one lesson (signed in)
 *   POST /listening-lab/skills/:slug/test     the rule's test: skip it (Premium), or its final test
 *                                             once every lesson is done. One go a day, then Xu.
 *                                             body: { pay? }
 *   GET  /listening-lab/review                forms due for review, what is left today
 *   POST /listening-lab/review/runs           start or resume a review
 *   GET  /listening-lab/runs/:id              a run as the page plays it
 *   POST /listening-lab/runs/:id/answer       answer the current item: the server checks it
 *                                             body: { position, answer, listens, slow, hint, time_ms, anonymous_id? }
 *   POST /listening-lab/runs/:id/finish       every item answered: progress, review cards, XP and Xu
 *   GET  /listening-lab/wallet                Xu, freezes, unlocks left this week, prices
 *   POST /listening-lab/lessons/:key/unlock   buy a locked lesson with Xu (kept for good)
 *   POST /listening-lab/wallet/freeze         buy a streak freeze with Xu
 *
 * Tests and reviews are drawn for each learner and each go from the pools the team wrote:
 * different items, the same rules (lib/runs.ts drawTest, drawReview). Guests play lessons
 * only (learner key a:<anonymous_id>); tests and reviews keep progress, so they need an account.
 */
import { UUID_RE, answerOf, loadLessonGraph, type LessonGraph, type LessonRow } from '../lib/lessons';
import {
	LESSON_TEST, MAX_LISTENS, acceptOf, choicesFor, drawLesson, drawMixed, drawReview, drawTest, fitsLesson, fitsMixed, focusFits, isRight, triesFor, passed,
	practiceOf, reviewOfValue, summaryOf, targetOf,
	tilesFor, weakestForms, withRetry, type PoolClip, type RunItem,
} from '../lib/runs';
import { REVIEW, gradeOf, masteryOf, schedule, cardColumns } from '../lib/review';
import { COIN, CoinError, buyFreeze, earnCoins, payRetest, streakDayXu, unlockLesson, walletOf, type CoinReason } from '../lib/coins';
import { MAX_FREEZES, goalRunOf, grantRewards, lessonXp, recordPractice, vnDay, DEFAULT_GOAL } from '../lib/xp';
import { mixUps } from '../lib/mixups';
import { mistakeOf, type Mistake } from '../lib/mistakes';
import { normalizeAnswer } from './engagementRoutes';
import { subsOf } from '../lib/subs';
import { CHALLENGE, beatsOf, cachedItemStats, challengeItems, lastClosedWeek, loadChallenges, priceOf, scoreOf, stateOf, withLessons, type ChallengeRow } from '../lib/challenges';
import { unlockBankVideo, unlockChallenge } from '../lib/coins';
import { BANK, bankFormat, bankPrice, bankWrong, loadBankItems, type BankItem } from '../lib/bank';
import { isPremiumUser } from '../lib/premium';
import { clipOut, lessonTranslations, readClips, registerLearner, wrongOf } from './lessonRoutes';

const ANON_ID_RE = /^[A-Za-z0-9-]{16,64}$/;
const badKey = (key: string) => !key || key.length > 64;
type Mode = 'learn' | 'lesson_test' | 'skill_test' | 'review' | 'challenge' | 'bank';

function learnerOf(req: any) {
	const userId: string | null = req.accountability?.user ?? null;
	const raw = req.body?.anonymous_id ?? req.query?.anonymous_id;
	const anonymousId = typeof raw === 'string' && ANON_ID_RE.test(raw) ? raw : null;
	const key = userId ? `u:${userId}` : anonymousId ? `a:${anonymousId}` : null;
	return { userId, anonymousId, key };
}

/** A lesson's clips as drawing sees them, and the payload the page plays */
async function poolOf(database: any, g: LessonGraph, lesson: LessonRow, answerMode?: 'per_clip' | 'one_answer', fallbackWrong: (target: string) => string[] = mixUps) {
	const rows = await readClips(database, [lesson.id]);
	// A challenge round is not on the path (not in the graph): its group's answer mode is passed in
	const group = answerMode ? { answer_mode: answerMode } : g.groupOf(lesson);
	const byId = new Map<string, { row: any; clip: PoolClip }>();
	rows.forEach((r: any) => {
		const answer = answerOf(r, lesson.text, group.answer_mode);
		const focus = String(r.focus_text || '').trim() || null;
		// The clip's own wrong answers, else ones made from the words heard one for another
		const own = wrongOf(r);
		const wrong = own.length ? own : fallbackWrong(targetOf({ answer, focus }));
		byId.set(r.id, {
			row: r,
			clip: {
				id: r.id, role: r.role, answer, focus,
				difficulty: r.difficulty ?? null,
				forced: r.answer_format || null,
				hasChoices: wrong.length > 0,
				wrong,
			},
		});
	});
	const payload = (item: RunItem, index: number) => {
		const hit = byId.get(item.clip_id);
		if (!hit) return null;
		const { row, clip } = hit;
		const base = clipOut(row, lesson.text, group.answer_mode, true);
		// A step the team wrote brings its own wrong choices / tiles; else the clip's
		const wrong = item.wrong?.length ? item.wrong : clip.wrong || [];
		const choices = item.format === 'choice' ? choicesFor(clip, wrong) : null;
		// A choice with nothing to choose from (a run drawn when choices were borrowed from other
		// clips, or wrong choices removed since): typed instead. The check asks for the same words.
		const format = item.format === 'choice' && !choices ? (focusFits(clip) ? 'gap' : 'type') : item.format;
		return {
			index,
			phase: item.phase,
			format,
			result: item.result || null,
			tries: item.tries || 0,
			clip: {
				...base,
				format,
				choices,
				tiles: format === 'bank' ? tilesFor(clip, wrong) : null,
				focus: clip.focus,
			},
		};
	};
	return { lesson, byId, clips: [...byId.values()].map((x) => x.clip), payload };
}
type Pool = Awaited<ReturnType<typeof poolOf>>;

/** Pools of several lessons (tests of a rule, reviews), loaded once each */
async function poolsOf(database: any, g: LessonGraph, lessonIds: string[]) {
	const out = new Map<string, Pool>();
	for (const id of new Set(lessonIds)) {
		const lesson = g.lessonById.get(id);
		if (lesson) out.set(id, await poolOf(database, g, lesson));
	}
	return out;
}

/**
 * A clip to hear next to the one just answered, from the same lesson: after a trap, the rule
 * itself (the core clip first); after a missed item, one of the lesson's traps. Hearing the two
 * one after the other shows the difference better than any words. null when there is none,
 * and never a clip the run still has to ask (`upcoming`).
 */
async function contrastOf(database: any, clipRow: any, trap: boolean, upcoming: string[] = []) {
	const row = await database('listening_clips as c')
		.join('source_videos as sv', 'sv.id', 'c.source_video_id')
		.select('c.id', 'c.role', 'c.transcript', 'c.start_time', 'c.end_time', 'c.playback_rate', 'sv.youtube_video_id', 'sv.thumbnail_url')
		.where({ 'c.lesson_id': clipRow.lesson_id, 'c.status': 'published' })
		.whereIn('c.role', trap ? ['core', 'pool'] : ['trap'])
		.whereNot('c.id', clipRow.id)
		// A clip still to come in this run would be heard, and read, before it is asked
		.whereNotIn('c.id', upcoming)
		.whereNotNull('c.start_time').whereNotNull('c.end_time').whereNotNull('sv.youtube_video_id')
		.orderByRaw(`CASE c.role WHEN 'core' THEN 0 ELSE 1 END, random()`)
		.first();
	if (!row) return null;
	const transcript = String(row.transcript || '').replace(/\s+/g, ' ').trim();
	return {
		id: row.id,
		trap: row.role === 'trap',
		/** The line said, the part with the rule in [brackets] */
		transcript: transcript || null,
		start_time: Number(row.start_time),
		end_time: Number(row.end_time),
		rate: Number(row.playback_rate) || null,
		video: { youtube_video_id: row.youtube_video_id, thumbnail_url: row.thumbnail_url },
	};
}

/** A challenge round's lesson, read directly (it is off the path), and its group's answer mode */
async function challengeLessonOf(database: any, lessonId: string) {
	const row = await database('listening_lessons as l')
		.join('listening_skills as s', 's.id', 'l.skill_id')
		.join('listening_groups as gr', 'gr.id', 's.group_id')
		.select('l.id', 'l.skill_id', 'l.short_id', 'l.text', 'l.difficulty', 'l.is_premium', 'l.sort', 'l.kind', 'gr.answer_mode')
		.where('l.id', lessonId).first();
	if (!row) return null;
	const { answer_mode, ...lesson } = row;
	return { lesson: lesson as LessonRow, answerMode: (answer_mode === 'per_clip' ? 'per_clip' : 'one_answer') as 'per_clip' | 'one_answer' };
}

/**
 * Pools of the lessons the items of a challenge or a bank run come from (their clips may be
 * from any lesson, a past challenge's included, so the path's graph is not used)
 */
async function pickedPools(database: any, g: LessonGraph, items: RunItem[], fallbackLessonId?: string | null) {
	const out = new Map<string, Pool>();
	for (const id of new Set(items.map((it) => it.lesson_id || fallbackLessonId).filter(Boolean) as string[])) {
		const found = await challengeLessonOf(database, id);
		if (found) out.set(id, await poolOf(database, g, found.lesson, found.answerMode, bankWrong));
	}
	return out;
}

/** Every item of a finished challenge or bank run, now with its answer; `pct`: how many others got it right */
function reviewOfRun(items: RunItem[], pools: Map<string, Pool>, fallbackLessonId: string | null, stats: Record<string, number> = {}) {
	return items.flatMap((it, i) => {
		const pool = pools.get(it.lesson_id || fallbackLessonId || '');
		const shown = pool?.payload(it, i);
		const hit = pool?.byId.get(it.clip_id);
		if (!shown || !hit) return [];
		return [{
			index: i, format: it.format, correct: !!it.result?.correct, given: it.result?.answer ?? '',
			expected: it.format === 'type' ? hit.clip.answer : targetOf(hit.clip),
			pct: stats[it.clip_id] ?? null, clip: shown.clip,
		}];
	});
}

/** The run as the page plays it. Every item keeps its index, whatever the page skips. */
async function runOut(database: any, g: LessonGraph, run: any) {
	const items: RunItem[] = run.items || [];
	let pools: Map<string, Pool>;
	let challenge: ChallengeRow | null = null;
	let video: { short_id: string; title: string } | null = null;
	if (run.mode === 'challenge' || run.mode === 'bank') {
		pools = await pickedPools(database, g, items, run.lesson_id);
		if (run.mode === 'challenge') challenge = run.challenge_id ? (await loadChallenges(database, { id: run.challenge_id }))[0] || null : null;
		else {
			const p = run.practice_id ? await database('practice_videos').select('short_id', 'title').where('id', run.practice_id).first() : null;
			video = p ? { short_id: p.short_id, title: p.title } : null;
		}
	} else pools = await poolsOf(database, g, items.map((it) => it.lesson_id || run.lesson_id));
	const lesson = run.lesson_id ? g.lessonById.get(run.lesson_id) : null;
	const skill = run.skill_id ? g.skillById.get(run.skill_id) : null;
	// A lesson's practice steps may carry their own question: read live, so an edit shows at once
	const prompts = new Map<string, string>();
	if (run.mode === 'learn' && run.lesson_id) {
		const written = await database('listening_lessons').select('practice').where('id', run.lesson_id).first();
		for (const s of practiceOf(written?.practice)) if (s.prompt) prompts.set(s.clip_id, s.prompt);
	}
	return {
		id: run.id,
		mode: run.mode as Mode,
		status: run.status,
		position: Number(run.position) || 0,
		max_listens: challenge ? challenge.max_listens : MAX_LISTENS[run.mode] || 3,
		bank: video,
		challenge: challenge ? { short_id: challenge.short_id, week: challenge.week, title: { vi: challenge.title_vi, en: challenge.title_en } } : null,
		lesson: lesson ? { short_id: lesson.short_id, number: g.numberOf(lesson) } : null,
		skill: skill ? { slug: skill.slug, name: skill.name } : null,
		items: items.map((it, i) => {
			const out = pools.get(it.lesson_id || run.lesson_id)?.payload(it, i);
			// lesson_id: where a "report a problem" on the item is filed (reviews and tests mix lessons)
			// The question of a practice step, and of its retry (same clip)
			const prompt = it.phase === 'practice' || it.phase === 'retry' ? prompts.get(it.clip_id) || null : null;
			// A challenge keeps right / wrong for the end
			if (out && run.mode === 'challenge' && run.status === 'active') {
				if (out.result) out.result = { answered: true } as any;
				// The explanations and "sounds like" give the answers away: sent with the result
				Object.assign(out.clip, { translations: null, sounds_like: null });
			}
			return out ? { ...out, lesson_id: it.lesson_id || run.lesson_id, hearts: triesFor(run.mode, out.format, it.phase), prompt } : null;
		}).filter(Boolean),
	};
}

export function registerRunRoutes(router: any, context: any) {
	const { database, logger } = context;
	const fail = (res: any, what: string, error: any) => {
		logger?.error?.(`[runs] ${what} failed: ${String(error)}`);
		return res.status(500).json({ success: false, message: 'Server error' });
	};
	const coinFail = (res: any, e: CoinError) => {
		const status = e.code === 'NOT_ENOUGH' || e.code === 'MAX_FREEZES' ? 402 : 409;
		return res.status(status).json({ success: false, code: e.code });
	};

	/** The run, locked for this transaction; null when it is not this learner's */
	async function loadRun(req: any, trx: any = database) {
		const id = String(req.params.id || '');
		if (!UUID_RE.test(id)) return null;
		const { key } = learnerOf(req);
		const run = await trx('listening_runs').where('id', id).forUpdate().first();
		if (!run || !key || run.learner_key !== key) return null;
		return run;
	}

	/** Clips this learner answered before, among `ids` (drawing puts them last) */
	async function metOf(userId: string | null, ids: string[]) {
		const met = new Set<string>();
		if (!userId || !ids.length) return met;
		const rows = await database('listening_attempts').distinct('clip_id').where('user_id', userId).whereIn('clip_id', ids);
		for (const r of rows) met.add(r.clip_id);
		return met;
	}

	/** The active run of this learner for a mode and lesson / rule, or a new one with `draw()` items */
	async function openRun(
		learner: ReturnType<typeof learnerOf>,
		mode: Mode,
		where: { lesson_id?: string | null; skill_id?: string | null },
		draw: () => RunItem[] | Promise<RunItem[]>,
		opts: { restart?: boolean; valid?: (items: RunItem[]) => boolean; extra?: Record<string, unknown>; match?: Record<string, unknown> } = {},
	) {
		return database.transaction(async (trx: any) => {
			const q = trx('listening_runs').where({ learner_key: learner.key, mode, status: 'active' });
			if (where.lesson_id !== undefined) q.where('lesson_id', where.lesson_id);
			if (where.skill_id !== undefined) q.where('skill_id', where.skill_id);
			if (opts.match) q.where(opts.match);
			const active = await q.orderBy('started_at', 'desc').forUpdate().first();
			const stale = active && opts.valid && !opts.valid(active.items || []);
			if (active && !opts.restart && !stale) return active;
			if (active) await trx('listening_runs').where('id', active.id).update({ status: 'abandoned', date_updated: trx.fn.now() });
			const items = await draw();
			if (!items.length) return null;
			const [row] = await trx('listening_runs').insert({
				user_id: learner.userId, learner_key: learner.key, mode,
				skill_id: where.skill_id ?? null, lesson_id: where.lesson_id ?? null, items: JSON.stringify(items), ...(opts.extra || {}),
			}).returning('*');
			return row;
		});
	}

	// ── A lesson ──────────────────────────────────────────────────────────
	router.post('/listening-lab/lessons/:key/runs', async (req: any, res: any) => {
		const lessonKey = String(req.params.key || '');
		if (badKey(lessonKey)) return res.status(400).json({ success: false, message: 'Invalid lesson key' });
		const learner = learnerOf(req);
		if (!learner.key) return res.status(400).json({ success: false, message: 'anonymous_id needed' });
		try {
			const g = await loadLessonGraph(req, context);
			const lesson = g.findLesson(lessonKey);
			if (!lesson) return res.status(404).json({ success: false, message: 'Lesson not found' });
			if (g.isLocked(lesson)) {
				return res.status(403).json({ success: false, code: 'PREMIUM_REQUIRED', price: COIN.unlock[lesson.kind || 'pattern'] ?? COIN.unlock.pattern });
			}
			const ruleBy = g.ruleLockedBy(g.skillOf(lesson));
			if (ruleBy) return res.status(403).json({ success: false, code: 'RULE_LOCKED', by: { name: ruleBy.name, slug: ruleBy.slug } });
			if (g.isOrderLocked(lesson)) return res.status(403).json({ success: false, code: 'ORDER_LOCKED' });
			const pool = await poolOf(database, g, lesson);
			const written = await database('listening_lessons').select('practice', 'review_of', 'practice_shuffle').where('id', lesson.id).first();
			// A review lesson: the pool clips of the lessons it reviews (published ones), mixed
			const reviewed = lesson.kind === 'mixed' ? reviewOfValue(written?.review_of).filter((id) => id !== lesson.id && g.lessonById.has(id)) : [];
			if (reviewed.length) {
				const pools = await poolsOf(database, g, reviewed);
				const forms = [...pools.values()].map((p) => ({ lessonId: p.lesson.id, clips: p.clips }));
				const ids = [...pool.byId.keys(), ...forms.flatMap((f) => f.clips.map((c) => c.id))];
				const has = (clipId: string, lessonId?: string) => (lessonId ? !!pools.get(lessonId)?.byId.has(clipId) : pool.byId.has(clipId));
				// The steps the team set, those whose clip is still there (unpublished since: left out)
				const known = new Set(ids);
				const script = practiceOf(written?.practice).filter((s) => known.has(s.clip_id));
				// Clips the lessons reviewed use in their practice come last: heard there already
				const practiced = new Set((await database('listening_lessons').select('practice').whereIn('id', reviewed))
					.flatMap((r: any) => practiceOf(r.practice).map((s) => s.clip_id)));
				const run = await openRun(learner, 'learn', { lesson_id: lesson.id, skill_id: lesson.skill_id },
					async () => drawMixed(forms, pool.clips, await metOf(learner.userId, ids), Math.random, script, practiced),
					{ restart: !!req.body?.restart, valid: (items) => fitsMixed(items, has, script) });
				if (!run) return res.status(409).json({ success: false, code: 'EMPTY_LESSON', message: 'This lesson has no clip to play yet' });
				return res.json({ success: true, data: await runOut(database, g, run) });
			}
			const script = practiceOf(written?.practice);
			const shuffled = !!written?.practice_shuffle;
			// A run left halfway is taken up again, unless the lesson changed since: then it starts over
			const run = await openRun(learner, 'learn', { lesson_id: lesson.id, skill_id: lesson.skill_id },
				async () => drawLesson(pool.clips, await metOf(learner.userId, [...pool.byId.keys()]), Math.random, script, { shuffle: shuffled }),
				{ restart: !!req.body?.restart, valid: (items) => fitsLesson(items, script, (id) => pool.byId.has(id), shuffled) });
			if (!run) return res.status(409).json({ success: false, code: 'EMPTY_LESSON', message: 'This lesson has no clip to play yet' });
			return res.json({ success: true, data: await runOut(database, g, run) });
		} catch (error) {
			return fail(res, 'Start run', error);
		}
	});

	// ── Skip-ahead test of one lesson ─────────────────────────────────────
	router.post('/listening-lab/lessons/:key/test', async (req: any, res: any) => {
		const lessonKey = String(req.params.key || '');
		if (badKey(lessonKey)) return res.status(400).json({ success: false, message: 'Invalid lesson key' });
		const learner = learnerOf(req);
		if (!learner.userId) return res.status(401).json({ success: false, code: 'LOGIN_REQUIRED' });
		try {
			const g = await loadLessonGraph(req, context);
			const lesson = g.findLesson(lessonKey);
			if (!lesson) return res.status(404).json({ success: false, message: 'Lesson not found' });
			if (g.isLocked(lesson)) return res.status(403).json({ success: false, code: 'PREMIUM_REQUIRED' });
			// A lesson's test skips that lesson, not the rules before it
			const ruleBy = g.ruleLockedBy(g.skillOf(lesson));
			if (ruleBy) return res.status(403).json({ success: false, code: 'RULE_LOCKED', by: { name: ruleBy.name, slug: ruleBy.slug } });
			const pool = await poolOf(database, g, lesson);
			// A review lesson is skipped by a test on the lessons it reviews
			const written = await database('listening_lessons').select('review_of', 'trap_draw').where('id', lesson.id).first();
			const reviewed = lesson.kind === 'mixed' ? reviewOfValue(written?.review_of).filter((id) => id !== lesson.id && g.lessonById.has(id)) : [];
			const pools = reviewed.length ? await poolsOf(database, g, reviewed) : new Map([[lesson.id, pool]]);
			const forms = [...pools.values()].map((p) => ({ lessonId: p.lesson.id, clips: p.clips }));
			const ids = forms.flatMap((f) => f.clips.map((c) => c.id));
			// The traps the team wants in this lesson's test (trap_draw, 1 by default)
			const traps = written?.trap_draw == null ? 1 : Math.max(0, Math.min(3, Number(written.trap_draw) || 0));
			const run = await openRun(learner, 'lesson_test', { lesson_id: lesson.id, skill_id: lesson.skill_id },
				async () => drawTest(forms, LESSON_TEST.size, await metOf(learner.userId, ids), Math.random, traps),
				{ valid: (items) => items.every((it) => !!pools.get(it.lesson_id || lesson.id)?.byId.has(it.clip_id)) });
			if (!run) return res.status(409).json({ success: false, code: 'EMPTY_LESSON' });
			return res.json({ success: true, data: await runOut(database, g, run) });
		} catch (error) {
			return fail(res, 'Start lesson test', error);
		}
	});

	// ── The rule's test: skip it, or its final test ───────────────────────
	router.post('/listening-lab/skills/:slug/test', async (req: any, res: any) => {
		const slug = String(req.params.slug || '');
		if (badKey(slug)) return res.status(400).json({ success: false, message: 'Invalid skill' });
		const learner = learnerOf(req);
		if (!learner.userId) return res.status(401).json({ success: false, code: 'LOGIN_REQUIRED' });
		try {
			const g = await loadLessonGraph(req, context);
			const skill = g.skills.find((s) => s.slug === slug);
			if (!skill) return res.status(404).json({ success: false, message: 'Skill not found' });
			const open = (g.lessonsBySkill.get(skill.id) || []).filter((l) => !g.isLocked(l));
			if (!open.length) return res.status(403).json({ success: false, code: 'PREMIUM_REQUIRED' });
			// Skipping a rule is Premium; everyone takes the final test once every lesson is done
			const allDone = open.every((l) => g.done.has(l.id));
			if (!g.premium && !allDone) return res.status(403).json({ success: false, code: 'FINISH_LESSONS_FIRST' });
			// Premium skips a rule wherever it is on the path; a free learner's rule waits its turn
			const ruleBy = g.ruleLockedBy(skill);
			if (ruleBy && !g.premium) return res.status(403).json({ success: false, code: 'RULE_LOCKED', by: { name: ruleBy.name, slug: ruleBy.slug } });

			const today = vnDay();
			const active = await database('listening_runs').where({ user_id: learner.userId, mode: 'skill_test', skill_id: skill.id, status: 'active' }).first('id');
			if (!active) {
				// One go a day is free; another costs Xu
				const dayStart = (await database.raw(`SELECT (?::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') AS t`, [today])).rows[0].t;
				const goes = Number((await database('listening_runs')
					.where({ user_id: learner.userId, mode: 'skill_test', skill_id: skill.id }).where('started_at', '>=', dayStart)
					.count('* as n').first())?.n) || 0;
				if (goes > 0) {
					if (!req.body?.pay) return res.status(402).json({ success: false, code: 'RETEST_COSTS', price: COIN.retest });
					await payRetest(database, learner.userId, skill.id, goes, today);
				}
			}

			const settings = await database('listening_skills').select('test_size').where('id', skill.id).first();
			const pools = await poolsOf(database, g, open.map((l) => l.id));
			const allIds = [...pools.values()].flatMap((p) => [...p.byId.keys()]);
			const run = await openRun(learner, 'skill_test', { skill_id: skill.id, lesson_id: null },
				async () => drawTest([...pools.values()].map((p) => ({ lessonId: p.lesson.id, clips: p.clips })), Number(settings?.test_size) || 8, await metOf(learner.userId, allIds)));
			if (!run) return res.status(409).json({ success: false, code: 'EMPTY_LESSON' });
			return res.json({ success: true, data: await runOut(database, g, run) });
		} catch (error) {
			if (error instanceof CoinError) return coinFail(res, error);
			return fail(res, 'Start skill test', error);
		}
	});

	// ── Review ────────────────────────────────────────────────────────────
	/** Forms due for this learner that they can still open, most overdue first */
	async function dueForms(g: LessonGraph, userId: string) {
		const rows = await database('listening_review_cards').select('lesson_id', 'due').where('user_id', userId).where('due', '<=', database.fn.now()).orderBy('due');
		const open = rows.filter((r: any) => { const l = g.lessonById.get(r.lesson_id); return l && !g.isLocked(l); });
		const locked = rows.length - open.length;
		return { open: open.map((r: any) => r.lesson_id as string) as string[], locked };
	}
	async function reviewsToday(userId: string) {
		const row = await database('user_daily_stats').select('reviews').where({ user_id: userId, day: vnDay() }).first();
		return Number(row?.reviews) || 0;
	}

	router.get('/listening-lab/review', async (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		if (!userId) return res.status(401).json({ success: false, code: 'LOGIN_REQUIRED' });
		try {
			const g = await loadLessonGraph(req, context);
			const [due, done, next] = await Promise.all([
				dueForms(g, userId),
				reviewsToday(userId),
				database('listening_review_cards').where('user_id', userId).where('due', '>', database.fn.now()).min('due as d').first(),
			]);
			const left = g.premium ? REVIEW.session : Math.max(0, REVIEW.free - done);
			const active = await database('listening_runs').where({ user_id: userId, mode: 'review', status: 'active' }).first('id');
			return res.json({
				success: true,
				data: {
					due: due.open.length,
					// Forms of lessons no longer open (Premium ended): they wait for it
					locked: due.locked,
					premium: g.premium,
					done_today: done,
					left_today: left,
					free_per_day: REVIEW.free,
					next_due: next?.d || null,
					resume: !!active,
				},
			});
		} catch (error) {
			return fail(res, 'Review summary', error);
		}
	});

	router.post('/listening-lab/review/runs', async (req: any, res: any) => {
		const learner = learnerOf(req);
		if (!learner.userId) return res.status(401).json({ success: false, code: 'LOGIN_REQUIRED' });
		try {
			const g = await loadLessonGraph(req, context);
			const due = await dueForms(g, learner.userId);
			const left = g.premium ? REVIEW.session : Math.max(0, REVIEW.free - (await reviewsToday(learner.userId)));
			const active = await database('listening_runs').where({ user_id: learner.userId, mode: 'review', status: 'active' }).first('id');
			if (!active && !left) return res.status(402).json({ success: false, code: 'REVIEW_LIMIT', free_per_day: REVIEW.free });
			const ids = due.open.slice(0, left || REVIEW.session);
			const pools = await poolsOf(database, g, ids);
			const run = await openRun(learner, 'review', { lesson_id: null, skill_id: null },
				async () => drawReview(ids.filter((id: string) => pools.has(id)).map((id: string) => ({ lessonId: id, clips: pools.get(id)!.clips })), left,
					await metOf(learner.userId, [...pools.values()].flatMap((p) => [...p.byId.keys()]))));
			if (!run) return res.status(409).json({ success: false, code: 'NOTHING_DUE' });
			return res.json({ success: true, data: await runOut(database, g, run) });
		} catch (error) {
			return fail(res, 'Start review', error);
		}
	});

	// ── A run ─────────────────────────────────────────────────────────────
	router.get('/listening-lab/runs/:id', async (req: any, res: any) => {
		try {
			const run = await loadRun(req);
			if (!run) return res.status(404).json({ success: false, message: 'Run not found' });
			const g = await loadLessonGraph(req, context);
			return res.json({ success: true, data: await runOut(database, g, run) });
		} catch (error) {
			return fail(res, 'Load run', error);
		}
	});

	router.post('/listening-lab/runs/:id/answer', async (req: any, res: any) => {
		const body = req.body || {};
		const learner = learnerOf(req);
		try {
			const out = await database.transaction(async (trx: any) => {
				const run = await loadRun(req, trx);
				if (!run) return { status: 404 as const };
				if (run.status !== 'active') return { status: 409 as const, code: 'RUN_CLOSED' };
				let items: RunItem[] = run.items || [];
				const position = Number(run.position) || 0;
				if (Number(body.position) !== position || !items[position] || items[position]!.result) {
					return { status: 409 as const, code: 'STALE_POSITION', position };
				}
				const item = items[position]!;
				const lessonId = item.lesson_id || run.lesson_id;
				const lessonRow = await trx('listening_lessons as l')
					.join('listening_skills as s', 's.id', 'l.skill_id')
					.join('listening_groups as g', 'g.id', 's.group_id')
					.select('l.id', 'l.text', 'g.answer_mode').where('l.id', lessonId).first();
				const clipRow = await trx('listening_clips').where('id', item.clip_id).first();
				if (!lessonRow || !clipRow) return { status: 409 as const, code: 'CLIP_GONE' };

				const answer = answerOf(clipRow, lessonRow.text, lessonRow.answer_mode);
				const clip: PoolClip = {
					id: clipRow.id, role: clipRow.role, answer, focus: String(clipRow.focus_text || '').trim() || null,
					difficulty: clipRow.difficulty, forced: clipRow.answer_format, hasChoices: true,
					accept: acceptOf(clipRow.accept_also),
				};
				const given = String(body.answer ?? '').slice(0, 255);
				const hint = body.hint === true;
				const correct = !hint && isRight(clip, item.format, given);
				const trap = clipRow.role === 'trap';
				// What a wrong answer says about what was heard; a line the team wrote for that wrong choice wins
				let mistake: Mistake | null = null;
				if (!correct && !hint) {
					let why: Record<string, string> = {};
					if (run.mode === 'learn' && run.lesson_id && (item.phase === 'practice' || item.phase === 'retry')) {
						const written = await trx('listening_lessons').select('practice').where('id', run.lesson_id).first();
						why = practiceOf(written?.practice).find((s) => s.clip_id === item.clip_id)?.why || {};
					}
					mistake = mistakeOf(item.format === 'type' ? answer : targetOf(clip), given, why);
				}
				const listens = Math.max(1, Math.min(20, Math.round(Number(body.listens) || 1)));
				const timeMs = Number.isFinite(body.time_ms) ? Math.max(0, Math.min(3_600_000, Math.round(body.time_ms))) : null;
				// A wrong typed answer with a heart left: tried again, the answer not shown yet
				const tries = (Number(item.tries) || 0) + 1;
				const again = !correct && !hint && tries < triesFor(run.mode, item.format, item.phase);
				const attempt = (final: boolean) => learner.userId && trx('listening_attempts').insert({
					id: trx.raw('gen_random_uuid()'), user_id: learner.userId, clip_id: item.clip_id, lesson_id: lessonId,
					answer: hint ? '[REVEALED]' : given, is_correct: correct, attempt_number: tries, listen_count: listens,
					mode: 'phrase', run_id: run.id, phase: item.phase, format: item.format,
					used_slow: body.slow === true, used_hint: hint && final,
					time_ms: timeMs,
					date_created: trx.fn.now(),
				});
				if (again) {
					items[position] = { ...item, tries };
					await trx('listening_runs').where('id', run.id).update({ items: JSON.stringify(items), date_updated: trx.fn.now() });
					await attempt(false);
					return {
						status: 200 as const, again: true, lessonId: lessonId as string, first: false,
						data: { correct: false, again: true, hearts: triesFor(run.mode, item.format, item.phase) - tries, position, total: items.length, mistake },
					};
				}
				items[position] = { ...item, tries: tries - 1, result: { correct, answer: given, listens, slow: body.slow === true, hint, time_ms: timeMs, mistake, trap } };
				const before = items.length;
				// A missed practice item comes back once; tests and reviews count every answer as given
				if (!correct && run.mode === 'learn') items = withRetry(items, position, focusFits(clip) ? 'gap' : 'type');

				await trx('listening_runs').where('id', run.id).update({
					items: JSON.stringify(items), position: position + 1, date_updated: trx.fn.now(),
				});
				if (learner.userId) {
					await attempt(true);
					if (run.mode === 'learn') {
						await trx.raw(`
							INSERT INTO listening_progress (user_id, lesson_id, status, last_run_id) VALUES (?, ?, 'in_progress', ?)
							ON CONFLICT (user_id, lesson_id) DO UPDATE SET last_run_id = EXCLUDED.last_run_id, date_updated = now()
						`, [learner.userId, run.lesson_id, run.id]);
					}
				}
				return {
					// The lesson learned (a review lesson's items come from the lessons it reviews)
					status: 200 as const, again: false, lessonId: (run.mode === 'learn' ? run.lesson_id : lessonId) as string, first: position === 0 && run.mode === 'learn',
					mode: run.mode as Mode, clipRow, clipLessonId: lessonId as string,
					upcoming: items.filter((it, i) => i > position && !it.result).map((it) => it.clip_id),
					// A miss about the rule (the focus words): another word misheard is not what a trap shows
					aboutRule: !mistake || !clip.focus || (() => {
						const focus = new Set(normalizeAnswer(clip.focus!).split(' '));
						return `${mistake.heard} ${mistake.said}`.split(/\s+/).some((w) => w && focus.has(normalizeAnswer(w)));
					})(),
					data: {
						correct,
						expected: answer,
						focus: clip.focus,
						trap,
						// Why the rule does not apply here: shown once a trap is answered
						trap_reason: trap ? { vi: String(clipRow.trap_reason_vi || '').trim() || null, en: String(clipRow.trap_reason_en || '').trim() || null } : null,
						mistake,
						position: position + 1,
						total: items.length,
						retry_added: items.length > before,
						done: position + 1 >= items.length,
					},
				};
			});
			if (out.status === 404) return res.status(404).json({ success: false, message: 'Run not found' });
			if (out.status === 409) return res.status(409).json({ success: false, code: out.code, position: (out as any).position });

			// A practice day (the streak); a learner counted once per lesson
			if (out.again) return res.json({ success: true, data: out.data });
			// A challenge says nothing until the end: right or wrong shows on the result screen
			if (out.mode === 'challenge') {
				if (learner.userId) {
					const won = await recordPractice(database, learner.userId, { attempts: 1 });
					await grantRewards(context, req.schema, learner.userId, won.rewards);
				}
				return res.json({ success: true, data: { hidden: true, position: out.data.position, total: out.data.total, done: out.data.done } });
			}
			let rewards: any[] = [];
			if (learner.userId) {
				const won = await recordPractice(database, learner.userId, { attempts: 1 });
				rewards = won.rewards;
				await grantRewards(context, req.schema, learner.userId, won.rewards);
			}
			if (out.first && learner.key) await registerLearner(database, out.lessonId, learner.userId, learner.anonymousId).catch(() => false);
			// A trap answered right in a lesson or a review: Xu at once, once per clip a day
			const coins = { added: 0, balance: null as number | null };
			const learning = out.mode === 'learn' || out.mode === 'review';
			if (learner.userId && learning && out.data.trap && out.data.correct) {
				const today = vnDay();
				// The first time ever pays most; the same clip again, once a day, pays a little
				let r = await earnCoins(database, learner.userId, { reason: 'trap', amount: COIN.earn.trap, dedupe: `trap:${out.clipRow.id}`, lessonId: out.clipLessonId }, today);
				if (!r.wanted) r = await earnCoins(database, learner.userId, { reason: 'trap', amount: COIN.earn.trapAgain, dedupe: `trap:${out.clipRow.id}:${today}`, lessonId: out.clipLessonId }, today);
				coins.added = r.added;
				coins.balance = r.coins;
			}
			// Another clip of the lesson to hear next to this one: a trap after a missed rule, the rule after a trap
			const contrast = learning && (out.data.trap || (!out.data.correct && out.aboutRule))
				? await contrastOf(database, out.clipRow, out.data.trap, out.upcoming)
				: null;
			// What the clip's lines mean, in the page's language (body.locale): shown now it is answered
			const subs = await subsOf(database, out.clipRow.id, body.locale).catch(() => null);
			return res.json({ success: true, data: { ...out.data, rewards, coins, contrast, subs } });
		} catch (error) {
			return fail(res, 'Answer', error);
		}
	});

	// ── Finish ────────────────────────────────────────────────────────────
	/** Lessons of a rule a learner has done or skipped, kept on their rule progress */
	const refreshSkillProgress = (trx: any, userId: string, skillId: string, patch: Record<string, any> = {}) => trx.raw(`
		INSERT INTO listening_skill_progress (user_id, skill_id, lessons_done, status, mastered_at, last_test_run_id, date_updated)
		SELECT ?, ?, COUNT(*), coalesce(?::varchar, 'learning'), ?::timestamptz, ?::uuid, now()
		FROM listening_progress p JOIN listening_lessons l ON l.id = p.lesson_id
		WHERE p.user_id = ? AND l.skill_id = ? AND p.status IN ('completed', 'tested_out')
		ON CONFLICT (user_id, skill_id) DO UPDATE SET
			lessons_done = EXCLUDED.lessons_done,
			status = CASE WHEN ?::varchar IS NULL THEN listening_skill_progress.status ELSE EXCLUDED.status END,
			mastered_at = coalesce(EXCLUDED.mastered_at, listening_skill_progress.mastered_at),
			last_test_run_id = coalesce(EXCLUDED.last_test_run_id, listening_skill_progress.last_test_run_id),
			date_updated = now()
	`, [userId, skillId, patch.status ?? null, patch.mastered_at ?? null, patch.last_test_run_id ?? null, userId, skillId, patch.status ?? null]);

	/** A lesson skipped by a test: tested out (a lesson already learned stays completed), reviewed in a week */
	const testOut = async (trx: any, userId: string, lessonId: string, runId: string) => {
		await trx.raw(`
			INSERT INTO listening_progress (user_id, lesson_id, status, completed_at, last_run_id, date_updated)
			VALUES (?, ?, 'tested_out', now(), ?, now())
			ON CONFLICT (user_id, lesson_id) DO UPDATE SET
				status = CASE WHEN listening_progress.status = 'completed' THEN 'completed' ELSE 'tested_out' END,
				completed_at = coalesce(listening_progress.completed_at, now()), last_run_id = EXCLUDED.last_run_id, date_updated = now()
		`, [userId, lessonId, runId]);
		await trx.raw(`
			INSERT INTO listening_review_cards (user_id, lesson_id, due, source) VALUES (?, ?, now() + (? || ' days')::interval, 'tested_out')
			ON CONFLICT (user_id, lesson_id) DO NOTHING
		`, [userId, lessonId, REVIEW.testedOutDays]);
	};

	router.post('/listening-lab/runs/:id/finish', async (req: any, res: any) => {
		const learner = learnerOf(req);
		try {
			const closed = await database.transaction(async (trx: any) => {
				const run = await loadRun(req, trx);
				if (!run) return { status: 404 as const };
				const summary = summaryOf(run.items || []);
				if (!summary.finished) return { status: 409 as const, code: 'NOT_FINISHED' };
				let ok = true;
				if (run.mode === 'lesson_test' || run.mode === 'skill_test') {
					const s = await trx('listening_skills').select('pass_ratio').where('id', run.skill_id).first();
					ok = passed(run.items, Number(s?.pass_ratio) || 0.8);
				}
				if (run.mode === 'challenge') {
					const c = await trx('listening_challenges').select('pass_score').where('id', run.challenge_id).first();
					ok = scoreOf(run.items || [], Number(c?.pass_score) || 7).passed;
				}
				const first = run.status === 'active';
				if (first) await trx('listening_runs').where('id', run.id).update({ status: 'finished', passed: ok, finished_at: trx.fn.now(), date_updated: trx.fn.now() });
				return { status: 200 as const, run, summary, first, ok: first ? ok : !!run.passed };
			});
			if (closed.status === 404) return res.status(404).json({ success: false, message: 'Run not found' });
			if (closed.status === 409) return res.status(409).json({ success: false, code: closed.code });
			const { run, summary } = closed;
			const mode = run.mode as Mode;
			if (mode === 'challenge') return res.json({ success: true, data: await finishChallenge(req, learner, run, closed.first) });
			if (mode === 'bank') return res.json({ success: true, data: await finishBank(req, learner, run, closed.first) });
			const items: RunItem[] = run.items || [];

			const xp = { total: 0, kind: null as string | null };
			const coins = { added: 0, missed: 0, balance: null as number | null };
			let rewards: any[] = [];
			const userId = learner.userId;
			const today = vnDay();
			const earn = async (reason: CoinReason, amount: number, dedupe: string, lessonId: string | null = null) => {
				if (!userId || amount <= 0) return null;
				const r = await earnCoins(database, userId, { reason, amount, dedupe, lessonId }, today);
				coins.added += r.added;
				if (r.wanted > r.added) coins.missed += r.wanted - r.added;
				coins.balance = r.coins;
				return r;
			};
			const addXp = async (won: { xp: number; rewards: any[]; kind?: string | null }, kind: string | null = null) => {
				xp.total += won.xp;
				xp.kind = won.kind ?? (won.xp ? kind : xp.kind);
				rewards = [...rewards, ...won.rewards];
				if (userId) await grantRewards(context, req.schema, userId, won.rewards);
			};

			if (userId && closed.first) {
				if (mode === 'learn') {
					await database.transaction(async (trx: any) => {
						await trx.raw(`
							INSERT INTO listening_progress (user_id, lesson_id, status, score, completed_at, last_run_id, date_updated)
							VALUES (?, ?, 'completed', ?, now(), ?, now())
							ON CONFLICT (user_id, lesson_id) DO UPDATE SET
								status = 'completed', score = EXCLUDED.score, last_run_id = EXCLUDED.last_run_id,
								completed_at = COALESCE(listening_progress.completed_at, EXCLUDED.completed_at), date_updated = now()
						`, [userId, run.lesson_id, summary.total ? Math.round((summary.right / summary.total) * 100) : null, run.id]);
						// First review of this form tomorrow; a form already in review keeps its schedule.
						// A review lesson teaches no form of its own: the forms it mixed keep theirs.
						if (!items.some((it) => it.lesson_id)) {
							await trx.raw(`
								INSERT INTO listening_review_cards (user_id, lesson_id, due, source) VALUES (?, ?, now() + interval '1 day', 'learned')
								ON CONFLICT (user_id, lesson_id) DO NOTHING
							`, [userId, run.lesson_id]);
						}
						await refreshSkillProgress(trx, userId, run.skill_id);
					});
					await addXp(await lessonXp(database, userId, run.lesson_id, summary.hinted, today));
					// Free lessons pay more than Premium ones: free is where Xu are earned
					const graph = await loadLessonGraph(req, context);
					const lessonRow = graph.lessonById.get(run.lesson_id);
					const paid = !!lessonRow && graph.isPremiumContent(lessonRow);
					const first = await earn('lesson', paid ? COIN.earn.lessonPremium : COIN.earn.lesson, `lesson:${run.lesson_id}`, run.lesson_id);
					if (summary.perfect) await earn('perfect', paid ? COIN.earn.perfectPremium : COIN.earn.perfect, `perfect:${run.lesson_id}`, run.lesson_id);
					// A lesson done again still pays, much less: the first go of the day, then a little for each
					if (first && !first.wanted) {
						const again = await earn('replay', COIN.earn.replay, `replay:${run.lesson_id}:${today}`, run.lesson_id);
						if (again && !again.wanted) await earn('replay', COIN.earn.replayLater, `replay:${run.lesson_id}:${today}:${run.id}`, run.lesson_id);
					}
				} else if (mode === 'lesson_test' && closed.ok) {
					await database.transaction(async (trx: any) => {
						await testOut(trx, userId, run.lesson_id, run.id);
						await refreshSkillProgress(trx, userId, run.skill_id);
					});
					await addXp(await recordPractice(database, userId, { xp: { reason: 'lesson_test', dedupe: `lesson_test:${run.lesson_id}`, lessonId: run.lesson_id } }, today), 'lesson_test');
				} else if (mode === 'skill_test' && closed.ok) {
					const g = await loadLessonGraph(req, context);
					const open = (g.lessonsBySkill.get(run.skill_id) || []).filter((l) => !g.isLocked(l));
					// Every lesson learned before: the final test makes the rule mastered; else it was skipped
					const learnedAll = open.every((l) => g.done.has(l.id) && !g.testedOut.has(l.id));
					await database.transaction(async (trx: any) => {
						for (const l of open) await testOut(trx, userId, l.id, run.id);
						await refreshSkillProgress(trx, userId, run.skill_id, { status: learnedAll ? 'mastered' : 'tested_out', mastered_at: new Date().toISOString(), last_test_run_id: run.id });
					});
					await addXp(await recordPractice(database, userId, { xp: { reason: 'skill_test', dedupe: `skill_test:${run.skill_id}` } }, today), 'skill_test');
					await earn('skill_test', COIN.earn.skillTest, `skill_test:${run.skill_id}`);
				} else if (mode === 'review') {
					const answered = items.filter((it) => it.result && it.lesson_id);
					const skills = new Set<string>();
					await database.transaction(async (trx: any) => {
						for (const it of answered) {
							const card = await trx('listening_review_cards').where({ user_id: userId, lesson_id: it.lesson_id }).forUpdate().first();
							const next = cardColumns(schedule(card || null, gradeOf(it.result!)));
							await trx('listening_review_cards').insert({ user_id: userId, lesson_id: it.lesson_id, ...next, source: card?.source || 'learned' })
								.onConflict(['user_id', 'lesson_id']).merge(next);
							const l = await trx('listening_lessons').select('skill_id').where('id', it.lesson_id).first();
							if (l?.skill_id) skills.add(l.skill_id);
						}
						await trx.raw(`
							INSERT INTO user_daily_stats (user_id, day, reviews) VALUES (?, ?, ?)
							ON CONFLICT (user_id, day) DO UPDATE SET reviews = user_daily_stats.reviews + EXCLUDED.reviews
						`, [userId, today, answered.length]);
						// The rule's bar: how well its forms are held now
						for (const skillId of skills) {
							const cards = await trx('listening_review_cards as c').join('listening_lessons as l', 'l.id', 'c.lesson_id')
								.select('c.*').where({ 'c.user_id': userId, 'l.skill_id': skillId });
							await trx.raw(`
								INSERT INTO listening_skill_progress (user_id, skill_id, mastery, date_updated) VALUES (?, ?, ?, now())
								ON CONFLICT (user_id, skill_id) DO UPDATE SET mastery = EXCLUDED.mastery, date_updated = now()
							`, [userId, skillId, masteryOf(cards)]);
						}
					});
					for (const [i, it] of items.entries()) {
						if (it.result?.correct) await addXp(await recordPractice(database, userId, { xp: { reason: 'review', dedupe: `review:${run.id}:${i}` } }, today), 'review');
					}
					await earn('review', COIN.earn.review, `review:${run.id}`);
				}
				// Xu won on traps during this run (given at once, when answered): counted in the run's total
				if (mode === 'learn' || mode === 'review') {
					const won = await database('coin_events').where({ user_id: userId, reason: 'trap' }).where('created_at', '>=', run.started_at).sum('amount as n').first();
					coins.added += Number(won?.n) || 0;
				}
				// Today's goal reached: a coin bonus once a day
				const [day, user] = await Promise.all([
					database('user_daily_stats').select('xp').where({ user_id: userId, day: today }).first(),
					database('directus_users').select('daily_goal').where('id', userId).first(),
				]);
				if ((Number(day?.xp) || 0) >= (Number(user?.daily_goal) || DEFAULT_GOAL)) {
					// Xu for the day, more the longer the run of goal days; a bonus at 7, 30, 100, 365 (once ever)
					const run = await goalRunOf(database, userId, today);
					await earn('goal', streakDayXu(run), `goal:${today}`);
					const bonus = COIN.streakMilestone[run];
					if (bonus) await earn('streak_milestone', bonus, `streak_milestone:${run}`);
				}
			}

			const g = await loadLessonGraph(req, context);
			// How long it took: start to finish, or (a run left and taken up again later) the time
			// spent answering
			const wall = Date.now() - new Date(run.started_at).getTime();
			const timeMs = wall > 0 && wall <= 3_600_000 ? wall : summary.answer_ms;
			// The forms to work on: a failed test's, or the ones missed in a review lesson
			let weakest: any[] = [];
			if (((mode === 'lesson_test' || mode === 'skill_test') && !closed.ok) || (mode === 'learn' && items.some((it) => it.lesson_id))) {
				const trs = await lessonTranslations(database, weakestForms(items).map((w) => w.lessonId));
				weakest = weakestForms(items).slice(0, 3).flatMap((w) => {
					const l = g.lessonById.get(w.lessonId);
					if (!l) return [];
					const tr = (trs.get(l.id) || []).find((t: any) => t.title) as any;
					return [{ short_id: l.short_id, number: g.numberOf(l), title: tr?.title || null, missed: w.missed }];
				});
			}
			const skill = run.skill_id ? g.skillById.get(run.skill_id) : null;
			return res.json({
				success: true,
				data: {
					mode, summary, time_ms: timeMs, passed: closed.ok, weakest, xp, coins, rewards,
					skill: skill ? { slug: skill.slug, name: skill.name } : null,
				},
			});
		} catch (error) {
			return fail(res, 'Finish run', error);
		}
	});

	// ── Weekly challenge (lib/challenges.ts) ──────────────────────────────
	type Card = ReturnType<typeof cardOf>;
	/** One round as the pages show it, for this learner */
	function cardOf(c: ChallengeRow, ctx: {
		now: number; lastClosed: string | null; all: ChallengeRow[]; userId: string | null; premium: boolean;
		unlocked: Set<string>; results: any[]; runs: any[];
	}) {
		const state = stateOf(c, ctx.now);
		const passedRuns = new Set(ctx.runs.filter((r) => r.status === 'finished' && r.passed).map((r) => r.challenge_id));
		const price = ctx.premium || ctx.unlocked.has(c.lesson_id) ? 0 : priceOf(c, ctx.lastClosed, ctx.now);
		let blocked: null | 'SCHEDULED' | 'LOGIN_REQUIRED' = null;
		if (state === 'scheduled') blocked = 'SCHEDULED';
		else if (price > 0 && !ctx.userId) blocked = 'LOGIN_REQUIRED';
		const mine = ctx.results.find((r) => r.challenge_id === c.id);
		const participants = Number(c.participants) || 0;
		return {
			id: c.id, short_id: c.short_id, week: c.week, title: { vi: c.title_vi, en: c.title_en },
			state, starts_at: c.starts_at, ends_at: c.ends_at, total: c.total, pass_score: c.pass_score, max_listens: c.max_listens,
			participants, passed_count: Number(c.passed_count) || 0,
			pass_rate: participants ? Math.round(((Number(c.passed_count) || 0) * 100) / participants) : null,
			/** Xu to open it now (0: open), and whether Premium covers it */
			price, premium: ctx.premium, blocked,
			/** The official go (while it was live) */
			my: mine ? { score: Number(mine.score), total: Number(mine.total), passed: !!mine.passed } : null,
			passed_any: passedRuns.has(c.id),
			played: ctx.runs.some((r) => r.challenge_id === c.id && r.status === 'finished'),
			resume: ctx.runs.some((r) => r.challenge_id === c.id && r.status === 'active'),
		};
	}
	async function cardsFor(req: any, rows: ChallengeRow[], all?: ChallengeRow[]): Promise<Card[]> {
		if (!rows.length) return [];
		const learner = learnerOf(req);
		const now = Date.now();
		const everything = all || await loadChallenges(database);
		const weeks = new Set(rows.map((r) => r.week));
		const ids = [...new Set([...rows.map((r) => r.id), ...everything.filter((r) => weeks.has(r.week)).map((r) => r.id)])];
		const [premium, unlocks, results, runs] = await Promise.all([
			learner.userId ? isPremiumUser(database, learner.userId) : false,
			learner.userId ? database('listening_unlocks').select('lesson_id').where('user_id', learner.userId).whereIn('lesson_id', rows.map((r) => r.lesson_id)) : [],
			learner.key ? database('listening_challenge_results').select('challenge_id', 'score', 'total', 'passed').where('learner_key', learner.key).whereIn('challenge_id', ids) : [],
			learner.key ? database('listening_runs').select('challenge_id', 'status', 'passed').where({ learner_key: learner.key, mode: 'challenge' }).whereIn('challenge_id', ids) : [],
		]);
		const ctx = { now, lastClosed: lastClosedWeek(everything, now), all: everything, userId: learner.userId, premium, unlocked: new Set<string>(unlocks.map((u: any) => u.lesson_id)), results, runs };
		return rows.map((c) => cardOf(c, ctx));
	}

	/** This week's rounds and every week before, newest first; guests send ?anonymous_id */
	router.get('/listening-lab/challenges', async (req: any, res: any) => {
		try {
			const all = (await loadChallenges(database)).filter((c) => stateOf(c) !== 'scheduled');
			const cards = await cardsFor(req, all, all);
			const weeks: { week: string; state: string; starts_at: any; ends_at: any; rounds: Card[] }[] = [];
			for (const card of cards) {
				let w = weeks.find((x) => x.week === card.week);
				if (!w) weeks.push(w = { week: card.week, state: card.state, starts_at: card.starts_at, ends_at: card.ends_at, rounds: [] });
				w.rounds.push(card);
			}
			const current = weeks.find((w) => w.state === 'live') || null;
			return res.json({ success: true, data: { current, past: weeks.filter((w) => w !== current) } });
		} catch (error) {
			return fail(res, 'Challenges', error);
		}
	});

	router.get('/listening-lab/challenges/:key', async (req: any, res: any) => {
		const key = String(req.params.key || '');
		if (badKey(key)) return res.status(400).json({ success: false, message: 'Invalid challenge' });
		try {
			const [c] = await loadChallenges(database, { shortId: key });
			if (!c) return res.status(404).json({ success: false, message: 'Challenge not found' });
			const [card] = await cardsFor(req, [c]);
			return res.json({ success: true, data: card });
		} catch (error) {
			return fail(res, 'Challenge', error);
		}
	});

	/** Start or resume a round. A price to pay: 402 PRICE, then again with { pay: true } */
	router.post('/listening-lab/challenges/:key/runs', async (req: any, res: any) => {
		const key = String(req.params.key || '');
		if (badKey(key)) return res.status(400).json({ success: false, message: 'Invalid challenge' });
		const learner = learnerOf(req);
		if (!learner.key) return res.status(400).json({ success: false, message: 'anonymous_id needed' });
		try {
			const [c] = await loadChallenges(database, { shortId: key });
			if (!c) return res.status(404).json({ success: false, message: 'Challenge not found' });
			const [card] = await cardsFor(req, [c]);
			if (card!.blocked) return res.status(403).json({ success: false, code: card!.blocked });
			if (card!.price > 0) {
				if (!req.body?.pay) return res.status(402).json({ success: false, code: 'PRICE', price: card!.price });
				await unlockChallenge(database, learner.userId!, c.lesson_id, card!.price);
			}
			const written = await database('listening_lessons').select('practice').where('id', c.lesson_id).first();
			const items = await withLessons(database, challengeItems(written?.practice));
			const order = items.map((it) => it.clip_id).join();
			const run = await openRun(learner, 'challenge', { lesson_id: c.lesson_id, skill_id: null }, () => items,
				{ restart: !!req.body?.restart, extra: { challenge_id: c.id }, valid: (its) => its.map((it) => it.clip_id).join() === order });
			if (!run) return res.status(409).json({ success: false, code: 'EMPTY_LESSON' });
			const g = await loadLessonGraph(req, context);
			return res.json({ success: true, data: await runOut(database, g, run) });
		} catch (error) {
			if (error instanceof CoinError) return coinFail(res, error);
			return fail(res, 'Start challenge', error);
		}
	});

	/**
	 * The end of a round: the score; the official go (first one finished while live) is counted
	 * and wins Xu when passed. Then every item with what was said, the right answer and how many
	 * people got it right.
	 */
	async function finishChallenge(req: any, learner: ReturnType<typeof learnerOf>, run: any, first: boolean) {
		const [c] = await loadChallenges(database, { id: run.challenge_id });
		const items: RunItem[] = run.items || [];
		const { score, total, passed: ok } = scoreOf(items, Number(c?.pass_score) || 7);
		let official = false;
		const coins = { added: 0, balance: null as number | null };
		if (c && first && learner.key && stateOf(c) === 'live') {
			official = await database.transaction(async (trx: any) => {
				const inserted = await trx('listening_challenge_results')
					.insert({ challenge_id: c.id, learner_key: learner.key, user_id: learner.userId, run_id: run.id, score, total, passed: ok })
					.onConflict(['challenge_id', 'learner_key']).ignore().returning('challenge_id');
				if (!inserted.length) return false;
				await trx('listening_challenges').where('id', c.id).update({
					participants: trx.raw('participants + 1'), passed_count: trx.raw('passed_count + ?', [ok ? 1 : 0]),
				});
				return true;
			});
			if (official && ok && learner.userId) {
				const won = await earnCoins(database, learner.userId, { reason: 'challenge', amount: CHALLENGE.earn.pass, dedupe: `challenge:${c.id}`, lessonId: c.lesson_id });
				coins.added += won.added;
				coins.balance = won.coins;
				if (score === total) {
					const extra = await earnCoins(database, learner.userId, { reason: 'challenge', amount: CHALLENGE.earn.perfect, dedupe: `challenge_perfect:${c.id}`, lessonId: c.lesson_id });
					coins.added += extra.added;
					coins.balance = extra.coins;
				}
			}
		}
		const fresh = c ? (await loadChallenges(database, { id: c.id }))[0] || null : null;
		const stats: Record<string, number> = fresh ? await cachedItemStats(database, fresh) : {};
		const card = fresh ? (await cardsFor(req, [fresh]))[0] || null : null;
		const beats = fresh && card?.my ? await beatsOf(database, fresh.id, card.my.score, card.participants) : null;
		const review = reviewOfRun(items, await pickedPools(database, null as any, items, run.lesson_id), run.lesson_id, stats);
		return { mode: 'challenge' as const, score, total, passed: ok, official, beats, coins, challenge: card, review };
	}

	// ── Practice bank (lib/bank.ts) ───────────────────────────────────────
	/** What this learner may open, has done and others did, for a set of sentences */
	async function bankCtx(req: any, clipIds: string[]) {
		const learner = learnerOf(req);
		const [premium, unlocks, mine, others, active] = await Promise.all([
			learner.userId ? isPremiumUser(database, learner.userId) : false,
			learner.userId ? database('practice_video_unlocks').select('practice_id').where('user_id', learner.userId) : [],
			learner.userId && clipIds.length ? database('practice_clip_progress').select('clip_id').where({ user_id: learner.userId, right_once: true }).whereIn('clip_id', clipIds) : [],
			clipIds.length ? database('practice_clip_progress').select('clip_id').count('* as n').whereIn('clip_id', clipIds).groupBy('clip_id') : [],
			learner.key && clipIds.length ? database('listening_runs').select('clip_id').where({ learner_key: learner.key, mode: 'bank', status: 'active' }).whereIn('clip_id', clipIds) : [],
		]);
		return {
			userId: learner.userId, premium,
			unlocked: new Set<string>(unlocks.map((u: any) => u.practice_id)),
			done: new Set<string>(mine.map((m: any) => m.clip_id)),
			learners: new Map<string, number>(others.map((o: any) => [o.clip_id, Number(o.n)])),
			active: new Set<string>(active.map((r: any) => r.clip_id)),
		};
	}
	type BankCtx = Awaited<ReturnType<typeof bankCtx>>;

	/** One sentence as a card, for this learner */
	function bankCardOf(it: BankItem, ctx: BankCtx) {
		const locked = it.is_premium && !ctx.premium && !ctx.unlocked.has(it.practice_id);
		return {
			id: it.id, n: it.n,
			video: { short_id: it.video_short_id, title: it.video_title },
			rule: { slug: it.skill_slug, name: it.skill_name },
			difficulty: it.difficulty,
			is_premium: it.is_premium, locked,
			/** Xu to open its video now (0: open): all the video's sentences open together */
			price: locked ? bankPrice(it) : 0, premium: ctx.premium,
			blocked: locked && !ctx.userId ? ('LOGIN_REQUIRED' as const) : null,
			done: ctx.done.has(it.id),
			learners: ctx.learners.get(it.id) || 0,
			resume: ctx.active.has(it.id),
		};
	}

	/**
	 * The bank, a page at a time: ?page=1&limit=24 and the filters rule (a rule's slug), level (1-3),
	 * show (free | todo). Order is the bank's own (videos, then as said), with `n` as the number.
	 */
	router.get('/listening-lab/practice', async (req: any, res: any) => {
		try {
			const all = await loadBankItems(database);
			const ctx = await bankCtx(req, all.map((it) => it.id));
			const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
			const limit = Math.min(60, Math.max(1, Math.floor(Number(req.query.limit)) || 24));
			const rule = String(req.query.rule || '');
			const level = Math.floor(Number(req.query.level)) || 0;
			const show = String(req.query.show || '');
			const cards = all.map((it) => bankCardOf(it, ctx));
			const rules = new Map<string, { slug: string; name: string; n: number }>();
			for (const it of all) {
				const e = rules.get(it.skill_slug) || { slug: it.skill_slug, name: it.skill_name, n: 0 };
				e.n++;
				rules.set(it.skill_slug, e);
			}
			const shown = cards.filter((c) => (!rule || c.rule.slug === rule) && (!level || c.difficulty === level) && (show !== 'free' || !c.locked) && (show !== 'todo' || !c.done));
			const thumbs = [...new Map(all.map((it) => [it.practice_id, it.thumbnail_url || `https://i.ytimg.com/vi/${it.youtube_video_id}/hqdefault.jpg`])).values()];
			return res.json({
				success: true,
				data: {
					items: shown.slice((page - 1) * limit, page * limit), total: shown.length, page, limit,
					rules: [...rules.values()].sort((a, b) => b.n - a.n),
					/** Of the whole bank, for the front page tile */
					summary: { total: cards.length, free: cards.filter((c) => !c.is_premium).length, done: cards.filter((c) => c.done).length, videos: thumbs.length, thumbs: thumbs.slice(0, 3) },
					default_price: BANK.price, earn: BANK.earn,
				},
			});
		} catch (error) {
			return fail(res, 'Bank', error);
		}
	});

	/** The sentence after this one that the learner can open (the card's "next") */
	async function bankNext(req: any, it: BankItem) {
		const all = await loadBankItems(database);
		const ctx = await bankCtx(req, all.map((x) => x.id));
		const next = all.find((x) => x.n > it.n && !bankCardOf(x, ctx).locked) || all.find((x) => x.n !== it.n && !bankCardOf(x, ctx).locked) || null;
		return { card: bankCardOf(it, ctx), next: next ? next.id : null };
	}

	router.get('/listening-lab/practice/:key', async (req: any, res: any) => {
		const key = String(req.params.key || '');
		if (!UUID_RE.test(key)) return res.status(400).json({ success: false, message: 'Invalid sentence' });
		try {
			const [it] = await loadBankItems(database, { clipId: key });
			if (!it) return res.status(404).json({ success: false, message: 'Sentence not found' });
			const { card, next } = await bankNext(req, it);
			return res.json({ success: true, data: { ...card, next } });
		} catch (error) {
			return fail(res, 'Bank item', error);
		}
	});

	/** Start or resume one sentence. A price to pay: 402 PRICE, then again with { pay: true } */
	router.post('/listening-lab/practice/:key/runs', async (req: any, res: any) => {
		const key = String(req.params.key || '');
		if (!UUID_RE.test(key)) return res.status(400).json({ success: false, message: 'Invalid sentence' });
		const learner = learnerOf(req);
		if (!learner.key) return res.status(400).json({ success: false, message: 'anonymous_id needed' });
		try {
			const [it] = await loadBankItems(database, { clipId: key });
			if (!it) return res.status(404).json({ success: false, message: 'Sentence not found' });
			const { card } = await bankNext(req, it);
			if (card.blocked) return res.status(403).json({ success: false, code: card.blocked });
			if (card.price > 0) {
				if (!req.body?.pay) return res.status(402).json({ success: false, code: 'PRICE', price: card.price });
				await unlockBankVideo(database, learner.userId!, it.practice_id, card.price);
			}
			const g = await loadLessonGraph(req, context);
			const pools = await pickedPools(database, g, [{ lesson_id: it.lesson_id } as RunItem]);
			const clip = pools.get(it.lesson_id)?.byId.get(it.id)?.clip;
			if (!clip) return res.status(409).json({ success: false, code: 'EMPTY_LESSON' });
			const run = await openRun(learner, 'bank', {},
				() => [{ clip_id: it.id, lesson_id: it.lesson_id, phase: 'practice' as const, format: bankFormat(clip, Math.floor(Math.random() * 3)), result: null }],
				{ restart: !!req.body?.restart, extra: { practice_id: it.practice_id, clip_id: it.id }, match: { clip_id: it.id } });
			if (!run) return res.status(409).json({ success: false, code: 'EMPTY_LESSON' });
			return res.json({ success: true, data: await runOut(database, g, run) });
		} catch (error) {
			if (error instanceof CoinError) return coinFail(res, error);
			return fail(res, 'Start bank run', error);
		}
	});

	/** The end of one sentence: kept as done when right, Xu the first time it is right, its answer and explanation */
	async function finishBank(req: any, learner: ReturnType<typeof learnerOf>, run: any, first: boolean) {
		const items: RunItem[] = run.items || [];
		const correct = !!items[0]?.result?.correct;
		const coins = { added: 0, balance: null as number | null };
		if (learner.userId && first && run.clip_id) {
			const old = await database('practice_clip_progress').where({ user_id: learner.userId, clip_id: run.clip_id }).first();
			await database('practice_clip_progress').insert({
				user_id: learner.userId, clip_id: run.clip_id, right_once: correct, plays: 1,
				first_right_at: correct ? database.fn.now() : null, last_played_at: database.fn.now(),
			}).onConflict(['user_id', 'clip_id']).merge({
				plays: database.raw('practice_clip_progress.plays + 1'), last_played_at: database.fn.now(),
				...(correct ? { right_once: true, first_right_at: old?.first_right_at || database.fn.now() } : {}),
			});
			// Xu once per sentence ever, for the first time it is heard right
			if (correct) {
				const won = await earnCoins(database, learner.userId, { reason: 'bank', amount: BANK.earn, dedupe: `bank:${run.clip_id}` });
				coins.added += won.added;
				coins.balance = won.coins;
			}
		}
		const [it] = run.clip_id ? await loadBankItems(database, { clipId: run.clip_id }) : [];
		const info = it ? await bankNext(req, it) : null;
		const review = reviewOfRun(items, await pickedPools(database, null as any, items), null);
		return { mode: 'bank' as const, correct, coins, card: info?.card || null, next: info?.next || null, review };
	}

	// ── Xu ────────────────────────────────────────────────────────────────
	router.get('/listening-lab/wallet', async (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		if (!userId) return res.json({ success: true, data: null });
		try {
			return res.json({ success: true, data: await walletOf(database, userId, MAX_FREEZES) });
		} catch (error) {
			return fail(res, 'Wallet', error);
		}
	});

	router.post('/listening-lab/lessons/:key/unlock', async (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const key = String(req.params.key || '');
		if (badKey(key)) return res.status(400).json({ success: false, message: 'Invalid lesson key' });
		try {
			const g = await loadLessonGraph(req, context);
			const lesson = g.findLesson(key);
			if (!lesson) return res.status(404).json({ success: false, message: 'Lesson not found' });
			if (!g.isLocked(lesson)) return res.status(409).json({ success: false, code: 'NOT_LOCKED' });
			const paid = await unlockLesson(database, userId, lesson);
			return res.json({ success: true, data: { price: paid.price, wallet: await walletOf(database, userId, MAX_FREEZES) } });
		} catch (error) {
			if (error instanceof CoinError) return coinFail(res, error);
			return fail(res, 'Unlock lesson', error);
		}
	});

	router.post('/listening-lab/wallet/freeze', async (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		try {
			await buyFreeze(database, userId, MAX_FREEZES);
			return res.json({ success: true, data: await walletOf(database, userId, MAX_FREEZES) });
		} catch (error) {
			if (error instanceof CoinError) return coinFail(res, error);
			return fail(res, 'Buy freeze', error);
		}
	});
}

